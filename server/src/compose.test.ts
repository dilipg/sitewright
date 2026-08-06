// server/src/compose.test.ts
/**
 * The route table IS the allowlist (router.ts): an unregistered path has
 * nowhere to go. That only holds if the table itself is assembled correctly.
 * Before this file existed, nothing imported scripts/serve.ts at all — a
 * dropped `...keyRoutes(...)` spread, or loadMasterKey() moved after
 * openDatabase, would have passed all 157 tests that existed at the time.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { buildRoutes } from "./compose.ts";
import { PreviewPool } from "./preview-pool.ts";
import { createProject } from "./projects.ts";
import { createRequestListener } from "./router.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { createUser } from "./users.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function fresh(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "server-compose-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  return db;
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Every (method, path) pair the hosted composition root must expose. */
const EXPECTED_ROUTES: Array<[string, string]> = [
  ["POST", "/api/login"],
  ["POST", "/api/logout"],
  ["GET", "/api/me"],
  ["PUT", "/api/key"],
  ["GET", "/api/key"],
  ["DELETE", "/api/key"],
  ["GET", "/api/projects"],
  ["GET", "/api/projects/:id"],
  ["GET", "/preview/:projectId/*"],
];

describe("buildRoutes", () => {
  it("registers exactly the expected (method, path) pairs — no more, no fewer", () => {
    const db = fresh();
    // A pool is passed, because scripts/serve.ts always passes one: without
    // it `buildRoutes` omits the preview route, and this — the one test whose
    // title claims to pin the COMPLETE route set — would pin a table
    // production never builds. Constructing a pool spawns nothing; nothing
    // starts until acquire(). Same reasoning as project-registry.test.ts.
    const masterKey = randomBytes(32);
    const pool = new PreviewPool({ db, masterKey, projectsRoot: mkdtempSync(join(tmpdir(), "compose-pool-")) });
    const routes = buildRoutes({ db, masterKey, secureCookies: true, pool });
    const actual = routes.map((r): [string, string] => [r.method, r.path]);
    const sortKey = (pair: [string, string]) => pair.join(" ");
    expect([...actual].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      [...EXPECTED_ROUTES].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    );
  });

  it("has no duplicate (method, path) pair", () => {
    // The table IS the allowlist; router.ts's `.find()` returns the first
    // match, so a duplicate here would be silently shadowed rather than
    // caught. Slice 4 adds two more routes across multiple arrays — exactly
    // the situation where a duplicate registered in the wrong one is
    // otherwise invisible.
    const db = fresh();
    const routes = buildRoutes({ db, masterKey: randomBytes(32), secureCookies: true });
    const seen = new Set<string>();
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

/**
 * Every other test in this file inspects buildRoutes's return value as a
 * plain array. createRequestListener(buildRoutes(...)) — what scripts/serve.ts
 * actually does — was never called anywhere else in the suite, so the
 * router's construction-time validation (duplicate-route detection, the
 * at-most-one-parameter check) never ran against the REAL composed table in
 * CI. A route with two `:param` segments would pass every other test and
 * `tsc`, then throw only at boot.
 */
describe("createRequestListener(buildRoutes(...))", () => {
  const dirs: string[] = [];
  const dbs: DatabaseSync[] = [];
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "server-compose-listener-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "identity.db"));
    dbs.push(db);
    const alice = createUser(db, "a@example.com", "h");
    const bob = createUser(db, "b@example.com", "h");
    const listener = createRequestListener(
      buildRoutes({ db, masterKey: randomBytes(32), secureCookies: true }),
    );

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

  it("builds without throwing", () => {
    const db = fresh();
    expect(() => createRequestListener(
      buildRoutes({ db, masterKey: randomBytes(32), secureCookies: true }),
    )).not.toThrow();
  });

  it("authorizes correctly for two users across the full composed table", async () => {
    const { db, alice, call, aliceCookie, bobCookie } = harness();
    const project = createProject(db, alice.id, "alice-run", "Alice");

    const mine = await call("GET", "/api/projects", aliceCookie);
    expect(mine.status).toBe(200);
    expect(mine.json).toEqual({ projects: [expect.objectContaining({ id: project.id })] });

    const own = await call("GET", `/api/projects/${project.id}`, aliceCookie);
    expect(own.status).toBe(200);
    expect(own.json).toEqual(expect.objectContaining({ id: project.id, name: "Alice" }));

    const foreign = await call("GET", `/api/projects/${project.id}`, bobCookie);
    const absent = await call("GET", "/api/projects/nope", bobCookie);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toBe(absent.body);
  });
});

// scripts/serve.ts itself cannot be imported for a unit test: its module body
// has side effects the instant it runs — it parses process.argv, may call
// process.exit, and (past the master-key/db setup this suite cares about)
// binds a real port. So this reads its source text instead. That is a
// narrower guarantee than executing the script — it cannot prove the
// deletion happens at RUNTIME — but it is a genuine regression guard: it
// fails if the `delete process.env[MASTER_KEY_ENV_VAR]` line is removed, or
// reordered to before loadMasterKey() or after openDatabase(). The runtime
// behaviour itself is confirmed live, once, against a real running process
// (see this fix round's report) — not on every CI run, which is exactly why
// this static check exists as a backstop between those live checks.
describe("scripts/serve.ts — master-key handling (item 1)", () => {
  const serveSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "serve.ts"),
    "utf8",
  );

  it("loads the master key before opening the database", () => {
    // Preserved deliberately across the compose.ts refactor: an operator who
    // forgot WEBGEN_MASTER_KEY must learn it immediately, not after a
    // migration has already run against --db.
    const loadIndex = serveSource.indexOf("loadMasterKey()");
    const openIndex = serveSource.indexOf("openDatabase(");
    expect(loadIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeLessThan(openIndex);
  });

  it("deletes the master key from process.env immediately after loading it, and before opening the database", () => {
    // Without this, every child process this server ever spawns without an
    // explicit `env` override — the generated project's own build, its
    // typecheck, the orchestrator's regeneration subprocess — inherits
    // WEBGEN_MASTER_KEY verbatim, and one process.env read in any of them
    // (all of which can run untrusted, model-generated code) decrypts every
    // user's stored key.
    const loadIndex = serveSource.indexOf("loadMasterKey()");
    const deleteIndex = serveSource.indexOf("delete process.env[MASTER_KEY_ENV_VAR]");
    const openIndex = serveSource.indexOf("openDatabase(");
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(loadIndex);
    expect(deleteIndex).toBeLessThan(openIndex);
  });

  it("keeps the unhandledRejection/uncaughtException handlers inside the listen callback", () => {
    // Registered at module scope, these would swallow every startup failure
    // — an unopenable --db, a port already in use — and turn a failed boot
    // into a silent exit 0 that logs "server continues" while serving
    // nothing. Already found and fixed once on this branch; this pins it so
    // a future refactor cannot reintroduce it without a red test.
    const listenIndex = serveSource.indexOf("server.listen(port");
    const rejectionIndex = serveSource.indexOf('process.on("unhandledRejection"');
    const exceptionIndex = serveSource.indexOf('process.on("uncaughtException"');
    expect(listenIndex).toBeGreaterThan(-1);
    expect(rejectionIndex).toBeGreaterThan(listenIndex);
    expect(exceptionIndex).toBeGreaterThan(listenIndex);
  });

  it("still exits the process on a listen error", () => {
    const errorHandlerIndex = serveSource.indexOf('server.on("error"');
    const exitIndex = serveSource.indexOf("process.exit(1)", errorHandlerIndex);
    expect(errorHandlerIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeGreaterThan(errorHandlerIndex);
  });

  it("shuts the preview pool down on both termination signals", () => {
    // Every preview is a child process. Without this, Ctrl-C leaves a Vite
    // server per open project holding its port — the exact failure the pool's
    // cap exists to bound, reintroduced at exit. preview-pool.test.ts covers
    // `pool.shutdown()` itself; nothing else covers that serve.ts CALLS it,
    // and deleting these two lines leaves the whole suite green.
    expect(serveSource).toContain('process.on("SIGINT"');
    expect(serveSource).toContain('process.on("SIGTERM"');
    expect(serveSource).toContain("pool.shutdown()");
  });

  it("mounts the preview upgrade listener, the one authorization path outside the route table", () => {
    // A WebSocket upgrade fires 'upgrade', never 'request', so
    // createRequestListener — and with it requireProject — never runs for it.
    // preview-upgrade.test.ts covers the listener's own authorization; this
    // pins that serve.ts actually attaches it, which no other test can see.
    const upgradeIndex = serveSource.indexOf('server.on("upgrade"');
    expect(upgradeIndex).toBeGreaterThan(-1);
    expect(serveSource.indexOf("createPreviewUpgradeListener", upgradeIndex)).toBeGreaterThan(upgradeIndex);
  });
});
