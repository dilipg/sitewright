# Preview Pool (slice 4c-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Vite dev server per open project, spawned on demand as a subprocess on a dynamic port, reverse-proxied at `/preview/<projectId>/*` after the ownership check, reaped when idle, hard-capped at 6.

**Architecture:** The hosted server never loads a generated project into its own process — it spawns `compiler/scripts/preview.ts` as a child and proxies to it. That is not a style preference: the server process holds the master key for every user's API key in memory, and a generated project's `vite.config.ts` is model-generated from a free-text brief, i.e. untrusted code. `import`ing it in-process would hand every user's key to a prompt injection. The pool owns process lifecycle; a separate proxy module owns byte-shuffling, including the WebSocket upgrade Vite's HMR needs.

**Tech Stack:** Node 24 (`node:http`, `node:child_process`, `node:net`), TypeScript, vitest. No new runtime dependencies — no `http-proxy`, no `express`.

## Context

Slice 4c is split in two because it is two subsystems. **This plan is 4c-1: the pool and the proxy.** 4c-2 mounts the twelve `/__*` compiler endpoints through it, wires per-request usage-log ingestion, and maps the typed API-key errors to HTTP statuses.

Read before starting:
- `docs/superpowers/specs/2026-08-04-accounts-byok-tenancy-design.md` — "Preview pool" (lines 168-175), the Architecture diagram (lines 66-86), "Operational requirements" (177-192), and **"Accepted risks" (194-208)**, which is what justifies the subprocess boundary.
- `CLAUDE.md` — the ownership map and the two `server/` rules.
- `docs/decisions.md` 2026-08-05 rows — 4b's decisions, including that `requireBudget` and `ingestUsageLog` still have no caller.

**State you inherit.** `server/` has a deny-by-default route table (`server/src/router.ts`, single-`:param` segment matching), `requireSession`, `requireProject`, `requireBudget`, and `project-registry.ts` whose three lists are a partition of the live table. `server/src/agent-env.ts` has `buildAgentEnv` with **no caller** — this plan is its first. `server/src/redact.ts` has `redactSecrets` with **no caller** — this plan is its first. `scripts/serve.ts` loads the master key, deletes it from `process.env`, opens the database, adopts existing projects, and listens.

## Global Constraints

1. **Never load a generated project in the server process.** Preview is always a child process. The server holds the master key; the project's Vite config is model-generated untrusted input.
2. **The child must not inherit the master key, and must not inherit the host's `ANTHROPIC_API_KEY` either.** The first would let untrusted config decrypt every stored key. The second is subtler and just as wrong: a user with no stored key would silently spend the host's money. Both are deletions, not omissions.
3. **Previewing is free; generating is not.** A user with no stored API key must still be able to open a preview. `buildAgentEnv` throws `MissingApiKeyError` in that case, and the pool must treat that as "spawn without a key", not as a failure.
4. **A process with work in flight is never reaped.** Spec decision 13 and the Operational requirements: killing a fan-out halfway leaves a half-generated project, which is worse than the overspend. Idle means idle, not quiet-for-a-while.
5. **Hard cap of 6 concurrent, with a clear error naming the cap** when it is reached.
6. **Proxy timeout above the slowest measured operation, with margin.** Measured in the spec: section regen ~90s, add-section ~84s, page regen ~5 min, export with build several minutes. And note the failure mode: **a 504 does not stop the subprocess**, so a premature timeout means the UI reports failure while the work completes, the user retries, and two page regens mutate one directory.
7. **Auth lives at the HTTP boundary only.** `compiler/scripts/preview.ts` stays unauthenticated and locally usable; `npm run check` never requires a login. Changes to `compiler/` in this plan are additive options with unchanged defaults.
8. **No HTTP route may create a user.**
9. **Nothing may log an API key or the master key.** Child stdout/stderr passes through `redactSecrets` before it reaches any log sink.
10. **No new runtime dependencies.**
11. **No platform-specific path literals in assertions.** A win32 literal passes on Windows and turns ubuntu CI red; this shipped three times in slice 4a. Build paths with `node:path`.
12. **Every test must fail if the behavior it names is removed.** Perturb, watch the named assertion fail, restore. Assertions ordered behind one that fails first, and comparisons between things that structurally cannot differ, are the two recurring shapes to avoid.
13. **Never modify `docs/` to make code pass.** If the spec is wrong or ambiguous, stop and report it.
14. **Every child process must die with the server.** An orphaned Vite server holding a port is the failure this pool exists to bound.

---

### Task 1: Teach the preview CLI a dynamic port, a base path, and a machine-readable ready line

**Files:**
- Modify: `compiler/src/preview.ts` (add `base` to `PreviewOptions`)
- Modify: `compiler/scripts/preview.ts` (`--base` flag, machine-readable ready line)
- Test: `compiler/src/preview.test.ts` (or the existing preview test file — find it first)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `PreviewOptions` gains `base?: string`.
  - The CLI accepts `--base <path>` and, in addition to its existing human line, prints exactly one line `PREVIEW_READY {"port":<number>,"base":"<string>"}` once listening.

**Why a `base`.** The pool proxies at `/preview/<projectId>/`, so the child must generate asset URLs under that prefix or every `/src/main.tsx` request lands on the parent's root and 404s. Vite's `base` is the supported mechanism, and passing it in the inline config merges over the project's own `vite.config.ts` without editing a generated file.

**Why a machine-readable line.** The parent needs the OS-assigned port. Parsing the existing prose line would couple the pool to a human-facing string. The `PREVIEW_READY ` prefix mirrors `REGEN_RESULT ` in `compiler/src/regen-api.ts` — an existing convention in this codebase for a machine-readable line on a child's stdout.

- [ ] **Step 1: Find the existing preview tests and read them**

Run: `ls compiler/src/preview*.ts compiler/src/*preview*` and read whatever test file covers `startPreviewServer`. Match its style; do not introduce a second harness shape. Note the default port is 5273 and `strictPort: true`.

- [ ] **Step 2: Write the failing tests**

Add to the existing preview test file:

**CORRECTED — read this before writing the port test.** The plan originally told you to ask Vite for port 0 and let the OS assign one. **That does not work, verified empirically twice:** Vite treats `0` as falsy when deciding whether a port was configured, so `--port 0` silently serves on Vite's own default (5173), and two children both asking for port 0 collide. The port therefore has to be chosen by the PARENT and passed concretely — that is task 2's `findFreePort`.

The original assertion here was also too weak to catch it: it asserted `port !== 5273`, and 5173 (Vite's default) satisfies that, so the test passed green under a title that was false. Do not reproduce it. Write this instead:

```ts
  it("honours the concrete port it is given", async () => {
    // The pool picks the port itself and passes it, so this is the contract
    // that actually matters.
    const port = await someFreePortHelper();   // bind :0 with node:net, read the port, close
    const server = await startPreviewServer(fixtureDir, { port });
    try {
      const address = server.httpServer?.address();
      expect((address as { port: number }).port).toBe(port);
    } finally {
      await server.close();
    }
  });

  it("does NOT treat port 0 as a request for an ephemeral port", async () => {
    // Documents the trap rather than leaving it to be rediscovered: Vite
    // treats 0 as "no port configured" and falls back to its own default, so
    // asking for 0 gives every child the SAME port and the second one dies on
    // strictPort. This is why the parent probes for a port instead.
    const server = await startPreviewServer(fixtureDir, { port: 0 });
    try {
      const port = (server.httpServer?.address() as { port: number }).port;
      // Deliberately not asserting a specific number — Vite's default is
      // Vite's business. What matters is that 0 did not mean "ephemeral".
      expect(port).toBeGreaterThan(0);
      expect(server.config.server.port).not.toBe(0);
    } finally {
      await server.close();
    }
  });

  it("serves under a base path when given one", async () => {
    const server = await startPreviewServer(fixtureDir, { port: 0, base: "/preview/abc/" });
    try {
      expect(server.config.base).toBe("/preview/abc/");
    } finally {
      await server.close();
    }
  });

  it("keeps serving at the root when given no base", async () => {
    const server = await startPreviewServer(fixtureDir, { port: 0 });
    try {
      expect(server.config.base).toBe("/");
    } finally {
      await server.close();
    }
  });
```

Use whatever the existing tests use for `fixtureDir` (the `fixtures/` project). If the existing tests do not start a real server, follow their approach instead and report what you found.

- [ ] **Step 3: Implement**

In `compiler/src/preview.ts`, extend the options and pass `base` through:

```ts
export interface PreviewOptions {
  port?: number;
  /**
   * Vite's base path. The hosted server proxies each preview at
   * `/preview/<projectId>/`, and without a matching base every asset URL the
   * dev server generates (`/src/main.tsx`, `/@vite/client`) points at the
   * PROXY's root instead of the project's, so the page loads and every module
   * 404s. Undefined leaves Vite's own default ("/"), which is what the local
   * `npm run preview` wants.
   */
  base?: string;
}
```

and in the `createServer` call add `base: options.base` alongside `root` and `configFile`. Passing `undefined` is the same as not passing it, so the local default is untouched.

In `compiler/scripts/preview.ts`, add a `--base` flag and the ready line. Note the existing arg parsing filters out flag values positionally — read it carefully and extend it so `--base` does not break the `<projectDir>` detection. Then after listening:

```ts
// Machine-readable, for the hosted server's preview pool: the parent needs
// the OS-assigned port when it spawned us with `--port 0`. Prefixed like
// REGEN_RESULT in regen-api.ts, the existing convention for a line a parent
// process parses. The human line above stays for local use.
console.log(`PREVIEW_READY ${JSON.stringify({ port: actualPort, base })}`);
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w compiler -- preview`
Expected: PASS. Then run the whole compiler suite (`npm test -w compiler`) — 170 tests must stay green, and the compiler e2e (`npm run test:e2e -w compiler`, 13 tests) must too, since it drives the preview server.

**If port 0 does not work with `strictPort: true`**, stop and report exactly what happened rather than removing `strictPort` — that flag is what makes a port collision loud instead of silent, and the pool depends on it.

- [ ] **Step 5: Verify the CLI end to end by hand**

Run: `node compiler/scripts/preview.ts fixtures --port 0` (adjust the fixture path to the real one), confirm a `PREVIEW_READY {"port":<n>,...}` line appears with a plausible ephemeral port, `curl` that port's root to confirm HTML comes back, then kill it. Paste the observed line into your report.

- [ ] **Step 6: Commit**

```bash
git add compiler/src/preview.ts compiler/scripts/preview.ts compiler/src/preview.test.ts
git commit -m "feat(compiler): allow a dynamic port, a base path, and a machine-readable ready line"
```

---

### Task 2: The pool — spawn, reuse, reap, cap

**Files:**
- Create: `server/src/preview-pool.ts`
- Test: `server/src/preview-pool.test.ts`
- Modify: `server/src/agent-env.ts` (extract a `scrubbedEnv` helper)
- Modify: `server/src/agent-env.test.ts`

**Interfaces:**
- Consumes: `buildAgentEnv`, `MissingApiKeyError`, `UnknownUserError`, `DisabledUserError` from `./agent-env.ts`; `redactSecrets` from `./redact.ts`; `resolveProjectDirectory` from `./projects.ts`; `Project` from `./projects.ts`.
- Produces:
  - `findFreePort(): Promise<number>`
  - `const MAX_PREVIEWS = 6`
  - `class PreviewCapacityError extends Error` — message names the cap.
  - `interface PreviewProcess { projectId: string; port: number; base: string; inFlight: number; lastUsedAt: number }`
  - `class PreviewPool` with:
    - `constructor(deps: { db, masterKey, projectsRoot, previewCommand?, idleMs?, now?, spawnFn? })`
    - `acquire(project: Project, ownerId: string): Promise<PreviewProcess>` — spawns or reuses; increments nothing.
    - `retain(projectId: string): void` / `release(projectId: string): void` — in-flight accounting, so a reaper cannot kill a process mid-regen.
    - `reapIdle(): string[]` — kills processes with `inFlight === 0` and `lastUsedAt` older than `idleMs`; returns the project ids killed.
    - `shutdown(): Promise<void>` — kills every child.
    - `list(): PreviewProcess[]` — for tests and an operator view.

**The env is the security-critical part of this task.** Three separate rules:
- The master key must not reach the child (untrusted `vite.config.ts` runs there).
- The host's own `ANTHROPIC_API_KEY` must not reach the child either. If it did, a user with no stored key would spend the host's money — silently, and with no `usage_event` attribution problem to reveal it, since ingestion attributes by the requesting user regardless of whose key paid.
- A user WITH a stored key gets it, so 4c-2's billable endpoints work.

- [ ] **Step 1: Extract `scrubbedEnv` in `agent-env.ts`**

There must be exactly one place that decides what a child may not inherit. Add:

```ts
/**
 * A copy of the environment with everything a child must never inherit
 * removed. Two deletions, for two different reasons:
 *
 * - The master key decrypts every user's stored API key. A preview child runs
 *   the project's own model-generated vite.config.ts, so anything in its
 *   environment is reachable by untrusted code.
 * - The HOST's ANTHROPIC_API_KEY. This one is easy to miss because it looks
 *   like a harmless default: if a user has no stored key and the child
 *   inherits the operator's, generation still works — and the operator pays,
 *   for a user the spend cap will happily record as having spent nothing they
 *   were billed for. Absent is correct; inherited is a silent transfer.
 *
 * A copy, never a mutation of process.env, which would leak into every later
 * spawn in this process.
 */
export function scrubbedEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env[MASTER_KEY_ENV_VAR];
  delete env.ANTHROPIC_API_KEY;
  return env;
}
```

and rewrite `buildAgentEnv`'s body to use it:

```ts
  const apiKey = resolveApiKey(db, masterKey, userId, pastedKey);
  const env = scrubbedEnv(baseEnv);
  // Last assignment wins deliberately: the host's own key was just removed by
  // scrubbedEnv, and the request's user pays for the request.
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
```

Add to `server/src/agent-env.test.ts`:

```ts
  it("removes the host's own ANTHROPIC_API_KEY, so an absent user key is absent rather than the operator's", () => {
    const env = scrubbedEnv({ ANTHROPIC_API_KEY: "sk-ant-host", PATH: "/usr/bin" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("removes the master key", () => {
    const env = scrubbedEnv({ [MASTER_KEY_ENV_VAR]: "secret" });
    expect(env[MASTER_KEY_ENV_VAR]).toBeUndefined();
  });

  it("does not mutate the environment it was given", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-host" };
    scrubbedEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-host");
  });
```

Verify `buildAgentEnv`'s existing tests still pass unchanged — the refactor must not alter its behavior for a user who has a key.

- [ ] **Step 2: Write the failing pool tests**

The pool's tests must not spawn real Vite servers — that is minutes per test and flaky in CI. Inject the spawn: the constructor takes an optional `spawnFn` defaulting to the real one, and the tests pass a fake that returns a controllable child. Write the fake as a small helper in the test file that returns an object with `stdout`/`stderr` as `EventEmitter`s, a `kill()` that records the call and emits `exit`, and a `pid`.

```ts
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createProject, type Project } from "./projects.ts";
import { setApiKey } from "./api-keys.ts";
import { MAX_PREVIEWS, PreviewCapacityError, PreviewPool } from "./preview-pool.ts";

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
    expect(preview.port).toBe(40001);
    expect(preview.projectId).toBe(project.id);
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
    setApiKey(db, MASTER_KEY, ownerId, "sk-ant-user-key-1234");
    const pool = makePool();
    await pool.acquire(project, ownerId);
    expect(spawned[0]!.env.WEBGEN_MASTER_KEY).toBeUndefined();
  });

  it("spawns without a key when the user stored none, rather than refusing to preview", async () => {
    // Previewing is free; generating is not. A user with no key must still be
    // able to open a project.
    const pool = makePool();
    const preview = await pool.acquire(project, ownerId);
    expect(preview.port).toBe(40001);
    expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does not hand a keyless user the host's own key", async () => {
    const pool = makePool();
    await pool.acquire(project, ownerId);
    expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
```

For that last test to mean anything the base environment must actually contain a host key, so build the pool with an explicit `baseEnv` the pool passes through to `scrubbedEnv`/`buildAgentEnv` — add a `baseEnv` option to the constructor for exactly this reason, defaulting to `process.env`, and set it to `{ ANTHROPIC_API_KEY: "sk-ant-HOST" }` in that test. **If you cannot make the assertion fail by removing the `delete env.ANTHROPIC_API_KEY` line, the test is not pinning it — say so.**

Then the capacity and reaping cases:

```ts
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
    await expect(pool.acquire(project, ownerId)).rejects.toThrow();
    expect(spawned).toHaveLength(0);
  });
});
```

`mkdirSync` for `run-b` is needed in that shutdown test — add it. Adjust the fake-child helper if the real spawn's contract differs; report any adjustment.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- preview-pool.test.ts`
Expected: FAIL — `Cannot find module './preview-pool.ts'`.

- [ ] **Step 4: Implement `server/src/preview-pool.ts`**

Write it to satisfy the tests above. The design points that the tests pin, so you know what the shape has to be:

- `findFreePort()` binds a `node:net` server on port 0, reads the assigned port, closes it, and resolves that number. This is inherently a check-then-use race, and that is acceptable **only because `strictPort` makes losing the race a loud child exit rather than a silent rebind**: `acquire` retries the whole spawn up to 3 times on a child that dies without announcing readiness, and gives up with a clear error after that. Comment both halves — the race and why it is tolerable.
- One `Map<string, Entry>` keyed by project id, where an `Entry` holds the child, port, base, `inFlight`, `lastUsedAt`, and the pending-ready promise.
- `acquire` returns the existing entry's `PreviewProcess` if the child is alive, and **stores the in-flight spawn promise in the map before awaiting it**, so two concurrent first requests share one spawn.
- Readiness: accumulate `stdout` data into a buffer, split on `\n`, and resolve on the first line starting with `PREVIEW_READY `. Reject if the child exits first, and reject on a spawn timeout — pick a generous one (a cold Vite start on a large generated project is seconds, not milliseconds; 60s with a comment).
- `child.on("exit")` deletes the entry, so a crashed preview is respawned rather than proxied to a dead port.
- Capacity: when the map is full, call `reapIdle()` once and re-check; if still full, throw `PreviewCapacityError` with a message naming `MAX_PREVIEWS`.
- Env: call `buildAgentEnv({ db, masterKey, userId: ownerId, baseEnv })` inside a `try`; on `MissingApiKeyError` fall back to `scrubbedEnv(baseEnv)`; let `UnknownUserError` and `DisabledUserError` propagate. Comment why the three are treated differently.
- Child output: attach `stderr` (and non-ready `stdout` lines) to a log that passes text through `redactSecrets` before `console.error`/`console.log`. This is `redactSecrets`' first call site — the guarantee stops being "true by construction" the moment a child's output is logged, which is exactly now.
- `kill`: send `SIGTERM`. On Windows `SIGTERM` is not really a signal — `child.kill()` terminates the process, which is what is wanted; note that in a comment rather than reaching for `taskkill`.
- Never `unref()` a child: an orphaned Vite server holding a port is the failure this pool exists to bound.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- preview-pool.test.ts`

- [ ] **Step 6: Prove four assertions are load-bearing**

Perturb each, confirm the named test fails, restore, and report the exact failure message:

1. Remove `delete env.ANTHROPIC_API_KEY` from `scrubbedEnv`. Expected: "does not hand a keyless user the host's own key" FAILS.
2. Make `reapIdle` ignore `inFlight`. Expected: "never kills a process with work in flight" FAILS.
3. Remove the store-the-promise-before-awaiting in `acquire`. Expected: "does not spawn twice for two concurrent first requests" FAILS.
4. Remove the `child.on("exit")` cleanup. Expected: "forgets a process that exits on its own" FAILS.

If any perturbation does not fail, that test is not pinning what it claims — report it rather than moving on.

- [ ] **Step 7: Run the full server suite and commit**

Run: `npm test -w server`

```bash
git add server/src/preview-pool.ts server/src/preview-pool.test.ts server/src/agent-env.ts server/src/agent-env.test.ts
git commit -m "feat(server): pool one preview subprocess per project, reaped and capped"
```

---

### Task 3: The reverse proxy, including the WebSocket upgrade

**Files:**
- Create: `server/src/preview-proxy.ts`
- Test: `server/src/preview-proxy.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (deliberately — this module shuffles bytes and knows nothing about projects, ownership, or the pool).
- Produces:
  - `const PREVIEW_PROXY_TIMEOUT_MS`
  - `proxyHttp(args: { req: IncomingMessage; res: ServerResponse; port: number; path: string }): Promise<void>`
  - `proxyUpgrade(args: { req: IncomingMessage; socket: Duplex; head: Buffer; port: number; path: string }): void`

**The timeout is a spec requirement with a stated reason.** Measured slowest operation is an export with a production build, "several minutes"; page regen is ~5 minutes. Set `PREVIEW_PROXY_TIMEOUT_MS` to **15 minutes** and put the reasoning in the comment: a 504 does not stop the subprocess, so a premature timeout produces a UI that reports failure while the work completes, a user who retries, and two page regens mutating one directory.

**The WebSocket upgrade is not optional.** Vite's HMR is a WebSocket. Without proxying `upgrade`, the client retries forever, the console fills with errors, and a regenerated section never appears without a manual reload — which the spec's decision 3 explicitly relies on ("regeneration expects HMR-fresh modules").

- [ ] **Step 1: Write the failing tests**

Test against a real `node:http` server as the upstream — no mocking of sockets. That is the only way this module's behavior is meaningfully verified.

```ts
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_PROXY_TIMEOUT_MS, proxyHttp } from "./preview-proxy.ts";

let upstream: Server;
let upstreamPort: number;
let seen: Array<{ url: string; method: string; headers: Record<string, unknown>; body: string }>;

beforeEach(async () => {
  seen = [];
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "", method: req.method ?? "",
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/boom") { res.writeHead(500); res.end("upstream error"); return; }
      res.writeHead(200, { "Content-Type": "text/plain", "X-Upstream": "yes" });
      res.end("hello from upstream");
    });
  });
  upstream.listen(0);
  await once(upstream, "listening");
  upstreamPort = (upstream.address() as { port: number }).port;
});

afterEach(async () => {
  upstream.close();
  await once(upstream, "close");
});
```

Then drive `proxyHttp` through a second real server that proxies to the first, and use `fetch` against the proxy. Assert, each as its own case:

1. A GET's body, status and upstream headers reach the client (`X-Upstream: yes`, `hello from upstream`).
2. The rewritten path arrives upstream — proxying `/preview/abc/src/main.tsx` with `path: "/src/main.tsx"` makes `seen[0].url` exactly `/src/main.tsx`.
3. A POST's request body arrives intact upstream (send JSON, assert `seen[0].body`).
4. An upstream 500 is passed through as 500, not converted to 502.
5. When the upstream is not listening at all (use a port you bind and immediately close), the client gets **502**, and the response is JSON with an `error` — not a hung socket. This is the case a dead preview process produces.
6. `PREVIEW_PROXY_TIMEOUT_MS` is at least 10 minutes: `expect(PREVIEW_PROXY_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000)`. A bare number assertion is weak on its own, so also assert it is set on the upstream request — see step 3.

For the upgrade path, write one end-to-end test using `node:http`'s own `upgrade` event on both ends: a client sends `Connection: Upgrade`, the upstream responds `101` and then writes a frame, and the test asserts the bytes arrive back through the proxy. If you cannot get a reliable assertion without adding a WebSocket dependency, use a raw `net` socket and a hand-written upgrade handshake — do **not** add a dependency, and do not skip the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- preview-proxy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/preview-proxy.ts`**

Use `node:http`'s `request` to forward, `pipe` in both directions, and `server.on("upgrade")`-style socket forwarding for the WebSocket case. Points to get right:

- Forward the method, the rewritten path, and the headers. Set `host` to `localhost:<port>` — leaving the proxy's own `Host` header makes Vite's origin checks reject the request.
- Copy the upstream status and every upstream header onto the response.
- `request.setTimeout(PREVIEW_PROXY_TIMEOUT_MS)` and, on timeout, destroy the upstream request and answer 504 — but only if headers have not been sent, else just end the response.
- On `error` from the upstream request, answer **502** with a JSON body if nothing has been written yet. A dead child must not become a hung request.
- For the upgrade, forward the raw handshake, write `head` if non-empty, and pipe socket-to-socket both ways. Destroy one side when the other closes, or a killed preview leaks sockets.
- Never throw out of either function: both are called from a request handler, and an uncaught throw in an async listener is answered by nothing at all (slice 2 shipped exactly that bug — `node:http` does not await a rejected listener promise, so the connection hung to timeout).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- preview-proxy.test.ts`

- [ ] **Step 5: Prove two assertions are load-bearing**

1. Remove the `host` header rewrite. Expected: report what breaks — if no test fails, add one asserting `seen[0].headers.host` is `localhost:<upstreamPort>`, because Vite's host check depends on it.
2. Remove the upstream `error` handler. Expected: the "upstream not listening gives 502" test FAILS (it will hang or throw rather than answering 502).

Report both observed failures.

- [ ] **Step 6: Commit**

```bash
git add server/src/preview-proxy.ts server/src/preview-proxy.test.ts
git commit -m "feat(server): reverse-proxy preview HTTP and the HMR websocket"
```

---

### Task 4: Mount it — `/preview/:projectId/*`, the reaper, and shutdown

**Files:**
- Create: `server/src/preview-routes.ts`
- Test: `server/src/preview-routes.test.ts`
- Modify: `server/src/router.ts` (a wildcard tail after a `:param`, if it does not already support one)
- Modify: `server/src/router.test.ts`
- Modify: `server/src/compose.ts` (accept and spread the preview routes)
- Modify: `server/src/project-registry.ts` + its test (declare the new endpoint)
- Modify: `server/scripts/serve.ts` (construct the pool, run the reaper, kill children on shutdown)

**Interfaces:**
- Consumes: `PreviewPool` from `./preview-pool.ts`; `proxyHttp` from `./preview-proxy.ts`; `requireProject` from `./require-project.ts`.
- Produces: `previewRoutes(deps: { db: DatabaseSync; pool: PreviewPool }): Route[]`, and `buildRoutes` gains an optional `pool`.

**The router needs a tail wildcard, and this is the one place to be careful.** `/preview/:projectId/*` must match `/preview/abc/src/main.tsx` — a path with slashes after the parameter. Today the matcher requires equal segment counts precisely so a parameter cannot span a slash, and `docs/decisions.md` records why: a parameter that spans slashes means registering one route silently exposes every path beneath it. A tail wildcard is that same hazard, made explicit and opt-in. So:

- Only a **trailing** `*` is allowed, and only as the final segment. A `*` anywhere else must throw at table-build time, like the duplicate-route guard already does.
- The matched tail is exposed separately (e.g. `ctx.params["*"]`), decoded per segment with the same `URIError` guard the existing matcher uses — an unguarded `decodeURIComponent` on a malformed escape rejected the listener promise and left the request with no response at all.
- Literal and single-param routes must still win over a wildcard, so a future `/preview/:projectId/status` cannot be shadowed. Add a third matching pass rather than reordering the array.

- [ ] **Step 1: Extend the router, test-first**

Add to `server/src/router.test.ts`:

```ts
  it("matches a trailing wildcard across slashes and exposes the tail", async () => { /* /preview/:id/* vs /preview/abc/src/main.tsx -> params.id === "abc", params["*"] === "src/main.tsx" */ });
  it("matches an empty tail", async () => { /* /preview/abc/ -> params["*"] === "" */ });
  it("prefers a literal or single-param route over a wildcard", async () => { /* register both /preview/:id/status and /preview/:id/*; /preview/abc/status hits the former */ });
  it("throws when a wildcard is not the final segment", () => { /* /preview/*/thing */ });
  it("does not answer a wildcard route for a malformed percent-escape in the tail", async () => { /* %ZZ -> 404, and crucially A RESPONSE IS WRITTEN */ });
```

Fill each in against the file's existing style. Then implement in `server/src/router.ts`, keeping the dedupe key correct for wildcard patterns.

- [ ] **Step 2: Write `preview-routes.ts` and its tests**

One route: `GET /preview/:projectId/*`, wrapped in `requireProject` with `{ from: "param", name: "projectId" }`, whose handler acquires from the pool, retains, proxies, and releases in a `finally`.

```ts
      handler: requireProject(db, { from: "param", name: "projectId" }, async (req, res, ctx) => {
        let preview;
        try {
          preview = await pool.acquire(ctx.project, ctx.user.id);
        } catch (error) {
          // Capacity is the user's problem to act on and says so; anything
          // else is ours. Neither may leak a stack trace or an env value.
          sendJson(res, error instanceof PreviewCapacityError ? 503 : 500, {
            error: error instanceof PreviewCapacityError ? error.message : "could not start the preview",
          });
          return;
        }
        // retain/release BRACKET the proxy so the reaper cannot kill a
        // subprocess mid-request. In a finally, because a client that
        // disconnects mid-export must still release the slot — otherwise one
        // aborted request pins a preview forever and the cap leaks.
        pool.retain(ctx.project.id);
        try {
          await proxyHttp({ req, res, port: preview.port, path: `/${ctx.params["*"] ?? ""}` });
        } finally {
          pool.release(ctx.project.id);
        }
      }),
```

Tests (drive the real route table through `createRequestListener`, with a fake pool):
1. An unauthenticated request gets 401 and **never touches the pool** (assert `acquire` was not called — a pool that spawns before authentication is a denial-of-service surface).
2. A logged-in user requesting **another user's** project gets 404, and the pool is never touched.
3. The owner's request proxies, and the tail path arrives at the proxy verbatim.
4. `PreviewCapacityError` becomes 503 with the cap in the message.
5. Any other spawn failure becomes 500 and the body contains no stack trace and no environment value.
6. `release` is called even when the proxy throws. Assert with a proxy fake that rejects.

- [ ] **Step 3: Declare the endpoint in the registry**

Add `{ method: "GET", path: "/preview/:projectId/*", idFrom: { from: "param", name: "projectId" }, billable: false }` to `PROJECT_SCOPED_ENDPOINTS`. It is project-scoped and not billable — serving files spends nothing.

Then **check the 4b tripwire still holds**: `project-registry.test.ts` asserts no billable endpoint is mounted. This route is not billable, so it must stay green. Run that file and confirm. If the partition tests fail because the new path is now live, fix the registry, never the test's meaning.

- [ ] **Step 4: Wire the lifecycle in `serve.ts`**

Order matters and is already load-bearing in this file (master key → delete from env → open db → adopt → createServer → error handler → listen with the process handlers inside). Add:

- Construct the pool after the database is open, passing `projectsRoot` and the master key already in hand.
- Pass it to `buildRoutes({ db, masterKey, secureCookies, pool })`.
- Register `server.on("upgrade")` to resolve the project from the URL, check ownership, and call `proxyUpgrade`. **An upgrade must be authorized exactly like a request** — it carries the session cookie, and an unauthenticated upgrade that proxies straight through is an ownership hole the route table cannot see, because upgrades never reach the route table.
- A reaper on `setInterval(...).unref()` calling `pool.reapIdle()`, logging what it killed.
- On `SIGINT`/`SIGTERM`, `await pool.shutdown()` then exit, so children never outlive the server.

Add a comment on the upgrade handler explaining that it is the one authorization path outside the route table, and therefore the one that has to be re-derived by hand.

- [ ] **Step 5: Verify the whole thing against a real project, by hand**

The unit tests all use a fake spawn, so nothing so far proves a real Vite child works behind the proxy. Do this manually and paste the results into your report:

1. Create a user with the CLI, store no API key.
2. Start the server with `--projects-root` pointing at a real generated project (or `fixtures/`, if a generated one is not available — say which you used).
3. Log in with `curl -c` to get a session cookie.
4. `curl -b` the project's `/preview/<id>/` and confirm HTML comes back.
5. Confirm a nested asset resolves — request whatever `<script src>` the HTML references and confirm 200, not 404. **This is the test of the `base` path**; if assets 404, the base is wrong and the proxy is useless.
6. Confirm a second request does not spawn a second child (the server logs one spawn).
7. Open the page in a browser if possible and confirm no HMR WebSocket errors in the console. If HMR cannot connect through the subpath proxy, **report it as a finding** — do not disable HMR to make it quiet, and do not claim it works without looking.
8. `Ctrl-C` the server and confirm no `node`/`vite` process is left holding the child's port.

- [ ] **Step 6: Run everything and commit**

Run: `npm run check` — exit 0, and note the per-package counts.

```bash
git add server/src/preview-routes.ts server/src/preview-routes.test.ts server/src/router.ts server/src/router.test.ts server/src/compose.ts server/src/project-registry.ts server/src/project-registry.test.ts server/scripts/serve.ts
git commit -m "feat(server): mount the preview proxy behind the ownership check"
```

---

## What this slice deliberately does not do

State these in the final report rather than letting a reader infer completeness:

1. **The twelve `/__*` compiler endpoints are still unmounted.** That is 4c-2, along with per-request usage-log ingestion (`ingestUsageLog`'s first caller) and mapping `MissingApiKeyError` / `UndecryptableApiKeyError` / `DisabledUserError` onto HTTP statuses.
2. **`/__archetypes` has a known wrinkle for 4c-2**, worth flagging now: the registry lists it as session-only and project-independent, but it is served by `regenApiPlugin`, which only exists inside a project's preview process. Serving it without a project means either picking an arbitrary running preview or giving the server its own copy of the archetype catalog. Neither is obviously right, and the spec does not say.
3. **Paste-per-session API keys are in tension with a pooled process, and this plan does not resolve it.** `resolveApiKey` accepts a pasted key, but no HTTP endpoint passes one today, so nothing regresses. The tension is structural: a long-lived child gets its key at spawn, so a key pasted later cannot reach it without a restart — and restarting would kill work in flight, which spec decision 13 forbids. Whoever adds paste-per-session needs per-request key injection instead, which means the orchestrator spawn takes the key from the request rather than from its parent's environment. **Flagged for a human ruling, not resolved here.**
4. **Accepted risk 1 is now real, not theoretical.** Same-origin preview means generated code shares an origin with the editor and can make same-site authenticated requests. The spec accepts this and lists the five-step migration to cross-origin; nothing in this plan changes it. Worth restating in the report because this slice is the moment the risk goes from designed-for to live.
