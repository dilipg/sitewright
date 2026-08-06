// server/src/preview-pool.test.ts
/**
 * The pool spawns real subprocesses in production but never in a test — a
 * real Vite start is seconds and flaky under CI load. Every test here injects
 * `spawnFn` and drives the fake child by hand, including its readiness line,
 * so the tests pin the pool's own state machine (spawn-once, in-flight
 * accounting, idle reaping, capacity) rather than Vite's behaviour.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createProject, type Project } from "./projects.ts";
import { setApiKey } from "./api-keys.ts";
import { DisabledUserError, UnknownUserError } from "./agent-env.ts";
import { MASTER_KEY_ENV_VAR } from "./master-key.ts";
import {
  KILL_GRACE_MS,
  MAX_PREVIEWS,
  PreviewCapacityError,
  PreviewPool,
  SHUTDOWN_SPAWN_WAIT_MS,
} from "./preview-pool.ts";

const MASTER_KEY = Buffer.alloc(32, 7);

/** A stand-in for a spawned preview: emits its ready line on command. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => boolean;
    killed: boolean; pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 4242;
  child.kill = () => { child.killed = true; child.emit("exit", 0, null); return true; };
  return child;
}

/**
 * A child that ignores its first `kill()` (the default SIGTERM) — standing
 * in for Vite's own `process.once("SIGTERM")` handler stalling on
 * `server.close()` — but honours an explicit "SIGKILL", which a real OS
 * process cannot ignore. `killCalls` records every signal argument the pool
 * actually passed, in order, so a test can tell "sent SIGTERM, then escalated
 * to SIGKILL" apart from "sent SIGTERM twice" or "went straight to SIGKILL".
 */
function stubbornChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => boolean;
    killed: boolean; pid: number; killCalls: Array<string | undefined>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 4343;
  child.killCalls = [];
  child.kill = (signal?: string) => {
    child.killCalls.push(signal);
    if (signal === "SIGKILL") {
      child.killed = true;
      child.emit("exit", null, "SIGKILL");
    }
    // The first call (SIGTERM, i.e. no explicit signal) is deliberately a
    // no-op: no "exit", no `killed` flip — exactly a stalled graceful close.
    return true;
  };
  return child;
}

let dir: string;
let db: DatabaseSync;
let projectsRoot: string;
let ownerId: string;
let project: Project;
let spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
let children: ReturnType<typeof fakeChild>[];
let clock: number;

function makePool(overrides: Record<string, unknown> = {}) {
  return new PreviewPool({
    db,
    masterKey: MASTER_KEY,
    projectsRoot,
    now: () => clock,
    spawnFn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ command, args, env: options.env });
      const child = fakeChild();
      children.push(child);
      // Announce readiness on the next tick so `acquire` genuinely awaits it.
      setImmediate(() => {
        const portIndex = args.indexOf("--port");
        const baseIndex = args.indexOf("--base");
        child.stdout.emit(
          "data",
          Buffer.from(`PREVIEW_READY ${JSON.stringify({
            port: 40000 + children.length,
            base: baseIndex >= 0 ? args[baseIndex + 1] : "/",
          })}\n`),
        );
      });
      return child;
    },
    // Real `verifyPort` opens an actual TCP connection to confirm a
    // PREVIEW_READY line's claim; the fake child above never opens a real
    // socket, so this pool would otherwise wait out every retry and fail
    // every single test. Individual tests override this to prove the
    // failure path (see "readiness" below).
    verifyPort: async () => {},
    ...overrides,
  });
}

beforeEach(() => {
  clock = 1_000_000;
  spawned = [];
  children = [];
  dir = mkdtempSync(join(tmpdir(), "pool-"));
  db = openDatabase(join(dir, "identity.db"));
  projectsRoot = join(dir, "generated");
  mkdirSync(join(projectsRoot, "run-a"), { recursive: true });
  ownerId = createUser(db, "a@example.com", "hash").id;
  project = createProject(db, ownerId, "run-a", "Run A");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spawning", () => {
  it("spawns one process and returns its OS-assigned port", async () => {
    const pool = makePool();
    const preview = await pool.acquire(project, ownerId);
    expect(spawned).toHaveLength(1);
    const { args } = spawned[0]!;
    const passedPort = Number(args[args.indexOf("--port") + 1]);
    expect(preview.port).toBe(passedPort);
    expect(preview.projectId).toBe(project.id);
  });

  it("is proxied on the port it was passed, not a different port the child announces", async () => {
    // The child runs the project's own unvalidated vite.config.ts — nobody
    // has reviewed it, and it could print an early, well-formed PREVIEW_READY
    // line naming any port it likes. Believing that value would hand
    // untrusted input a redirect primitive: the pool would proxy every
    // request for this project to whatever port the child claims. The fake
    // spawnFn above always announces a fabricated port (40000 + n) unrelated
    // to the one it was actually passed — this pins that the pool ignores it.
    const pool = makePool();
    const preview = await pool.acquire(project, ownerId);
    const { args } = spawned[0]!;
    const passedPort = Number(args[args.indexOf("--port") + 1]);
    expect(preview.port).toBe(passedPort);
    expect(preview.port).not.toBe(40001);
  });

  it("passes a concrete probed port, never 0, and the project's proxy base", async () => {
    // Vite treats port 0 as "no port configured" and falls back to its own
    // default, so every child asking for 0 would get the SAME port and the
    // second would die on strictPort. Verified empirically — the parent must
    // pick the port. See findFreePort.
    const pool = makePool();
    const preview = await pool.acquire(project, ownerId);
    const { args } = spawned[0]!;
    const passedPort = Number(args[args.indexOf("--port") + 1]);
    expect(passedPort).toBeGreaterThan(0);
    expect(args[args.indexOf("--base") + 1]).toBe(`/preview/${project.id}/`);
    expect(preview.base).toBe(`/preview/${project.id}/`);
  });

  it("spawns in the project's own resolved directory", async () => {
    const pool = makePool();
    await pool.acquire(project, ownerId);
    expect(spawned[0]!.args).toContain(join(projectsRoot, "run-a"));
  });

  it("reuses the running process for a second request", async () => {
    const pool = makePool();
    const first = await pool.acquire(project, ownerId);
    const second = await pool.acquire(project, ownerId);
    expect(spawned).toHaveLength(1);
    expect(second.port).toBe(first.port);
  });

  it("does not spawn twice for two concurrent first requests", async () => {
    // Without an in-flight promise per project, two requests arriving before
    // the first child is ready both spawn — two Vite servers on one directory.
    const pool = makePool();
    const [a, b] = await Promise.all([pool.acquire(project, ownerId), pool.acquire(project, ownerId)]);
    expect(spawned).toHaveLength(1);
    expect(a.port).toBe(b.port);
  });
});

describe("the child's environment", () => {
  it("passes the owner's stored API key", async () => {
    setApiKey(db, MASTER_KEY, ownerId, "sk-ant-user-key-1234");
    const pool = makePool();
    await pool.acquire(project, ownerId);
    expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBe("sk-ant-user-key-1234");
  });

  it("never passes the master key", async () => {
    // Planted explicitly in baseEnv, the way the adjacent host-key test
    // does: `process.env` (the default baseEnv) never has WEBGEN_MASTER_KEY
    // set in this test process, so asserting against the default would pass
    // whether or not scrubbedEnv's deletion exists — see task-2-report.md's
    // FIX 3 perturbation for proof this version actually pins the behavior.
    const pool = makePool({ baseEnv: { [MASTER_KEY_ENV_VAR]: "master-key-plaintext", PATH: "/usr/bin" } });
    await pool.acquire(project, ownerId);
    expect(spawned[0]!.env[MASTER_KEY_ENV_VAR]).toBeUndefined();
  });

  it("spawns without a key when the user stored none, rather than refusing to preview", async () => {
    // Previewing is free; generating is not. A user with no key must still be
    // able to open a project.
    const pool = makePool();
    const preview = await pool.acquire(project, ownerId);
    expect(preview.port).toBeGreaterThan(0);
    expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does not hand a keyless user the host's own key", async () => {
    const pool = makePool({ baseEnv: { ANTHROPIC_API_KEY: "sk-ant-HOST" } });
    await pool.acquire(project, ownerId);
    expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("readiness", () => {
  it("kills the child and rejects when a readiness line never leads to a verifiably listening port", async () => {
    // The line is deliberately malformed JSON — proving it doesn't crash the
    // handler (it's logged, never trusted) — and `verifyPort` is rigged to
    // never succeed, simulating "claims ready but the port never actually
    // accepts a connection." Either way, the required outcome is the same:
    // the child dies and the pool stays clean, never an orphaned live
    // process outside the pool's own tracking and cap.
    const pool = new PreviewPool({
      db, masterKey: MASTER_KEY, projectsRoot, now: () => clock,
      verifyPort: async () => {
        throw new Error("simulated: port never accepted a connection");
      },
      spawnFn: () => {
        const c = fakeChild();
        children.push(c);
        setImmediate(() => c.stdout.emit("data", Buffer.from("PREVIEW_READY {garbage\n")));
        return c;
      },
    });
    await expect(pool.acquire(project, ownerId)).rejects.toThrow();
    expect(children[0]!.killed).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });

  it("fails fast, rather than hanging out the full timeout, when spawn itself errors", async () => {
    // spawn() failing to launch at all (a bad command, ENOENT, EACCES) emits
    // "error", not "exit". Without a listener for it, acquire would hang
    // until SPAWN_TIMEOUT_MS on every one of its retries instead of failing
    // immediately.
    const pool = new PreviewPool({
      db, masterKey: MASTER_KEY, projectsRoot, now: () => clock,
      spawnFn: () => {
        const c = fakeChild();
        children.push(c);
        setImmediate(() => c.emit("error", new Error("spawn ENOENT")));
        return c;
      },
    });
    await expect(pool.acquire(project, ownerId)).rejects.toThrow();
    expect(pool.list()).toHaveLength(0);
  });
});

describe("capacity", () => {
  function projectN(n: number): Project {
    mkdirSync(join(projectsRoot, `run-${n}`), { recursive: true });
    return createProject(db, ownerId, `run-${n}`, `Run ${n}`);
  }

  it("caps at six concurrent previews with an error naming the cap", async () => {
    const pool = makePool();
    for (let n = 0; n < MAX_PREVIEWS; n += 1) await pool.acquire(projectN(n), ownerId);
    expect(pool.list()).toHaveLength(MAX_PREVIEWS);
    await expect(pool.acquire(projectN(99), ownerId)).rejects.toThrow(PreviewCapacityError);
    await expect(pool.acquire(projectN(98), ownerId)).rejects.toThrow(/6/);
  });

  it("reclaims an idle slot before refusing", async () => {
    const pool = makePool({ idleMs: 1000 });
    const first = projectN(0);
    await pool.acquire(first, ownerId);
    for (let n = 1; n < MAX_PREVIEWS; n += 1) await pool.acquire(projectN(n), ownerId);
    clock += 5000;              // everything is now idle
    pool.retain(first.id);      // ...except the first, which is working
    const seventh = await pool.acquire(projectN(99), ownerId);
    expect(seventh.port).toBeGreaterThan(0);
    expect(pool.list().map((p) => p.projectId)).toContain(first.id);
  });

  it("still refuses when every slot is busy", async () => {
    const pool = makePool({ idleMs: 1000 });
    const busy: Project[] = [];
    for (let n = 0; n < MAX_PREVIEWS; n += 1) {
      const p = projectN(n);
      busy.push(p);
      await pool.acquire(p, ownerId);
      pool.retain(p.id);
    }
    clock += 5000;
    await expect(pool.acquire(projectN(99), ownerId)).rejects.toThrow(PreviewCapacityError);
  });

  it("does not reap other tenants' idle previews to serve a disabled owner's request", async () => {
    // Authorization (buildChildEnv, which raises DisabledUserError) must run
    // BEFORE ensureCapacity ever reaps: otherwise a request that is going to
    // be refused anyway gets to kill another tenant's idle preview on its
    // way to being refused.
    const pool = makePool({ idleMs: 1000 });
    const acquired: Project[] = [];
    for (let n = 0; n < MAX_PREVIEWS; n += 1) {
      const p = projectN(n);
      acquired.push(p);
      await pool.acquire(p, ownerId);
    }
    clock += 5000; // every existing preview is now idle enough to be reclaimable
    const disabledOwnerId = createUser(db, "disabled@example.com", "hash").id;
    db.prepare("UPDATE user SET disabled_at = ? WHERE id = ?").run(Date.now(), disabledOwnerId);
    await expect(pool.acquire(projectN(99), disabledOwnerId)).rejects.toThrow();
    expect(pool.list()).toHaveLength(MAX_PREVIEWS);
    expect(pool.list().map((p) => p.projectId).sort()).toEqual(acquired.map((p) => p.id).sort());
  });
});

describe("reaping", () => {
  it("kills a process idle past the timeout", async () => {
    const pool = makePool({ idleMs: 1000 });
    await pool.acquire(project, ownerId);
    clock += 1001;
    expect(pool.reapIdle()).toEqual([project.id]);
    expect(children[0]!.killed).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });

  it("never kills a process with work in flight, however long it has run", async () => {
    // A page regen takes about five minutes and issues no other request. If
    // idleness were measured only by elapsed time, the reaper would kill the
    // subprocess mid-run and leave a half-generated page.
    const pool = makePool({ idleMs: 1000 });
    await pool.acquire(project, ownerId);
    pool.retain(project.id);
    clock += 600_000;
    expect(pool.reapIdle()).toEqual([]);
    expect(children[0]!.killed).toBe(false);
  });

  it("becomes reapable once the work finishes, timed from the release", async () => {
    const pool = makePool({ idleMs: 1000 });
    await pool.acquire(project, ownerId);
    pool.retain(project.id);
    clock += 600_000;
    pool.release(project.id);
    expect(pool.reapIdle()).toEqual([]);   // the clock restarts at release
    clock += 1001;
    expect(pool.reapIdle()).toEqual([project.id]);
  });

  it("counts nested work, so the outer release does not free an inner run", async () => {
    const pool = makePool({ idleMs: 1000 });
    await pool.acquire(project, ownerId);
    pool.retain(project.id);
    pool.retain(project.id);
    pool.release(project.id);
    clock += 5000;
    expect(pool.reapIdle()).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("forgets a process that exits on its own, so the next request respawns", async () => {
    const pool = makePool();
    await pool.acquire(project, ownerId);
    children[0]!.emit("exit", 1, null);
    expect(pool.list()).toHaveLength(0);
    await pool.acquire(project, ownerId);
    expect(spawned).toHaveLength(2);
  });

  it("kills every child on shutdown", async () => {
    const pool = makePool();
    await pool.acquire(project, ownerId);
    mkdirSync(join(projectsRoot, "run-b"), { recursive: true });
    await pool.acquire(createProject(db, ownerId, "run-b", "Run B"), ownerId);
    await pool.shutdown();
    expect(children.every((c) => c.killed)).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });

  it("rejects rather than hanging when a child dies before announcing a port", async () => {
    const pool = new PreviewPool({
      db, masterKey: MASTER_KEY, projectsRoot, now: () => clock,
      spawnFn: () => { const c = fakeChild(); children.push(c); setImmediate(() => c.emit("exit", 1, null)); return c; },
    });
    await expect(pool.acquire(project, ownerId)).rejects.toThrow();
    expect(pool.list()).toHaveLength(0);
  });

  it("refuses a disabled owner", async () => {
    setApiKey(db, MASTER_KEY, ownerId, "sk-ant-user-key-1234");
    db.prepare("UPDATE user SET disabled_at = ? WHERE id = ?").run(Date.now(), ownerId);
    const pool = makePool();
    await expect(pool.acquire(project, ownerId)).rejects.toThrow(DisabledUserError);
    expect(spawned).toHaveLength(0);
  });

  it("refuses an unknown owner", async () => {
    // .toThrow() alone would still pass if UnknownUserError's own check were
    // deleted: agent-env.ts's next line (`user.disabledAt`) would throw a
    // TypeError on a null user, and the assertion would not notice the
    // difference. The specific error class is what this test claims to pin.
    const pool = makePool();
    await expect(pool.acquire(project, "no-such-user-id")).rejects.toThrow(UnknownUserError);
    expect(spawned).toHaveLength(0);
  });

  it("refuses a disabled owner on the reuse path, and does not hand back the still-running child", async () => {
    // A preview already running for a project must stop being reachable the
    // moment its owner is disabled — revocation is immediate elsewhere in
    // this codebase (see agent-env.ts's DisabledUserError), and a warm
    // process must not be the one place that guarantee quietly lapses.
    const pool = makePool();
    await pool.acquire(project, ownerId);
    db.prepare("UPDATE user SET disabled_at = ? WHERE id = ?").run(Date.now(), ownerId);
    await expect(pool.acquire(project, ownerId)).rejects.toThrow(DisabledUserError);
  });
});

describe("output redaction", () => {
  it("buffers stderr into lines before redacting, so a key split across two pipe chunks is not logged whole", async () => {
    // Pipe chunk boundaries carry no semantic meaning -- a key can land split
    // across two separate 'data' events on stderr exactly as easily as on
    // stdout. Redacting each chunk independently (rather than buffering into
    // complete lines first, the way stdout already does) would let either
    // half evade KEY_PATTERN and log both halves in plaintext.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pool = makePool({
        spawnFn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          spawned.push({ command, args, env: options.env });
          const child = fakeChild();
          children.push(child);
          setImmediate(() => {
            const baseIndex = args.indexOf("--base");
            child.stdout.emit(
              "data",
              Buffer.from(`PREVIEW_READY ${JSON.stringify({ port: 40001, base: baseIndex >= 0 ? args[baseIndex + 1] : "/" })}\n`),
            );
            // The key arrives split across two chunks with no line break in
            // between -- exactly the shape a real pipe can deliver.
            child.stderr.emit("data", Buffer.from("leaked key: sk-ant-abc"));
            child.stderr.emit("data", Buffer.from("def123\n"));
          });
          return child;
        },
      });
      await pool.acquire(project, ownerId);
      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).not.toContain("sk-ant-abcdef123");
      expect(logged).toContain("sk-ant-[redacted]");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("post-readiness child error handling", () => {
  it("keeps an 'error' listener attached to a running child, so a later kill() failure does not throw unhandled", async () => {
    // ChildProcess emits 'error' when a LATER kill() cannot deliver its
    // signal (see preview-proxy.ts's module comment, which states "an
    // 'error' event with no listener attached throws synchronously" as an
    // absolute rule). spawnAndAwaitReady's OWN "error" listener is removed
    // the moment readiness settles (success or failure either way) -- this
    // pins that something else picks the slot up once the child is actually
    // running, by proving `emit` itself does not throw for lack of a
    // listener.
    const pool = makePool();
    await pool.acquire(project, ownerId);
    expect(() => children[0]!.emit("error", new Error("kill ESRCH"))).not.toThrow();
  });
});

describe("bounded shutdown / kill escalation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("escalates a reaped child to SIGKILL when it ignores SIGTERM within the grace period", async () => {
    vi.useFakeTimers();
    const child = stubbornChild();
    const pool = makePool({
      idleMs: 1000,
      spawnFn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ command, args, env: options.env });
        children.push(child);
        const baseIndex = args.indexOf("--base");
        const base = baseIndex >= 0 ? args[baseIndex + 1] : "/";
        // A microtask, not setImmediate/setTimeout: this must fire
        // regardless of the fake timers installed above, and before the
        // listeners registered synchronously just below are attached would
        // lose the event entirely.
        void Promise.resolve().then(() => {
          child.stdout.emit("data", Buffer.from(`PREVIEW_READY ${JSON.stringify({ port: 40001, base })}\n`));
        });
        return child;
      },
    });
    await pool.acquire(project, ownerId);
    clock += 1001;
    expect(pool.reapIdle()).toEqual([project.id]);
    // Only SIGTERM (no explicit signal) has been sent so far — the grace
    // period has not elapsed yet.
    expect(child.killCalls).toEqual([undefined]);

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 100);
    expect(child.killCalls).toEqual([undefined, "SIGKILL"]);
  });

  it("escalates to SIGKILL on shutdown() too, for an already-running child that ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const child = stubbornChild();
    const pool = makePool({
      spawnFn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ command, args, env: options.env });
        children.push(child);
        const baseIndex = args.indexOf("--base");
        const base = baseIndex >= 0 ? args[baseIndex + 1] : "/";
        void Promise.resolve().then(() => {
          child.stdout.emit("data", Buffer.from(`PREVIEW_READY ${JSON.stringify({ port: 40001, base })}\n`));
        });
        return child;
      },
    });
    await pool.acquire(project, ownerId);

    const shutdownPromise = pool.shutdown();
    // shutdown() must not resolve while the child is still ignoring SIGTERM.
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 500);
    expect(child.killCalls).toEqual([undefined]);

    await vi.advanceTimersByTimeAsync(1000); // past the grace period
    await shutdownPromise; // must now resolve, having escalated
    expect(child.killCalls).toEqual([undefined, "SIGKILL"]);
  });

  it("shutdown() resolves promptly on a still-spawning entry, instead of hanging for up to 180s", async () => {
    vi.useFakeTimers();
    const pool = makePool({
      spawnFn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ command, args, env: options.env });
        const child = fakeChild();
        children.push(child);
        // Deliberately never announces readiness — stands in for a cold
        // spawn still in progress the moment shutdown() is called.
        return child;
      },
    });
    // Not awaited: this call never settles during the test (the child never
    // announces readiness, and time is never advanced far enough to trip
    // SPAWN_TIMEOUT_MS), so it must not block the assertions below.
    void pool.acquire(project, ownerId).catch(() => { /* never actually reached */ });
    await vi.advanceTimersByTimeAsync(0); // let acquire()'s spawn attempt register its entry

    const shutdownPromise = pool.shutdown();
    let shutdownResolved = false;
    void shutdownPromise.then(() => { shutdownResolved = true; });

    // Advance by exactly the bound: shutdown() must be done by now, well
    // short of MAX_SPAWN_ATTEMPTS * SPAWN_TIMEOUT_MS (180s) — the unbounded
    // wait this fix closes.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_SPAWN_WAIT_MS + 100);
    expect(shutdownResolved).toBe(true);
  });
});
