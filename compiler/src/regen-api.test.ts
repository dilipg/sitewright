/**
 * The one thing about the regen/edit endpoints that is testable without a model
 * and without a running server: HOW they spawn the orchestrator.
 *
 * Every one of /__regen, /__regen-page, /__add-section and /__edit-prompt ends
 * its argument list with `--instruction <free-form user text>`. If that text
 * does not survive the spawn exactly, argparse exits 2, no result line is ever
 * printed, and the endpoint 500s on every call — which is what `shell: true`
 * did: Node concatenates argv into one unquoted command string (its own
 * DEP0190 deprecation says so), so "make the headline shorter" arrived as five
 * arguments.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { regenApiPlugin, runProcess, usageEnvFor } from "./regen-api.ts";
import { USAGE_ID_HEADER, usageLogPathFor } from "./usage-log-path.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** A stand-in for `IncomingMessage`, since these tests never open a socket:
 *  only `.headers` is ever read by `usageEnvFor`. */
function fakeRequest(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/**
 * Echoes its own argv as JSON — a stand-in for argparse, minus the uv startup
 * cost. The `--` before the flags is for NODE's own option parsing of `-e`
 * scripts (without it node itself rejects `--instruction` as a bad option); it
 * says nothing about the spawn, which is what is under test here. The product
 * path spawns `uv run python -m <module> … --instruction <text>`, where python
 * stops parsing options at `-m`'s module and argparse receives the rest.
 */
const ECHO_ARGV = "console.log(JSON.stringify(process.argv.slice(1)))";

describe("runProcess", () => {
  it("delivers an instruction containing spaces and a quote as ONE argument", async () => {
    // A space is the common case; the quote is the one that a shell, or naive
    // hand-quoting, mangles rather than merely splits.
    const instruction = 'make the "big" headline shorter';
    const { stdout, code } = await runProcess(
      process.execPath,
      ["-e", ECHO_ARGV, "--", "--instruction", instruction],
      REPO_ROOT,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(["--instruction", instruction]);
  });

  it("preserves shell metacharacters instead of letting a shell interpret them", async () => {
    // The same code path is fed straight from a text box, so this is the
    // injection surface as much as it is a correctness one.
    const instruction = 'shorten it & echo hi > out.txt | whoami `id` $(pwd)';
    const { stdout } = await runProcess(
      process.execPath,
      ["-e", ECHO_ARGV, "--", "--instruction", instruction],
      REPO_ROOT,
    );

    expect(JSON.parse(stdout.trim())).toEqual(["--instruction", instruction]);
  });

  it("rejects rather than hanging when the executable does not exist", async () => {
    await expect(
      runProcess("wg-no-such-executable", ["--version"], REPO_ROOT),
    ).rejects.toThrow();
  });

  it("merges a 4th-argument env addition over the inherited environment", async () => {
    // The orchestrator needs PATH (inherited) AND the per-request addition
    // (WEBGEN_USAGE_LOG) at once — a replace instead of a merge would either
    // lose PATH (and, under the hosted server, ANTHROPIC_API_KEY) or lose the
    // addition. Asserting both env vars in the same child proves it is a
    // merge, not one or the other.
    const { stdout } = await runProcess(
      process.execPath,
      ["-e", "console.log(JSON.stringify([process.env.WEBGEN_USAGE_LOG, typeof process.env.PATH]))"],
      REPO_ROOT,
      { WEBGEN_USAGE_LOG: "/tmp/example.jsonl" },
    );

    expect(JSON.parse(stdout.trim())).toEqual(["/tmp/example.jsonl", "string"]);
  });
});

describe("usageEnvFor", () => {
  const validId = "0123456789abcdef0123456789abcdef";

  it("turns a well-formed usage-id header into a WEBGEN_USAGE_LOG addition", () => {
    const env = usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: validId }));
    expect(env).toEqual({ WEBGEN_USAGE_LOG: usageLogPathFor(validId) });
  });

  it("returns undefined when the header is absent", () => {
    // The load-bearing default: no header, no addition, so the local
    // unauthenticated preview (which never sends this header) is unaffected.
    expect(usageEnvFor(fakeRequest({}))).toBeUndefined();
  });

  it("returns undefined rather than throwing when the header is malformed", () => {
    // A bad id is not the child's problem to police (Task 1 brief); the
    // request still proceeds, just without usage attribution.
    expect(usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: "../../etc/passwd" }))).toBeUndefined();
  });

  it("takes the first value when the header arrives duplicated", () => {
    const env = usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: [validId, "ignored"] }));
    expect(env).toEqual({ WEBGEN_USAGE_LOG: usageLogPathFor(validId) });
  });
});

describe("usageEnvFor + runProcess (end to end)", () => {
  it("a well-formed x-webgen-usage-id header reaches the child as WEBGEN_USAGE_LOG", async () => {
    // This is the actual point of Task 1: a per-request header, translated by
    // usageEnvFor, must survive all the way into the orchestrator child's
    // environment — not just that runProcess can merge SOME env object.
    const id = "fedcba9876543210fedcba9876543210";
    const env = usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: id }));

    const { stdout } = await runProcess(
      process.execPath,
      ["-e", "console.log(process.env.WEBGEN_USAGE_LOG ?? '')"],
      REPO_ROOT,
      env,
    );

    expect(stdout.trim()).toBe(usageLogPathFor(id));
  });
});

/**
 * FIX 1 (whole-branch review, HIGH): the hosted server proxies `route` and
 * `section` bytes verbatim into these endpoints' JSON bodies with no
 * validation, and neither did this file — `snapshotRoute` joined the value
 * straight into `join(root, "src", "pages", routeSlug)`, and `path.join`
 * normalises `..` segments, so `route = "../../../../victim/src"` escaped
 * the project root and copied another tenant's files into the caller's own
 * `.regen-backup`, BEFORE the request's mock/real branch even ran.
 *
 * These drive the real middleware `regenApiPlugin` registers — not a
 * reimplementation of it — via a minimal fake Vite `server` object exposing
 * only what `configureServer` actually touches (`middlewares.use`,
 * `moduleGraph.invalidateAll`). No real Vite dev server is booted: the
 * validation this fix adds returns before any project file is read, so a
 * project directory need not even be a working Vite project for these
 * cases — only `startPreviewServer`-level tests (preview.test.ts) need that.
 */
describe("regenApiPlugin: route-slug validation on proxied route/section fields (FIX 1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    delete process.env.WG_REGEN_MOCK;
  });

  function freshRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "regen-traversal-"));
    dirs.push(dir);
    return dir;
  }

  type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  interface FakeViteServer {
    middlewares: { use: (fn: Middleware) => void };
    moduleGraph: { invalidateAll: () => void };
  }

  /** Extracts and drives the real middleware `regenApiPlugin(root)` registers. */
  function mountRegenApi(root: string) {
    const plugin: Plugin = regenApiPlugin(root);
    let handler: Middleware | undefined;
    const fakeServer: FakeViteServer = {
      middlewares: { use: (fn) => { handler = fn; } },
      moduleGraph: { invalidateAll: () => { /* not under test here */ } },
    };
    // configureServer is a plain function on this plugin (not the
    // {handler, order} object form Vite's typing also allows), so it can be
    // invoked directly once cast past ViteDevServer's much larger shape —
    // the same "give it only what it actually reads" idiom
    // compiler-routes.test.ts uses for its own fake `res`.
    (plugin.configureServer as unknown as (server: FakeViteServer) => void)(fakeServer);
    if (handler === undefined) throw new Error("regenApiPlugin never registered its middleware");
    const middleware = handler;

    function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: string }> {
      return new Promise((resolveCall) => {
        const chunks: string[] = [];
        const res = {
          statusCode: 200,
          setHeader() { /* no-op */ },
          end(chunk?: string) {
            if (chunk !== undefined) chunks.push(String(chunk));
            resolveCall({ status: res.statusCode, body: chunks.join("") });
          },
        } as unknown as ServerResponse;

        const req = new EventEmitter() as unknown as IncomingMessage;
        Object.assign(req, { method, url, headers: {} });

        middleware(req, res, () => resolveCall({ status: 404, body: "" }));

        // readBody's req.on("data"/"end") listeners are attached
        // SYNCHRONOUSLY inside the middleware call above — safe to emit
        // right away, in the same tick.
        const emitter = req as unknown as EventEmitter;
        if (body !== undefined) emitter.emit("data", Buffer.from(JSON.stringify(body)));
        emitter.emit("end");
      });
    }

    return { call };
  }

  // Any section id whose route component (`.split(".")[0]`) starts with a
  // literal "." always yields "" — see regen-api.ts's routeSlugOfSection —
  // so this exact shape was never itself an escape. Pre-fix it still wasn't
  // harmless, though: an empty route slug silently resolved to `src/pages`
  // itself, sweeping the ENTIRE pages directory into the backup rather than
  // one route's — which is what the "no backup directory" assertions below
  // catch even for this endpoint pair.
  const TRAVERSAL_ROUTE = "../../../../victim/src";
  const TRAVERSAL_SECTION = "../../../../victim.hero";

  it("rejects a traversal route with 400 on /__regen-page and creates no backup directory", async () => {
    const root = freshRoot();
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__regen-page", { route: TRAVERSAL_ROUTE, instruction: "x" });
    expect(result.status).toBe(400);
    expect(existsSync(join(root, ".regen-backup"))).toBe(false);
  });

  it("rejects a traversal route with 400 on /__add-section and creates no backup directory", async () => {
    const root = freshRoot();
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__add-section", {
      route: TRAVERSAL_ROUTE, archetype: "hero", instruction: "x",
    });
    expect(result.status).toBe(400);
    expect(existsSync(join(root, ".regen-backup"))).toBe(false);
  });

  it("rejects a traversal route with 400 on /__edit-prompt", async () => {
    const root = freshRoot();
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__edit-prompt", { route: TRAVERSAL_ROUTE, instruction: "x" });
    expect(result.status).toBe(400);
    // /__edit-prompt never snapshots even a valid route (see the handler's
    // own comment: it changes nothing on disk) — asserted anyway so a future
    // change that adds a snapshot here inherits this same coverage.
    expect(existsSync(join(root, ".regen-backup"))).toBe(false);
  });

  it("rejects a traversal-shaped section with 400 on /__regen and creates no backup directory", async () => {
    const root = freshRoot();
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__regen", { section: TRAVERSAL_SECTION, instruction: "x" });
    expect(result.status).toBe(400);
    expect(existsSync(join(root, ".regen-backup"))).toBe(false);
  });

  it("rejects a traversal-shaped section with 400 on /__regen-revert", async () => {
    const root = freshRoot();
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__regen-revert", { section: TRAVERSAL_SECTION });
    expect(result.status).toBe(400);
  });

  it("400s a non-string route/section instead of throwing inside .split()", async () => {
    const root = freshRoot();
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__regen-page", { route: 12345, instruction: "x" });
    expect(result.status).toBe(400);
    expect(existsSync(join(root, ".regen-backup"))).toBe(false);
  });

  it("still accepts a well-formed route slug on /__regen-page (does not over-reject)", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "src", "pages", "home"), { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ nodes: {} }));
    process.env.WG_REGEN_MOCK = "1";
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__regen-page", { route: "home", instruction: "x" });
    // mockRegenPage throws ("no active sections on route") because the
    // manifest above declares none — a 500, not the 400 a rejected guard
    // would produce. The point here is which side of the guard the request
    // landed on, not that the regen itself succeeds.
    expect(result.status).toBe(500);
    // Proves the guard let the request through to snapshotRoute (which runs
    // BEFORE the mock/real branch) — unlike every traversal case above.
    expect(existsSync(join(root, ".regen-backup"))).toBe(true);
  });

  it("still accepts a well-formed section id on /__regen (does not over-reject)", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "src", "pages", "home"), { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ nodes: {} }));
    process.env.WG_REGEN_MOCK = "1";
    const { call } = mountRegenApi(root);
    const result = await call("POST", "/__regen", { section: "home.hero", instruction: "x" });
    // mockRegen throws ("not a manifest node") for the same reason as above.
    expect(result.status).toBe(500);
    expect(existsSync(join(root, ".regen-backup"))).toBe(true);
  });
});
