// server/src/orchestrator-failure.test.ts
/**
 * VERIFIED AGAINST THE REAL ARTEFACT, not an imitation of one.
 *
 * `fixtures/real-generate-failures.json` holds the exact stdout/stderr of three
 * real failed generations, recovered from `job.error` rows in the live identity
 * database (which is gitignored, so that file is the only checked-in copy). The
 * fan-out record is dogfood finding G1 itself: 11m13s, $1.2767, 13 usage rows,
 * and a recorded reason that was 1592 characters of nested-escaped, thrice-
 * truncated Python `repr`.
 *
 * READ THE FIXTURE'S OWN `note` BEFORE ADDING A CASE. Each `stdout` is only the
 * last 1500 characters of that run's real stdout, because `.slice(-1500)` is all
 * the old code kept — so the fan-out record's report head is GONE (that loss is
 * the finding) while the design and plan records' reports happened to fit inside
 * the window and survived whole. Both halves are useful, and they exercise
 * different paths: report-present and report-absent.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clipHeadAndTail, clipTail, describeOrchestratorFailure, extractFailureReport,
  MAX_LEAF_CHARS, MAX_STREAM_TAIL_CHARS, MAX_STREAM_TAIL_CHARS_WITHOUT_REPORT,
  renderFailureReport, unescapeOnce,
} from "./orchestrator-failure.ts";

interface RealFailure {
  readonly jobId: string;
  readonly runId: string;
  readonly stage: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly spendUsd: number | null;
  readonly elapsedSeconds: number;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/real-generate-failures.json", import.meta.url), "utf8"),
) as { note: string; records: RealFailure[] };

function real(stage: string): RealFailure {
  const found = FIXTURE.records.find((record) => record.stage === stage);
  if (found === undefined) throw new Error(`fixture has no ${stage} record`);
  return found;
}

/** Everything above the first raw-stream section: the part a reader sees first. */
function answerSection(message: string): string {
  const at = message.indexOf("\n\n--- raw ");
  return at < 0 ? message : message.slice(0, at);
}

describe("describeOrchestratorFailure against the real design-stage failure", () => {
  const record = real("design");

  it("names the failed stage in the first three lines, instead of leaving it inside a 1500-char window", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: record.stdout, stderr: record.stderr });
    const firstLines = message.split("\n").slice(0, 3).join("\n");
    expect(firstLines).toContain("failed stage: design");
  });

  it("puts the report ABOVE both raw tails, so a reader who stops early still has the cause", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: record.stdout, stderr: record.stderr });
    expect(message.indexOf("failed stage:")).toBeLessThan(message.indexOf("--- raw stdout"));
    expect(message.indexOf("--- raw stdout")).toBeLessThan(message.indexOf("--- raw stderr"));
  });

  it("surfaces the actual cause — the TypeScript error and the file and line it is on", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: record.stdout, stderr: record.stderr });
    expect(answerSection(message)).toContain("src/primitives/Icon.tsx(164,7): error TS2322");
    expect(answerSection(message)).toContain("Property 'draggable' does not exist");
  });

  it("unescapes the report's nested escapes, so the reader sees \"data-node-id\" and not \\\"data-node-id\\\"", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: record.stdout, stderr: record.stderr });
    // The real stored bytes carry the escaped form; the ANSWER carries the
    // readable one. (The raw tail below it still holds the escaped original,
    // which is why this asserts against the answer section only.)
    expect(record.stdout).toContain('\\"data-node-id\\"');
    expect(answerSection(message)).toContain('"data-node-id": string | undefined');
    expect(answerSection(message)).not.toContain('\\"data-node-id\\"');
  });

  it("still carries both raw streams verbatim — the report is never parsed AND discarded", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: record.stdout, stderr: record.stderr });
    expect(message).toContain("--- raw stdout");
    expect(message).toContain("--- raw stderr");
    // The one line the whole of stderr contained on this run.
    expect(message).toContain("Bytecode compiled 6239 files in 511ms");
  });
});

describe("describeOrchestratorFailure against the real plan-stage failure", () => {
  const record = real("plan");

  it("renders a multi-line detail as real lines rather than one \\n-littered string", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: record.stdout, stderr: record.stderr });
    const answer = answerSection(message);
    expect(answer).toContain("failed stage: plan");
    expect(answer).toContain("Kitaru refused to run this flow");
    // Four separate lines in the original; four separate lines here.
    expect(answer).toContain("\n  Resolved active stack: default");
    expect(answer).toContain("\n  Choose a stack explicitly before running this workflow.");
  });
});

describe("describeOrchestratorFailure against the real G1 fan-out failure", () => {
  const record = real("fanout");

  /**
   * The fixture's `stdout` is what the OLD code left behind: a 1500-character
   * window that opened after the report's own `{`, so no report is recoverable
   * from it at all. This is the "the shape is not the expected report" case, and
   * the rule for it is that the raw tail must still come through whole.
   */
  it("falls back to the raw tail when the report is unrecoverable, keeping the evidence", () => {
    expect(extractFailureReport(record.stdout)).toBe(null);
    const message = describeOrchestratorFailure({ code: 1, stdout: record.stdout, stderr: record.stderr });
    expect(message).toContain("orchestrator exited with code 1");
    // The informative END of the tail — the SQLAlchemy error code that says what
    // actually broke — survives.
    expect(message).toContain("https://sqlalche.me/e/20/e3q8");
    expect(message).toContain("Bytecode compiled 6239 files in 450ms");
  });

  it("gives a report-less failure the FULL per-stream budget, since the tail is then all the evidence there is", () => {
    const noisy = `${"x".repeat(4000)}\nnothing structured here`;
    const message = describeOrchestratorFailure({ code: 1, stdout: noisy, stderr: "" });
    // The NUMBER is spelled out, not read back from the constant under test:
    // asserting `last ${MAX_STREAM_TAIL_CHARS_WITHOUT_REPORT} of` put the same
    // value on both sides and passed no matter what the budget was changed to.
    // (Caught by perturbing the constant and watching this test stay green.)
    expect(message).toContain("last 1500 of");
    expect(MAX_STREAM_TAIL_CHARS_WITHOUT_REPORT).toBeGreaterThan(MAX_STREAM_TAIL_CHARS);
    expect(message).toContain("nothing structured here");
  });

  /**
   * The same failure as it reaches the NEW code in production: the whole stdout,
   * report head intact.
   *
   * `head` is a reconstruction and is labelled as one — those bytes are
   * unrecoverable. It is not invented, though: its shape is `acceptance.py`
   * lines 171-175 (`{"gate_report": …, "failed_workers": {slug: {returncode,
   * stderr_tail}}}`) and `fanout.py` line 138, the slug is this run's own
   * `home` route from its `plan/siteplan.json`, and it is short enough that the
   * REAL 1500 bytes — which already close every brace and quote it opens — are
   * what the assertions below are actually about.
   */
  const reconstructedFullStdout = [
    "=== fan-out: 2 page workers, at most 1 at a time: ['home', 'contact']\n",
    "=== home: exit=1 duration=402.11s\n",
    '{\n  "failed_stage": "fanout",\n  "detail": "{\\"gate_report\\": {\\"passed\\": false, \\"issues\\": []}, ',
    '\\"failed_workers\\": {\\"home\\": {\\"returncode\\": 1, \\"stderr_tail\\": \\"',
    record.stdout,
  ].join("");

  it("names the stage and the failed ROUTE, which the old 1500-char window could not", () => {
    const answer = answerSection(describeOrchestratorFailure({
      code: 1, stdout: reconstructedFullStdout, stderr: record.stderr,
    }));
    expect(answer).toContain("failed stage: fanout");
    // Per-leaf clipping is what keeps these two lines: they are short siblings
    // of a 1500-character `stderr_tail`, and a single whole-message clip of any
    // size would have chosen between them and the traceback.
    expect(answer).toContain("detail.failed_workers.home.returncode: 1");
    expect(answer).toContain("detail.gate_report.passed: false");
  });

  it("keeps the informative END of the giant leaf and states exactly how much it dropped", () => {
    const answer = answerSection(describeOrchestratorFailure({
      code: 1, stdout: reconstructedFullStdout, stderr: record.stderr,
    }));
    expect(answer).toContain("https://sqlalche.me/e/20/e3q8");
    expect(answer).toMatch(/\[\.\.\. \d+ earlier characters dropped \.\.\.\]/);
  });

  it("unescapes the THIRD level — the Python repr's own \\n — into real lines, and stops there", () => {
    const answer = answerSection(describeOrchestratorFailure({
      code: 1, stdout: reconstructedFullStdout, stderr: record.stderr,
    }));
    // Level 3 reached: in the real bytes the failed checkpoint's source is one
    // long `@checkpoint\\ndef commit_section_manifest(\\n    project_dir: str,`
    // run; two JSON parses plus one unescape pass make it real lines. This is
    // the line that names WHICH checkpoint failed, so it is the one that had to
    // become readable.
    expect(answer).toContain("\n  def commit_section_manifest(");
    expect(answer).toContain("\n      project_dir: str,");
    // AND THE LIMIT, asserted rather than left to be discovered: the traceback
    // is a JSON document inside that repr — a FOURTH level — so its own newlines
    // are still literal here. One pass is one pass; a cascade would strip
    // however many levels it found and corrupt a payload that legitimately
    // printed a backslash. The traceback is still readable enough to act on (the
    // file, the line, and SQLAlchemy's own error code below), which is why this
    // is a recorded limit and not a bug.
    expect(answer).toContain("step_launcher.py\\\", line 211, in launch\\n  request_factory");
  });
});

describe("extractFailureReport", () => {
  it("finds the report however much chatter precedes it", () => {
    const stdout = `${"Kitaru: Checkpoint `x` finished in 1m2s.\n".repeat(200)}{"failed_stage": "shell", "detail": "boom"}\n`;
    expect(extractFailureReport(stdout)?.stage).toBe("shell");
  });

  it("finds a report printed with indent=2, which is how acceptance.py prints it", () => {
    const stdout = 'noise\n{\n  "failed_stage": "export",\n  "detail": "tsc failed"\n}\n';
    const report = extractFailureReport(stdout);
    expect(report?.stage).toBe("export");
    expect(report?.fields.detail).toBe("tsc failed");
  });

  it("returns null rather than guessing when the report is cut off mid-string", () => {
    expect(extractFailureReport('{\n  "failed_stage": "fanout",\n  "detail": "half a rep')).toBe(null);
  });

  it("ignores an ESCAPED occurrence, so a report quoted inside another report's detail is not mistaken for one", () => {
    const stdout = '{"failed_stage": "fanout", "detail": "the worker printed {\\"failed_stage\\": \\"inner\\"} itself"}';
    const report = extractFailureReport(stdout);
    expect(report?.stage).toBe("fanout");
  });

  it("takes the LAST report when a run printed more than one", () => {
    const stdout = '{"failed_stage": "plan", "detail": "a"}\nretrying\n{"failed_stage": "design", "detail": "b"}';
    expect(extractFailureReport(stdout)?.stage).toBe("design");
  });

  it("ignores an object that merely mentions the key without a string stage", () => {
    expect(extractFailureReport('{"failed_stage": null, "detail": "x"}')).toBe(null);
    expect(extractFailureReport('{"failed_stage": 7}')).toBe(null);
  });

  it("keeps every field, not just `detail` — a report shape this code does not know must still be readable", () => {
    const report = extractFailureReport('{"failed_stage": "design", "reason": "primitives exhausted retries", "attempt": 3}');
    expect(report).not.toBe(null);
    const rendered = renderFailureReport(report!);
    expect(rendered).toContain("failed stage: design");
    expect(rendered).toContain("reason: primitives exhausted retries");
    expect(rendered).toContain("attempt: 3");
  });
});

describe("unescapeOnce", () => {
  it("turns an escaped newline into a real one", () => {
    expect(unescapeOnce("a\\nb")).toBe("a\nb");
  });

  it("removes EXACTLY one level, never two", () => {
    // The real artefact is escaped three times over; a cascade would silently
    // strip more than it claims and corrupt a payload that was legitimately
    // showing a backslash.
    expect(unescapeOnce("a\\\\nb")).toBe("a\\nb");
    expect(unescapeOnce("a\\\\\\\\nb")).toBe("a\\\\nb");
  });

  it("leaves an escape it does not know completely alone, both characters intact", () => {
    expect(unescapeOnce("C:\\Users\\x41")).toBe("C:\\Users\\x41");
  });

  it("does not decode numeric escapes, which could rebuild a credential no pattern would match", () => {
    expect(unescapeOnce("\\u0041\\x42")).toBe("\\u0041\\x42");
  });
});

describe("clipping", () => {
  it("clipTail keeps the end and states the exact number dropped", () => {
    const clipped = clipTail(`${"a".repeat(100)}THE-END`, 10);
    expect(clipped).toContain("THE-END");
    expect(clipped).toContain("[... 97 earlier characters dropped ...]");
  });

  it("clipTail leaves text within budget completely untouched", () => {
    expect(clipTail("short", 10)).toBe("short");
  });

  it("clipHeadAndTail keeps both ends, so `failed stage:` and a trailing traceback both survive", () => {
    const clipped = clipHeadAndTail(`HEAD${"m".repeat(500)}TAIL`, 4, 4);
    expect(clipped.startsWith("HEAD")).toBe(true);
    expect(clipped.endsWith("TAIL")).toBe(true);
    expect(clipped).toContain("[... 500 characters dropped from the middle ...]");
  });

  /**
   * The per-leaf clip bounds one big FIELD; this bounds one big REPORT. A gate
   * report carries one entry per issue, and a project-wide gate failure can
   * produce hundreds — each individually well inside the leaf budget, so nothing
   * downstream of the leaf clip would have bounded the row at all.
   *
   * (Added because perturbing `renderFailureReport` to skip its clip entirely
   * left the whole suite green: the clip had a unit test, and nothing asserted
   * that the renderer used it.)
   */
  it("bounds a report with hundreds of small fields, keeping the stage AND the final field", () => {
    const issues: Record<string, string> = {};
    for (let i = 0; i < 400; i += 1) issues[`issue_${String(i)}`] = `src/pages/home/sections/S${String(i)}.tsx is missing a node id`;
    const report = extractFailureReport(JSON.stringify({ failed_stage: "fanout", detail: JSON.stringify(issues) }));
    const rendered = renderFailureReport(report!);
    expect(rendered.length).toBeLessThan(3_200);
    expect(rendered).toContain("failed stage: fanout");
    expect(rendered).toContain("[... ");
    expect(rendered).toContain("characters dropped from the middle");
    // The tail survived too, which is the whole reason this clip keeps both ends.
    expect(rendered).toContain("issue_399");
  });

  it("stops expanding at a bounded depth and prints the rest as one JSON leaf, rather than one line per scalar", () => {
    let nested: unknown = { bottom: "the actual message" };
    for (let i = 0; i < 12; i += 1) nested = { [`level_${String(i)}`]: nested };
    const report = extractFailureReport(JSON.stringify({ failed_stage: "shell", detail: nested }));
    const rendered = renderFailureReport(report!);
    // Nothing is lost — the deepest value is still there — but it arrives as a
    // JSON blob on one line instead of a path 13 segments long.
    expect(rendered).toContain("the actual message");
    expect(rendered).not.toContain("level_11.bottom");
    expect(rendered).toContain('{"bottom":"the actual message"}');
  });

  it("bounds a leaf, so one huge field cannot crowd out its siblings", () => {
    const report = extractFailureReport(JSON.stringify({
      failed_stage: "fanout",
      detail: JSON.stringify({ huge: "z".repeat(20_000), returncode: 1 }),
    }));
    const rendered = renderFailureReport(report!);
    expect(rendered).toContain("detail.returncode: 1");
    expect(rendered.length).toBeLessThan(MAX_LEAF_CHARS + 3_000);
  });
});

describe("describeOrchestratorFailure, the failures that print no report at all", () => {
  it("says a missing exit code means a signal, which is what a container OOM kill looks like", () => {
    const message = describeOrchestratorFailure({ code: null, stdout: "", stderr: "" });
    expect(message).toContain("killed by a signal");
    expect(message).toContain("out-of-memory");
    expect(message).not.toContain("code null");
  });

  it("says so plainly when there was no output at all, rather than ending mid-sentence", () => {
    expect(describeOrchestratorFailure({ code: 1, stdout: "", stderr: "" }))
      .toContain("(no output on either stream)");
  });

  it("passes a raw Python traceback straight through", () => {
    const traceback = 'Traceback (most recent call last):\n  File "acceptance.py", line 114\nValueError: bad worker count\n';
    const message = describeOrchestratorFailure({ code: 1, stdout: "", stderr: traceback });
    expect(message).toContain("ValueError: bad worker count");
    expect(message).not.toContain("failed stage:");
  });

  it("keeps a stream out of the message entirely when it was empty", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: "something", stderr: "" });
    expect(message).toContain("--- raw stdout");
    expect(message).not.toContain("--- raw stderr");
  });
});

/**
 * The binding constraint: nothing this module produces may carry key material,
 * INCLUDING anything it revealed by unescaping. `redactSecrets` covered both
 * streams before this module existed and must keep covering everything it emits.
 */
describe("describeOrchestratorFailure never publishes key material", () => {
  const ANTHROPIC = "sk-ant-api03-REALLOOKINGKEY0123456789-ZZ";
  const GEMINI_AUTH = "AQ.AbNotARealAuthKeyJustTheRightShape";

  it("redacts a key sitting in the report's own detail", () => {
    const stdout = JSON.stringify({ failed_stage: "design", detail: `spawn env ANTHROPIC_API_KEY=${ANTHROPIC}` });
    const message = describeOrchestratorFailure({ code: 1, stdout, stderr: "" });
    expect(message).not.toContain(ANTHROPIC);
    expect(message).toContain("sk-ant-[redacted]");
  });

  it("redacts a key in a raw stream when there is no report to parse", () => {
    const message = describeOrchestratorFailure({ code: 1, stdout: `boom ${ANTHROPIC}`, stderr: `also ${ANTHROPIC}` });
    expect(message).not.toContain(ANTHROPIC);
  });

  /**
   * THE CASE THIS MODULE CREATED, and the reason redaction is not simply done
   * once on entry. `redact.ts`'s `AQ.` pattern is anchored on a word boundary,
   * and an escaped newline destroys one: `…\nAQ.<key>` presents `n` immediately
   * before `AQ.`, so the escaped form does not match while the UNESCAPED form
   * does. Unescaping without re-checking would therefore have published a key
   * that the code before this module redacted.
   */
  it("redacts a key that only becomes visible AFTER the unescape pass", () => {
    const hidden = `worker env dump:\\n${GEMINI_AUTH}\\nnext line`;
    // The precondition, asserted rather than assumed.
    expect(/\bAQ\./.test(hidden)).toBe(false);
    const stdout = JSON.stringify({ failed_stage: "fanout", detail: hidden });
    const message = describeOrchestratorFailure({ code: 1, stdout, stderr: "" });
    expect(message).not.toContain(GEMINI_AUTH);
    expect(message).toContain("AQ.[redacted]");
  });

  /**
   * The other half of the same rule, and the reason the leaf-level redaction is
   * not merely belt-and-braces over the entry pass. `JSON.parse` decodes
   * `\uXXXX`, so a producer that escapes aggressively can put a key into stdout
   * as bytes containing no `AQ.` at all — no pattern here can match it, and the
   * entry pass cannot help. It becomes a key only once the report is PARSED, and
   * the only redaction downstream of that parse is the leaf's.
   */
  it("redacts a key that no pattern could match until JSON.parse decoded it", () => {
    const stdout = `{"failed_stage": "design", "detail": "env \\u0041Q.AbNotARealAuthKeyJustTheRightShape"}`;
    // The precondition: the bytes on stdout contain no `AQ.` sequence at all.
    expect(stdout).not.toContain("AQ.");
    const message = describeOrchestratorFailure({ code: 1, stdout, stderr: "" });
    expect(message).not.toContain(GEMINI_AUTH);
    expect(message).toContain("AQ.[redacted]");
  });

  /**
   * A report's KEYS are as untrusted as its values — a model-generated route
   * slug, a node id, whatever a gate report is keyed by — and every other
   * redaction in this module covers a leaf's VALUE: `emitLeaf` interpolates its
   * `path` unredacted, and the empty-object branch emits a path with no leaf call
   * at all.
   *
   * The escape matters, and this test was inert without it: an ordinary key in a
   * field name is already caught by the entry pass, because the entry pass sees
   * the whole of stdout including its keys. Only a name that BECOMES a key when
   * `JSON.parse` decodes it (`s` → `s`) reaches the renderer unredacted, and
   * only the redaction over the joined report catches it there.
   */
  it("redacts key material in a FIELD NAME that JSON.parse decoded, whose value is an empty object", () => {
    const stdout = '{"failed_stage": "design", "detail": {"env_\\u0073k-ant-api03-REALLOOKINGKEY0123456789-ZZ": {}}}';
    // The precondition: the bytes on stdout contain no `sk-ant-` at all.
    expect(stdout).not.toContain("sk-ant-");
    const answer = answerSection(describeOrchestratorFailure({ code: 1, stdout, stderr: "" }));
    expect(answer).not.toContain("REALLOOKINGKEY0123456789");
    expect(answer).toContain("sk-ant-[redacted]");
    // SCOPED TO THE RENDERED REPORT ON PURPOSE, and this is a recorded limit
    // rather than an oversight: the raw tail below it is byte-exact and still
    // holds `env_sk-ant-…`, because no pattern can match a numerically
    // escaped key and `unescapeOnce` deliberately refuses to decode `\uXXXX`
    // (decoding numeric escapes out of untrusted output is how a credential no
    // pattern could see gets reassembled). The code before this module had the
    // identical property — the entry-pass redaction is unchanged — so nothing
    // regressed; see the G1 report's concerns.
  });

  it("redacts a key nested as deep as the real artefact's traceback is", () => {
    const stdout = JSON.stringify({
      failed_stage: "fanout",
      detail: JSON.stringify({
        failed_workers: { home: { returncode: 1, stderr_tail: `OSError: env was {'ANTHROPIC_API_KEY': '${ANTHROPIC}'}` } },
      }),
    });
    const message = describeOrchestratorFailure({ code: 1, stdout, stderr: "" });
    expect(message).not.toContain(ANTHROPIC);
  });

  it("redacts BEFORE it clips, so a clip can never expose a key body whose prefix it removed", () => {
    // The body alone matches no pattern, so a clip that kept only the body would
    // publish it. Redaction runs first, so the clip can only ever cut the marker.
    const body = "REALLOOKINGKEY0123456789-ZZ";
    const stdout = JSON.stringify({
      failed_stage: "design",
      detail: `${"padding ".repeat(300)}key=sk-ant-api03-${body}`,
    });
    const message = describeOrchestratorFailure({ code: 1, stdout, stderr: "" });
    expect(message).not.toContain(body);
  });

  it("bounds every stream tail, so a runaway child cannot write an unbounded row", () => {
    const message = describeOrchestratorFailure({
      code: 1,
      stdout: `{"failed_stage": "design", "detail": "small"}\n${"y".repeat(200_000)}`,
      stderr: "z".repeat(200_000),
    });
    // A spelled-out bound, for the same reason as the budget test above: derived
    // from the constant it is bounding, this would have passed at any budget.
    expect(message.length).toBeLessThan(3_000);
  });
});
