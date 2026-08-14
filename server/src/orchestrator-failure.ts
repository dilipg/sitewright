// server/src/orchestrator-failure.ts
/**
 * Turns a failed `generate` subprocess's raw output into a message whose FIRST
 * LINES say what broke.
 *
 * WHY THIS EXISTS (dogfood finding G1, and it is not the same bug the previous
 * fix closed). A generation failed after 11m14s having spent $1.28, and its
 * whole recorded reason was 1592 characters of nested-escaped, THRICE-truncated
 * Python `repr` of a Kitaru database row — including the checkpoint's own source
 * code — with the actual cause (a SQLAlchemy `OperationalError`, two page
 * workers racing one SQLite metadata store) sitting inside the third elision.
 * Full stderr was one line: `Bytecode compiled 6239 files in 450ms`.
 *
 * The previous fix (`fix(server): report both orchestrator streams`) made BOTH
 * streams reach the user, stdout first, 1500 characters each. That was
 * necessary and is kept. It was not sufficient, because the problem is the
 * PAYLOAD: `.slice(-1500)` of a giant escaped `repr` reliably lands in the
 * middle of noise. Worse, it destroyed the one thing that WAS the answer —
 * `acceptance.py` prints a structured `{"failed_stage": …, "detail": …}` report
 * to stdout, and the window opened AFTER that report's `{`, so the row in the
 * database contains the report's tail with no way to know it was one. The real
 * artefact is checked in (`fixtures/real-generate-failures.json`) and this
 * module is tested against it, not against a hand-written imitation.
 *
 * FOUR RULES, in the order they matter:
 *
 * 1. WHEN THE REPORT IS THERE, IT IS THE ANSWER. `extractFailureReport` finds
 *    the report by brace-matching around a `"failed_stage"` anchor and JSON-
 *    parses it, so `failed stage: fanout` is line 2 of the message no matter
 *    how much Kitaru chatter surrounds it. Nothing is inferred from position.
 *
 * 2. WHEN IT IS NOT THERE, THE RAW TAIL IS THE BEST AVAILABLE AND MUST STILL
 *    COME THROUGH. A traceback out of `main()`, a container OOM kill, a missing
 *    interpreter — none of those print a report, and those are exactly the
 *    failures where raw bytes matter most. So this NEVER parses-and-discards:
 *    both stream tails are appended whether or not a report was found (at 1500
 *    characters each when it was not — today's budget, unchanged — and 800 when
 *    it was, since the answer is already above them).
 *
 * 3. A NESTED-ESCAPED PAYLOAD IS UNESCAPED. The real artefact is escaped THREE
 *    times: the report is JSON, `detail` is a JSON document inside a JSON
 *    string, and inside THAT is a Python `repr` whose newlines are literal `\n`
 *    two-character sequences. Two structural JSON parses (the report, then any
 *    string leaf that is itself a JSON document) plus ONE textual
 *    `unescapeOnce` pass on each leaf is what turns all three levels into text
 *    with real newlines. The parses are the honest way to remove the first two
 *    levels; only the `repr` level needs the textual pass.
 *
 * 4. TRUNCATION IS PER-LEAF, KEEPS THE INFORMATIVE END, AND STATES WHAT IT
 *    DROPPED. This is the specific thing `.slice(-1500)` got wrong. Clipping
 *    the whole blob loses the labels; clipping each LEAF keeps every key —
 *    `failed_workers.home.returncode: 1` survives no matter how large its
 *    sibling `stderr_tail` is — and a leaf is always a tail of output
 *    (`stderr_tail`, a traceback), so its END is its informative half. Every
 *    clip is announced with an exact character count; nothing is silently
 *    elided.
 *
 * TWO DELIBERATE ASYMMETRIES, both of which look like inconsistencies until you
 * know why:
 *
 *   - The RENDERED REPORT is unescaped; the RAW TAILS are byte-exact. One
 *     unescape pass cannot be undone, and `\n` in `C:\node\x` is not an escape
 *     at all — so the transformation is applied only where it is provably
 *     wanted (inside a leaf that came out of a JSON parse) and never to the
 *     bytes kept as evidence. This costs nothing: a genuine traceback on stderr
 *     already has real newlines, so the no-report path has nothing to unescape.
 *   - The whole-report clip keeps its HEAD AND TAIL, while a leaf clip keeps
 *     only the tail. Which end of a whole report is informative depends on the
 *     stage (a typecheck error leads with the file and line; a traceback ends
 *     with the exception), and the head is where `failed stage:` lives.
 *
 * REDACTION RUNS THREE TIMES, and each one covers something the others cannot:
 * on entry over both raw streams (as before, so today's guarantee is unchanged),
 * on every leaf after `unescapeOnce`, and once over the joined report (which is
 * the only one that covers a report's KEYS — see `renderFailureReport`). Three
 * distinct hazards:
 *
 *   - A REVEALED key. Unescaping can make a key matchable that the escaped form
 *     hid: `redact.ts`'s `AQ.` pattern is boundary-anchored, and `…x\nAQ.<key>`
 *     escaped presents `n` immediately before `AQ.`, so there is no boundary.
 *     THE REAL FIX FOR THAT ONE IS IN `redact.ts` — its pattern now also matches
 *     after an escape sequence — because the same hazard applies to the raw
 *     tails here and to every other caller (`preview-pool.ts` logs a child's
 *     stdout), none of which unescape anything. Since that pattern covers the
 *     escaped form too, SWAPPING THE ORDER OF `unescapeOnce` AND `redactSecrets`
 *     inside `emitLeaf` breaks no test today: verified by perturbation, recorded
 *     rather than implied. The order is kept because it is the correct
 *     discipline for the NEXT boundary-sensitive pattern somebody adds, and
 *     because one hazard below is real regardless.
 *   - A DECODED key in a VALUE, which only the leaf-level call can catch.
 *     `JSON.parse` decodes `\uXXXX`, so stdout can carry a key as bytes
 *     containing no `AQ.` at all; no pattern can match those bytes, and the entry
 *     pass is powerless. It becomes a key only after the report is parsed, and the
 *     only redaction downstream of that parse is the leaf's. Removing it leaks —
 *     pinned by a test, not by this comment.
 *   - A DECODED key in a FIELD NAME, which only the joined-report call can catch,
 *     because `emitLeaf` interpolates its `path` unredacted and the
 *     empty-object/empty-array branches emit a path with no leaf call at all.
 *     Also pinned by a test. (The corresponding raw-tail exposure is NOT closed:
 *     a numerically escaped key survives in the byte-exact tail, exactly as it
 *     did before this module existed. Recorded in the G1 report, because
 *     `unescapeOnce` decoding `\uXXXX` would be the cure that causes the disease.)
 *
 * Every clip happens AFTER a redaction, never before, so a clip can only ever
 * cut the `[redacted]` marker and never expose a key body whose matchable prefix
 * it removed.
 */
import { redactSecrets } from "./redact.ts";

/** Longest a single rendered leaf may be; the END is kept (see rule 4). */
export const MAX_LEAF_CHARS = 900;
/** Kept from the START of a rendered report — where `failed stage:` always is. */
export const MAX_REPORT_HEAD_CHARS = 1_800;
/** Kept from the END of a rendered report. */
export const MAX_REPORT_TAIL_CHARS = 1_200;
/** Per-stream raw tail when a report WAS found: the answer is already above it. */
export const MAX_STREAM_TAIL_CHARS = 800;
/** Per-stream raw tail when NO report was found: the raw tail is the whole evidence. */
export const MAX_STREAM_TAIL_CHARS_WITHOUT_REPORT = 1_500;
/**
 * How deep the flattener will walk before it stops expanding and prints the
 * remaining value as one JSON leaf. `JSON.parse` output cannot contain a cycle,
 * so this is a bound on OUTPUT SIZE and stack depth, not a cycle guard.
 */
export const MAX_RENDER_DEPTH = 8;

const ANCHOR = '"failed_stage"';

/** A parsed `acceptance.py` failure report. `fields` is every key EXCEPT `failed_stage`. */
export interface FailureReport {
  readonly stage: string;
  readonly fields: Record<string, unknown>;
  /** The exact JSON text the report was parsed from — used by tests, not by the message. */
  readonly raw: string;
}

/**
 * The escapes a Python `repr` (or a second round of JSON encoding) leaves
 * behind. Deliberately SHORT: no `\uXXXX`, no `\xNN`, no `\0`. Numeric escapes
 * are the ones that can reconstitute a credential character-by-character out of
 * text that no redaction pattern could match, and nothing in the real artefact
 * needs them.
 */
const UNESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "'": "'",
  "\\": "\\",
  "/": "/",
};

/**
 * Removes exactly ONE level of backslash escaping.
 *
 * One regex pass, left to right, is what makes "exactly one" true: `\\n`
 * (backslash, backslash, `n`) matches at the first backslash, emits a single
 * `\`, and resumes at the `n` — so a doubly-escaped newline becomes `\n` and
 * NOT a real newline. Sequential `.replace()` calls per escape would have
 * cascaded and stripped two levels while claiming one.
 *
 * An unrecognised escape (`\U`, `\x41`) is left exactly as it was, both
 * characters intact.
 */
export function unescapeOnce(text: string): string {
  return text.replace(/\\([\s\S])/g, (whole: string, ch: string) => UNESCAPES[ch] ?? whole);
}

/** Keeps the last `max` characters, announcing the exact number dropped. */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `[... ${String(dropped)} earlier characters dropped ...]\n${text.slice(-max)}`;
}

/** Keeps both ends, announcing the exact number dropped from the middle. */
export function clipHeadAndTail(text: string, headMax: number, tailMax: number): string {
  if (text.length <= headMax + tailMax) return text;
  const dropped = text.length - headMax - tailMax;
  return `${text.slice(0, headMax)}\n[... ${String(dropped)} characters dropped from the middle ...]\n${text.slice(-tailMax)}`;
}

/**
 * Index of the `{` that opens the object whose key starts at `anchorAt`, or -1.
 *
 * Walks back over whitespace ONLY, which is the cheapest way to reject an
 * ESCAPED occurrence — `{\"failed_stage\":` inside some other string, i.e. a
 * report quoted inside a `detail` — since the character before its quote is a
 * backslash, not whitespace or `{`. No separate "am I inside a string?" pass is
 * needed.
 *
 * Not the only thing rejecting it, and worth being honest about: relaxing this to
 * "walk back to the nearest `{`" breaks no test, because a mis-framed candidate
 * fails `JSON.parse` a few lines below and is skipped anyway (verified by
 * perturbation). What DOES depend on framing the report out of the RAW text is
 * the order of operations — searching an unescaped copy of stdout instead finds
 * the quoted inner report and reports the wrong stage, and that is pinned by a
 * test.
 */
function openBraceBefore(text: string, anchorAt: number): number {
  let i = anchorAt - 1;
  while (i >= 0 && /\s/.test(text[i] ?? "")) i -= 1;
  return i >= 0 && text[i] === "{" ? i : -1;
}

/** Index of the `}` matching the `{` at `openAt`, ignoring braces inside string literals, or -1. */
function matchingBrace(text: string, openAt: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Finds `acceptance.py`'s `{"failed_stage": …}` report anywhere in `stdout`.
 *
 * ANCHORED ON THE KEY, not on position or on a sentinel. The report is the last
 * thing `main()` prints before `SystemExit(1)`, but it is preceded by however
 * much Kitaru, `uv` and fan-out chatter the run produced (~22 KB in the real
 * artefact), and a run can be killed after printing it — so "the last line" and
 * "the last JSON object" are both wrong. Adding a sentinel to the Python side
 * was considered and rejected: `"failed_stage"` already IS one, and the
 * orchestrator's print statement is a contract two other CLIs share.
 *
 * Returns the LAST report in the stream when there is more than one (only
 * `acceptance_edit.py` could produce a second, and the later one is the outcome
 * that killed the process).
 */
export function extractFailureReport(stdout: string): FailureReport | null {
  let found: FailureReport | null = null;
  let from = 0;
  for (;;) {
    const anchorAt = stdout.indexOf(ANCHOR, from);
    if (anchorAt < 0) return found;
    from = anchorAt + ANCHOR.length;
    const openAt = openBraceBefore(stdout, anchorAt);
    if (openAt < 0) continue;
    const closeAt = matchingBrace(stdout, openAt);
    if (closeAt < 0) continue;
    const raw = stdout.slice(openAt, closeAt + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Brace-matched but not valid JSON (a truncated report, or a `{` that
      // merely looked like one). Keep scanning; never guess at a repair.
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const stage = record.failed_stage;
    if (typeof stage !== "string") continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== "failed_stage") fields[key] = value;
    }
    found = { stage, fields, raw };
  }
}

/** One leaf line: `path: value`, or `path:` followed by an indented block when the value is multi-line. */
function emitLeaf(path: string, text: string, out: string[]): void {
  // unescape -> redact -> clip. The redact is here because `JSON.parse` decodes
  // `\uXXXX`, so this string can hold a key that no pattern could match in the
  // bytes it was parsed from; the clip is last so it can only ever cut a
  // `[redacted]` marker. See this module's own comment for which half of that is
  // pinned by a test and which is discipline.
  const readable = clipTail(redactSecrets(unescapeOnce(text)), MAX_LEAF_CHARS);
  if (!readable.includes("\n")) {
    out.push(`${path}: ${readable}`);
    return;
  }
  out.push(`${path}:`);
  for (const line of readable.split("\n")) out.push(`  ${line}`);
}

/**
 * Flattens a report field into `path: value` lines.
 *
 * A string leaf that is ITSELF a JSON document is expanded rather than printed
 * — that is level 2 of the real artefact's three levels of escaping
 * (`acceptance.py` line 175 does `json.dumps(detail)`, so fan-out's whole
 * `detail` is a JSON document inside a JSON string). Expanding it is what makes
 * `failed_workers.<slug>.returncode` a line of its own instead of a fragment
 * buried in a 6000-character string.
 */
function flatten(value: unknown, path: string, depth: number, out: string[]): void {
  if (depth >= MAX_RENDER_DEPTH) {
    emitLeaf(path, JSON.stringify(value) ?? String(value), out);
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
        flatten(parsed, path, depth + 1, out);
        return;
      }
    }
    emitLeaf(path, value, out);
    return;
  }
  if (value === null || typeof value !== "object") {
    emitLeaf(path, String(value), out);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${path}: []`);
      return;
    }
    value.forEach((item, index) => { flatten(item, `${path}[${String(index)}]`, depth + 1, out); });
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    out.push(`${path}: {}`);
    return;
  }
  for (const [key, item] of entries) flatten(item, `${path}.${key}`, depth + 1, out);
}

/**
 * `failed stage: <stage>` followed by every other field, flattened. Clipped at
 * both ends.
 *
 * The whole join is redacted ONE more time, and not out of superstition: a
 * report's KEYS are as untrusted as its values (they arrive from a
 * model-generated route slug, a node id, whatever a `gate_report` is keyed by),
 * and every other redaction in this module covers a leaf's VALUE. `emitLeaf`
 * interpolates `path` unredacted, and the empty-object/empty-array branches emit
 * a path with no leaf call at all — so without this, `{"sk-ant-…": {}}` would
 * reach `job.error` intact. Before the clip, so the clip can still only ever cut
 * a `[redacted]` marker. `redactSecrets` is idempotent on its own output (its
 * replacements contain `[`, which no pattern's character class admits), so the
 * leaves it has already covered are unaffected.
 */
export function renderFailureReport(report: FailureReport): string {
  const lines = [`failed stage: ${report.stage}`];
  for (const [key, value] of Object.entries(report.fields)) flatten(value, key, 0, lines);
  return clipHeadAndTail(redactSecrets(lines.join("\n")), MAX_REPORT_HEAD_CHARS, MAX_REPORT_TAIL_CHARS);
}

/** A labelled raw tail. BYTE-EXACT (never unescaped) — this is the evidence half. */
function labelledTail(name: string, text: string, max: number): string {
  const dropped = Math.max(0, text.length - max);
  const header = dropped > 0
    ? `--- raw ${name}: last ${String(max)} of ${String(text.length)} chars (${String(dropped)} dropped) ---`
    : `--- raw ${name}: ${String(text.length)} chars ---`;
  return `${header}\n${text.slice(-max)}`;
}

export interface OrchestratorFailure {
  /** `null` means the child was terminated by a signal — see `describeOrchestratorFailure`. */
  readonly code: number | null;
  /** RAW, un-redacted. This function redacts; passing pre-redacted text is harmless but not required. */
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The whole `job.error` value for a failed `generate`.
 *
 * Shape: a one-line header, then the rendered report if there was one, then each
 * non-empty stream's raw tail. A reader who stops after three lines has the
 * stage; a reader who needs bytes has them below.
 *
 * `code === null` is called out explicitly rather than printed as the string
 * "null". In Node it means the child was killed by a signal, and with both
 * streams empty (a container OOM kill, which is the shape this run was first
 * suspected of) there is otherwise nothing at all in the message to diagnose
 * from.
 */
export function describeOrchestratorFailure(failure: OrchestratorFailure): string {
  const stdout = redactSecrets(failure.stdout);
  const stderr = redactSecrets(failure.stderr);
  const report = extractFailureReport(stdout);

  const sections: string[] = [
    failure.code === null
      ? "orchestrator exited with no exit code, so it was killed by a signal (an out-of-memory kill looks like this)"
      : `orchestrator exited with code ${String(failure.code)}`,
  ];
  if (report !== null) sections.push(renderFailureReport(report));

  const max = report === null ? MAX_STREAM_TAIL_CHARS_WITHOUT_REPORT : MAX_STREAM_TAIL_CHARS;
  const streams: string[] = [];
  // stdout first: it is where the report is, so it is where a reader should
  // look first even when the report failed to parse.
  if (stdout.trim() !== "") streams.push(labelledTail("stdout", stdout, max));
  if (stderr.trim() !== "") streams.push(labelledTail("stderr", stderr, max));
  if (streams.length === 0) sections.push("(no output on either stream)");
  else sections.push(...streams);

  return sections.join("\n\n");
}
