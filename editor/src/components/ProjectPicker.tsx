/**
 * The first caller `GET /api/projects` and `POST /api/generate` have ever had.
 *
 * Both routes have existed since slices 4a and 5 respectively and nothing in
 * `editor/src` referenced either, so a tester had to read a project UUID out
 * of `user-cli list-projects` and paste it into the URL by hand. This is the
 * screen that removes that step, and — like `LoginScreen` — it is HOSTED MODE
 * ONLY (`App.tsx`'s `hostedShellWithoutProject`). The local, unauthenticated
 * preview server has no session, no project table and no job worker; local
 * mode must keep behaving exactly as it does today.
 *
 * THREE FUNCTIONS ARE EXPORTED SEPARATELY FROM THE COMPONENT, for the reason
 * `submitLogin` and `session-fetch.ts` already established: this workspace has
 * no React testing library and may not add one ("no new runtime dependencies"),
 * so anything living inside the component body is untestable by construction.
 * What is pulled out is precisely what can be wrong in a way that matters —
 * the request `Generate` makes, and which of a project's two UUIDs the list
 * hands back.
 *
 * THE ID / DIRECTORY DISTINCTION IS LOAD-BEARING. `GET /api/projects` returns
 * both `id` and `directory`, both UUID-shaped, and they are different values
 * by design (spec decision 8: a project IS a run directory, but the HTTP
 * identity and the filesystem identity are separate). Only `id` is accepted by
 * `?project=`, by `/api/projects/:id`, or by any project-scoped `/__*` route.
 * `requireProject` answers a foreign project and a nonexistent one
 * IDENTICALLY (one 404, one shared constant), so handing a directory where an
 * id belongs does not produce a diagnosable error — it produces "that project
 * does not exist" for a project that plainly does. `ProjectRow` therefore
 * carries no directory at all, so this component structurally cannot render
 * one.
 */
import { useEffect, useState } from "react";
import { generateUrl, projectsUrl } from "../lib/backend";
import { SessionExpiredError } from "../lib/session-fetch";
import { describeSpend, type SpendSummary } from "../lib/spend";

/** What the picker renders per project. Deliberately NOT the wire shape — see
 *  this module's header comment for why the on-disk directory is absent. */
export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  /** ISO calendar date (`YYYY-MM-DD`), UTC. */
  readonly createdAtLabel: string;
}

/** What `POST /api/generate` answers with, and the whole of what this screen
 *  hands onward. Both ids are needed downstream and they name different
 *  things: the JOB is what the progress view polls, the PROJECT is what the
 *  editor opens once it succeeds. */
export interface StartedGeneration {
  readonly jobId: string;
  readonly projectId: string;
}

export interface RequestOptions {
  /** Test seam only; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface ProjectPickerProps {
  /** Open an existing project. Receives the project's ID — never its
   *  directory (see the header comment). */
  readonly onOpen: (projectId: string) => void;
  /** A generation has STARTED. The caller owns everything after this point;
   *  nothing here polls. */
  readonly onGenerationStarted: (started: StartedGeneration) => void;
  /** A 401 from either request. Its own state, distinct from a load failure
   *  and from a generation failure. */
  readonly onSessionExpired: () => void;
  /** Shown so a tester on a shared machine can see which account is about to
   *  be billed. */
  readonly accountEmail?: string;
  /** TASK 4. Shown beside Generate, because that button spends ~$1.74 and the
   *  server refuses 402 over the cap. Absent means the line is not rendered at
   *  all — never a `$NaN`. */
  readonly spend?: SpendSummary;
  /** BYOK FORM. Which key is stored, in one honest line for all three states
   *  (`describeKeyStatus`) — never a provider for a key that does not exist.
   *  Absent means the caller has no key screen to offer, which is what keeps
   *  this component usable from a caller that does not have one. */
  readonly keyStatus?: string;
  /** BYOK FORM. Opens the key screen. The picker is the one place a tester who
   *  already has a key can get back to it: with a key stored, the screen no
   *  longer appears by itself. */
  readonly onOpenKeySettings?: () => void;
}

/**
 * The exact text a user sees for pressing Generate with nothing typed.
 *
 * Exported so the test can assert it exactly rather than by substring — task 2
 * measured that `rejects.toThrow(/brief/i)` still PASSES when the message is
 * perturbed by appending to it, and the wording IS the whole user-visible
 * outcome here.
 */
export const EMPTY_BRIEF_MESSAGE = "Enter a brief before generating.";

/** Measured figures, not estimates: `docs/reports/m7-wall-clock.md` and slice
 *  5's own live end-to-end run (401.8s / $1.09 for 10 sections; ~$1.74 and
 *  ~11 minutes for a full 3-page site). Stated on the form because there is
 *  no cancellation — spec decision 13, the orchestrator subprocess cannot be
 *  safely killed — so a mistyped brief spends anyway. */
const GENERATION_COST_USD = "$1.74";
const GENERATION_MINUTES = "11 minutes";

/* ------------------------------------------------------------------ *
 * List shaping
 * ------------------------------------------------------------------ */

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `new Date(NaN).toISOString()` THROWS a RangeError, and this runs inside
 * render with no error boundary anywhere above it (the same hazard
 * `backend.ts`'s `neutralizeDotSegments` records for `previewUrl`). A row
 * whose `created_at` is absent or non-numeric — an adopted project, a
 * hand-inserted row, a future schema change — must degrade to a label, never
 * take the screen down.
 *
 * UTC and ISO rather than `toLocaleDateString`: a locale-formatted string is
 * a different value on a different machine, so the assertion covering it
 * would pass or fail depending on where it ran. The cost is that a project
 * generated late in the evening west of UTC shows tomorrow's date; the
 * alternative is an untestable label.
 */
function toCreatedAtLabel(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "date unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date unknown";
  return date.toISOString().slice(0, 10);
}

/**
 * The wire payload -> what the list renders.
 *
 * Reads the two fields it needs off an untyped record rather than casting the
 * whole payload to a trusted interface: this parses a network response, and
 * an `as` cast asserts a shape instead of checking one — the precise mistake
 * `jobs.ts`'s poll loop had to be fixed for.
 *
 * Newest first. The server's own `listProjectsByOwner` is `ORDER BY
 * created_at, directory` (oldest first), which is the wrong end for a picker:
 * the project a tester wants is almost always the one they just generated,
 * and it would otherwise sink to the bottom of a growing list.
 */
export function toProjectRows(payload: unknown): ProjectRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: Array<ProjectRow & { readonly sortKey: number }> = [];
  for (const entry of payload as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const id = readString(raw, "id");
    // No id means no way to open it — a row that cannot be acted on is worse
    // than an absent one, because it reads as a project the user has lost.
    if (id === undefined) continue;
    const createdAt = raw.createdAt;
    rows.push({
      id,
      // The server names a project after its own brief, truncated to 200
      // chars. The fallback names no identifier at all: showing the id (let
      // alone the directory) where a human label belongs is how a UUID ends
      // up being read as a name.
      name: readString(raw, "name") ?? "Untitled project",
      createdAtLabel: toCreatedAtLabel(createdAt),
      sortKey: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    });
  }
  return rows
    .sort((a, b) => b.sortKey - a.sortKey)
    .map(({ id, name, createdAtLabel }) => ({ id, name, createdAtLabel }));
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/** Wrapped rather than aliased: a bare `const f = fetch; f(...)` invokes the
 *  global with the wrong receiver and throws "Illegal invocation" in a
 *  browser (the same note `submitLogin` carries). */
function resolveFetch(options: RequestOptions): typeof fetch {
  return options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
}

/**
 * A refusal's own message, verbatim — used for `POST /api/generate` and
 * deliberately NOT for `GET /api/projects`, which is the asymmetry worth
 * explaining.
 *
 * `POST /api/generate` refuses for several genuinely different reasons and
 * words each one itself: 402 over the spend cap (retrying cannot help until
 * the 24h window rolls — which is exactly why it is 402 and not 429), 429
 * with two generations already in flight (retrying DOES help, once one
 * finishes), 400 for a malformed body, 413 for an over-long brief, 403 for a
 * disabled API key, 400 for a missing one. Every one of those is actionable
 * and already worded; rewording them here would either flatten the
 * distinction or invent advice the server did not give.
 *
 * `GET /api/projects` has no such vocabulary. It is session-only, its 401 is
 * handled as its own state before this is ever reached, and everything else
 * is either an unanticipated 500 (whose body says `internal`, which tells a
 * user nothing) or — far more likely in this deployment model — a 502/504
 * from the editor's own Vite proxy because the hosted server is not running
 * at all. There the STATUS is the diagnostic and the body is noise, so that
 * caller names the status instead of quoting the body.
 */
async function refusalMessage(response: Response, verb: string): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A proxy error page, an empty body, an upstream that died mid-response:
    // not JSON, and not a reason to throw a second error over the first.
    body = undefined;
  }
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === "string" && error !== "") return error;
  return `${verb} (HTTP ${String(response.status)}).`;
}

/**
 * Lists the caller's own projects. Session-only and scoped by the server's
 * SQL, so no other user's row is ever in hand.
 *
 * A 401 becomes `SessionExpiredError` — its own state, which App renders as
 * the login screen. Any other non-2xx throws BEFORE `.json()` is called, so
 * an error body is never parsed as if it were the project list (the defect
 * `refreshManifest` shipped: a 401's `{error}` parsed fine and became a
 * `manifest` with no `nodes`).
 */
export async function loadProjects(options: RequestOptions = {}): Promise<ProjectRow[]> {
  const response = await resolveFetch(options)(projectsUrl(), {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) throw new SessionExpiredError();
  if (!response.ok) {
    // The status, not the body — see `refusalMessage`'s comment for why this
    // caller is the exception. Thrown before `.json()` either way.
    throw new Error(
      `Could not load your sites (HTTP ${String(response.status)}). Is the server running?`,
    );
  }
  const body = (await response.json()) as { projects?: unknown };
  return toProjectRows(body.projects);
}

/**
 * Starts a generation and returns THE TWO IDS IT STARTED — it does not wait
 * for the work, and it must not.
 *
 * **202 means the work has STARTED, not finished.** `POST /api/generate`
 * creates the project row and its directory synchronously, queues a job, and
 * answers 202 immediately; the run itself takes ~11 minutes. That status code
 * is the one signal the job model reserved for "a job now exists, go poll for
 * it" (`lib/jobs.ts`'s own header), so ANY other status is a refusal here,
 * even a 200 carrying an identical-looking body.
 *
 * NOTE WHAT THIS DOES NOT USE: `enqueueAndPoll`. That helper POSTs and then
 * polls to completion, resolving with a terminal `JobOutcome` — which is the
 * right shape for the five flows that already use it (seconds to a couple of
 * minutes, with their own in-place progress) and the wrong one here. Polling
 * belongs to the progress view, which has a stage, a section count and an
 * elapsed clock to show for those eleven minutes; doing it in this function
 * would hide the entire run behind one unresolved promise and duplicate the
 * poll loop besides.
 *
 * The empty-brief guard runs BEFORE any request. The server does answer 400
 * for a blank brief (`BAD_BRIEF`), so this is not the only defence — but a
 * round trip to be told you typed nothing is worse than not making the call,
 * and the guard is what lets the message name the fix instead of the status.
 */
export async function startGeneration(
  brief: string,
  options: RequestOptions = {},
): Promise<StartedGeneration> {
  const trimmed = brief.trim();
  if (trimmed === "") throw new Error(EMPTY_BRIEF_MESSAGE);

  const response = await resolveFetch(options)(generateUrl(), {
    method: "POST",
    // Required, not decorative: the server refuses a body with no JSON
    // content type, which is what closes CSRF on every state-changing route.
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    // Trimmed on the way out as well as guarded: the server trims before
    // storing the project name, so sending the untrimmed text would make the
    // name the user sees differ from the brief they typed.
    body: JSON.stringify({ brief: trimmed }),
  });

  if (response.status === 401) throw new SessionExpiredError();
  if (response.status !== 202) {
    throw new Error(await refusalMessage(response, "Could not start the generation"));
  }

  const body = (await response.json()) as { jobId?: unknown; projectId?: unknown };
  if (typeof body.jobId !== "string" || typeof body.projectId !== "string") {
    // A 202 from something that is not this endpoint would otherwise hand the
    // progress view `undefined`, which polls `/api/jobs/undefined` forever
    // while a real, paid generation runs unobserved.
    throw new Error("The server accepted the request but did not say which job it started.");
  }
  return { jobId: body.jobId, projectId: body.projectId };
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export default function ProjectPicker({
  onOpen,
  onGenerationStarted,
  onSessionExpired,
  accountEmail,
  spend,
  keyStatus,
  onOpenKeySettings,
}: ProjectPickerProps) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [brief, setBrief] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  // The SAME function the key screen renders its own spend line from, so neither
  // surface can present a floor as an exact figure — see `lib/spend.ts` for the
  // accepted risk that makes this the mitigation rather than a nicety.
  const budgetLine = describeSpend(spend);

  useEffect(() => {
    let cancelled = false;
    void loadProjects()
      .then((loaded) => {
        if (!cancelled) setRows(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof SessionExpiredError) {
          onSessionExpired();
          return;
        }
        // An empty list and a failed load are different facts and must not
        // look the same: "you have no projects yet" invites a tester to spend
        // $1.74 regenerating a site they already have.
        setRows([]);
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting) return;
    setStartError(undefined);
    setStarting(true);
    try {
      const started = await startGeneration(brief);
      // Deliberately no `setStarting(false)` on success: this screen is
      // replaced by the progress view in the same tick, and re-enabling the
      // button first would offer a second, separately billed run for the
      // brief that just started.
      onGenerationStarted(started);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired();
        return;
      }
      setStartError(error instanceof Error ? error.message : String(error));
      setStarting(false);
    }
  }

  return (
    <div className="project-picker" data-testid="project-picker">
      <header className="picker-header">
        <h1>Website Generator</h1>
        {accountEmail !== undefined && (
          <p className="picker-account" data-testid="picker-account">
            Signed in as <strong>{accountEmail}</strong>
          </p>
        )}
        {/* BYOK FORM. Which key is stored, and the way back to the screen that
            changes it. Rendered in the header rather than beside Generate because
            it is an account fact, not a per-run one — and because with a key
            already stored the screen never appears on its own, so this link is
            the only route to it. */}
        {onOpenKeySettings !== undefined && (
          <p className="picker-account" data-testid="picker-key">
            <span data-testid="picker-key-status">{keyStatus ?? "API key status unknown"}</span>{" "}
            <button
              type="button"
              className="picker-key-button"
              data-testid="picker-key-button"
              onClick={onOpenKeySettings}
            >
              Change API key
            </button>
          </p>
        )}
      </header>

      <section className="picker-panel" aria-labelledby="picker-projects-heading">
        <h2 id="picker-projects-heading">Your sites</h2>
        {rows === null ? (
          <p className="picker-muted">Loading your sites…</p>
        ) : loadError !== undefined ? (
          <p className="picker-error" data-testid="picker-load-error" role="alert">
            {loadError}
          </p>
        ) : rows.length === 0 ? (
          <p className="picker-muted" data-testid="picker-empty">
            No sites yet. Describe one below to generate your first.
          </p>
        ) : (
          <ul className="picker-list">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="picker-project"
                  data-testid="picker-project"
                  data-project-id={row.id}
                  onClick={() => onOpen(row.id)}
                >
                  <span className="picker-project-name">{row.name}</span>
                  <span className="picker-project-date">{row.createdAtLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="picker-panel" aria-labelledby="picker-new-heading">
        <h2 id="picker-new-heading">Generate a new site</h2>
        <form className="new-site-form" onSubmit={(event) => void onGenerate(event)}>
          <label htmlFor="new-site-brief">Describe the site in one line</label>
          <textarea
            id="new-site-brief"
            data-testid="new-site-brief"
            className="new-site-brief"
            rows={3}
            placeholder="a landing page for a neighbourhood bakery, with a menu and an order form"
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            // App.tsx registers a window-level keydown handler (Esc, Ctrl+Z,
            // Ctrl+Y) whose effect is still mounted while this screen
            // renders — without this, Ctrl+Z in the brief would be swallowed
            // by the canvas's undo. Same guard LoginScreen's inputs carry.
            onKeyDown={(event) => event.stopPropagation()}
            disabled={starting}
          />
          {startError !== undefined && (
            <p className="picker-error" data-testid="generate-error" role="alert">
              {startError}
            </p>
          )}
          <button
            type="submit"
            data-testid="generate-button"
            className="picker-generate"
            disabled={starting}
          >
            {starting ? "Starting…" : "Generate site"}
          </button>
          {/* TASK 4 — beside the affordance that spends it, not on a settings
              page. The server refuses an over-cap request with 402 (retrying
              cannot help until the 24h window rolls), so seeing the number
              before typing a brief is the difference between a decision and a
              rejection. */}
          {budgetLine !== undefined && (
            <p className="picker-budget" data-testid="picker-budget">
              {budgetLine}
            </p>
          )}
          {/* Stated BEFORE the money is spent, not after. There is no
              cancellation (spec decision 13: the orchestrator subprocess
              cannot be safely killed), so a mistyped brief runs to completion
              and is billed either way — a tester who is not told finds out by
              paying. Both figures are measured, not estimated. */}
          <p className="picker-footnote">
            Generating a site costs about {GENERATION_COST_USD} on your own API key and takes about{" "}
            {GENERATION_MINUTES}. It cannot be cancelled once it starts — a mistyped brief still
            spends.
          </p>
        </form>
      </section>
    </div>
  );
}
