// server/src/require-session.test.ts
/**
 * One place where "is this caller logged in" is decided. The value of a wrapper
 * over a convention is that a route CANNOT be registered without choosing:
 * either it is wrapped, or it is visibly public in the route table.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser, setDisabled } from "./users.ts";
import { createSession } from "./sessions.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";
import { createRequestListener, type Route } from "./router.ts";
import { requireSession } from "./require-session.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "server-authz-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const user = createUser(db, "a@example.com", "hash");
  return { db, user };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Drives a route without opening a socket. */
async function call(routes: Route[], cookie?: string) {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; res.headersSent = true; return res; },
    setHeader() {},
    end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
  };
  const req = Object.assign((async function* () {})(), {
    method: "GET",
    url: "/api/whoami",
    headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
  });
  await createRequestListener(routes)(req as never, res as never);
  const text = chunks.join("");
  if (text === "") return { status, json: undefined };
  // A malformed body — e.g. two response writes concatenated because a
  // handler ran when it should not have — must not make the harness itself
  // throw before the caller's own assertions get to run. Fall back to the
  // raw text rather than letting JSON.parse's exception pre-empt whatever
  // the test is actually trying to check.
  try {
    return { status, json: JSON.parse(text) };
  } catch {
    return { status, json: text };
  }
}

describe("requireSession", () => {
  it("passes the resolved user to the handler", async () => {
    const { db, user } = fresh();
    const session = createSession(db, user.id);
    const routes: Route[] = [{
      method: "GET",
      path: "/api/whoami",
      handler: requireSession(db, (_req, res, ctx) => {
        res.writeHead(200);
        res.end(JSON.stringify({ id: ctx.user.id }));
      }),
    }];
    const result = await call(routes, `${SESSION_COOKIE}=${session.id}`);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ id: user.id });
  });

  it("401s with no cookie and never runs the handler", async () => {
    // "Never runs the handler" is the real guarantee: a handler that ran and
    // then had its response discarded could still have written to the database.
    const { db } = fresh();
    let ran = false;
    const routes: Route[] = [{
      method: "GET",
      path: "/api/whoami",
      handler: requireSession(db, (_req, res) => { ran = true; res.writeHead(200); res.end("{}"); }),
    }];
    let result: { status: number; json: unknown } | undefined;
    let threw: unknown;
    try {
      result = await call(routes);
    } catch (e) {
      threw = e;
    }
    // Asserted first and in isolation: neither a corrupted response body nor
    // an overwritten status code can pre-empt the one assertion that encodes
    // the actual security property under test — the handler must not run.
    expect(ran).toBe(false);
    expect(threw).toBeUndefined();
    expect(result?.status).toBe(401);
  });

  it("401s for a forged session id", async () => {
    const { db } = fresh();
    const routes: Route[] = [{
      method: "GET",
      path: "/api/whoami",
      handler: requireSession(db, (_req, res) => { res.writeHead(200); res.end("{}"); }),
    }];
    expect((await call(routes, `${SESSION_COOKIE}=forged`)).status).toBe(401);
  });

  it("401s once the user is disabled, with the same live session", async () => {
    // Revocation must reach an already-authenticated route, not just login.
    const { db, user } = fresh();
    const session = createSession(db, user.id);
    const routes: Route[] = [{
      method: "GET",
      path: "/api/whoami",
      handler: requireSession(db, (_req, res) => { res.writeHead(200); res.end("{}"); }),
    }];
    setDisabled(db, user.id, true);
    expect((await call(routes, `${SESSION_COOKIE}=${session.id}`)).status).toBe(401);
  });
});
