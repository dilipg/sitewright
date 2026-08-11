/**
 * Regeneration endpoints for the preview server (PRD section 4):
 *
 *   POST /__regen        { section, instruction } -> { passed, orphanedOverrides,
 *                                                     tombstoned, failureReport, canRevert }
 *   POST /__regen-page   { route, instruction }   -> same, plus { sections, perSection }
 *   POST /__regen-revert { section }              -> { ok }
 *       (the FIELD is always `section`; its VALUE may be a section id or a
 *        bare route slug. This line previously read `{ section | route }`,
 *        which reads as "either field name" and is wrong — a `route` field
 *        yields 400 `invalid route slug`. Round 1's own plan copied the error
 *        from here and wasted a live call on it.)
 *   GET  /__archetypes                            -> { archetypes: [{name, description}] }
 *   POST /__add-section  { route, archetype, instruction }
 *                                                 -> { passed, sectionId, failureReport }
 *   POST /__edit-prompt  { route, instruction, selection? }
 *                                                 -> { operations, clarify, structural, notes }
 *
 * Before every regen the section's page directory + manifest are snapshotted;
 * revert restores the snapshot — the one-step "revert regeneration" (PRD 4.4).
 *
 * Page-level regen (PRD section 4, 7.9) reuses that snapshot unchanged: it was
 * always the whole route's directory, so one revert already restores a whole
 * page. What matters is that the page path snapshots ONCE, before any section
 * runs — snapshotting per section would leave the backup holding the previous
 * section's freshly regenerated output, and "revert" would then undo only the
 * last section while claiming to undo the page.
 *
 * There is ONE snapshot slot per project, and for as long as an operation that
 * took it is still RUNNING it is claimed: a concurrent regeneration of a
 * DIFFERENT route is refused rather than silently replacing it. Two browser
 * tabs is all that takes — `MAX_ACTIVE_JOBS_PER_USER` is 2 and bounds
 * concurrency per user, never per project. See `claimedSlots` for what that
 * does and does not close.
 *
 * Real mode spawns the orchestrator CLI (Kitaru replay fork, 4.1). Mock mode
 * (WG_REGEN_MOCK=1) applies deterministic file transformations mirroring the
 * real contract so the editor UX is e2e-testable in CI without model spend;
 * the real engine path is proven by the 4.1 live checks and the 4.3 stress
 * suite. Mock-mode manifest edits are direct JSON writes — acceptable ONLY
 * because mock mode is test infrastructure, never the product path.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import type { EditAgentResult } from "./edit-protocol.ts";
import { mockEditOperations } from "./edit-mock.ts";
import { MAX_BODY_BYTES } from "./max-body-bytes.ts";
import { ROUTE_SLUG } from "./route-slug.ts";
import { isValidUsageId, USAGE_ID_HEADER, usageLogPathFor } from "./usage-log-path.ts";

const MOCK_DELAY_MS = 1500; // keeps the in-place progress state observable in e2e

/**
 * Resolved by `readBody` in place of a parsed body when the request body
 * exceeds `MAX_BODY_BYTES` — by that point `readBody` has already answered
 * 413 and destroyed the request, so every call site checks for this sentinel
 * FIRST and returns immediately rather than trying to answer the same
 * request a second time.
 */
const BODY_TOO_LARGE = Symbol("body-too-large");

/**
 * Guards every filesystem path this plugin builds from proxied, otherwise-
 * unvalidated request input. `route` and `section`'s route component both
 * end up joined straight into a project-relative path (`snapshotRoute`,
 * below) — `path.join` normalises `..` segments, so an unchecked value can
 * walk outside the project root before any handler logic even runs. Found in
 * review: the hosted server proxies `route`/`section` bytes verbatim and
 * neither it nor this file validated them, so
 * `route = "../../../../victim/src"` escaped the project directory and
 * copied another tenant's files into the caller's own `.regen-backup`.
 *
 * Shares `ROUTE_SLUG` with `preview.ts`'s `/__overrides/<route-slug>` guard
 * rather than redefining it — one definition, so the two call sites cannot
 * silently drift apart.
 */
function isValidRouteSlug(value: unknown): value is string {
  return typeof value === "string" && ROUTE_SLUG.test(value);
}

/**
 * The route component of a section (or bare-route) id — same rule
 * `snapshotSection`/`restoreSnapshot` use to derive a route slug from a
 * section id, applied here so the VALIDATION sees exactly what the
 * filesystem call will. A `..`-shaped id (e.g. `"../../secret.hero"`) starts
 * with a literal `.`, so this always yields `""` for that specific shape —
 * not itself exploitable — but the guard is applied regardless, for the same
 * reason `route` is: an unvalidated value has no business reaching
 * `path.join` at all, and a non-string body field must fail closed here
 * rather than throw deeper in `.split()`.
 */
function routeSlugOfSection(section: unknown): string | undefined {
  return typeof section === "string" ? section.split(".")[0] : undefined;
}

/** Sends the uniform 400 every route-slug rejection below uses. */
function respondInvalidRouteSlug(res: ServerResponse): void {
  respondJson(res, 400, { error: "invalid route slug" });
}

export function regenApiPlugin(projectRoot: string): Plugin {
  const root = resolve(projectRoot);
  return {
    name: "website-generator:regen-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (req.method === "POST" && url === "/__regen") {
          void readBody(req, res).then(async (body) => {
            if (body === BODY_TOO_LARGE) return; // readBody already answered 413
            // Whether THIS request took the snapshot claim. A request refused
            // by someone else's claim must not release it in the `finally`
            // below — that would hand the slot to the very clobberer the
            // refusal exists to stop.
            let claimed = false;
            try {
              const { section, instruction } = body as { section: string; instruction: string };
              if (!isValidRouteSlug(routeSlugOfSection(section))) {
                respondInvalidRouteSlug(res);
                return;
              }
              snapshotSection(root, section);
              claimed = true;
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockRegen(root, section, instruction)
                  : await realRegen(root, section, instruction, usageEnvFor(req));
              // the editor reloads the frame immediately on response; the
              // watcher's async invalidation would race it and serve stale
              // transforms from the module cache
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ...result, canRevert: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            } finally {
              // Released whether the run passed, failed or threw: the claim
              // means "still running", and it is not running any more. A leak
              // here refuses every later regeneration on this project.
              if (claimed) releaseSnapshotClaim(root);
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/__regen-page") {
          void readBody(req, res).then(async (body) => {
            if (body === BODY_TOO_LARGE) return; // readBody already answered 413
            let claimed = false; // see /__regen above
            try {
              const { route, instruction } = body as { route: string; instruction: string };
              if (!isValidRouteSlug(route)) {
                respondInvalidRouteSlug(res);
                return;
              }
              // once, before any section runs — see the header comment
              snapshotRoute(root, route);
              claimed = true;
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockRegenPage(root, route, instruction)
                  : await realRegenPage(root, route, instruction, usageEnvFor(req));
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ...result, canRevert: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            } finally {
              if (claimed) releaseSnapshotClaim(root);
            }
          });
          return;
        }
        if (req.method === "GET" && url === "/__archetypes") {
          void archetypeCatalog(root)
            .then((archetypes) => respondJson(res, 200, { archetypes }))
            .catch((error) => respondJson(res, 500, { error: String(error) }));
          return;
        }
        if (req.method === "POST" && url === "/__add-section") {
          void readBody(req, res).then(async (body) => {
            if (body === BODY_TOO_LARGE) return; // readBody already answered 413
            let claimed = false; // see /__regen above
            try {
              const { route, archetype, instruction } = body as {
                route: string;
                archetype: string;
                instruction: string;
              };
              if (!isValidRouteSlug(route)) {
                respondInvalidRouteSlug(res);
                return;
              }
              // Same route-wide snapshot as a regen, so an added section is
              // revertable by the same one step — adding one is as much a
              // change to the page as regenerating it (PRD 4.4). It therefore
              // takes, and must release, the same claim.
              snapshotRoute(root, route);
              claimed = true;
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockAddSection(root, route, archetype, instruction)
                  : await realAddSection(root, route, archetype, instruction, usageEnvFor(req));
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ...result, canRevert: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            } finally {
              if (claimed) releaseSnapshotClaim(root);
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/__edit-prompt") {
          void readBody(req, res).then(async (body) => {
            if (body === BODY_TOO_LARGE) return; // readBody already answered 413
            try {
              const { route, instruction, selection } = body as {
                route: string;
                instruction: string;
                selection?: string;
              };
              if (!isValidRouteSlug(route)) {
                respondInvalidRouteSlug(res);
                return;
              }
              // No snapshot here, unlike regen: this endpoint changes nothing on
              // disk. It returns operations; the editor applies them as ordinary
              // overrides, which the existing undo stack already covers.
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? mockEditOperations(instruction, route)
                  : await realEditPrompt(root, route, instruction, selection, usageEnvFor(req));
              respondJson(res, 200, result);
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/__regen-revert") {
          void readBody(req, res).then((body) => {
            if (body === BODY_TOO_LARGE) return; // readBody already answered 413
            try {
              const { section } = body as { section: string };
              if (!isValidRouteSlug(routeSlugOfSection(section))) {
                respondInvalidRouteSlug(res);
                return;
              }
              restoreSnapshot(root, section);
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ok: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        next();
      });
    },
  };
}

/* ---------- snapshot / revert ---------- */

function snapshotDir(root: string): string {
  return join(root, ".regen-backup");
}

function snapshotSection(root: string, section: string): void {
  snapshotRoute(root, section.split(".")[0]!);
}

/**
 * Which route the single pending snapshot belongs to.
 *
 * There is ONE snapshot slot per project. It holds a whole-project
 * `manifest.json` alongside one route's page directory, and keeping one slot
 * keeps those two paired, which is the invariant the revert depends on. What
 * was missing was any record of WHOSE snapshot it is.
 *
 * CORRECTION (docs/decisions.md 2026-08-10, "F13 review, finding 1"): this
 * comment used to justify the single slot by saying per-route slots would
 * "trade file loss for MANIFEST loss". That was WRONG and the review proved it
 * by reproduction — the manifest loss happens under one slot ANYWAY whenever
 * two regenerations overlap. Do not re-derive a design decision from it. What
 * closes the overlap is `claimedSlots` below; the single slot survives on the
 * pairing argument alone.
 */
function snapshotOwnerFile(root: string): string {
  return join(snapshotDir(root), "route.txt");
}

/**
 * Which project roots have their single snapshot slot CLAIMED by an operation
 * that has not finished yet, and by which route. Keyed by resolved root, so
 * one process serving several projects keeps them independent.
 *
 * P1 (docs/decisions.md 2026-08-10, "F13 review, finding 1"):
 * `MAX_ACTIVE_JOBS_PER_USER` is 2 and bounds concurrency per USER, never per
 * project, so ONE tester with two browser tabs can start two regenerations of
 * two different routes on one project. They share one preview child and one
 * slot: the second `snapshotRoute` wiped the first's, and a later revert then
 * restored a manifest predating the first route's commit while that route's
 * CODE stayed regenerated — silent divergence, no error anywhere.
 *
 * IN MEMORY, deliberately, and not a file beside the slot:
 *
 *  - The race is between two requests to the SAME process. The hosted server
 *    runs one Vite child per project and proxies every `/__*` call for that
 *    project into it; the local `compiler/scripts/preview.ts` is one process
 *    per project too. A cross-process lock would buy nothing here.
 *  - A lock FILE would outlive the process that took it. A preview child that
 *    is killed mid-regen (a deploy, an OOM, the pool's own reap) would leave
 *    a stale claim, and there is no endpoint that clears one — every later
 *    regeneration on that project would be refused forever. In-memory state
 *    has exactly the lifetime of the `await` it protects.
 *
 * What it therefore does NOT cover, recorded rather than implied: two
 * PROCESSES writing one project's slot (an orphaned orchestrator grandchild
 * still writing after its preview child died — the known H1 gap — or an
 * operator running the local preview server against a hosted project's
 * directory). Those need the cross-process file lock the manifest service
 * already has, or per-project serialisation of regen jobs.
 */
const claimedSlots = new Map<string, { route: string; holders: number }>();

/**
 * Releases a claim taken by `snapshotRoute`. MUST be called only by the caller
 * that actually took one — a request REFUSED by someone else's claim must not
 * run this, or the refusal hands the slot straight to the next clobberer.
 * Exported for the same reason `runProcess` is: so it can be driven directly.
 */
export function releaseSnapshotClaim(root: string): void {
  const key = resolve(root);
  const claim = claimedSlots.get(key);
  if (claim === undefined) return;
  claim.holders -= 1;
  if (claim.holders <= 0) claimedSlots.delete(key);
}

export function snapshotRoute(root: string, routeSlug: string): void {
  const source = join(root, "src", "pages", routeSlug);
  // Validated BEFORE the existing slot is destroyed (F13 review, finding 4).
  // The old order wiped the slot and only then discovered it had nothing to
  // copy, so `POST /__regen-page {"route":"contact"}` — a VALID slug with no
  // such directory — destroyed whatever legitimate pre-regen copy was pending
  // and left the revert answering "no regeneration to revert". Same
  // destructive-step-ahead-of-validation shape this module was just fixed for;
  // it existed twice more, and this is one of them.
  if (!existsSync(source)) {
    throw new Error(
      `route ${JSON.stringify(routeSlug)} has no page directory; nothing was snapshotted`,
    );
  }
  // The route the owner record WILL name, normalised here so the claim and
  // `route.txt` cannot disagree about what "the same route" means.
  const owner = routeSlug.trim();
  // Refused, not replaced (P1). Deliberately AFTER the page-directory check
  // above: both are non-destructive, and the F13-review finding-4 test reads
  // the message a missing directory produces, so a claim-first order would
  // silently change what that test exercises.
  //
  // The SAME route may re-claim: the editor retries a failed regen against the
  // same section, and the page path snapshots the route it is about to loop
  // over. Counted rather than flagged, so two overlapping same-route runs
  // cannot have the first one's completion free the slot out from under the
  // second.
  const claim = claimedSlots.get(resolve(root));
  if (claim !== undefined && claim.route !== owner) {
    throw new Error(
      `a pending regeneration of route ${JSON.stringify(claim.route)} still holds this ` +
        `project's single snapshot slot; revert or discard that regeneration before ` +
        `regenerating ${JSON.stringify(owner)}. Nothing was changed.`,
    );
  }
  const backup = snapshotDir(root);
  rmSync(backup, { recursive: true, force: true });
  cpSync(source, join(backup, "page"), { recursive: true });
  cpSync(join(root, "manifest.json"), join(backup, "manifest.json"));
  // Written LAST, so a crash mid-copy leaves an unowned slot that the restore
  // below refuses rather than a slot that lies about what it contains.
  // `.trim()`ed on the way IN as well as on the way out, so the two sides of
  // the comparison normalise identically (F13 review, finding 5): a read-side
  // trim alone accepted `"home"` for a snapshot recorded as `" home"`.
  writeFileSync(snapshotOwnerFile(root), owner, "utf8");
  // Claimed only once the slot is genuinely written: a snapshot that threw
  // mid-copy holds nothing worth protecting, and its caller never reaches the
  // `claimed = true` that would release it.
  const key = resolve(root);
  const existing = claimedSlots.get(key);
  claimedSlots.set(key, { route: owner, holders: (existing?.holders ?? 0) + 1 });
}

/**
 * Accepts a section id or a bare route slug: the snapshot is route-wide
 * either way, so `home.hero` and `home` restore exactly the same thing.
 *
 * F13 (found by round 1's live verification, docs/reports/m8-live-verification.md):
 * this used to restore the single slot into WHATEVER route the caller named,
 * deleting that route first. Regenerating `home` and then reverting `about`
 * therefore deleted `about` and replaced its files with `home`'s — cross-route
 * data loss, reachable over the authenticated HTTP surface. The editor never
 * tripped it because it only ever reverts the route it just regenerated; the
 * HTTP API has no such discipline.
 *
 * The ownership check runs BEFORE the `rmSync`, because the old ordering
 * destroyed the target route first and could not have been undone even if the
 * copy had then failed.
 */
export function restoreSnapshot(root: string, sectionOrRoute: string): void {
  const routeSlug = sectionOrRoute.split(".")[0]!;
  const backup = snapshotDir(root);
  if (!existsSync(backup)) throw new Error("no regeneration to revert");

  const ownerFile = snapshotOwnerFile(root);
  const owner = existsSync(ownerFile) ? readFileSync(ownerFile, "utf8").trim() : null;
  if (owner !== routeSlug) {
    // An absent owner file means a snapshot taken before this guard existed.
    // Refused rather than trusted: the whole point is that a slot of unknown
    // provenance is exactly what caused the data loss.
    throw new Error(
      `the pending regeneration snapshot belongs to route ${JSON.stringify(owner)}, ` +
        `not ${JSON.stringify(routeSlug)}; nothing was changed`,
    );
  }

  // Both halves of the snapshot must be present BEFORE the target route is
  // deleted (F13 review, finding 3). Checking only that `.regen-backup/` exists
  // was not enough: with `page/` or `manifest.json` missing, the old order
  // deleted `src/pages/<route>` and then threw on the copy, destroying the
  // route with nothing left to restore it from. The third instance of the same
  // destructive-step-ahead-of-validation shape.
  const page = join(backup, "page");
  const manifestCopy = join(backup, "manifest.json");
  if (!existsSync(page) || !existsSync(manifestCopy)) {
    throw new Error(
      "the pending regeneration snapshot is incomplete (missing page or manifest); nothing was changed",
    );
  }

  rmSync(join(root, "src", "pages", routeSlug), { recursive: true, force: true });
  cpSync(page, join(root, "src", "pages", routeSlug), { recursive: true });
  cpSync(manifestCopy, join(root, "manifest.json"));
  rmSync(backup, { recursive: true, force: true });
  // The slot is gone, so any claim on it is stale by construction — dropped
  // wholesale rather than decremented. A revert IS the consumption the P1
  // refusal tells the user to perform, so it must leave the next route free.
  claimedSlots.delete(resolve(root));
}

/* ---------- real mode: orchestrator CLI (Kitaru replay fork) ---------- */

interface RegenOutcome {
  passed: boolean;
  orphanedOverrides: string[];
  tombstoned: string[];
  failureReport: string;
}

/** A page regen reports the same shape plus which sections it covered, so the
 *  editor can name a partial failure instead of just saying the page failed. */
interface PageRegenOutcome extends RegenOutcome {
  sections: string[];
  perSection: Record<string, boolean>;
}

function realRegen(
  root: string,
  section: string,
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<RegenOutcome> {
  return runRegenCli(root, ["--section", section], instruction, env);
}

function realRegenPage(
  root: string,
  route: string,
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<PageRegenOutcome> {
  return runRegenCli(root, ["--route", route], instruction, env) as Promise<PageRegenOutcome>;
}

function runRegenCli(
  root: string,
  scopeArgs: string[],
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<RegenOutcome> {
  return runCli<RegenOutcome>(
    root,
    ["orchestrator.regenerate", ...scopeArgs],
    instruction,
    "REGEN_RESULT ",
    env,
  );
}

/**
 * Spawns a child process and buffers its output. One place, because every
 * endpoint here spawns the same way.
 *
 * Deliberately WITHOUT `shell: true`. A shell means Node hands the OS one
 * command STRING, built by concatenating argv with spaces and no quoting
 * (Node's own DEP0190 warns about exactly this), so an argument containing a
 * space arrives as several arguments and one containing a quote arrives
 * mangled. Every argument list here ends in `--instruction <free-form user
 * text>`, so with a shell argparse saw five arguments for "make the headline
 * shorter", exited 2, and no endpoint could ever produce a result line. It was
 * also a shell-injection surface fed straight from a text box.
 *
 * Shell-free spawning resolves `uv` on Windows too: libuv searches PATH and
 * PATHEXT, so the bare name finds `uv.exe` (verified on this platform — and
 * the argv-preservation test below is the standing proof).
 */
export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Merged over the inherited environment rather than replacing it: the
    // orchestrator needs PATH, and under the hosted server it needs the
    // ANTHROPIC_API_KEY the preview pool put in this process's environment
    // for its owner. Only the caller's additions are new.
    const env = extraEnv === undefined ? undefined : { ...process.env, ...extraEnv };
    const child = spawn(command, args, env === undefined ? { cwd } : { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // Without this the promise never settles when the executable is missing:
    // "close" does not fire if the process never started.
    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

/**
 * The env addition for a request that may spend money. Absent header → no
 * addition, so the local unauthenticated preview behaves exactly as before
 * and keeps writing to the orchestrator's own shared runlog.
 *
 * Exported (though not part of the plugin's public surface) so it can be
 * tested directly rather than only through a live orchestrator spawn — the
 * header-to-env translation is the actual new logic here; `runProcess`'s
 * merge behavior is already covered on its own.
 */
export function usageEnvFor(req: IncomingMessage): NodeJS.ProcessEnv | undefined {
  const raw = req.headers[USAGE_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!isValidUsageId(value)) return undefined;
  const path = usageLogPathFor(value);
  mkdirSync(dirname(path), { recursive: true });
  return { WEBGEN_USAGE_LOG: path };
}

/** Spawns an orchestrator CLI and reads its single machine-readable result
 *  line. `moduleAndArgs` starts with the module name; --run-id (the project
 *  directory's own name) and --instruction are added here. */
async function runCli<T>(
  root: string,
  moduleAndArgs: string[],
  instruction: string,
  marker: string,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const orchestratorDir = resolve(root, "..", "..", "orchestrator");
  const runId = basename(root);
  const [moduleName, ...args] = moduleAndArgs;
  const { stdout, stderr } = await runProcess(
    "uv",
    ["run", "python", "-m", moduleName!, "--run-id", runId, ...args, "--instruction", instruction],
    orchestratorDir,
    env,
  );
  const resultLine = stdout.split("\n").find((line) => line.startsWith(marker));
  if (resultLine === undefined) {
    throw new Error(`${moduleName!} produced no result:\n${stderr.slice(-2000)}`);
  }
  return JSON.parse(resultLine.slice(marker.length)) as T;
}

interface AddSectionOutcome {
  passed: boolean;
  sectionId: string;
  failureReport: string;
}

function realAddSection(
  root: string,
  route: string,
  archetype: string,
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<AddSectionOutcome> {
  return runCli<AddSectionOutcome>(
    root,
    ["orchestrator.add_section", "--route", route, "--archetype", archetype],
    instruction,
    "ADD_SECTION_RESULT ",
    env,
  );
}

function realEditPrompt(
  root: string,
  route: string,
  instruction: string,
  selection: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<EditAgentResult> {
  const scope = ["orchestrator.edit_agent", "--route", route];
  if (selection !== undefined) scope.push("--selection", selection);
  return runCli<EditAgentResult>(root, scope, instruction, "EDIT_RESULT ", env);
}

/**
 * The archetype catalog for the "+" picker (PRD 4.1), read from the
 * orchestrator's own `ARCHETYPE_CATALOG`.
 *
 * Deliberately NOT duplicated in TypeScript. The catalog decides which
 * archetypes actually have prompt templates, so a copy here would drift the
 * moment one is added and would offer the user a section the generator cannot
 * build. Cached after the first read — it cannot change while the server runs.
 */
let catalogCache: Array<{ name: string; description: string }> | undefined;

async function archetypeCatalog(root: string): Promise<Array<{ name: string; description: string }>> {
  if (catalogCache !== undefined) return catalogCache;
  const raw = await runPython(root, ["-m", "orchestrator.catalog"]);
  const parsed = JSON.parse(raw) as Record<string, string>;
  catalogCache = Object.entries(parsed).map(([name, description]) => ({ name, description }));
  return catalogCache;
}

async function runPython(root: string, args: string[]): Promise<string> {
  const orchestratorDir = resolve(root, "..", "..", "orchestrator");
  const { stdout, stderr } = await runProcess("uv", ["run", "python", ...args], orchestratorDir);
  // Kitaru prints a Windows daemon notice on import, so the payload is the
  // last non-empty line rather than the whole of stdout.
  const line = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!line.startsWith("{")) throw new Error(`python produced no JSON:\n${stderr.slice(-2000)}`);
  return line;
}

/* ---------- mock mode: deterministic transformations for UX e2e ---------- */

async function mockRegen(root: string, section: string, instruction: string): Promise<RegenOutcome> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, MOCK_DELAY_MS));

  if (instruction.includes("FAIL")) {
    return {
      passed: false,
      orphanedOverrides: [],
      tombstoned: [],
      failureReport:
        'gate 3 (tokens-only): Raw hex color "#ff0000" at src/pages/home/sections/Hero.tsx:12. Components must reference semantic tokens. (mock failure)',
    };
  }

  const routeSlug = section.split(".")[0]!;
  // Which files this section owns comes from the MANIFEST, not from a guess:
  // it is the node registry (contract section 2), and the real path reads it
  // too. This was hardcoded to Hero while only home.hero was ever regenerated
  // in mock mode; a page regen loops every section, and rewriting Hero six
  // times would have made the mock look like it worked while touching one file.
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    nodes: Record<string, { component?: string }>;
  };
  const component = manifest.nodes[section]?.component;
  if (component === undefined) throw new Error(`mock regen: "${section}" is not a manifest node`);
  const sectionFile = join(root, "src", "pages", routeSlug, "sections", `${component}.tsx`);
  const mockFile = join(root, "src", "pages", routeSlug, "mock", `${component}.data.ts`);

  // Headline rewrite — stands in for "the model produced new copy". Not every
  // archetype has a `headline`, so a section without one is left alone rather
  // than reported as changed; the transformation is illustrative, and the
  // contract being tested is the response shape and the revert path.
  const shortInstruction = instruction.slice(0, 48).replace(/"/g, "'");
  if (existsSync(mockFile)) {
    writeFileSync(
      mockFile,
      readFileSync(mockFile, "utf8").replace(
        /headline: "[^"]*"/,
        `headline: "Regenerated: ${shortInstruction}"`,
      ),
    );
  }

  const orphaned: string[] = [];
  const tombstoned: string[] = [];
  if (instruction.includes("remove the subheadline")) {
    const subheadlineId = `${section}.subheadline`;
    writeFileSync(
      sectionFile,
      readFileSync(sectionFile, "utf8").replace(
        /^\s*<Text nodeId="[a-z.-]+\.subheadline"[\s\S]*?<\/Text>\r?\n/m,
        "",
      ),
    );
    // mock-only direct manifest edit (product path goes through the service)
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.nodes[subheadlineId] !== undefined) {
      manifest.nodes[subheadlineId].status = "tombstoned";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      tombstoned.push(subheadlineId);
    }
    const overridesPath = join(root, "overrides", `${routeSlug}.overrides.json`);
    if (existsSync(overridesPath)) {
      const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as {
        overrides: Array<{ nodeId: string }>;
      };
      if (overrides.overrides.some((entry) => entry.nodeId === subheadlineId)) {
        orphaned.push(subheadlineId);
      }
    }
  }

  return { passed: true, orphanedOverrides: orphaned, tombstoned, failureReport: "" };
}

/**
 * Mock page regen: loops the route's ACTIVE section roots exactly as the real
 * page path loops them, and aggregates the same way, so the editor's page-scope
 * UX is e2e-testable without model spend. Sections are read from the manifest
 * rather than the filesystem — the manifest is the node registry (contract
 * section 2), and it is what the real path reads too.
 */
async function mockRegenPage(
  root: string,
  route: string,
  instruction: string,
): Promise<PageRegenOutcome> {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    nodes: Record<string, { status: string }>;
  };
  const sections = Object.entries(manifest.nodes)
    .filter(
      ([nodeId, node]) =>
        nodeId.startsWith(`${route}.`) &&
        nodeId.split(".").length === 2 &&
        node.status === "active",
    )
    .map(([nodeId]) => nodeId);
  if (sections.length === 0) throw new Error(`no active sections on route "${route}"`);

  const perSection: Record<string, boolean> = {};
  const orphaned = new Set<string>();
  const tombstoned = new Set<string>();
  const failures: string[] = [];
  for (const section of sections) {
    const result = await mockRegen(root, section, instruction);
    perSection[section] = result.passed;
    for (const id of result.orphanedOverrides) orphaned.add(id);
    for (const id of result.tombstoned) tombstoned.add(id);
    if (!result.passed) failures.push(`${section}: ${result.failureReport}`);
  }
  return {
    passed: failures.length === 0,
    sections,
    perSection,
    orphanedOverrides: [...orphaned].sort(),
    tombstoned: [...tombstoned].sort(),
    failureReport: failures.join("\n"),
  };
}

/**
 * Mock add-a-section: writes a real (if plain) section component, its mock
 * data, its manifest entries and its render line, so the editor's "+" flow is
 * e2e-testable without model spend.
 *
 * It deliberately produces a section that is genuinely selectable and
 * editable — a stub that rendered nothing would let the UX test pass while
 * proving nothing about what the user ends up with. The component is written
 * to satisfy the same contract rules the real templates do: primitives are
 * default imports (contract 4.1), the root carries `data-node-id={nodeId}`,
 * and nodeId comes from a separate NodeProps intersection (contract 5.6).
 */
async function mockAddSection(
  root: string,
  route: string,
  archetype: string,
  instruction: string,
): Promise<AddSectionOutcome> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, MOCK_DELAY_MS));

  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    nodes: Record<string, unknown>;
  };
  const taken = new Set(
    Object.keys(manifest.nodes)
      .filter((nodeId) => nodeId.startsWith(`${route}.`) && nodeId.split(".").length === 2)
      .map((nodeId) => nodeId.split(".")[1]!),
  );
  let slug = archetype;
  for (let n = 2; taken.has(slug); n += 1) slug = `${archetype}-${n}`;

  const component = slug
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
  const sectionId = `${route}.${slug}`;
  const pageDir = join(root, "src", "pages", route);
  const file = `src/pages/${route}/sections/${component}.tsx`;

  writeFileSync(
    join(pageDir, "sections", `${component}.tsx`),
    `import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

export interface ${component}Props {
  heading: string;
  body: string;
}

export default function ${component}({ nodeId, heading, body }: ${component}Props & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-surface) py-(--space-16)">
      <Container>
        <Heading nodeId="${sectionId}.heading" level={2} variant="section">
          {heading}
        </Heading>
        <Text nodeId="${sectionId}.body" variant="body">
          {body}
        </Text>
      </Container>
    </section>
  );
}
`,
  );
  const dataVar = component[0]!.toLowerCase() + component.slice(1) + "Data";
  writeFileSync(
    join(pageDir, "mock", `${component}.data.ts`),
    `import type { ${component}Props } from "../sections/${component}";

export const ${dataVar}: ${component}Props = {
  heading: "Added: ${archetype}",
  body: ${JSON.stringify(instruction.slice(0, 160))},
};
`,
  );

  // mock-only direct manifest edit (the product path goes through the service)
  const entry = (element: string, editable: string[]) => ({
    route: route === "home" ? "/" : `/${route}`,
    file,
    component,
    element,
    editable,
    status: "active",
  });
  manifest.nodes[sectionId] = entry("section", ["style", "layout", "visibility"]);
  manifest.nodes[`${sectionId}.heading`] = entry("Heading", ["text", "style", "layout", "visibility"]);
  manifest.nodes[`${sectionId}.body`] = entry("Text", ["text", "style", "layout", "visibility"]);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const indexPath = join(pageDir, "index.tsx");
  const source = readFileSync(indexPath, "utf8");
  const importLines = source.split("\n").filter((line) => line.startsWith("import "));
  const withImports = source.replace(
    importLines.at(-1)!,
    `${importLines.at(-1)!}\nimport { ${dataVar} } from "./mock/${component}.data";\nimport ${component} from "./sections/${component}";`,
  );
  writeFileSync(
    indexPath,
    withImports.replace(
      "\n    </>",
      `\n      <${component} nodeId="${sectionId}" {...${dataVar}} />\n    </>`,
    ),
  );

  return { passed: true, sectionId, failureReport: "" };
}

/* ---------- plumbing ---------- */

/**
 * Bounded BEFORE accumulation, not after — see max-body-bytes.ts's own
 * comment on why this is the place an unbounded body actually threatens
 * memory (this process, the one serving every other request for the
 * project), not `proxyHttp`, which merely pipes.
 *
 * On exceeding `MAX_BODY_BYTES`, answers 413 and resolves `BODY_TOO_LARGE`
 * directly, rather than throwing/rejecting: every call site above is a bare
 * `.then(...)` with no `.catch`, matching the rest of this file's "never
 * leave an unhandled rejection on an async listener" discipline (see
 * preview-proxy.ts's module comment for the exact shape of bug that
 * habit exists to avoid) — a rejection here would either hang the request
 * or crash the process, neither of which a 413 should do.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // already answered and destroyed below
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        res.statusCode = 413;
        res.end("request body too large");
        resolveBody(BODY_TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return; // 413 already answered above
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolveBody({});
      }
    });
  });
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}
