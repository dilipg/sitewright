// server/src/require-session.ts
/**
 * Turns a session cookie into a user, or answers 401 — in one place.
 *
 * A wrapper rather than a convention, because the wrapper makes the choice
 * visible at the route table: a route is either wrapped or it is plainly
 * public. Slice 4's ownership check wraps this in turn, so the two decisions
 * compose instead of being repeated per handler.
 */
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "./users.ts";
import { type Handler, parseCookies, sendJson } from "./router.ts";
import { resolveSession, SESSION_COOKIE } from "./sessions.ts";

export type AuthedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { url: URL; params: Record<string, string>; user: User },
) => Promise<void> | void;

export function requireSession(db: DatabaseSync, handler: AuthedHandler): Handler {
  return async (req, res, ctx) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    // resolveSession re-reads the user and rejects a disabled one, so
    // revocation reaches an already-authenticated request, not just login.
    const user = sid === undefined ? null : resolveSession(db, sid);
    if (user === null) {
      sendJson(res, 401, { error: "not authenticated" });
      return;
    }
    await handler(req, res, { ...ctx, user });
  };
}
