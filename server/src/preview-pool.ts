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
 */
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createServer } from "node:net";
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

    this.ensureCapacity();

    // `entry` is referenced by the `.then`/`.catch` closures below before it
    // is assigned. That is safe: those closures only ever run in a later
    // microtask, and `entry` is fully assigned before this synchronous
    // function body yields (at the `await readyPromise` a few lines down).
    let entry!: Entry;
    const readyPromise = this.spawnAndWait(project, ownerId)
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

  private async spawnAndWait(
    project: Project,
    ownerId: string,
  ): Promise<{ child: SpawnedChild; port: number; base: string }> {
    const directory = resolveProjectDirectory(this.projectsRoot, project.directory);
    const base = `/preview/${project.id}/`;
    // Resolved ONCE, outside the retry loop below: a failure here has
    // nothing to do with a lost port race, and must fail the whole acquire
    // immediately rather than being retried three times for no reason.
    const env = this.buildChildEnv(ownerId);

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
      `preview process for project ${project.id} failed to start after ${MAX_SPAWN_ATTEMPTS} attempts: ${String(lastError)}`,
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
      let buffer = "";

      const onExit = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(new Error(`preview process for ${directory} exited (code ${String(code)}) before announcing readiness`));
      };

      const onStdoutData = (chunk: Buffer | string): void => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!settled && line.startsWith("PREVIEW_READY ")) {
            settled = true;
            clearTimeout(timeoutHandle);
            child.off("exit", onExit);
            try {
              const announced = JSON.parse(line.slice("PREVIEW_READY ".length)) as { port: number; base: string };
              resolve({ child, port: announced.port, base: announced.base });
            } catch {
              reject(new Error(`could not parse preview readiness line: ${redactSecrets(line)}`));
            }
          } else if (line.length > 0) {
            // The CLI's own human-readable log line, or a stray console.log
            // from the generated project's own code path. This is
            // redactSecrets' first real call site: the moment a child's
            // output reaches a log call, "no key is ever logged" stops being
            // true by construction and starts depending on this line.
            console.log(`[preview:${port}] ${redactSecrets(line)}`);
          }
        }
      };

      const onStderrData = (chunk: Buffer | string): void => {
        console.error(`[preview:${port}] ${redactSecrets(chunk.toString())}`);
      };

      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("exit", onExit);
        child.kill();
        reject(new Error(`preview process for ${directory} did not become ready within ${SPAWN_TIMEOUT_MS}ms`));
      }, SPAWN_TIMEOUT_MS);

      child.on("exit", onExit);
      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
    });
  }
}
