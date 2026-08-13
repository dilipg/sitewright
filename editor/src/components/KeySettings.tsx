/**
 * The first caller `PUT /api/key`, `GET /api/key` and `DELETE /api/key` have
 * ever had from a browser.
 *
 * All three routes have existed since slice 3 and nothing in `editor/src`
 * referenced any of them, so the README told a tester to run two curl commands
 * — and the failure for skipping that step was DEFERRED: with no key stored,
 * pressing Generate used to answer 202, run an eleven-minute progress screen,
 * and land a `failed` job. An enqueue-time pre-check now refuses immediately
 * (`job-routes.ts`'s `NO_API_KEY`, whose message this screen is what makes
 * true), but until this screen existed there was nowhere to put a key.
 *
 * HOSTED MODE ONLY, like `LoginScreen` and `ProjectPicker`: the local,
 * unauthenticated preview server (`compiler/scripts/preview.ts`) has no session,
 * no key table and no `/api/*` routes at all, and local mode must keep behaving
 * exactly as it does today.
 *
 * WHAT THIS MODULE REFUSES TO DO, and why each is structural rather than
 * conventional:
 *
 * - **The submitted key is never echoed, never kept in state past the submit,
 *   and never logged.** Only the fingerprint the SERVER returned is rendered.
 *   `getApiKeyFingerprint` takes no master key precisely so that a display-only
 *   caller is incapable of decrypting; computing `apiKey.slice(-4)` in the
 *   browser would undermine that from the other side, so `submitKey` reads the
 *   fingerprint off the response and nowhere else.
 * - **The no-key state names NO provider.** `GET /api/key` answers
 *   `{fingerprint: null, provider: null}` — deliberately not defaulting to
 *   `"anthropic"` — so that this form cannot present a choice the user never
 *   made. `toKeyState` preserves that: its `absent` variant has no provider
 *   field to render.
 * - **No sign-up link and no password-reset link.** Account creation exists only
 *   in `server/src/user-cli.ts`; invite-only is a property of the code, not an
 *   unimplemented feature. This screen is reached only by an already
 *   authenticated user, so a link here would be doubly wrong.
 *
 * FIVE FUNCTIONS ARE EXPORTED SEPARATELY FROM THE COMPONENT, for the reason
 * `submitLogin`, `startGeneration` and `session-fetch.ts` already established:
 * this workspace has no React testing library and may not add one ("no new
 * runtime dependencies"), so anything living inside the component body is
 * untestable by construction. What is pulled out is exactly what can be wrong in
 * a way that matters — the request each action makes, what comes back out of a
 * submit, and how the three key states are told apart.
 */
import { useState } from "react";
import { keyUrl } from "../lib/backend";
import { SessionExpiredError } from "../lib/session-fetch";
import { describeSpend, type SpendSummary } from "../lib/spend";

/**
 * Mirrors `server/src/api-keys.ts`'s `API_KEY_PROVIDERS` exactly, and this is the
 * one place that list is duplicated on the editor side — `editor/` has no
 * dependency on `server/` (they are separate composition roots that share no
 * types across the process boundary), the same reason `backend.ts` re-declares
 * `PROJECT_QUERY_PARAM`.
 *
 * A third provider added on the server without being added here is NOT a silent
 * failure in the dangerous direction: this form could not offer it, but
 * `toKeyState` renders an unrecognised stored provider as no provider at all
 * rather than mislabelling it (see `describeKeyStatus`).
 */
export const API_KEY_PROVIDERS = ["anthropic", "gemini"] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

/**
 * The FORM's initial selection, and nothing more. It mirrors the server's own
 * `DEFAULT_API_KEY_PROVIDER` (an absent `provider` in a `PUT` body means
 * anthropic), so the control agrees with what the request would do anyway.
 *
 * It is deliberately NOT used to describe a STORED key: a radio button needs an
 * initial position, but a status line that named a provider for a key that does
 * not exist would be claiming a choice the user never made.
 */
export const DEFAULT_API_KEY_PROVIDER: ApiKeyProvider = "anthropic";

export function isApiKeyProvider(value: unknown): value is ApiKeyProvider {
  return typeof value === "string" && (API_KEY_PROVIDERS as readonly string[]).includes(value);
}

/** Human labels for the radio group and the stored-key line. */
export const PROVIDER_LABELS: Readonly<Record<ApiKeyProvider, string>> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

/**
 * What the user is told the field wants. Deliberately a HINT and not a
 * validation: the shapes are enforced by `server/src/api-keys.ts`'s
 * `API_KEY_SHAPES`, and re-implementing either regex here would give this app a
 * second, drifting opinion about what a valid key looks like — which would show
 * up as the browser refusing a key the server would have accepted.
 */
const PROVIDER_HINTS: Readonly<Record<ApiKeyProvider, string>> = {
  anthropic: "Starts with sk-ant-",
  gemini: "Starts with AQ. or AIza",
};

/** Where a tester with no key goes to get one. */
const PROVIDER_CONSOLES: Readonly<Record<ApiKeyProvider, string>> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
};

/**
 * THREE STATES, not two, and the third is the point.
 *
 * `absent` and `stored` are what the server reports. `unknown` is what this app
 * knows after a failed or unrecognisable probe — the same honesty a job's
 * `interrupted` status exists for. Collapsing it into `absent` would tell a user
 * who HAS a key that they have none (and push a needless form at them);
 * collapsing it into `stored` would let them press a $1.74 button that refuses.
 * Neither is available to guess at, so it is its own state.
 *
 * `provider` is `undefined` rather than defaulted on a stored key whose provider
 * the server did not name (or named as something this build does not know): a
 * fingerprint labelled with the wrong provider is worse than one labelled with
 * none, because the whole reason the pair travels together is that a key sent to
 * the wrong provider fails 401 after the money is committed.
 */
export type KeyState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "stored";
      readonly fingerprint: string;
      readonly provider: ApiKeyProvider | undefined;
    }
  | { readonly kind: "unknown" };

/** What a successful `PUT` reports back: never the key, only what may be shown. */
export interface SavedKey {
  readonly fingerprint: string;
  readonly provider: ApiKeyProvider;
}

export interface KeyRequestOptions {
  /** Test seam only; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The exact text for pressing Save with nothing pasted.
 *
 * Exported so a test can assert it exactly rather than by substring: a substring
 * assertion is not a discriminating assertion (`toThrow(/key/i)` still passes
 * when the message is perturbed by appending), and the wording is the whole
 * user-visible outcome here. The server would also refuse an empty string with
 * its own 400, so this guard exists to name the fix rather than the status — and
 * to not spend a round trip saying "you typed nothing".
 */
export const EMPTY_KEY_MESSAGE = "Paste an API key before saving.";

/**
 * Stated on the screen where a user CHOOSES gemini, because choosing it is what
 * makes the choice matter.
 *
 * THE ACCEPTED RISK, in the user's own words: `pricing.py` has no Gemini rates,
 * so a Gemini run writes `cost_usd = NULL` for every call and the spend cap
 * cannot see it. The figure beside the Generate button stays a floor for as long
 * as a Gemini key is in use, and the cap does not bound the bill. This was
 * accepted deliberately in exchange for shipping both providers, on condition
 * that it is visible — so it is stated up front here, and `describeSpend` says
 * "at least" for as long as any unpriced call is inside the 24-hour window.
 */
export const GEMINI_SPEND_WARNING =
  "On a Google Gemini key, spend is a FLOOR rather than a total: those models have no published " +
  "rates here, so their calls are recorded with no cost and your daily budget does not bound them. " +
  "An Anthropic key is priced exactly.";

/** Stated wherever a submit could have failed, because the field is cleared on
 *  every attempt — the key must not sit in this app's state waiting to be
 *  retried, so a rejected key has to be pasted again. */
export const KEY_FIELD_CLEARED_HINT =
  "The field is cleared after every attempt, so nothing keeps your key — paste it again to retry.";

/* ------------------------------------------------------------------ *
 * Reading the stored state
 * ------------------------------------------------------------------ */

/** Wrapped rather than aliased: a bare `const f = fetch; f(...)` invokes the
 *  global with the wrong receiver and throws "Illegal invocation" in a browser
 *  (the same note `submitLogin` and `startGeneration` carry). */
function resolveFetch(options: KeyRequestOptions): typeof fetch {
  return options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
}

/**
 * `GET /api/key`'s body -> which of the three states this is.
 *
 * THE NO-KEY BODY IS `{fingerprint: null, provider: null}`, NOT a bare `null`
 * and not a 404 — the route answers 200 either way, because "you have no key" is
 * a state this screen renders rather than an error. So the discriminator is
 * `fingerprint === null`, and a reader that tested the body itself for null would
 * see every no-key response as an unrecognisable payload.
 *
 * Reads the two fields off an untyped record rather than casting the payload to a
 * trusted interface: this parses a network response, and an `as` cast asserts a
 * shape instead of checking one — the precise mistake `jobs.ts`'s poll loop and
 * `refreshManifest` both had to be fixed for.
 */
export function toKeyState(payload: unknown): KeyState {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "unknown" };
  }
  const raw = payload as { fingerprint?: unknown; provider?: unknown };
  if (raw.fingerprint === null || raw.fingerprint === undefined) return { kind: "absent" };
  // A present-but-unusable fingerprint (a number, an empty string) is not "no
  // key" — something is stored and this build cannot describe it.
  if (typeof raw.fingerprint !== "string" || raw.fingerprint === "") return { kind: "unknown" };
  return {
    kind: "stored",
    fingerprint: raw.fingerprint,
    provider: isApiKeyProvider(raw.provider) ? raw.provider : undefined,
  };
}

/**
 * The stored key as `Provider · ••••fingerprint`, or `undefined` when nothing is
 * stored.
 *
 * The bullets are not decoration: they are what makes the last four characters
 * read as the TAIL of a hidden value rather than as the whole of a short one.
 */
export function describeStoredKey(state: KeyState): string | undefined {
  if (state.kind !== "stored") return undefined;
  const masked = `••••${state.fingerprint}`;
  return state.provider === undefined ? masked : `${PROVIDER_LABELS[state.provider]} · ${masked}`;
}

/** The absent state's own words. Names no provider — see this module's header. */
export const NO_KEY_STATUS = "No API key stored";
/** The unknown state's own words: it claims neither, in either direction. */
export const UNKNOWN_KEY_STATUS = "API key status unknown";

/**
 * One line for any of the three states, for surfaces that always show something
 * (the project picker's header). Never invents a provider for a key that does
 * not exist, and never asserts a key exists when the probe failed.
 */
export function describeKeyStatus(state: KeyState): string {
  return describeStoredKey(state) ?? (state.kind === "absent" ? NO_KEY_STATUS : UNKNOWN_KEY_STATUS);
}

/**
 * Reads which key is stored, if any. Never returns the key, because the endpoint
 * cannot return it: `GET /api/key` is served by `getApiKeyFingerprint`, which
 * takes no master key at all.
 *
 * `cache: "no-store"` is load-bearing rather than habitual: a cached answer would
 * show a key the user has just removed, or hide one they have just saved, and the
 * whole purpose of this screen is to tell them which is true.
 */
export async function loadStoredKey(options: KeyRequestOptions = {}): Promise<KeyState> {
  const response = await resolveFetch(options)(keyUrl(), {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) throw new SessionExpiredError();
  if (!response.ok) {
    // Thrown BEFORE `.json()`, so an error body is never read as the resource —
    // and the caller turns this into `unknown`, not into "no key".
    throw new Error(
      `Could not check whether an API key is stored (HTTP ${String(response.status)}).`,
    );
  }
  return toKeyState(await response.json());
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * A refusal's own message, verbatim.
 *
 * `PUT /api/key` words its three 400s itself and each names a different fix: the
 * key does not match the selected provider's shape (one message per provider, so
 * a user who picked the wrong selector is told what the field wanted), or the
 * provider is not one this server supports. Rewording them here would either
 * flatten that distinction or invent advice the server did not give.
 *
 * NEVER includes the submitted value, and neither does the server: a mistyped-
 * but-real key must not land in a response, a rendered error or a console.
 */
async function refusalMessage(response: Response, verb: string): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A proxy error page, an empty body, an upstream that died mid-response: not
    // JSON, and not a reason to throw a second error over the first.
    body = undefined;
  }
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === "string" && error !== "") return error;
  return `${verb} (HTTP ${String(response.status)}).`;
}

/**
 * Stores the key and returns ONLY what may be shown.
 *
 * THE RETURN VALUE CONTAINS NO KEY MATERIAL beyond the fingerprint the server
 * itself chose to disclose, and that is the whole point of the function existing
 * separately from the form. Two rules make it hold:
 *
 *  1. The fingerprint is read off the RESPONSE. Deriving it locally
 *     (`apiKey.slice(-4)`) would produce the same four characters and pass any
 *     test that only checks the rendered string — while making the browser a
 *     second place that computes something from key material, which is exactly
 *     the property `getApiKeyFingerprint`'s missing master-key parameter exists
 *     to guarantee from the server side.
 *  2. Nothing else from the request is copied into it. The caller clears its own
 *     field the moment this resolves or rejects.
 *
 * The provider falls back to the DECLARED one when the server does not echo it.
 * That is not the same as inventing a choice: the user selected it, and the
 * server accepted it. It is `GET /api/key`'s null-provider state that must never
 * be defaulted, because there the user chose nothing.
 *
 * The key is TRIMMED on the way out. A pasted credential routinely carries a
 * trailing newline, and the server's shape regexes are anchored — so an
 * untrimmed paste is a 400 that reads as "this key is wrong" for a key that is
 * perfectly good.
 *
 * `Content-Type: application/json` is required by `readJsonBody`. Note that
 * `PUT /api/key` deliberately has no content-type CSRF check of its own (an HTML
 * form can only issue GET and POST, so a cross-site form cannot produce a PUT at
 * all) — this header is here because the body is JSON, not as a CSRF defence.
 */
export async function submitKey(
  apiKey: string,
  provider: ApiKeyProvider,
  options: KeyRequestOptions = {},
): Promise<SavedKey> {
  const trimmed = apiKey.trim();
  // Before any request: a round trip to be told the field is empty is worse than
  // not making the call, and this way the message can name the fix.
  if (trimmed === "") throw new Error(EMPTY_KEY_MESSAGE);

  const response = await resolveFetch(options)(keyUrl(), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ apiKey: trimmed, provider }),
  });

  if (response.status === 401) throw new SessionExpiredError();
  if (!response.ok) throw new Error(await refusalMessage(response, "Could not save the API key"));

  const body = (await response.json()) as { fingerprint?: unknown; provider?: unknown };
  return {
    // An empty fingerprint renders as bullets alone rather than as invented
    // characters. The key IS stored at this point (the server said 200), so
    // throwing here would send the user to re-enter a credential that landed.
    fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : "",
    provider: isApiKeyProvider(body.provider) ? body.provider : provider,
  };
}

/**
 * Deletes the stored key. `DELETE /api/key` is silent when there is nothing to
 * delete (revoking twice is not an error), so a 200 means "no key is stored"
 * rather than "a key was found and removed".
 *
 * A failure THROWS rather than being swallowed: reporting the key as gone while
 * it is still stored and still usable is the one lie this action can tell.
 *
 * NAMES THE STATUS RATHER THAN QUOTING THE BODY, unlike `submitKey` — the same
 * asymmetry `ProjectPicker` documents between `startGeneration` and
 * `loadProjects`, and for the same reason. `PUT /api/key` words three different
 * 400s itself, each naming a different fix, so quoting it is strictly better than
 * paraphrasing. `DELETE /api/key` has no such vocabulary: it answers 200 or 401
 * and nothing else, so a non-2xx here is a 500 or a 502 from the editor's own Vite
 * proxy, where the body says `internal` (telling a user nothing) and the status
 * says everything. Measured, not assumed: quoting the body here produced the
 * user-facing message "internal".
 */
export async function removeStoredKey(options: KeyRequestOptions = {}): Promise<void> {
  const response = await resolveFetch(options)(keyUrl(), {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (response.status === 401) throw new SessionExpiredError();
  if (!response.ok) {
    throw new Error(
      `Could not remove the API key (HTTP ${String(response.status)}) — it may still be stored.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export interface KeySettingsProps {
  /** The state the caller has already probed. This component holds no copy of
   *  its own: one source of truth, reported back through `onSaved`. */
  readonly stored: KeyState;
  /** Shown here as well as on the picker, because this is where the provider
   *  choice that decides whether the figure is exact is made. */
  readonly spend?: SpendSummary;
  /** The stored key CHANGED — saved or removed. Named for the brief's own
   *  interface; a removal is as much a change to what is saved as a save is. */
  readonly onSaved: (stored: KeyState) => void;
  /** A 401 from any of the three requests: its own state, never a rejected key. */
  readonly onSessionExpired: () => void;
  /** Leave for the project list. Present even with no key stored, deliberately:
   *  editing an existing site costs nothing and needs no key, so trapping a
   *  user here would deny them work they can do. */
  readonly onClose: () => void;
}

export default function KeySettings({
  stored,
  spend,
  onSaved,
  onSessionExpired,
  onClose,
}: KeySettingsProps) {
  // The pasted key, for as long as the user is typing it and not one render
  // longer: cleared in the submit's `finally`, on success and on failure alike.
  const [keyDraft, setKeyDraft] = useState("");
  const [provider, setProvider] = useState<ApiKeyProvider>(
    // A replace defaults to the provider already in use — a choice this user did
    // make. With nothing stored, the form's own default (see
    // DEFAULT_API_KEY_PROVIDER) is all there is.
    stored.kind === "stored" ? (stored.provider ?? DEFAULT_API_KEY_PROVIDER) : DEFAULT_API_KEY_PROVIDER,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [replacing, setReplacing] = useState(false);

  const storedLabel = describeStoredKey(stored);
  // The form is the whole screen unless a key is already stored and the user has
  // not asked to replace it.
  const showForm = storedLabel === undefined || replacing;
  const spendLine = describeSpend(spend);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await submitKey(keyDraft, provider);
      onSaved({ kind: "stored", fingerprint: saved.fingerprint, provider: saved.provider });
      setReplacing(false);
    } catch (caught) {
      if (caught instanceof SessionExpiredError) {
        onSessionExpired();
        return;
      }
      // Verbatim, whatever it is — see `refusalMessage`. Never the key: neither
      // the server's messages nor this app's own quote the submitted value.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      // THE KEY LEAVES THIS APP HERE, on every path including the session-expired
      // early return above (a `finally` still runs). Nothing keeps it: not for a
      // retry, not for a "did you mean" hint, not for a second attempt under the
      // other provider.
      setKeyDraft("");
      setBusy(false);
    }
  }

  async function onRemove() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await removeStoredKey();
      onSaved({ kind: "absent" });
      setReplacing(false);
    } catch (caught) {
      if (caught instanceof SessionExpiredError) {
        onSessionExpired();
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setKeyDraft("");
      setBusy(false);
    }
  }

  return (
    <div className="key-settings" data-testid="key-settings">
      <header className="key-header">
        <h1>Your API key</h1>
        <p className="key-intro">
          Every generation, regeneration and prompt-edit runs on your own key, billed to your own
          provider account. It is stored encrypted; only the last four characters are ever shown
          back to you, and you can remove it at any time.
        </p>
      </header>

      <section className="picker-panel" aria-labelledby="key-stored-heading">
        <h2 id="key-stored-heading">Stored key</h2>
        {storedLabel !== undefined ? (
          <p className="key-stored" data-testid="key-stored">
            {storedLabel}
          </p>
        ) : stored.kind === "absent" ? (
          /* Names NO provider: `GET /api/key` reports `provider: null` with no
             key precisely so this line cannot claim a choice the user never
             made. */
          <p className="picker-muted" data-testid="key-absent">
            {NO_KEY_STATUS} for this account yet. Paste one below — a generation cannot run without
            it.
          </p>
        ) : (
          <p className="picker-error" data-testid="key-unknown" role="alert">
            {UNKNOWN_KEY_STATUS} — the check did not complete, so this screen cannot say whether one
            is stored. Saving a key below is safe either way: it replaces whatever is there.
          </p>
        )}

        {storedLabel !== undefined && (
          <div className="key-actions">
            <button
              type="button"
              className="progress-secondary"
              data-testid="key-replace"
              disabled={busy}
              onClick={() => setReplacing(true)}
            >
              Replace
            </button>
            <button
              type="button"
              className="progress-secondary"
              data-testid="key-remove"
              disabled={busy}
              onClick={() => void onRemove()}
            >
              Remove
            </button>
          </div>
        )}
      </section>

      {showForm && (
        <section className="picker-panel" aria-labelledby="key-form-heading">
          <h2 id="key-form-heading">{storedLabel === undefined ? "Save a key" : "Replace the key"}</h2>
          <form className="key-form" onSubmit={(event) => void onSubmit(event)}>
            <fieldset className="key-providers" data-testid="key-providers">
              <legend>Provider</legend>
              {API_KEY_PROVIDERS.map((candidate) => (
                <label key={candidate} className="key-provider-option">
                  <input
                    type="radio"
                    name="key-provider"
                    data-testid={`key-provider-${candidate}`}
                    value={candidate}
                    checked={provider === candidate}
                    disabled={busy}
                    onChange={() => setProvider(candidate)}
                  />
                  <span className="key-provider-name">{PROVIDER_LABELS[candidate]}</span>
                  <span className="key-provider-hint">
                    {PROVIDER_HINTS[candidate]} —{" "}
                    <a href={PROVIDER_CONSOLES[candidate]} target="_blank" rel="noreferrer noopener">
                      get a key
                    </a>
                  </span>
                </label>
              ))}
            </fieldset>

            <label htmlFor="key-input">API key</label>
            <input
              id="key-input"
              data-testid="key-input"
              // A password field, and never a text one: this value is a bearer
              // credential for someone else's account, and a tester pastes it on
              // a shared screen.
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyDraft}
              disabled={busy}
              onChange={(event) => setKeyDraft(event.target.value)}
              // App.tsx registers a window-level keydown handler (Esc, Ctrl+Z,
              // Ctrl+Y) whose effect is still mounted while this screen renders —
              // without this, Ctrl+Z in the field would be swallowed by the
              // canvas's undo. Same guard LoginScreen's inputs carry.
              onKeyDown={(event) => event.stopPropagation()}
            />

            {error !== undefined && (
              <p className="picker-error" data-testid="key-error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="picker-generate" data-testid="key-save" disabled={busy}>
              {busy ? "Saving…" : "Save key"}
            </button>

            <p className="key-footnote" data-testid="key-cleared-hint">
              {KEY_FIELD_CLEARED_HINT}
            </p>
          </form>
        </section>
      )}

      <section className="picker-panel" aria-labelledby="key-spend-heading">
        <h2 id="key-spend-heading">What it will cost you</h2>
        {/* The same sentence, from the same function, as the picker's budget
            line: `describeSpend` says "At least" for as long as any call in the
            window could not be priced, so neither surface can present a floor as
            an exact figure. */}
        {spendLine !== undefined && (
          <p className="picker-budget" data-testid="key-spend">
            {spendLine}
          </p>
        )}
        {/* The accepted risk, beside the choice that triggers it. */}
        <p className="key-warning" data-testid="key-gemini-warning">
          {GEMINI_SPEND_WARNING}
        </p>
      </section>

      <button type="button" className="progress-secondary" data-testid="key-close" onClick={onClose}>
        Your sites
      </button>
    </div>
  );
}
