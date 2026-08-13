import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_KEY_PROVIDER,
  describeKeyStatus,
  describeStoredKey,
  EMPTY_KEY_MESSAGE,
  GEMINI_SPEND_WARNING,
  loadStoredKey,
  NO_KEY_STATUS,
  removeStoredKey,
  submitKey,
  toKeyState,
  UNKNOWN_KEY_STATUS,
} from "./KeySettings";
import { describeSpend } from "../lib/spend";
import { SessionExpiredError } from "../lib/session-fetch";
// Vite's own `?raw` suffix rather than `node:fs` — this workspace's tsconfig has
// no node types, and adding `@types/node` for one test would be a new
// dependency. Same precedent as `App.test.ts` and `ProjectPicker.test.ts`.
import keySettingsSource from "./KeySettings.tsx?raw";

/**
 * `.test.ts`, not `.test.tsx` — `LoginScreen.test.ts` and `ProjectPicker.test.ts`
 * set the precedent, and the reason is measured rather than stylistic:
 * `vitest.config.ts` once included `src/**\/*.test.ts` ONLY, so a `.test.tsx`
 * file was silently skipped. A test file that exists, reads as coverage and never
 * runs is the one failure mode "every test must fail if the behaviour it names is
 * removed" cannot detect, because a test that does not execute cannot fail.
 *
 * Nothing here mounts a component: this workspace has no React testing library
 * and may not add one ("no new runtime dependencies"). That constraint is exactly
 * why `submitKey`, `loadStoredKey`, `removeStoredKey`, `toKeyState` and the
 * describe-* helpers are exported separately from the form — the halves of this
 * screen that can be wrong in a way that matters (what leaves the browser, what
 * comes back, and what is rendered about a key that does not exist) are the
 * halves testable without a DOM. The rest is asserted as source text, following
 * `ProjectPicker.test.ts`'s own component half.
 */

/** A real Anthropic key's shape, and unmistakable in an assertion failure. The
 *  last four characters are `aaaa`, which is what makes the "fingerprint came
 *  from the SERVER" test below discriminating. */
const SECRET = "sk-ant-aaaaaaaaaaaaaaaaaaaaaa";

/** Records every call the function under test makes. */
function recordingFetch(respond: (url: string, init: RequestInit) => Response): {
  calls: Array<{ url: string; method: string; init: RequestInit }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; method: string; init: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", init: init ?? {} });
    return respond(String(url), init ?? {});
  };
  return { calls, fetchImpl };
}

/* ------------------------------------------------------------------ *
 * submitKey: the key goes out and never comes back
 * ------------------------------------------------------------------ */

describe("submitKey: the submitted key never comes back out", () => {
  it("never renders the key it just submitted, only the fingerprint the server returned", async () => {
    // THE requirement of this whole screen. The key is a bearer credential for
    // someone else's account: it may be sent, and nothing more. A result that
    // carried it would be one `JSON.stringify` (a log line, an error report, a
    // dev-tools state dump) away from disclosure.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ fingerprint: "aaaa" }), { status: 200 });
    const result = await submitKey(SECRET, "anthropic", { fetchImpl });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("renders the fingerprint the SERVER returned, never one computed from the key it holds", async () => {
    // The discriminating half of the test above, and it is not a nicety.
    // `apiKey.slice(-4)` would produce the same four characters for a real key
    // and pass every assertion about the rendered string — while making the
    // browser a second place that derives a value from key material. The server
    // side of that property is structural (`getApiKeyFingerprint` takes no master
    // key, so a display-only caller cannot decrypt); this is the client side of
    // it. The server's answer here deliberately DISAGREES with the key's own
    // tail, which a locally-computed fingerprint cannot survive.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ fingerprint: "9999", provider: "anthropic" }), { status: 200 });
    const result = await submitKey(SECRET, "anthropic", { fetchImpl });
    expect(result.fingerprint).toBe("9999");
  });

  it("PUTs {apiKey, provider} as JSON to /api/key", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ fingerprint: "aaaa", provider: "anthropic" }), { status: 200 }),
    );
    await submitKey(SECRET, "anthropic", { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/key");
    expect(calls[0]!.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      apiKey: SECRET,
      provider: "anthropic",
    });
  });

  it("declares the provider the user chose, so a Gemini key is never stored as an Anthropic one", async () => {
    // The declared provider decides which environment variable `agent-env.ts`
    // injects. A mismatch surfaces as a provider 401 AFTER the job is queued and
    // the money committed, which is why the server refuses a shape/provider
    // disagreement — and why this request must carry the selection rather than
    // letting it default.
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ fingerprint: "2Fk8", provider: "gemini" }), { status: 200 }),
    );
    const result = await submitKey("AQ.abcdefghijklmnopqrstuvwxyz012Fk8", "gemini", { fetchImpl });
    expect(JSON.parse(String(calls[0]!.init.body)).provider).toBe("gemini");
    expect(result.provider).toBe("gemini");
  });

  it("trims the pasted key, because the server's shape regexes are anchored", async () => {
    // A pasted credential routinely carries a trailing newline. Anchored regexes
    // (`/^sk-ant-[A-Za-z0-9_-]{20,}$/`) refuse it, so an untrimmed paste is a 400
    // that reads as "this key is wrong" for a key that is perfectly good.
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ fingerprint: "aaaa" }), { status: 200 }),
    );
    await submitKey(`  ${SECRET}\n`, "anthropic", { fetchImpl });
    expect(JSON.parse(String(calls[0]!.init.body)).apiKey).toBe(SECRET);
  });

  it("refuses an empty field without calling the server, with the exact guard message", async () => {
    // A substring assertion is not a discriminating assertion — `toThrow(/key/i)`
    // still passes when the message is perturbed by appending to it — and this
    // wording is the whole user-visible outcome of pressing Save with nothing
    // pasted.
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    for (const blank of ["", " ", "\t", "\n", "  \n\t  "]) {
      await expect(submitKey(blank, "anthropic", { fetchImpl })).rejects.toThrow(
        new Error(EMPTY_KEY_MESSAGE),
      );
    }
    expect(called).toBe(false);
  });
});

describe("submitKey: a refusal", () => {
  it("surfaces the server's 400 verbatim and exactly, so the user is told which field was wrong", async () => {
    // `PUT /api/key` words one 400 per provider precisely so a user who picked
    // the wrong selector is told what the field wanted rather than guessing.
    // Asserted as an exact string, not a substring: an "improvement" that appends
    // a hint or rewords it would still pass a `/Gemini/` match while losing the
    // distinction the server drew.
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ error: "apiKey must be a Google AI Studio API key (AQ.… or AIza…)" }),
        { status: 400 },
      );
    await expect(submitKey(SECRET, "gemini", { fetchImpl })).rejects.toThrow(
      new Error("apiKey must be a Google AI Studio API key (AQ.… or AIza…)"),
    );
  });

  it("never puts the submitted key into the error it throws", async () => {
    // The server does not quote the offending value; nor may this. An error
    // message is the single most likely thing to be logged, screenshotted or
    // pasted into an issue.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "apiKey must be an Anthropic API key (sk-ant-…)" }), {
        status: 400,
      });
    const error = await submitKey(SECRET, "anthropic", { fetchImpl }).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("falls back to naming the status when a refusal carries no message at all", async () => {
    const fetchImpl = async () => new Response("<html>502 bad gateway</html>", { status: 502 });
    const error = await submitKey(SECRET, "anthropic", { fetchImpl }).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain("502");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("a 401 is an expired session, NOT a rejected key", async () => {
    // Reporting "your key was refused" for a session that merely lapsed sends the
    // user to replace a credential that was never read — the same lie
    // `interrupted` exists to prevent, arrived at from another direction.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "not authenticated" }), { status: 401 });
    const error = await submitKey(SECRET, "anthropic", { fetchImpl }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SessionExpiredError);
  });
});

/* ------------------------------------------------------------------ *
 * toKeyState: the no-key state
 * ------------------------------------------------------------------ */

describe("toKeyState: the no-key state is a BODY, not an absent one", () => {
  it("reads no-key from {fingerprint: null, provider: null}, not from a bare null body", async () => {
    // `GET /api/key` answers 200 with both fields null — "you have no key" is a
    // state this screen renders, not an error and not a 404. A reader that tested
    // the body itself for null would see every no-key response as garbage.
    expect(toKeyState({ fingerprint: null, provider: null })).toEqual({ kind: "absent" });
  });

  it("the no-key state names NO provider, because the user has not chosen one", async () => {
    // `provider` is deliberately null rather than "anthropic" in that response, so
    // that this form cannot present a choice the user never made. Both halves are
    // asserted: the state carries no provider anywhere in it, and the line
    // rendered from it names neither provider.
    const absent = toKeyState({ fingerprint: null, provider: null });
    expect(JSON.stringify(absent)).not.toMatch(/anthropic|gemini/i);
    expect(describeStoredKey(absent)).toBeUndefined();
    expect(describeKeyStatus(absent)).toBe(NO_KEY_STATUS);
    expect(describeKeyStatus(absent)).not.toMatch(/anthropic|gemini/i);
  });

  it("carries a stored key's provider and fingerprint, and masks the fingerprint", async () => {
    const state = toKeyState({ fingerprint: "2Fk8", provider: "gemini" });
    expect(state).toEqual({ kind: "stored", fingerprint: "2Fk8", provider: "gemini" });
    expect(describeStoredKey(state)).toBe("Google Gemini · ••••2Fk8");
  });

  it("does not invent a provider for a stored key the server did not name one for", async () => {
    // A fingerprint labelled with the WRONG provider is worse than one labelled
    // with none: the pair travels together because a key sent to the wrong
    // provider fails 401 after the money is committed.
    const state = toKeyState({ fingerprint: "aaaa" });
    expect(state).toEqual({ kind: "stored", fingerprint: "aaaa", provider: undefined });
    expect(describeStoredKey(state)).toBe("••••aaaa");
    expect(describeStoredKey(state)).not.toMatch(/anthropic|gemini/i);
  });

  it("an unrecognisable payload is UNKNOWN — never 'no key', in either direction", async () => {
    // Claiming "no key" for a user who has one pushes a needless form at them;
    // claiming one exists lets them press a $1.74 button that refuses. Neither is
    // available to guess at, so the third state is its own.
    for (const payload of [null, undefined, "nope", 7, [], { fingerprint: 7 }, { fingerprint: "" }]) {
      expect(toKeyState(payload), JSON.stringify(payload)).toEqual({ kind: "unknown" });
    }
    expect(describeKeyStatus({ kind: "unknown" })).toBe(UNKNOWN_KEY_STATUS);
  });
});

/* ------------------------------------------------------------------ *
 * loadStoredKey / removeStoredKey
 * ------------------------------------------------------------------ */

describe("loadStoredKey", () => {
  it("GETs /api/key with no-store, because a cached answer shows a key that was just removed", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ fingerprint: "aaaa", provider: "anthropic" }), { status: 200 }),
    );
    const state = await loadStoredKey({ fetchImpl });
    expect(calls[0]!.url).toBe("/api/key");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.init.cache).toBe("no-store");
    expect(state).toEqual({ kind: "stored", fingerprint: "aaaa", provider: "anthropic" });
  });

  it("a 401 is an expired session, distinguishable from a failed probe", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "not authenticated" }), { status: 401 });
    const error = await loadStoredKey({ fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionExpiredError);
  });

  it("throws on any other non-2xx BEFORE parsing the body as a key state", async () => {
    // A 500's `{error}` parses as JSON perfectly well, and `{fingerprint:
    // undefined}` would read as "no key" — telling a user with a stored key that
    // they have none.
    const fetchImpl = async () => new Response(JSON.stringify({ error: "internal" }), { status: 500 });
    const error = await loadStoredKey({ fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
    expect((error as Error).message).toContain("500");
  });
});

describe("removeStoredKey", () => {
  it("DELETEs /api/key", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await removeStoredKey({ fetchImpl });
    expect(calls[0]!.url).toBe("/api/key");
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("throws rather than reporting a key as gone while it is still stored and still usable", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "internal" }), { status: 500 });
    await expect(removeStoredKey({ fetchImpl })).rejects.toThrow(/500/);
  });

  it("a 401 is an expired session", async () => {
    const fetchImpl = async () => new Response("{}", { status: 401 });
    const error = await removeStoredKey({ fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionExpiredError);
  });
});

/* ------------------------------------------------------------------ *
 * describeSpend: the accepted risk this plan ships
 * ------------------------------------------------------------------ */

describe("describeSpend: spend that admits when it is a floor", () => {
  it("says the spend figure is a FLOOR when any event was unpriced", () => {
    // THE required mitigation. `pricing.py` has no Gemini rates, so a Gemini run
    // writes `cost_usd = NULL` and `checkSpendCap`'s total omits it — the cap does
    // not bound that spend. Shipping both providers was accepted on condition
    // that this is visible, so a figure presented as exact is the failure.
    expect(describeSpend({ spendCapUsd: 10, spentUsd24h: 1.74, unpricedEvents: 3 })).toMatch(
      /at least/i,
    );
    expect(describeSpend({ spendCapUsd: 10, spentUsd24h: 1.74, unpricedEvents: 0 })).not.toMatch(
      /at least/i,
    );
  });

  it("words the floor caveat exactly, and names how many calls could not be priced", () => {
    // The discriminating half: `/at least/i` alone still passes for a caveat that
    // says "at least" and then explains nothing, or that drops the count. The
    // count is what tells a tester whether this is one stray call or their whole
    // run.
    expect(describeSpend({ spendCapUsd: 10, spentUsd24h: 1.74, unpricedEvents: 3 })).toBe(
      "$8.26 of your $10.00 daily budget is left ($1.74 spent in the last 24 hours). At least — 3 call(s) used a model with no published rate, so the real spend is higher.",
    );
  });

  it("renders nothing at all rather than $NaN when a figure is missing", () => {
    // An absent cap is not a cap of zero, and an unpriced-events count alone is
    // not a spend figure.
    expect(describeSpend(undefined)).toBeUndefined();
    expect(describeSpend({})).toBeUndefined();
    expect(describeSpend({ unpricedEvents: 3 })).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The component half, asserted as source text
 * ------------------------------------------------------------------ */

describe("KeySettings.tsx: the key never lingers, and nothing else is shown", () => {
  it("takes the key in a password field, never a text one", () => {
    const field = keySettingsSource.slice(keySettingsSource.indexOf('data-testid="key-input"'));
    expect(field).toContain('type="password"');
    expect(field).toContain('autoComplete="off"');
  });

  it("clears the key from state on EVERY path out of a submit, including a failure", () => {
    // "Never retained in state after submit" is the constraint, and the only
    // structural way to honour it is a `finally` — a clear on the success path
    // alone leaves a rejected key sitting in this app's memory for as long as the
    // screen is open, which is exactly the case where a user walks away.
    const submit = keySettingsSource.slice(
      keySettingsSource.indexOf("async function onSubmit("),
      keySettingsSource.indexOf("async function onRemove("),
    );
    expect(submit).toContain("} finally {");
    const finallyIndex = submit.indexOf("} finally {");
    expect(submit.indexOf('setKeyDraft("")')).toBeGreaterThan(finallyIndex);
  });

  it("never hands the key, or anything derived from it, to a console", () => {
    // The whole file, not one function: a `console.debug` added anywhere while
    // chasing a 400 is how a credential reaches a log.
    expect(keySettingsSource).not.toMatch(/console\.\w+\([^)]*(keyDraft|apiKey|trimmed)/);
  });

  /* NOTE, recorded rather than silently dropped: a source-text ban on a
     client-side `slice(-4)` was written here first and REMOVED. Its regex matched
     this module's own header comment — the paragraph explaining why deriving a
     fingerprint locally is wrong — so the assertion banned its own explanation,
     which is how an explanation gets deleted to make a test pass (the exact trap
     `ProjectPicker.test.ts` records for a blanket `/\bdirectory\b/`). The
     behaviour is covered discriminatingly and without prose sensitivity by
     "renders the fingerprint the SERVER returned, never one computed from the key
     it holds", whose stubbed server answers `9999` for a key ending `aaaa`. */

  it("carries no sign-up and no password-reset affordance", () => {
    // Account creation exists only in the operator CLI — invite-only is
    // structural. This screen is reached only by an authenticated user, so either
    // link would be a dead end pointing at a route that must not exist.
    expect(keySettingsSource).not.toMatch(/sign ?up|password reset|forgot your password/i);
  });

  it("shows spend through describeSpend, so the floor caveat cannot be bypassed here", () => {
    expect(keySettingsSource).toContain("describeSpend(spend)");
    expect(keySettingsSource).toContain('data-testid="key-spend"');
  });

  it("states the Gemini spend risk in as many words, beside the provider choice", () => {
    // Asserted exactly: the accepted risk was accepted on condition that it is
    // visible, and a reworded warning that drops "floor" or drops the fact that
    // the budget does not bound it is the failure this pins.
    expect(GEMINI_SPEND_WARNING).toBe(
      "On a Google Gemini key, spend is a FLOOR rather than a total: those models have no published " +
        "rates here, so their calls are recorded with no cost and your daily budget does not bound them. " +
        "An Anthropic key is priced exactly.",
    );
    expect(keySettingsSource).toContain("{GEMINI_SPEND_WARNING}");
    // ...and it sits with the provider radios rather than three screens away.
    expect(keySettingsSource.indexOf('data-testid="key-providers"')).toBeLessThan(
      keySettingsSource.indexOf('data-testid="key-gemini-warning"'),
    );
  });

  it("offers a way out even with no key stored, because editing an existing site needs none", () => {
    expect(keySettingsSource).toContain('data-testid="key-close"');
  });

  it("defaults the SELECTOR to the server's own default, and nothing else", () => {
    // The form's initial radio position is not a claim about what is stored; the
    // status line is, and it names no provider (asserted above).
    expect(DEFAULT_API_KEY_PROVIDER).toBe("anthropic");
  });
});
