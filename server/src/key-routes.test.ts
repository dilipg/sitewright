// server/src/key-routes.test.ts
/**
 * The response body is the security boundary here. A hijacked session must be
 * able to learn that a key exists, and its last four characters, and nothing
 * more (spec, BYOK requirement 3).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createSession } from "./sessions.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";
import { createRequestListener } from "./router.ts";
import { getApiKeyPlaintext } from "./api-keys.ts";
import { keyRoutes } from "./key-routes.ts";

const masterKey = randomBytes(32);
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-XY9z";
/** `AIza` + exactly 35 characters (39 total) — a real Google standard key's verified shape. */
const GEMINI_KEY = "AIzaSyIsNotARealKeyJustTheRightShape123";
/** The format AI Studio issues TODAY. Length deliberately unpinned; see api-keys.ts. */
const GEMINI_AUTH_KEY = "AQ.AbNotARealAuthKeyJustTheRightShape";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "server-keyroutes-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const user = createUser(db, "a@example.com", "hash");
  const session = createSession(db, user.id);
  const listener = createRequestListener(keyRoutes({ db, masterKey }));

  // `body` is JSON-stringified as usual. `raw`, when given, bypasses
  // JSON.stringify entirely and is sent as-is — the only way to get non-JSON
  // bytes (or an oversized body) onto the wire for a test. Same idiom as
  // auth-routes.test.ts's call() helper.
  async function call(method: string, path: string, body?: unknown, cookie?: string, raw?: Buffer) {
    const chunks: string[] = [];
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; res.headersSent = true; return res; },
      setHeader() {},
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const payload = raw !== undefined ? [raw] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign((async function* () { yield* payload; })(), {
      method,
      url: path,
      headers: {
        host: "localhost",
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
    });
    await listener(req as never, res as never);
    const text = chunks.join("");
    return { status, json: text === "" ? undefined : JSON.parse(text), raw: text };
  }
  return { db, user, cookie: `${SESSION_COOKIE}=${session.id}`, call };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("PUT /api/key", () => {
  it("stores the key and returns only its fingerprint", async () => {
    const { call, cookie, db, user } = harness();
    const result = await call("PUT", "/api/key", { apiKey: KEY }, cookie);
    expect(result.status).toBe(200);
    // The response must not carry the key even incidentally. Asserted on the
    // raw text FIRST and independently of the parsed-JSON check below: every
    // response here comes from a single sendJson, so raw is always
    // JSON.stringify(json), which means a strict toEqual on json would catch
    // a leak before this line ever ran. If toEqual is ever loosened to
    // toMatchObject/objectContaining, this is the assertion that still holds.
    expect(result.raw).not.toContain(KEY);
    // BOTH fields, exactly: a fingerprint with no provider is what a UI
    // renders as the wrong provider's key, and a provider with no fingerprint
    // leaves the user unable to tell which key is stored.
    expect(result.json).toEqual({ fingerprint: "XY9z", provider: "anthropic" });
    // ...but it really was stored.
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toEqual({ apiKey: KEY, provider: "anthropic" });
  });

  it("401s without a session and stores nothing", async () => {
    const { call, db, user } = harness();
    expect((await call("PUT", "/api/key", { apiKey: KEY })).status).toBe(401);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBeNull();
  });

  it("rejects a value that is not an Anthropic key", async () => {
    const { call, cookie } = harness();
    expect((await call("PUT", "/api/key", { apiKey: "hunter2" }, cookie)).status).toBe(400);
  });

  it("rejects a missing or non-string apiKey", async () => {
    const { call, cookie } = harness();
    expect((await call("PUT", "/api/key", {}, cookie)).status).toBe(400);
    expect((await call("PUT", "/api/key", { apiKey: 42 }, cookie)).status).toBe(400);
  });

  it("never echoes the rejected value back", async () => {
    // A 400 that quotes the input puts a mistyped-but-real key in the response,
    // and from there into a browser console or an error-tracking service.
    const { call, cookie } = harness();
    const result = await call("PUT", "/api/key", { apiKey: "sk-ant-short" }, cookie);
    expect(result.raw).not.toContain("sk-ant-short");
  });

  // JSON.parse("null") succeeds, so readJsonBody's own try/catch never sees it
  // as invalid JSON — the parsed value is `null`, and `(parsed as
  // {apiKey?}).apiKey` on it would throw unless there's a type guard before
  // that access. That throw would escape to the router's catch-all as an
  // unhandled 500. Same pattern as auth-routes.test.ts's equivalent test,
  // which exists because POST /api/login genuinely shipped a 500 here before
  // this guard was added.
  it("rejects a null JSON body with 400, not 500", async () => {
    const { call, cookie } = harness();
    const result = await call("PUT", "/api/key", null, cookie);
    expect(result.status).toBe(400);
  });

  // Guards against the handler's guard being narrowed to `parsed !== null`
  // (which an array would still pass, since typeof [] === "object"). An array
  // has no .apiKey property, so accessing it is merely undefined rather than
  // throwing — but an array is not a legitimate request body and must still
  // be rejected as malformed, not accepted as if apiKey were missing.
  it("rejects a JSON array body with 400", async () => {
    const { call, cookie } = harness();
    const result = await call("PUT", "/api/key", [], cookie);
    expect(result.status).toBe(400);
  });

  // Well-formed JSON with wrong types is not the only "malformed body".
  // readJsonBody calls JSON.parse, which throws on bytes that aren't JSON at
  // all — an unguarded throw here would escape to createRequestListener's
  // catch, which is a 500.
  it("rejects a body that is not valid JSON with 400, not 500", async () => {
    const { call, cookie } = harness();
    const result = await call("PUT", "/api/key", undefined, cookie, Buffer.from("not json at all{{{"));
    expect(result.status).toBe(400);
  });

  it("rejects an over-limit body with 400, not 500", async () => {
    const { call, cookie } = harness();
    const result = await call("PUT", "/api/key", undefined, cookie, Buffer.alloc(1_500_000, "a"));
    expect(result.status).toBe(400);
  });

  it("replaces an existing key", async () => {
    const { call, cookie, db, user } = harness();
    await call("PUT", "/api/key", { apiKey: KEY }, cookie);
    await call("PUT", "/api/key", { apiKey: "sk-ant-api03-second-value-here-AAAA" }, cookie);
    expect(getApiKeyPlaintext(db, masterKey, user.id))
      .toEqual({ apiKey: "sk-ant-api03-second-value-here-AAAA", provider: "anthropic" });
  });
});

describe("PUT /api/key, provider choice", () => {
  it("stores a Gemini key when the body declares gemini", async () => {
    const { call, cookie, db, user } = harness();
    const result = await call("PUT", "/api/key", { apiKey: GEMINI_KEY, provider: "gemini" }, cookie);
    expect(result.status).toBe(200);
    expect(result.raw).not.toContain(GEMINI_KEY);
    expect(result.json).toEqual({ fingerprint: "e123", provider: "gemini" });
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toEqual({ apiKey: GEMINI_KEY, provider: "gemini" });
  });

  it("accepts the AQ. auth-key format AI Studio issues today", async () => {
    // The format check that actually decides whether a new tester can onboard:
    // AI Studio no longer issues AIza keys at all.
    const { call, cookie, db, user } = harness();
    const result = await call("PUT", "/api/key", { apiKey: GEMINI_AUTH_KEY, provider: "gemini" }, cookie);
    expect(result.status).toBe(200);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toEqual({ apiKey: GEMINI_AUTH_KEY, provider: "gemini" });
  });

  it("treats an absent provider as anthropic, so a pre-existing {apiKey} caller still works", async () => {
    // The README's own curl, and slice 3's every client, send no provider.
    const { call, cookie } = harness();
    expect((await call("PUT", "/api/key", { apiKey: KEY }, cookie)).json)
      .toEqual({ fingerprint: "XY9z", provider: "anthropic" });
  });

  it("rejects an Anthropic key declared as gemini, and a Gemini key declared as anthropic", async () => {
    // The mismatch this whole task exists to prevent: stored the wrong way
    // round, it fails 401 only AFTER a job is queued and the money committed.
    const { call, cookie, db, user } = harness();
    expect((await call("PUT", "/api/key", { apiKey: KEY, provider: "gemini" }, cookie)).status).toBe(400);
    expect((await call("PUT", "/api/key", { apiKey: GEMINI_KEY, provider: "anthropic" }, cookie)).status).toBe(400);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBeNull();
  });

  it("says WHICH field is wrong, exactly, rather than blaming the key for a bad provider", async () => {
    // Exact strings, not substrings: a user told "your key is malformed" when
    // the selector is what is wrong goes and changes the wrong field. Both
    // messages reach the browser verbatim.
    const { call, cookie } = harness();
    const badProvider = await call("PUT", "/api/key", { apiKey: KEY, provider: "openai" }, cookie);
    expect(badProvider.status).toBe(400);
    expect(badProvider.json).toEqual({ error: "provider must be one of: anthropic, gemini" });

    const badAnthropic = await call("PUT", "/api/key", { apiKey: "hunter2" }, cookie);
    expect(badAnthropic.json).toEqual({ error: "apiKey must be an Anthropic API key (sk-ant-…)" });

    const badGemini = await call("PUT", "/api/key", { apiKey: "hunter2", provider: "gemini" }, cookie);
    expect(badGemini.json).toEqual({ error: "apiKey must be a Google AI Studio API key (AQ.… or AIza…)" });
  });

  it("rejects a non-string provider without storing anything", async () => {
    const { call, cookie, db, user } = harness();
    for (const provider of [42, null, ["gemini"], { name: "gemini" }, ""]) {
      const result = await call("PUT", "/api/key", { apiKey: KEY, provider }, cookie);
      expect(result.status).toBe(400);
      expect(result.json).toEqual({ error: "provider must be one of: anthropic, gemini" });
    }
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBeNull();
  });

  it("never echoes a rejected key back, whichever provider was declared", async () => {
    const { call, cookie } = harness();
    const gemini = await call("PUT", "/api/key", { apiKey: "AIzaMistypedButRealLooking", provider: "gemini" }, cookie);
    expect(gemini.raw).not.toContain("AIzaMistypedButRealLooking");
    const mismatched = await call("PUT", "/api/key", { apiKey: GEMINI_KEY, provider: "anthropic" }, cookie);
    expect(mismatched.raw).not.toContain(GEMINI_KEY);
  });

  it("switches provider on replace, leaving no trace of the old one", async () => {
    const { call, cookie, db, user } = harness();
    await call("PUT", "/api/key", { apiKey: KEY }, cookie);
    await call("PUT", "/api/key", { apiKey: GEMINI_KEY, provider: "gemini" }, cookie);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toEqual({ apiKey: GEMINI_KEY, provider: "gemini" });
    expect((await call("GET", "/api/key", undefined, cookie)).json)
      .toEqual({ fingerprint: "e123", provider: "gemini" });
  });
});

describe("GET /api/key", () => {
  it("reports the fingerprint when a key is stored", async () => {
    const { call, cookie } = harness();
    await call("PUT", "/api/key", { apiKey: KEY }, cookie);
    const result = await call("GET", "/api/key", undefined, cookie);
    expect(result.json).toEqual({ fingerprint: "XY9z", provider: "anthropic" });
    expect(result.raw).not.toContain(KEY);
  });

  it("reports the provider alongside the fingerprint, so the form can render both", async () => {
    const { call, cookie } = harness();
    await call("PUT", "/api/key", { apiKey: GEMINI_KEY, provider: "gemini" }, cookie);
    const result = await call("GET", "/api/key", undefined, cookie);
    expect(result.json).toEqual({ fingerprint: "e123", provider: "gemini" });
    expect(result.raw).not.toContain(GEMINI_KEY);
  });

  it("reports null rather than 404 when no key is stored", async () => {
    // "You have no key" is a normal state the settings screen must render, not
    // an error condition. BOTH fields are null: defaulting the provider here
    // would let the form claim a choice the user never made.
    const { call, cookie } = harness();
    const result = await call("GET", "/api/key", undefined, cookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ fingerprint: null, provider: null });
  });

  it("401s without a session", async () => {
    const { call } = harness();
    expect((await call("GET", "/api/key")).status).toBe(401);
  });
});

describe("DELETE /api/key", () => {
  it("removes the key", async () => {
    const { call, cookie, db, user } = harness();
    await call("PUT", "/api/key", { apiKey: KEY }, cookie);
    expect((await call("DELETE", "/api/key", undefined, cookie)).status).toBe(200);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBeNull();
  });

  it("succeeds when there is no key, so revoking twice is not an error", async () => {
    const { call, cookie } = harness();
    expect((await call("DELETE", "/api/key", undefined, cookie)).status).toBe(200);
  });

  it("401s without a session", async () => {
    const { call } = harness();
    expect((await call("DELETE", "/api/key")).status).toBe(401);
  });
});

describe("tenancy", () => {
  it("gives each session its own key, never the other user's", async () => {
    // There is no user id in any path, so cross-user access is structurally
    // impossible rather than merely guarded — but "structurally impossible" is
    // a claim, and this is the test that makes it one. Slice 4 adds paths that
    // DO carry an id, and this is the property those must preserve.
    //
    // Both users live on the harness's single database and go through its one
    // listener; only the cookie differs. That is exactly the thing under test.
    const { db, call, cookie: firstCookie } = harness();
    const second = createUser(db, "b@example.com", "hash");
    const secondCookie = `${SESSION_COOKIE}=${createSession(db, second.id).id}`;

    await call("PUT", "/api/key", { apiKey: KEY }, firstCookie);
    await call("PUT", "/api/key", { apiKey: "sk-ant-api03-second-users-key-BB22" }, secondCookie);

    expect((await call("GET", "/api/key", undefined, secondCookie)).json)
      .toEqual({ fingerprint: "BB22", provider: "anthropic" });
    expect((await call("GET", "/api/key", undefined, firstCookie)).json)
      .toEqual({ fingerprint: "XY9z", provider: "anthropic" });
  });

  it("keeps each session's PROVIDER separate too, not only the key", async () => {
    // One user on Gemini and one on Anthropic is the ordinary case once both
    // providers exist. Crossing the providers would send one user's key to the
    // other's API — a 401 after the money is committed, per tenant.
    const { db, call, cookie: firstCookie } = harness();
    const second = createUser(db, "b@example.com", "hash");
    const secondCookie = `${SESSION_COOKIE}=${createSession(db, second.id).id}`;

    await call("PUT", "/api/key", { apiKey: KEY }, firstCookie);
    await call("PUT", "/api/key", { apiKey: GEMINI_KEY, provider: "gemini" }, secondCookie);

    expect((await call("GET", "/api/key", undefined, firstCookie)).json)
      .toEqual({ fingerprint: "XY9z", provider: "anthropic" });
    expect((await call("GET", "/api/key", undefined, secondCookie)).json)
      .toEqual({ fingerprint: "e123", provider: "gemini" });
  });
});

describe("method table", () => {
  it("404s a method never registered for /api/key, rather than 401 or 405", async () => {
    // router.test.ts proves method-mismatch -> 404 generically; this pins it
    // for the two methods this task just added to the union. The route table
    // is an allowlist: an unregistered method has nowhere to go, not a
    // recognized path with the wrong verb.
    const { call, cookie } = harness();
    expect((await call("POST", "/api/key", { apiKey: KEY }, cookie)).status).toBe(404);
  });
});
