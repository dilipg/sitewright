// server/src/auth-routes.ts
/**
 * The only routes an unauthenticated caller can reach.
 *
 * Note what is absent: there is no route that CREATES a user. Invite-only is
 * structural (spec, threat model) — account creation exists solely in the
 * operator CLI, so no amount of guessing at the HTTP surface produces an
 * account.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Route } from "./router.ts";
import { parseCookies, readJsonBody, sendJson, serializeCookie } from "./router.ts";
import { findUserByEmail } from "./users.ts";
import { generatePassword, hashPassword, verifyPassword } from "./passwords.ts";
import { createSession, resolveSession, revokeSession, SESSION_TTL_MS } from "./sessions.ts";

export const SESSION_COOKIE = "sid";

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

export function authRoutes(deps: { db: DatabaseSync; secureCookies: boolean }): Route[] {
  const { db, secureCookies } = deps;

  return [
    {
      method: "POST",
      path: "/api/login",
      handler: async (req, res) => {
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
      handler: (req, res) => {
        const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const user = sid === undefined ? null : resolveSession(db, sid);
        if (user === null) {
          sendJson(res, 401, { error: "not authenticated" });
          return;
        }
        // Explicit field list, never the whole row: `user` carries the password
        // hash, and a spread would ship it to the client.
        sendJson(res, 200, { id: user.id, email: user.email, spendCapUsd: user.spendCapUsd });
      },
    },
  ];
}
