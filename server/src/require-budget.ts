// server/src/require-budget.ts
/**
 * The spend cap at the HTTP boundary: refuse to START billable work, in one
 * place (spec, "Spend cap").
 *
 * A decorator on the ctx-taking handler rather than another Handler wrapper,
 * because billable endpoints come in two shapes and both must use the same
 * check:
 *
 *   requireProject(db, source, requireBudget(db, handler))   // project-scoped
 *   requireSession(db, requireBudget(db, handler))           // session-only
 *
 * 402 rather than 429: 429 means "slow down", and clients and proxies retry it
 * with backoff — which is precisely wrong here, since no amount of retrying
 * helps until the window rolls. The body carries the numbers as fields as
 * well as in the sentence, so a UI can render a countdown without parsing
 * prose.
 */
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "./users.ts";
import { sendJson } from "./router.ts";
import { checkSpendCap, describeSpendCap } from "./spend-cap.ts";

type CtxHandler<C> = (req: IncomingMessage, res: ServerResponse, ctx: C) => Promise<void> | void;

export function requireBudget<C extends { user: User }>(
  db: DatabaseSync,
  inner: CtxHandler<C>,
): CtxHandler<C> {
  return async (req, res, ctx) => {
    // ctx.user is re-read from the database by resolveSession on every
    // request, so a cap an operator raised (or lowered) thirty seconds ago is
    // already in hand — no cache to invalidate, no restart to wait for.
    const status = checkSpendCap(db, ctx.user, Date.now());
    if (!status.allowed) {
      sendJson(res, 402, {
        error: describeSpendCap(status),
        capUsd: status.capUsd,
        spentUsd: status.spentUsd,
        resetAt: status.resetAt,
      });
      return;
    }
    await inner(req, res, ctx);
  };
}
