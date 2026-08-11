// server/src/key-routes.ts
/**
 * The user's own model-provider key: store, inspect, delete.
 *
 * Every route is session-scoped and acts only on the session's own user — there
 * is no user id in any path, so no route here can be pointed at somebody else's
 * key. The response bodies deliberately carry a fingerprint and a PROVIDER NAME
 * and nothing more (spec, BYOK requirement 3): a hijacked session should not be
 * able to harvest the credential itself. The provider is not a secret — it is
 * one of two public constants — and the settings form needs it to render which
 * key is stored, but the key material never appears in any response, including
 * a 400 rejecting it.
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
import {
  API_KEY_SHAPES,
  DEFAULT_API_KEY_PROVIDER,
  deleteApiKey,
  getApiKeyFingerprint,
  isApiKeyProvider,
  setApiKey,
  type ApiKeyProvider,
} from "./api-keys.ts";

/**
 * The boundary is the STRICT half of the two-layer shape rule. Here a key must
 * positively match the declared provider's own pattern (`API_KEY_SHAPES`), so a
 * typo, a pasted password or a truncated copy is refused with a legible 400
 * before anything is encrypted. `setApiKey` then enforces the complementary
 * rule — that the shape does not name a DIFFERENT provider — which is the one
 * that has to hold for callers that never come through HTTP.
 *
 * Never quotes the offending value: a mistyped-but-real key must not land in a
 * response, a browser console or an error tracker. One message per provider, so
 * a user who picked the wrong selector is told what the field wanted rather
 * than being left to guess.
 */
const BAD_KEY: Readonly<Record<ApiKeyProvider, { error: string }>> = {
  anthropic: { error: "apiKey must be an Anthropic API key (sk-ant-…)" },
  gemini: { error: "apiKey must be a Google AI Studio API key (AQ.… or AIza…)" },
};

/**
 * A body whose `provider` is a string nobody supports. Distinct from `BAD_KEY`
 * on purpose: the key may be perfectly good, and telling the user their key is
 * malformed when the selector is what is wrong sends them to change the wrong
 * field. Lists the accepted values from the union itself, so a third provider
 * cannot make this message stale.
 */
const BAD_PROVIDER = {
  error: "provider must be one of: anthropic, gemini",
};

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
          sendJson(res, 400, BAD_KEY[DEFAULT_API_KEY_PROVIDER]);
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          sendJson(res, 400, BAD_KEY[DEFAULT_API_KEY_PROVIDER]);
          return;
        }
        // An ABSENT provider means anthropic, which keeps every pre-existing
        // `{apiKey}` caller (the README's own curl, slice 3's tests) working
        // unchanged. An absent field is not the same as a wrong one: a
        // PRESENT but unsupported value is refused rather than defaulted,
        // because silently storing a key under a provider the user did not
        // choose is the mismatch this task exists to prevent.
        const declared = (parsed as { provider?: unknown }).provider;
        if (declared !== undefined && !isApiKeyProvider(declared)) {
          sendJson(res, 400, BAD_PROVIDER);
          return;
        }
        const provider: ApiKeyProvider = declared ?? DEFAULT_API_KEY_PROVIDER;
        const apiKey = (parsed as { apiKey?: unknown }).apiKey;
        if (typeof apiKey !== "string" || !API_KEY_SHAPES[provider].test(apiKey)) {
          sendJson(res, 400, BAD_KEY[provider]);
          return;
        }
        // Cannot throw ProviderMismatchError: the strict check above already
        // proved the key matches THIS provider, and the two patterns cannot
        // both match one string.
        const fingerprint = setApiKey(db, masterKey, ctx.user.id, apiKey, provider);
        // The provider travels back with the fingerprint so the settings form
        // can render "gemini · ••••XY9z" from one response. Both fields or
        // neither: a fingerprint with no provider is what a UI renders as the
        // wrong provider's key.
        sendJson(res, 200, { fingerprint, provider });
      }),
    },

    {
      method: "GET",
      path: "/api/key",
      handler: requireSession(db, (_req, res, ctx) => {
        // null, not 404: "no key yet" is a state the settings screen renders.
        // BOTH fields are null in that state — never a default provider for a
        // key that does not exist, which would let the form claim a choice the
        // user never made.
        const stored = getApiKeyFingerprint(db, ctx.user.id);
        sendJson(res, 200, {
          fingerprint: stored === null ? null : stored.fingerprint,
          provider: stored === null ? null : stored.provider,
        });
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
