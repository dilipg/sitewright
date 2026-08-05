// server/src/require-project.test.ts
/**
 * The ownership check, in one place. Its most important property is not that it
 * rejects — it is that it rejects a project belonging to someone else with the
 * SAME response as one that does not exist, so the endpoint cannot be used to
 * enumerate other people's projects.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser, setDisabled } from "./users.ts";
import { createSession } from "./sessions.ts";
import { SESSION_COOKIE } from "./sessions.ts";
import { createProject } from "./projects.ts";
import { createRequestListener, type Route } from "./router.ts";
import { requireProject } from "./require-project.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "server-reqproj-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const alice = createUser(db, "a@example.com", "h");
  const bob = createUser(db, "b@example.com", "h");
  return {
    db, alice, bob,
    aliceCookie: `${SESSION_COOKIE}=${createSession(db, alice.id).id}`,
    bobCookie: `${SESSION_COOKIE}=${createSession(db, bob.id).id}`,
    aliceProject: createProject(db, alice.id, "alice-run", "Alice"),
  };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function call(routes: Route[], path: string, cookie?: string) {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; res.headersSent = true; return res; },
    setHeader() {},
    end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
  };
  const req = Object.assign((async function* () {})(), {
    method: "GET", url: path, headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
  });
  await createRequestListener(routes)(req as never, res as never);
  const text = chunks.join("");
  if (text === "") return { status, body: text, json: undefined };
  // Mirrors require-session.test.ts's call(): a handler may legitimately write
  // a plain string body (the path-parameter test does), and that must not make
  // the harness itself throw before the caller's own assertions run.
  try {
    return { status, body: text, json: JSON.parse(text) };
  } catch {
    return { status, body: text, json: text };
  }
}

function routesFor(db: DatabaseSync, ran: { value: boolean }): Route[] {
  return [{
    method: "GET",
    path: "/api/thing",
    handler: requireProject(db, { from: "query", name: "project" }, (_req, res, ctx) => {
      ran.value = true;
      res.writeHead(200);
      res.end(JSON.stringify({ directory: ctx.project.directory, user: ctx.user.id }));
    }),
  }];
}

describe("requireProject", () => {
  it("passes the project and the user to the handler for its owner", async () => {
    const { db, alice, aliceCookie, aliceProject } = fresh();
    const ran = { value: false };
    const result = await call(routesFor(db, ran), `/api/thing?project=${aliceProject.id}`, aliceCookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ directory: "alice-run", user: alice.id });
  });

  it("401s with no session, before any project lookup", async () => {
    const { db, aliceProject } = fresh();
    const ran = { value: false };
    const result = await call(routesFor(db, ran), `/api/thing?project=${aliceProject.id}`);
    expect(ran.value).toBe(false);
    expect(result.status).toBe(401);
  });

  it("404s for another user's project and never runs the handler", async () => {
    // The core of the whole plan.
    const { db, bobCookie, aliceProject } = fresh();
    const ran = { value: false };
    const result = await call(routesFor(db, ran), `/api/thing?project=${aliceProject.id}`, bobCookie);
    expect(ran.value).toBe(false);
    expect(result.status).toBe(404);
  });

  it("gives a byte-identical response for someone else's project and a nonexistent one", async () => {
    // Otherwise the endpoint is a project-enumeration oracle: an attacker
    // learns which ids exist by the difference between 403 and 404.
    const { db, bobCookie, aliceProject } = fresh();
    const ran = { value: false };
    const foreign = await call(routesFor(db, ran), `/api/thing?project=${aliceProject.id}`, bobCookie);
    const absent = await call(routesFor(db, ran), "/api/thing?project=does-not-exist", bobCookie);
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toBe(absent.body);
  });

  it("400s when the project id is absent entirely", async () => {
    const { db, aliceCookie } = fresh();
    const ran = { value: false };
    expect((await call(routesFor(db, ran), "/api/thing", aliceCookie)).status).toBe(400);
    expect(ran.value).toBe(false);
  });

  it("401s once the owner is disabled, with a live session and their own project", async () => {
    // Revocation must reach a project endpoint, not just login.
    const { db, alice, aliceCookie, aliceProject } = fresh();
    const ran = { value: false };
    setDisabled(db, alice.id, true);
    expect((await call(routesFor(db, ran), `/api/thing?project=${aliceProject.id}`, aliceCookie)).status)
      .toBe(401);
    expect(ran.value).toBe(false);
  });

  it("reads the id from a path parameter when so configured", async () => {
    const { db, aliceCookie, aliceProject } = fresh();
    const routes: Route[] = [{
      method: "GET",
      path: "/api/projects/:id",
      handler: requireProject(db, { from: "param", name: "id" }, (_req, res, ctx) => {
        res.writeHead(200); res.end(ctx.project.directory);
      }),
    }];
    expect((await call(routes, `/api/projects/${aliceProject.id}`, aliceCookie)).body).toBe("alice-run");
  });
});
