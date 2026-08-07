// server/src/job-routes.ts
/**
 * Web-triggered generation, and job status (slice 5).
 *
 * `POST /api/generate` is the first route in this codebase that CREATES a
 * project — every prior slice's "no route creates a project" was true only
 * because nothing had triggered generation from the web yet (project-routes.ts's
 * own module comment says so explicitly). It is not a route that creates a
 * USER, and never will be: `server/src/user-cli.ts` stays the only path to an
 * account (spec, threat model; CLAUDE.md's ownership rule for `server/`).
 *
 * Per the resolved job-model design (docs/superpowers/specs/
 * 2026-08-06-job-model-design.md, "Resolved: the project row is created at
 * enqueue"): the project row AND its on-disk directory are created here,
 * synchronously, before the job is ever queued. A failed generation therefore
 * leaves an owned, visible, deletable project rather than an orphaned
 * directory nobody's account points at — the exact problem slice 4a's
 * adoption pass had to clean up once already for acceptance runs made before
 * any of this existed. The consequence, stated in the same design doc and
 * repeated in CLAUDE.md, is binding on the rest of this codebase too: a
 * project can now exist with an empty directory until the `generate` job
 * actually runs.
 *
 * `GET /api/jobs/:id` is deliberately NOT wrapped in `requireProject`: a job
 * belongs to the USER who queued it (`job.user_id`), not to a project, and a
 * generation job's `project_id` survives even if that project is later
 * deleted (`ON DELETE SET NULL`, jobs.ts's own schema comment) — a
 * requireProject-shaped check would have nothing left to compare against for
 * exactly the jobs most worth still being able to look up. The 404 for a
 * foreign or absent job reuses require-project.ts's own `NOT_FOUND` constant
 * verbatim (not a differently-worded copy) so the two responses are
 * byte-identical and a job id is exactly as useless an oracle as a project id
 * already is.
 *
 * `GET /api/jobs?project=<id>` IS project-scoped (a project's own recent
 * activity), so it goes through `requireProject` like any other project-owned
 * resource.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createJob, findJobById, listJobsByProject, type Job } from "./jobs.ts";
import { createProject, resolveProjectDirectory } from "./projects.ts";
import { requireBudget } from "./require-budget.ts";
import { NOT_FOUND, requireProject } from "./require-project.ts";
import { requireSession } from "./require-session.ts";
import { readJsonBody, sendJson, type Route } from "./router.ts";

/** Same shape as project-registry.ts's own private BY_QUERY — this route is not derived from the registry loop the way compiler-routes.ts's are, so it is declared directly here, matching the registry's OWN entry for `GET /api/jobs`. */
const PROJECT_ID_FROM_QUERY = { from: "query" as const, name: "project" };

/** Most recent jobs shown for one project's activity — bounded so a project with a long history is not a full-table read on every poll. */
const PROJECT_JOB_LIST_LIMIT = 50;

const BAD_BRIEF = { error: "a brief is required" };

/**
 * A directory name unique enough that `createProject`'s own UNIQUE
 * constraint on `directory` is never realistically the source of a failure —
 * a v4 UUID, not a counter or a slug derived from the brief (which could
 * collide trivially: two users typing the same one-line brief is the common
 * case this product exists for, not the rare one).
 */
function freshProjectDirectory(): string {
  return `web-${randomUUID()}`;
}

/**
 * The client-facing view of a job — an explicit field list, never the raw
 * row: `request_json` is the internal replay payload (never containing an
 * API key, per jobs.ts's own doc comment, but still not something a status
 * poll needs to echo back), and `result`/`error` are surfaced under their own
 * keys, present only when the job has actually reached that state, matching
 * the design doc's own `{ status, kind, createdAt, finishedAt, result?,
 * error? }` shape (id and projectId added: `GET /api/jobs?project=` returns
 * several of these at once, and a caller needs the id to tell them apart).
 *
 * `result_json` is itself a JSON string (the child's own response body, or
 * `generate`'s own `{stdout}` wrapper) — parsed here so a poller gets a
 * structured object rather than a double-encoded string. A parse failure
 * (defensive only; nothing in this codebase writes a non-JSON resultJson
 * today) falls back to the raw string rather than dropping the field or
 * throwing, since SOME evidence of what finished is better than a 500 on a
 * status poll.
 */
function publicJobView(job: Job): Record<string, unknown> {
  let result: unknown;
  if (job.resultJson !== null) {
    try {
      result = JSON.parse(job.resultJson);
    } catch {
      result = job.resultJson;
    }
  }
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(result !== undefined ? { result } : {}),
    ...(job.error !== null ? { error: job.error } : {}),
  };
}

export function jobRoutes(deps: { db: DatabaseSync; projectsRoot: string }): Route[] {
  const { db, projectsRoot } = deps;

  return [
    {
      method: "POST",
      path: "/api/generate",
      // requireBudget runs BEFORE any body is read or any project/job row is
      // created — an over-cap request is refused with no side effect at all,
      // matching the binding constraint that the spend cap gates enqueue and
      // an over-cap request creates no job row (and, here, no project row
      // either).
      handler: requireSession(db, requireBudget(db, async (req, res, ctx) => {
        let parsed: unknown;
        try {
          parsed = await readJsonBody(req);
        } catch {
          sendJson(res, 400, BAD_BRIEF);
          return;
        }
        const brief =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).brief
            : undefined;
        if (typeof brief !== "string" || brief.trim() === "") {
          sendJson(res, 400, BAD_BRIEF);
          return;
        }
        const trimmedBrief = brief.trim();

        // Project row AND directory, created together, before the job is
        // ever queued — see this module's own top comment for why. The name
        // is the brief itself (truncated): the only user-facing label
        // available at this point, and the same thing adopt.ts falls back to
        // when nothing better exists.
        const project = createProject(db, ctx.user.id, freshProjectDirectory(), trimmedBrief.slice(0, 200));
        mkdirSync(resolveProjectDirectory(projectsRoot, project.directory), { recursive: true });

        const job = createJob(db, {
          userId: ctx.user.id,
          projectId: project.id,
          kind: "generate",
          requestJson: JSON.stringify({ brief: trimmedBrief }),
          now: Date.now(),
        });

        sendJson(res, 202, { jobId: job.id, projectId: project.id });
      })),
    },
    {
      method: "GET",
      path: "/api/jobs/:id",
      handler: requireSession(db, (_req, res, ctx) => {
        const id = ctx.params.id;
        const job = id === undefined || id === "" ? null : findJobById(db, id);
        // One comparison, and the only one — mirrors requireProject's own
        // "a missing row and a foreign row collapse into the same branch."
        if (job === null || job.userId !== ctx.user.id) {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        sendJson(res, 200, publicJobView(job));
      }),
    },
    {
      method: "GET",
      path: "/api/jobs",
      handler: requireProject(db, PROJECT_ID_FROM_QUERY, (_req, res, ctx) => {
        const jobs = listJobsByProject(db, ctx.project.id, PROJECT_JOB_LIST_LIMIT);
        sendJson(res, 200, { jobs: jobs.map(publicJobView) });
      }),
    },
  ];
}
