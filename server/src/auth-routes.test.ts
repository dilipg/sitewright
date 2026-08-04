// server/src/auth-routes.test.ts
/**
 * Login is the one endpoint an unauthenticated stranger can reach, so its
 * failure behaviour matters more than its success behaviour.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { hashPassword } from "./passwords.ts";
import { createUser, setDisabled } from "./users.ts";
import { authRoutes } from "./auth-routes.ts";
import { createRequestListener } from "./router.ts";

// Same idiom as passwords.test.ts / sessions-entropy.test.ts: wrap the real
// implementation rather than stub it out, so hashing/verifying still works
// for every other test in this file (harness() logs users in for real), and
// count real calls to `verify` so a test can pin "argon2 verification
// actually ran" without touching the clock.
let verifyCallCount = 0;
vi.mock("@node-rs/argon2", async () => {
  const actual = await vi.importActual<typeof import("@node-rs/argon2")>("@node-rs/argon2");
  return {
    ...actual,
    verify: (...args: Parameters<typeof actual.verify>) => {
      verifyCallCount += 1;
      return actual.verify(...args);
    },
  };
});

const dirs: string[] = [];
// Tracked so afterAll can close every handle before removing its temp dir —
// same pattern as db.test.ts/users.test.ts/sessions.test.ts: on Windows an
// open DatabaseSync handle (WAL mode) makes rmSync fail with EPERM.
const dbs: DatabaseSync[] = [];
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "server-auth-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const user = createUser(db, "a@example.com", await hashPassword("s3cret-password"));
  const listener = createRequestListener(authRoutes({ db, secureCookies: false }));

  // `body` is JSON-stringified as usual. `raw`, when given, bypasses
  // JSON.stringify entirely and is sent as-is — the only way to get
  // non-JSON bytes (or an oversized body) onto the wire for a test.
  //
  // `contentType` defaults to "application/json" — real JSON callers always
  // send it, and login now requires it (CSRF: an HTML form can never send
  // this content type). Every pre-existing test below relies on that default
  // to keep meaning exactly what it meant before login started checking the
  // header. Pass a string to test a specific value, or `null` to send no
  // Content-Type header at all.
  async function call(
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
    raw?: Buffer,
    contentType: string | null = "application/json",
  ) {
    const chunks: string[] = [];
    let status = 0;
    const headers: Record<string, string | string[]> = {};
    const res = {
      headersSent: false,
      writeHead(code: number, hdrs?: Record<string, string | string[]>) {
        status = code; Object.assign(headers, hdrs ?? {}); res.headersSent = true; return res;
      },
      setHeader(name: string, value: string | string[]) { headers[name.toLowerCase()] = value; },
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const payload = raw !== undefined ? [raw] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const reqHeaders: Record<string, string> = { host: "localhost" };
    if (contentType !== null) reqHeaders["content-type"] = contentType;
    if (cookie !== undefined) reqHeaders.cookie = cookie;
    const req = Object.assign(
      (async function* () { yield* payload; })(),
      { method, url: path, headers: reqHeaders },
    );
    await listener(req as never, res as never);
    const text = chunks.join("");
    return { status, headers, json: text === "" ? undefined : JSON.parse(text) };
  }
  return { db, user, call };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function sidFrom(headers: Record<string, string | string[]>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0]! : String(raw);
  return value.split(";")[0]!.split("=")[1]!;
}

describe("POST /api/login", () => {
  it("sets a session cookie on correct credentials", async () => {
    const { call } = await harness();
    const result = await call("POST", "/api/login", { email: "a@example.com", password: "s3cret-password" });
    expect(result.status).toBe(200);
    const cookie = String(result.headers["set-cookie"]);
    expect(cookie).toContain("sid=");
    expect(cookie).toContain("HttpOnly");
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const { call } = await harness();
    const result = await call("POST", "/api/login", { email: "a@example.com", password: "wrong" });
    expect(result.status).toBe(401);
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  // NOTE: the handler also hashes a dummy password when no user matches, so an
  // unknown email costs roughly the same TIME as a wrong one. That is
  // deliberately not asserted here — a wall-clock bound on a shared CI runner
  // is flaky by construction, and a flaky test in the auth suite trains people
  // to ignore it. The uniform status and body below are what is testable.
  it("gives the SAME response for an unknown email as for a wrong password", async () => {
    // Distinguishable responses turn the login form into an account
    // enumeration oracle — which matters even invite-only, since it confirms
    // who has access.
    const { call } = await harness();
    const wrongPassword = await call("POST", "/api/login", { email: "a@example.com", password: "wrong" });
    const unknownEmail = await call("POST", "/api/login", { email: "nobody@example.com", password: "wrong" });
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.json).toEqual(wrongPassword.json);
  });

  // Without this, the entire dummy-hash mechanism (auth-routes.ts's
  // dummyHash()) could be deleted — skip verifyPassword whenever no user
  // matches — and every other test in this describe block would still pass,
  // since they only assert status and body shape. This pins the actual
  // mechanism: a real argon2 verification runs even when no user matched.
  it("actually runs an argon2 verification on the unknown-email path", async () => {
    const { call } = await harness();
    const before = verifyCallCount;
    await call("POST", "/api/login", { email: "nobody@example.com", password: "whatever" });
    expect(verifyCallCount - before).toBe(1);
  });

  it("refuses a disabled user", async () => {
    const { call, db, user } = await harness();
    setDisabled(db, user.id, true);
    expect((await call("POST", "/api/login", { email: "a@example.com", password: "s3cret-password" })).status).toBe(401);
  });

  it("never echoes the password back", async () => {
    const { call } = await harness();
    const result = await call("POST", "/api/login", { email: "a@example.com", password: "wrong" });
    expect(JSON.stringify(result.json)).not.toContain("wrong");
  });

  it("rejects a malformed body with 400 rather than throwing", async () => {
    const { call } = await harness();
    expect((await call("POST", "/api/login", { email: 42 })).status).toBe(400);
    expect((await call("POST", "/api/login", {})).status).toBe(400);
  });

  // The CSRF vector this closes: an HTML <form> submitting cross-site can
  // only send one of three content types, and application/x-www-form-urlencoded
  // is the classic one. SameSite=Lax does not stop this, because it only
  // guards requests that SEND the cookie — login SETS one. Credentials here
  // are well-formed and CORRECT; only the content type is wrong, isolating
  // this check from the body-shape checks above.
  it("rejects a form-encoded content type, even with an otherwise valid body", async () => {
    const { call } = await harness();
    const result = await call(
      "POST",
      "/api/login",
      { email: "a@example.com", password: "s3cret-password" },
      undefined,
      undefined,
      "application/x-www-form-urlencoded",
    );
    expect(result.status).toBe(400);
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a request with no Content-Type header at all", async () => {
    const { call } = await harness();
    const result = await call(
      "POST",
      "/api/login",
      { email: "a@example.com", password: "s3cret-password" },
      undefined,
      undefined,
      null,
    );
    expect(result.status).toBe(400);
  });

  // A real JSON client commonly sends a charset parameter; it must not be
  // treated as "not JSON". Matching is also case-insensitive per RFC 9110,
  // covered by the mixed case here.
  it("accepts application/json with a charset parameter, case-insensitively", async () => {
    const { call } = await harness();
    const result = await call(
      "POST",
      "/api/login",
      { email: "a@example.com", password: "s3cret-password" },
      undefined,
      undefined,
      "Application/JSON; charset=utf-8",
    );
    expect(result.status).toBe(200);
  });

  // JSON.parse("null") succeeds, so readJsonBody's own try/catch never sees
  // it as invalid JSON — the parsed value is `null`, and `body.email` on it
  // throws unless there's a type guard. That throw would escape to the
  // router's catch-all as an unhandled 500. This is the one body shape that
  // slipped through the (typeof body.email !== "string") check alone,
  // because the check never runs — accessing .email on null throws first.
  it("rejects a null JSON body with 400, not 500", async () => {
    const { call } = await harness();
    const result = await call("POST", "/api/login", null);
    expect(result.status).toBe(400);
  });

  // Guards against the fix being narrowed to `parsed !== null` (which arrays
  // would still pass, since typeof [] === "object"). An array has no .email
  // property so `body.email` is merely undefined rather than throwing, but it
  // is not a legitimate request body and must still be rejected as malformed.
  it("rejects a JSON array body with 400", async () => {
    const { call } = await harness();
    const result = await call("POST", "/api/login", []);
    expect(result.status).toBe(400);
  });

  // Gap the brief's own test name promised but didn't cover: well-formed JSON
  // with wrong types is not the only "malformed body". readJsonBody calls
  // JSON.parse, which throws on bytes that aren't JSON at all — and an
  // unguarded throw in a handler escapes to createRequestListener's catch,
  // which is a 500. Login is reachable by anyone unauthenticated, so a
  // hostile body must not be able to produce a server error.
  it("rejects a body that is not valid JSON with 400, not 500", async () => {
    const { call } = await harness();
    const result = await call("POST", "/api/login", undefined, undefined, Buffer.from("not json at all{{{"));
    expect(result.status).toBe(400);
  });

  it("rejects an over-limit body with 400, not 500", async () => {
    const { call } = await harness();
    const result = await call("POST", "/api/login", undefined, undefined, Buffer.alloc(1_500_000, "a"));
    expect(result.status).toBe(400);
  });
});

describe("GET /api/me", () => {
  it("returns the user for a valid session, and never the password hash", async () => {
    const { call } = await harness();
    const login = await call("POST", "/api/login", { email: "a@example.com", password: "s3cret-password" });
    const me = await call("GET", "/api/me", undefined, `sid=${sidFrom(login.headers)}`);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ email: "a@example.com" });
    expect(JSON.stringify(me.json)).not.toContain("argon2");
  });

  it("401s with no cookie", async () => {
    const { call } = await harness();
    expect((await call("GET", "/api/me")).status).toBe(401);
  });

  it("401s with a forged session id", async () => {
    const { call } = await harness();
    expect((await call("GET", "/api/me", undefined, "sid=forged")).status).toBe(401);
  });
});

describe("POST /api/logout", () => {
  it("invalidates the session immediately", async () => {
    const { call } = await harness();
    const login = await call("POST", "/api/login", { email: "a@example.com", password: "s3cret-password" });
    const cookie = `sid=${sidFrom(login.headers)}`;
    await call("POST", "/api/logout", undefined, cookie);
    expect((await call("GET", "/api/me", undefined, cookie)).status).toBe(401);
  });

  it("succeeds even without a session, so logging out is never an error", async () => {
    const { call } = await harness();
    expect((await call("POST", "/api/logout")).status).toBe(200);
  });
});
