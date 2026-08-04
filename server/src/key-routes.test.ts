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

  async function call(method: string, path: string, body?: unknown, cookie?: string) {
    const chunks: string[] = [];
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; res.headersSent = true; return res; },
      setHeader() {},
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
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
    expect(result.json).toEqual({ fingerprint: "XY9z" });
    // The response must not carry the key even incidentally.
    expect(result.raw).not.toContain(KEY);
    // ...but it really was stored.
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBe(KEY);
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

  it("replaces an existing key", async () => {
    const { call, cookie, db, user } = harness();
    await call("PUT", "/api/key", { apiKey: KEY }, cookie);
    await call("PUT", "/api/key", { apiKey: "sk-ant-api03-second-value-here-AAAA" }, cookie);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBe("sk-ant-api03-second-value-here-AAAA");
  });
});

describe("GET /api/key", () => {
  it("reports the fingerprint when a key is stored", async () => {
    const { call, cookie } = harness();
    await call("PUT", "/api/key", { apiKey: KEY }, cookie);
    const result = await call("GET", "/api/key", undefined, cookie);
    expect(result.json).toEqual({ fingerprint: "XY9z" });
    expect(result.raw).not.toContain(KEY);
  });

  it("reports null rather than 404 when no key is stored", async () => {
    // "You have no key" is a normal state the settings screen must render, not
    // an error condition.
    const { call, cookie } = harness();
    const result = await call("GET", "/api/key", undefined, cookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ fingerprint: null });
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
      .toEqual({ fingerprint: "BB22" });
    expect((await call("GET", "/api/key", undefined, firstCookie)).json)
      .toEqual({ fingerprint: "XY9z" });
  });
});
