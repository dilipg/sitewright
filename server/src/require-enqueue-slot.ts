// server/src/require-enqueue-slot.ts
/**
 * The per-user enqueue-time bound on BILLABLE work — replaces the deleted
 * `compiler-routes.ts`'s `requireBillableSlot`, closing the gap the task-3
 * review found: enqueuing is a single fast INSERT, so the OLD in-memory
 * reservation (`PreviewPool.reserveBillableSlot`/`releaseBillableSlot`,
 * held only across the handler's own `await`) was released again before the
 * request even finished, bounding nothing. What it actually bounded — "spend
 * lands in `usage_event` only at ingest (after a run finishes), so N billable
 * requests in flight at once for one user all evaluate `checkSpendCap`
 * against the same pre-run total" (the deleted guard's own doc comment,
 * `git show 995e851:server/src/compiler-routes.ts`) — still needs bounding,
 * and needs it MORE now: a queued job can sit for a while before a worker
 * claims it, so the pre-run-total window this guards is now longer, not
 * shorter, than it was when the old guard ran synchronously inline.
 *
 * This bound is a live COUNT of `queued` + `running` BILLABLE job rows
 * (`jobs.ts`'s `countActiveBillableJobsForUser`), not an in-memory
 * reservation — so it needs no separate "release" call at all: a slot frees
 * itself the moment `finishJob` moves a row to a terminal status, which
 * `countActiveBillableJobsForUser`'s own next call simply no longer counts.
 *
 * 429, not 402: retrying genuinely helps here once an in-flight job
 * finishes, unlike the spend cap's 402 where no amount of retrying helps
 * until the window rolls — the exact distinction the deleted guard's own doc
 * comment drew, and the one `require-budget.ts`'s 402 draws in the other
 * direction.
 *
 * Deliberately NOT gated on `entry.billable` internally — every call site
 * (`compiler-routes.ts`'s four billable `/__*` entries, `job-routes.ts`'s
 * `POST /api/generate`) only ever wraps a billable path with this in the
 * first place (see each call site's own comment for why), so this module
 * does not need to re-derive "is this specific request billable" — it only
 * ever runs for one.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { countActiveBillableJobsForUser, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER } from "./jobs.ts";
import { sendJson } from "./router.ts";
import type { User } from "./users.ts";

type CtxHandler<C> = (req: IncomingMessage, res: ServerResponse, ctx: C) => Promise<void> | void;

export function requireEnqueueSlot<C extends { user: User }>(
  db: DatabaseSync,
  inner: CtxHandler<C>,
): CtxHandler<C> {
  return async (req, res, ctx) => {
    const active = countActiveBillableJobsForUser(db, ctx.user.id);
    if (active >= MAX_ENQUEUED_BILLABLE_JOBS_PER_USER) {
      sendJson(res, 429, {
        error: `at most ${String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER)} billable jobs may be queued or running at once for this account; wait for one to finish and retry`,
      });
      return;
    }
    await inner(req, res, ctx);
  };
}
