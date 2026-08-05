// server/src/preview-pool.ts
/**
 * One Vite preview subprocess per open project, spawned, reused, reaped and
 * capped.
 *
 * Never loads a generated project in THIS process: everything that runs the
 * project's own model-generated code (its `vite.config.ts`, its plugin
 * chain) runs in a child, spawned with a deliberately narrowed environment
 * (see `PreviewPool.buildChildEnv`, and `scrubbedEnv`/`buildAgentEnv` in
 * `agent-env.ts`, which do the actual narrowing).
 *
 * Three properties this file exists to hold, all covered by
 * `preview-pool.test.ts`:
 *   - a process with work in flight (`retain`/`release`) is NEVER reaped,
 *     however long it has been running — a page regen takes about five
 *     minutes and looks, from the outside, exactly like an idle tab;
 *   - the child inherits neither the master key nor the host's own
 *     `ANTHROPIC_API_KEY` — a keyless user must get NO key, never the
 *     operator's;
 *   - a child is never `unref()`'d — an orphaned Vite server holding a port
 *     open past the parent's own lifetime is the exact failure this pool
 *     exists to bound.
 *
 * A fourth, easy to miss until a review found it: the child's `stdout` is
 * NOT a trust boundary. It runs the project's own model-generated
 * `vite.config.ts` — untrusted code that can print to stdout before
 * `compiler/scripts/preview.ts` ever does. A well-formed `PREVIEW_READY`
 * line is therefore only ever a HINT that the child believes it is ready,
 * never the source of truth for the port traffic gets proxied to — see
 * `spawnAndAwaitReady` and `verifyPort`.
 */
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createConnection, createServer } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  buildAgentEnv,
  MissingApiKeyError,
  scrubbedEnv,
} from "./agent-env.ts";
import type { Project } from "./projects.ts";
import { resolveProjectDirectory } from "./projects.ts";
import { redactSecrets } from "./redact.ts";

export const MAX_PREVIEWS = 6;

/** A truly idle preview (no requests, no in-flight work) this long gets reaped. */
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/**
 * A cold Vite start on a large generated project is seconds, not
 * milliseconds. This is generous on purpose: it exists only to fail loudly
 * — reject the caller's `acquire()` — rather than hang a request forever if
 * a child never announces readiness at all.
 */
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * `findFreePort` + `acquire`'s retry loop below: probing a port and then
 * asking Vite to bind it is inherently a check-then-use race (something
 * else can grab the same port in between). Retrying a handful of times is
 * the mitigation.
 */
const MAX_SPAWN_ATTEMPTS = 3;

export class PreviewCapacityError extends Error {
  constructor() {
    super(`preview capacity reached: at most ${MAX_PREVIEWS} preview processes may run at once`);
    this.name = "PreviewCapacityError";
  }
}

export interface PreviewProcess {
  projectId: string;
  port: number;
  base: string;
  inFlight: number;
  lastUsedAt: number;
}

/**
 * The minimal shape the pool needs from a spawned child — deliberately NOT
 * node:child_process's `ChildProcess` itself, so a test's fake need not
 * implement the dozens of members (stdin, connected, disconnect, send, …)
 * the pool will never touch. `kill()` takes no signal: the pool always wants
 * the default (SIGTERM), so there is nothing for a caller to pass.
 */
export interface SpawnedChild {
  readonly pid?: number;
  readonly killed?: boolean;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  kill(): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches EventEmitter's own (loose, overloaded) signature; see spawnedChild's callers, which only ever pass a two-arg "exit" listener.
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => SpawnedChild;

/**
 * Binds a `node:net` server on port 0 (the one place port 0 is safe: this
 * server is closed again before its port is ever used), reads back the
 * OS-assigned port, and resolves that number.
 *
 * Vite itself does NOT honour port 0 — it treats 0 as "no port configured"
 * and falls back to its own default (5173), so every child asking for 0
 * would collide on the same port. The parent must probe and pass a concrete
 * port instead, which is what every caller of this function does.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (port === null) {
          reject(new Error("findFreePort: could not determine the bound port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

/** A few attempts a short distance apart — see `defaultVerifyPort`. */
const VERIFY_ATTEMPTS = 10;
const VERIFY_INTERVAL_MS = 150;

function connectOnce(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

/**
 * Confirms `port` actually accepts a TCP connection — the one thing the
 * child cannot lie about via stdout, unlike a `PREVIEW_READY` line. A few
 * attempts a short distance apart: there is a small, real window between
 * Vite deciding to print its own readiness line and the listener actually
 * accepting connections, not because the connection itself is expected to
 * be flaky.
 *
 * Overridable via `PreviewPoolDeps.verifyPort` — the tests inject a fake
 * here for the same reason they inject a fake `spawnFn`: a test's fake
 * child never opens a real socket, so proving "acquire resolves once the
 * child is ready" and "acquire rejects and kills the child when it never
 * becomes ready" needs deterministic, instant control over this decision
 * rather than a real (and, against a port nothing is listening on, always
 * failing) network wait.
 */
async function defaultVerifyPort(port: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    try {
      await connectOnce(port);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < VERIFY_ATTEMPTS) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, VERIFY_INTERVAL_MS));
      }
    }
  }
  throw new Error(
    `port ${port} never accepted a connection after ${VERIFY_ATTEMPTS} attempts (last error: ${String(lastError)})`,
  );
}

// Resolved from this file's own URL, never a hardcoded absolute path — the
// pool must keep working regardless of where the repo is checked out.
const DEFAULT_PREVIEW_SCRIPT = fileURLToPath(
  new URL("../../compiler/scripts/preview.ts", import.meta.url),
);

interface Entry {
  /**
   * Resolves once the child has announced readiness. Stored in `entries`
   * BEFORE it is awaited by the caller that created it — that is the entire
   * mechanism behind "two concurrent first requests share one spawn": a
   * second `acquire()` for the same project finds this entry already
   * present and awaits the same promise instead of spawning its own child.
   */
  readyPromise: Promise<{ child: SpawnedChild; port: number; base: string }>;
  /** Undefined until `readyPromise` resolves — a still-spawning entry has no child yet. */
  child?: SpawnedChild;
  port?: number;
  base?: string;
  inFlight: number;
  lastUsedAt: number;
}

function toPreviewProcess(projectId: string, entry: Entry & { port: number; base: string }): PreviewProcess {
  return { projectId, port: entry.port, base: entry.base, inFlight: entry.inFlight, lastUsedAt: entry.lastUsedAt };
}

export interface PreviewPoolDeps {
  db: DatabaseSync;
  masterKey: Buffer;
  projectsRoot: string;
  /** Overridable for tests; production default resolves compiler/scripts/preview.ts via import.meta.url. */
  previewCommand?: { command: string; args: string[] };
  idleMs?: number;
  now?: () => number;
  spawnFn?: SpawnFn;
  /**
   * The environment `scrubbedEnv`/`buildAgentEnv` scrub FROM. Defaults to
   * `process.env`; overridable so a test can plant a fake host
   * `ANTHROPIC_API_KEY` and prove it never reaches a child, without actually
   * mutating this process's real environment.
   */
  baseEnv?: NodeJS.ProcessEnv;
  /** Overridable for tests; production default is `defaultVerifyPort` (a real TCP connect). */
  verifyPort?: (port: number) => Promise<void>;
}

const defaultSpawnFn: SpawnFn = (command, args, options) => {
  // stdio explicitly piped for stdout/stderr: that is what guarantees they
  // are non-null Readable streams (both extend EventEmitter), which is what
  // makes the cast below sound rather than merely convenient. stdin is
  // "ignore" — nothing this pool does ever writes to a preview child's stdin.
  const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  return child as unknown as SpawnedChild;
};

export class PreviewPool {
  private readonly db: DatabaseSync;
  private readonly masterKey: Buffer;
  private readonly projectsRoot: string;
  private readonly previewCommand: { command: string; args: string[] };
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly spawnFn: SpawnFn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly verifyPort: (port: number) => Promise<void>;
  private readonly entries = new Map<string, Entry>();

  constructor(deps: PreviewPoolDeps) {
    this.db = deps.db;
    this.masterKey = deps.masterKey;
    this.projectsRoot = deps.projectsRoot;
    this.previewCommand = deps.previewCommand ?? { command: process.execPath, args: [DEFAULT_PREVIEW_SCRIPT] };
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.spawnFn = deps.spawnFn ?? defaultSpawnFn;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.verifyPort = deps.verifyPort ?? defaultVerifyPort;
  }

  /**
   * Spawns a fresh preview child for `project`, or reuses one already
   * running. Increments nothing — a caller doing work across an `await`
   * boundary (a regen, say) must call `retain()` itself so the reaper cannot
   * kill the process out from under it.
   */
  async acquire(project: Project, ownerId: string): Promise<PreviewProcess> {
    const existing = this.entries.get(project.id);
    if (existing !== undefined) {
      const ready = await existing.readyPromise;
      existing.lastUsedAt = this.now();
      return { projectId: project.id, port: ready.port, base: ready.base, inFlight: existing.inFlight, lastUsedAt: existing.lastUsedAt };
    }

    const directory = resolveProjectDirectory(this.projectsRoot, project.directory);
    const base = `/preview/${project.id}/`;
    // Authorization BEFORE capacity, deliberately: `buildChildEnv` is also
    // where an unknown or disabled owner gets refused
    // (UnknownUserError/DisabledUserError). `ensureCapacity()` below can
    // reap — and kill — another tenant's idle preview to make room; running
    // it before this owner is even confirmed allowed to use the system
    // would let a bogus or disabled request evict a legitimate one on its
    // way to being refused anyway.
    const env = this.buildChildEnv(ownerId);

    this.ensureCapacity();

    // `entry` is referenced by the `.then`/`.catch` closures below before it
    // is assigned. That is safe: those closures only ever run in a later
    // microtask, and `entry` is fully assigned before this synchronous
    // function body yields (at the `await readyPromise` a few lines down).
    let entry!: Entry;
    const readyPromise = this.spawnWithRetries(project.id, directory, base, env)
      .then((result) => {
        entry.child = result.child;
        entry.port = result.port;
        entry.base = result.base;
        entry.lastUsedAt = this.now();
        this.attachExitHandler(project.id, entry, result.child);
        return result;
      })
      .catch((err: unknown) => {
        // A spawn that never became ready must not leave a dead placeholder
        // behind for the next caller to "reuse".
        if (this.entries.get(project.id) === entry) {
          this.entries.delete(project.id);
        }
        throw err;
      });
    entry = { readyPromise, inFlight: 0, lastUsedAt: this.now() };
    // Stored BEFORE awaiting: this is what makes two concurrent first
    // requests for the same project share this one spawn rather than both
    // independently starting a second Vite server on the same directory.
    this.entries.set(project.id, entry);

    const ready = await readyPromise;
    return { projectId: project.id, port: ready.port, base: ready.base, inFlight: entry.inFlight, lastUsedAt: entry.lastUsedAt };
  }

  /** Marks `projectId` as doing work, so `reapIdle` will not kill it mid-run. Nested: two `retain`s need two `release`s. */
  retain(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return;
    entry.inFlight += 1;
  }

  /** The counterpart to `retain`. Idleness is timed from the release that brings `inFlight` back to zero, not from when the work started. */
  release(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.inFlight === 0) {
      entry.lastUsedAt = this.now();
    }
  }

  /** Kills and forgets every process idle past `idleMs` with no work in flight. Returns the killed project ids. */
  reapIdle(): string[] {
    const now = this.now();
    const killed: string[] = [];
    for (const [projectId, entry] of this.entries) {
      // Work in flight is NEVER reaped, however long it has run — checked
      // first and unconditionally, before elapsed time is even considered.
      if (entry.inFlight !== 0) continue;
      // Still spawning (no child yet): not idle in any meaningful sense.
      if (entry.child === undefined || entry.port === undefined || entry.base === undefined) continue;
      if (now - entry.lastUsedAt < this.idleMs) continue;
      // No signal argument: Node's default for `.kill()` is SIGTERM, which is
      // exactly what is wanted. On Windows SIGTERM is not a real signal, but
      // `child.kill()` still terminates the process there — so there is
      // nothing extra to do, and no need to reach for `taskkill`.
      entry.child.kill();
      this.entries.delete(projectId);
      killed.push(projectId);
    }
    return killed;
  }

  /** Kills every child immediately, in-flight work notwithstanding — this is shutdown, not idle reaping. */
  async shutdown(): Promise<void> {
    const snapshot = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.all(snapshot.map((entry) => this.killEntry(entry)));
  }

  list(): PreviewProcess[] {
    const result: PreviewProcess[] = [];
    for (const [projectId, entry] of this.entries) {
      if (entry.port === undefined || entry.base === undefined) continue;
      result.push(toPreviewProcess(projectId, entry as Entry & { port: number; base: string }));
    }
    return result;
  }

  private async killEntry(entry: Entry): Promise<void> {
    if (entry.child !== undefined) {
      const child = entry.child;
      if (child.killed === true) return;
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.kill();
      });
      return;
    }
    // Still spawning: let the in-flight attempt settle (success or failure)
    // before deciding what to kill, rather than leaving an orphan that
    // finishes spawning after shutdown() has already returned.
    try {
      const result = await entry.readyPromise;
      await this.killEntry({ ...entry, child: result.child });
    } catch {
      // It already failed, or exited on its own — nothing left to kill.
    }
  }

  private ensureCapacity(): void {
    if (this.entries.size < MAX_PREVIEWS) return;
    this.reapIdle();
    if (this.entries.size >= MAX_PREVIEWS) {
      throw new PreviewCapacityError();
    }
  }

  private attachExitHandler(projectId: string, entry: Entry, child: SpawnedChild): void {
    child.on("exit", () => {
      // Only remove OUR OWN entry: if this project has since been respawned
      // (a newer entry object sits in the map), a stale exit event from the
      // OLD child must not delete the NEW one out from under it.
      if (this.entries.get(projectId) === entry) {
        this.entries.delete(projectId);
      }
    });
  }

  /**
   * Resolves the child's environment exactly once. `MissingApiKeyError`
   * means only "this user has no stored key" — previewing is free, so that
   * falls back to a scrubbed environment with no `ANTHROPIC_API_KEY` at all,
   * rather than refusing to preview. `UnknownUserError`/`DisabledUserError`
   * are NOT caught here: both mean the owner cannot use the system at all,
   * which must refuse the preview outright rather than spawn a keyless
   * child for a disabled or nonexistent account.
   */
  private buildChildEnv(ownerId: string): NodeJS.ProcessEnv {
    try {
      return buildAgentEnv({ db: this.db, masterKey: this.masterKey, userId: ownerId, baseEnv: this.baseEnv });
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        return scrubbedEnv(this.baseEnv);
      }
      throw err;
    }
  }

  /**
   * The retry loop only — authorization (`buildChildEnv`) has already run in
   * `acquire`, before capacity was even consulted, so nothing in here can
   * fail for an authorization reason.
   */
  private async spawnWithRetries(
    projectId: string,
    directory: string,
    base: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ child: SpawnedChild; port: number; base: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt += 1) {
      // Probing then handing Vite a concrete port is a check-then-use race —
      // something else can bind the same port between our probe and Vite's
      // own bind. That race is tolerable ONLY because the compiler side runs
      // with `strictPort` (compiler/scripts/preview.ts): losing the race is a
      // loud, immediate child exit, never a silent rebind onto a different
      // port that would leave this pool's entry pointing at the wrong
      // process. A loud exit is exactly what this retry loop is for.
      const requestedPort = await findFreePort();
      try {
        return await this.spawnAndAwaitReady(directory, requestedPort, base, env);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `preview process for project ${projectId} failed to start after ${MAX_SPAWN_ATTEMPTS} attempts: ${String(lastError)}`,
    );
  }

  private spawnAndAwaitReady(
    directory: string,
    port: number,
    base: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ child: SpawnedChild; port: number; base: string }> {
    const { command, args: baseArgs } = this.previewCommand;
    const args = [...baseArgs, directory, "--port", String(port), "--base", base];
    const child = this.spawnFn(command, args, { env });

    return new Promise((resolve, reject) => {
      let settled = false;
      let verifyStarted = false;
      let buffer = "";

      function cleanup(): void {
        clearTimeout(timeoutHandle);
        child.off("exit", onExit);
        child.off("error", onError);
      }

      // The one place every rejection path funnels through. A failed
      // readiness wait must never leave a live, untracked Vite server
      // holding a port open — that is the exact failure this module exists
      // to bound — so every path that can end this promise in rejection
      // kills the child first (unless it is already dead). Structural on
      // purpose: a future new failure path calls this and cannot forget to
      // kill, the way the old direct-reject-on-parse-failure path once did.
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (child.killed !== true) child.kill();
        reject(error);
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Always the port and base THIS pool chose — never read back from
        // the child. See the PREVIEW_READY handling below for why.
        resolve({ child, port, base });
      };

      const onExit = (code: number | null): void => {
        fail(new Error(`preview process for ${directory} exited (code ${String(code)}) before announcing readiness`));
      };

      const onError = (err: Error): void => {
        // spawn() itself failing to launch at all (ENOENT, EACCES, …)
        // surfaces as an "error" event, not "exit". Without this handler
        // `acquire` would hang for the full SPAWN_TIMEOUT_MS on every one of
        // its retries instead of failing fast.
        fail(err);
      };

      const onStdoutData = (chunk: Buffer | string): void => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("PREVIEW_READY ")) {
            // A HINT that the child believes it is ready — never the source
            // of truth for where to send traffic. The child runs the
            // project's own model-generated vite.config.ts: untrusted code
            // that could print an early, well-formed PREVIEW_READY line
            // naming any port it likes. Believing it would hand untrusted
            // input a redirect primitive (the pool would proxy every
            // request for this project to whatever port it claims). Parsed
            // only so a malformed line is logged instead of silently
            // ignored — never to extract a port or base to act on;
            // `succeed` above always uses the port/base THIS pool chose.
            try {
              JSON.parse(line.slice("PREVIEW_READY ".length));
            } catch {
              console.log(`[preview:${port}] malformed readiness line: ${redactSecrets(line)}`);
            }
            if (!verifyStarted) {
              verifyStarted = true;
              // The line only claims readiness; this confirms it against the
              // one thing that is not the child's to lie about — whether the
              // port THIS pool chose actually accepts a connection. If it
              // never does, `verifyPort` rejects and `fail` takes over
              // (which is also what closes the early-bogus-line case:
              // untrusted code printing a line before Vite is listening no
              // longer makes the pool declare readiness).
              this.verifyPort(port).then(succeed, (err: unknown) => {
                fail(err instanceof Error ? err : new Error(String(err)));
              });
            }
          } else if (line.length > 0) {
            // The CLI's own human-readable log line, or a stray console.log
            // from the generated project's own code path — one of
            // redactSecrets' three call sites in this function (see
            // redact.ts): the moment a child's output reaches a log call,
            // "no key is ever logged" stops being true by construction and
            // starts depending on this line.
            console.log(`[preview:${port}] ${redactSecrets(line)}`);
          }
        }
      };

      const onStderrData = (chunk: Buffer | string): void => {
        console.error(`[preview:${port}] ${redactSecrets(chunk.toString())}`);
      };

      const timeoutHandle = setTimeout(() => {
        fail(new Error(`preview process for ${directory} did not become ready within ${SPAWN_TIMEOUT_MS}ms`));
      }, SPAWN_TIMEOUT_MS);

      child.on("exit", onExit);
      child.on("error", onError);
      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
    });
  }
}
