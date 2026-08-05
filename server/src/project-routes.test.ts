// server/src/project-routes.test.ts
/**
 * GET /api/projects is the endpoint whose bug would be invisible in a
 * single-user test: returning everyone's projects looks identical to returning
 * yours when only you exist.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { createProject } from "./projects.ts";
import { createRequestListener } from "./router.ts";
import { projectRoutes } from "./project-routes.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "server-projroutes-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const alice = createUser(db, "a@example.com", "h");
  const bob = createUser(db, "b@example.com", "h");
  const listener = createRequestListener(projectRoutes({ db }));

  async function call(method: string, path: string, cookie?: string) {
    const chunks: string[] = [];
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; res.headersSent = true; return res; },
      setHeader() {},
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const req = Object.assign((async function* () {})(), {
      method, url: path, headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
    });
    await listener(req as never, res as never);
    const text = chunks.join("");
    return { status, body: text, json: text === "" ? undefined : JSON.parse(text) };
  }

  return {
    db, alice, bob, call,
    aliceCookie: `${SESSION_COOKIE}=${createSession(db, alice.id).id}`,
    bobCookie: `${SESSION_COOKIE}=${createSession(db, bob.id).id}`,
  };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/projects", () => {
  it("returns only the caller's projects", async () => {
    const { db, alice, bob, call, aliceCookie } = harness();
    createProject(db, alice.id, "alice-run", "Alice");
    createProject(db, bob.id, "bob-run", "Bob");
    const result = await call("GET", "/api/projects", aliceCookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ projects: [expect.objectContaining({ name: "Alice" })] });
    expect(result.body).not.toContain("bob-run");
  });

  it("returns an empty list, not a 404, for a user with none", async () => {
    const { call, aliceCookie } = harness();
    expect((await call("GET", "/api/projects", aliceCookie)).json).toEqual({ projects: [] });
  });

  it("401s without a session", async () => {
    const { call } = harness();
    expect((await call("GET", "/api/projects")).status).toBe(401);
  });

  it("never exposes another user's owner id", async () => {
    const { db, bob, call, aliceCookie } = harness();
    createProject(db, bob.id, "bob-run", "Bob");
    expect((await call("GET", "/api/projects", aliceCookie)).body).not.toContain(bob.id);
  });
});

describe("GET /api/projects/:id", () => {
  it("returns the caller's own project", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const p = createProject(db, alice.id, "alice-run", "Alice");
    expect((await call("GET", `/api/projects/${p.id}`, aliceCookie)).json)
      .toEqual(expect.objectContaining({ id: p.id, name: "Alice" }));
  });

  it("404s for another user's project, identically to a nonexistent one", async () => {
    const { db, alice, call, bobCookie } = harness();
    const p = createProject(db, alice.id, "alice-run", "Alice");
    const foreign = await call("GET", `/api/projects/${p.id}`, bobCookie);
    const absent = await call("GET", "/api/projects/nope", bobCookie);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toBe(absent.body);
  });
});
