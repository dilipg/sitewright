// server/src/key-routes.ts
/**
 * The user's own Anthropic key: store, inspect, delete.
 *
 * Every route is session-scoped and acts only on the session's own user — there
 * is no user id in any path, so no route here can be pointed at somebody else's
 * key. The response bodies deliberately carry a fingerprint and nothing more
 * (spec, BYOK requirement 3): a hijacked session should not be able to harvest
 * the credential itself.
 *
 * Note there is no Content-Type check here, unlike POST /api/login, and that is
 * not an oversight: an HTML form can only issue GET and POST, so a PUT or a
 * DELETE cannot be produced by cross-site form submission at all, and a
 * cross-origin fetch using those methods triggers a CORS preflight that fails.
 * The method itself is the guard login had to get from a header.
 */
import type { DatabaseSync } from "node:sqlite";
import { readJsonBody, sendJson, type Route } from "./router.ts";
import { requireSession } from "./require-session.ts";
import { deleteApiKey, getApiKeyFingerprint, setApiKey } from "./api-keys.ts";

/**
 * A shape check, not a validity check — only Anthropic can say whether a key
 * works. The point is to catch a pasted password or a truncated copy before it
 * is encrypted and stored as if it were a credential.
 */
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/** Never quotes the offending value: a mistyped-but-real key must not land in a response. */
const BAD_KEY = { error: "apiKey must be an Anthropic API key (sk-ant-…)" };

export function keyRoutes(deps: { db: DatabaseSync; masterKey: Buffer }): Route[] {
  const { db, masterKey } = deps;

  return [
    {
      method: "PUT",
      path: "/api/key",
      handler: requireSession(db, async (req, res, ctx) => {
        let parsed: unknown;
        try {
          parsed = await readJsonBody(req);
        } catch {
          sendJson(res, 400, BAD_KEY);
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          sendJson(res, 400, BAD_KEY);
          return;
        }
        const apiKey = (parsed as { apiKey?: unknown }).apiKey;
        if (typeof apiKey !== "string" || !KEY_SHAPE.test(apiKey)) {
          sendJson(res, 400, BAD_KEY);
          return;
        }
        const fingerprint = setApiKey(db, masterKey, ctx.user.id, apiKey);
        sendJson(res, 200, { fingerprint });
      }),
    },

    {
      method: "GET",
      path: "/api/key",
      handler: requireSession(db, (_req, res, ctx) => {
        // null, not 404: "no key yet" is a state the settings screen renders.
        sendJson(res, 200, { fingerprint: getApiKeyFingerprint(db, ctx.user.id) });
      }),
    },

    {
      method: "DELETE",
      path: "/api/key",
      handler: requireSession(db, (_req, res, ctx) => {
        deleteApiKey(db, ctx.user.id);
        sendJson(res, 200, { ok: true });
      }),
    },
  ];
}
