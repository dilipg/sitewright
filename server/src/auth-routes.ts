// server/src/auth-routes.ts
/**
 * The only routes an unauthenticated caller can reach.
 *
 * Note what is absent: there is no route that CREATES a user. Invite-only is
 * structural (spec, threat model) — account creation exists solely in the
 * operator CLI, so no amount of guessing at the HTTP surface produces an
 * account.
 */
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Route } from "./router.ts";
import { parseCookies, readJsonBody, sendJson, serializeCookie } from "./router.ts";
import { findUserByEmail } from "./users.ts";
import { generatePassword, hashPassword, verifyPassword } from "./passwords.ts";
import { createSession, revokeSession, SESSION_COOKIE, SESSION_TTL_MS } from "./sessions.ts";
import { requireSession } from "./require-session.ts";
import { checkSpendCap } from "./spend-cap.ts";

// Re-exported so existing importers (require-session.test.ts,
// key-routes.test.ts, and anything else that reaches for "the login cookie's
// name") keep working unchanged. The canonical definition lives in
// sessions.ts — see the comment there for why.
export { SESSION_COOKIE };

/** One message for every failure mode, so the form is not an enumeration oracle. */
const INVALID = { error: "invalid email or password" };

/**
 * Same shape as INVALID, reused for every way the request body itself is
 * unusable: wrong types, missing fields, bytes that aren't JSON at all, or a
 * body over the size limit. `readJsonBody` throws for the last two — see the
 * try/catch below — and this endpoint is reachable by anyone unauthenticated,
 * so a hostile body must produce a 400, never an unhandled 500.
 */
const BAD_REQUEST = { error: "email and password are required" };

/**
 * A real argon2id hash of a random string, computed once, to compare against
 * when no user matches. Lazily built and cached: hashing is deliberately slow,
 * so doing it per request would be a denial-of-service vector rather than a
 * defence.
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(generatePassword());
  return dummyHashPromise;
}

/**
 * `SameSite=Lax` protects requests that SEND the session cookie; login SETS
 * one, which Lax does not cover. A cross-site HTML form can only submit
 * `application/x-www-form-urlencoded`, `multipart/form-data`, or
 * `text/plain` — never `application/json` — so requiring this content type
 * closes the classic CSRF bypass: an attacker's page silently POSTs
 * credentials into the victim's browser, logging it into the attacker's
 * account. A cross-origin `fetch` that sets this content type also triggers
 * a CORS preflight, which fails here since no CORS headers exist.
 *
 * Parsed properly rather than compared verbatim: `application/json;
 * charset=utf-8` is a legitimate value a real client may send, and matching
 * must be case-insensitive (`Content-Type` values are case-insensitive per
 * RFC 9110).
 */
function hasJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return false;
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

export function authRoutes(deps: { db: DatabaseSync; secureCookies: boolean }): Route[] {
  const { db, secureCookies } = deps;

  return [
    {
      method: "POST",
      path: "/api/login",
      handler: async (req, res) => {
        if (!hasJsonContentType(req)) {
          sendJson(res, 400, BAD_REQUEST);
          return;
        }
        let parsed: unknown;
        try {
          // readJsonBody throws both on invalid JSON and on a body over the
          // 1 MB cap (router.ts's MAX_BODY_BYTES) — either is a malformed
          // request, not a server failure, so both land on the same 400.
          parsed = await readJsonBody(req);
        } catch {
          sendJson(res, 400, BAD_REQUEST);
          return;
        }
        // JSON.parse("null") and JSON.parse("[]") both succeed, so
        // readJsonBody's own try/catch above does not catch either — `parsed`
        // can be `null` or an array here. Without this guard, `body.email` on
        // a null body throws and escapes to the router's catch as an
        // unhandled 500; a hostile body must never produce one.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          sendJson(res, 400, BAD_REQUEST);
          return;
        }
        const body = parsed as { email?: unknown; password?: unknown };
        if (typeof body.email !== "string" || typeof body.password !== "string") {
          sendJson(res, 400, BAD_REQUEST);
          return;
        }

        const user = findUserByEmail(db, body.email);
        // Verify against a REAL hash even when the user is missing, so an
        // unknown email costs the same time as a wrong password. A hardcoded
        // literal would not do: verifyPassword catches malformed input and
        // returns false immediately, which is exactly the timing difference
        // this is meant to remove.
        const hash = user?.passwordHash ?? (await dummyHash());
        const ok = await verifyPassword(hash, body.password);
        if (user === null || user.disabledAt !== null || !ok) {
          sendJson(res, 401, INVALID);
          return;
        }

        const session = createSession(db, user.id);
        res.setHeader(
          "Set-Cookie",
          serializeCookie(SESSION_COOKIE, session.id, {
            maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
            secure: secureCookies,
          }),
        );
        sendJson(res, 200, { id: user.id, email: user.email });
      },
    },

    {
      method: "POST",
      path: "/api/logout",
      handler: (req, res) => {
        const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (sid !== undefined) revokeSession(db, sid);
        res.setHeader(
          "Set-Cookie",
          serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: secureCookies }),
        );
        // Always 200: logging out when already logged out is not an error.
        sendJson(res, 200, { ok: true });
      },
    },

    {
      method: "GET",
      path: "/api/me",
      // Was a hand-rolled parseCookies -> resolveSession -> 401 sequence,
      // identical to requireSession's — two implementations of the same
      // check meant a future change to one could silently miss the other.
      handler: requireSession(db, (_req, res, ctx) => {
        // The cap alone is not actionable — a user cannot tell they are near
        // it until a request is refused. Same computation the gate uses, so
        // the two can never disagree about the number shown and the number
        // enforced.
        const status = checkSpendCap(db, ctx.user, Date.now());
        // Explicit field list, never the whole row: `user` carries the
        // password hash, and a spread would ship it to the client.
        sendJson(res, 200, {
          id: ctx.user.id,
          email: ctx.user.email,
          spendCapUsd: ctx.user.spendCapUsd,
          spentUsd24h: status.spentUsd,
          resetAt: status.resetAt,
          // Both other surfaces that show this number already call it a
          // floor when this is non-zero — describeSpendCap's "at least $X
          // spent (N call(s) used a model with no published rate)" and the
          // `usage` CLI's identical caveat. Without this field, this is the
          // one surface a user actually sees that presented spentUsd24h as
          // exact: under the gemini escape hatch a user could see
          // `spentUsd24h: 0` while genuinely burning budget on unpriced
          // calls, with nothing telling them the number understates reality.
          unpricedEvents: status.unpricedEvents,
        });
      }),
    },
  ];
}
