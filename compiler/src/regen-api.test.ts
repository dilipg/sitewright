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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { MAX_BODY_BYTES } from "./max-body-bytes.ts";
import type { SnapshotClaim } from "./regen-api.ts";
import {
  regenApiPlugin,
  restoreSnapshot,
  runProcess,
  snapshotRoute,
  usageEnvFor,
} from "./regen-api.ts";
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
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
interface FakeViteServer {
  middlewares: { use: (fn: Middleware) => void };
  moduleGraph: { invalidateAll: () => void };
}

/**
 * Extracts and drives the real middleware `regenApiPlugin(root)` registers.
 *
 * At module scope rather than inside the FIX 1 describe below, because the P1
 * concurrency block at the bottom of this file drives the same middleware and
 * needs the identical harness — a third copy of it (there is already a second,
 * for raw bodies, whose `req` genuinely differs) would be a copy that can drift
 * from the thing under test. `call` returns a promise deliberately: the P1
 * block does NOT await the first request, which is what makes two requests
 * overlap the way two browser tabs do.
 */
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

/**
 * Residual 2 (2026-08-06 decisions.md row / CLAUDE.md's slice-4c paragraph):
 * `server/src/preview-proxy.ts`'s `proxyHttp` PIPES a proxied request body
 * straight through rather than buffering it, so `router.ts`'s own
 * MAX_BODY_BYTES never sees a proxied `/__*` body at all. `readBody` (below)
 * used to accumulate the whole thing into a `Buffer[]` before ever calling
 * JSON.parse, so the failure that matters is unbounded memory HERE, in this
 * process — the one serving every other request for the project.
 *
 * A fresh, minimal harness rather than reusing `mountRegenApi` above: this
 * one sends RAW bytes (not `JSON.stringify(body)`) so a body can be sized
 * precisely relative to `MAX_BODY_BYTES`, and its fake `req` needs a callable
 * `.destroy()` — `readBody` now calls it on the over-limit path, which the
 * FIX 1 harness's bare-EventEmitter `req` never needed.
 */
describe("regenApiPlugin: bounds a proxied body before ever parsing it (residual 2)", () => {
  function mountRegenApiRaw(root: string) {
    const plugin: Plugin = regenApiPlugin(root);
    let handler: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined;
    const fakeServer = {
      middlewares: { use: (fn: typeof handler) => { handler = fn; } },
      moduleGraph: { invalidateAll: () => { /* not under test here */ } },
    };
    (plugin.configureServer as unknown as (server: typeof fakeServer) => void)(fakeServer);
    if (handler === undefined) throw new Error("regenApiPlugin never registered its middleware");
    const middleware = handler;

    /** Drives one request with a RAW body, sent as a single chunk. */
    function call(url: string, body: Buffer): Promise<{ status: number; body: string }> {
      return new Promise((resolveCall) => {
        const outChunks: string[] = [];
        let destroyed = false;
        const res = {
          statusCode: 200,
          setHeader() { /* no-op */ },
          end(chunk?: string) {
            if (chunk !== undefined) outChunks.push(String(chunk));
            resolveCall({ status: res.statusCode, body: outChunks.join("") });
          },
        } as unknown as ServerResponse;

        const req = new EventEmitter() as unknown as IncomingMessage;
        Object.assign(req, {
          method: "POST", url, headers: {},
          destroy: () => { destroyed = true; },
        });

        middleware(req, res, () => resolveCall({ status: 404, body: "" }));

        const emitter = req as unknown as EventEmitter;
        if (!destroyed) emitter.emit("data", body);
        if (!destroyed) emitter.emit("end");
      });
    }

    return { call };
  }

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    delete process.env.WG_REGEN_MOCK;
  });
  function freshRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "regen-bodycap-"));
    dirs.push(dir);
    return dir;
  }

  it("answers 413 and never calls JSON.parse on a body over MAX_BODY_BYTES", async () => {
    const root = freshRoot();
    const { call } = mountRegenApiRaw(root);
    // Well-formed JSON, genuinely oversized: if the cap were removed, this
    // would parse fine and reach snapshotRoute, which is exactly the
    // difference this test needs to be able to see.
    const bigInstruction = "x".repeat(MAX_BODY_BYTES + 10_000);
    const payload = Buffer.from(JSON.stringify({ route: "home", instruction: bigInstruction }));
    const result = await call("/__regen-page", payload);
    expect(result.status).toBe(413);
    // Proves the request never reached snapshotRoute/JSON.parse at all.
    expect(existsSync(join(root, ".regen-backup"))).toBe(false);
  });

  it("still accepts a body comfortably under MAX_BODY_BYTES", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "src", "pages", "home"), { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ nodes: {} }));
    process.env.WG_REGEN_MOCK = "1";
    const { call } = mountRegenApiRaw(root);
    const instruction = "x".repeat(MAX_BODY_BYTES - 1_000);
    const payload = Buffer.from(JSON.stringify({ route: "home", instruction }));
    const result = await call("/__regen-page", payload);
    // mockRegenPage throws for the SAME reason the pre-existing "does not
    // over-reject" test above documents (no active sections in the empty
    // manifest) — a 500, not 413: the point is which side of the size cap
    // the request landed on.
    expect(result.status).toBe(500);
    expect(existsSync(join(root, ".regen-backup"))).toBe(true);
  });
});

/**
 * F13, found by round 1's live verification (docs/reports/m8-live-verification.md).
 *
 * `snapshotRoute` wrote to `.regen-backup/page` -- ONE fixed path, not keyed by
 * route -- and `restoreSnapshot` deleted the TARGET route before copying, with
 * nothing recording which route the snapshot came from. So regenerating one
 * route and then reverting a DIFFERENT one deleted the second route and
 * replaced its files with the first's: cross-route data loss, reachable over
 * the authenticated HTTP surface (`POST /__regen-revert`).
 *
 * The editor never tripped it because it only ever reverts the route it just
 * regenerated. The HTTP API has no such discipline.
 *
 * Driven through the exported helpers rather than the HTTP middleware because
 * the endpoint's own mock path needs a populated manifest and spends 1.5s per
 * section; the defect lives entirely in these two functions, and the module
 * already exports `runProcess`/`usageEnvFor` for tests by the same precedent.
 */
describe("snapshot/restore: a snapshot may only restore the route it came from (F13)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** Two routes, each with a uniquely-named file, so a swap is unmistakable. */
  function twoRouteProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "regen-f13-"));
    dirs.push(dir);
    for (const route of ["home", "about"]) {
      mkdirSync(join(dir, "src", "pages", route, "sections"), { recursive: true });
      writeFileSync(join(dir, "src", "pages", route, `${route}-only.tsx`), `// belongs to ${route}
`, "utf8");
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ nodes: {} }), "utf8");
    return dir;
  }

  /**
   * A snapshot whose regeneration has FINISHED — the endpoint's own `finally`
   * releases the claim before the response is even flushed, and that is the
   * only state in which a revert is ever offered.
   *
   * Written out here (rather than a bare `snapshotRoute`) since the
   * whole-branch review's C1: a revert while the run is still going is now
   * REFUSED, so leaving these snapshots claimed would make every test below
   * assert C1's message instead of the ownership rule it names. The refusal
   * itself has its own tests in the C1 block at the bottom of this file.
   */
  function finishedSnapshot(root: string, route: string): void {
    snapshotRoute(root, route).release();
  }

  it("refuses to restore `home`'s snapshot into `about`, leaving `about` untouched", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");

    expect(() => restoreSnapshot(root, "about")).toThrow(/belongs to route "home"/);

    // The actual defect: `about` must still be `about`.
    expect(existsSync(join(root, "src", "pages", "about", "about-only.tsx"))).toBe(true);
    expect(existsSync(join(root, "src", "pages", "about", "home-only.tsx"))).toBe(false);
  });

  it("does not consume the snapshot, so the legitimate revert still works after a refused one", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");
    try {
      restoreSnapshot(root, "about");
    } catch {
      // expected
    }

    // Asserting on the SLOT, not on `existsSync(pages/about)`: the first draft
    // of this test checked the latter and did not discriminate, because the
    // destructive restore recreated `pages/about` (with `home`'s files) so the
    // directory existed either way. The old code also deleted the backup at
    // the end of every restore, so reverting the wrong route destroyed the
    // ability to revert the right one -- that is the property under test.
    expect(existsSync(join(root, ".regen-backup", "route.txt"))).toBe(true);

    rmSync(join(root, "src", "pages", "home"), { recursive: true, force: true });
    restoreSnapshot(root, "home");
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("still restores the route the snapshot WAS taken from", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");
    rmSync(join(root, "src", "pages", "home"), { recursive: true, force: true });

    restoreSnapshot(root, "home");

    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("accepts a section id for the owning route, not just a bare slug", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");
    expect(() => restoreSnapshot(root, "home.hero")).not.toThrow();
  });

  it("refuses a snapshot slot with no owner record (taken before this guard)", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");
    rmSync(join(root, ".regen-backup", "route.txt"), { force: true });

    expect(() => restoreSnapshot(root, "home")).toThrow(/belongs to route null/);
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });
});

/**
 * F13 REVIEW findings 3, 4 and 5. The independent review of the F13 fix found
 * that the same defect shape being fixed — a destructive step ahead of its
 * validation — existed in TWO more places in these same two functions. One
 * instance was fixed and two were left.
 */
describe("snapshot/restore: no destructive step may precede its validation (F13 review)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function twoRouteProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "regen-f13r-"));
    dirs.push(dir);
    for (const route of ["home", "about"]) {
      mkdirSync(join(dir, "src", "pages", route), { recursive: true });
      writeFileSync(join(dir, "src", "pages", route, `${route}-only.tsx`), `// ${route}\n`, "utf8");
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ nodes: {} }), "utf8");
    return dir;
  }

  /** See the identically-named helper in the F13 block above: a snapshot whose
   *  regeneration has finished, which is the only state a revert is offered
   *  in (C1). */
  function finishedSnapshot(root: string, route: string): void {
    snapshotRoute(root, route).release();
  }

  it("finding 4: a valid slug with no page directory must not destroy the pending snapshot", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");

    // "contact" passes ROUTE_SLUG but has no directory. The old order wiped the
    // slot first and only then threw on the copy.
    expect(() => snapshotRoute(root, "contact")).toThrow(/no page directory/);

    // home's snapshot must have survived, and must still be restorable.
    expect(existsSync(join(root, ".regen-backup", "route.txt"))).toBe(true);
    rmSync(join(root, "src", "pages", "home"), { recursive: true, force: true });
    restoreSnapshot(root, "home");
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("finding 3: an incomplete snapshot must not delete the target route first", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");
    // Simulate a slot whose page half is gone but whose owner record is intact.
    rmSync(join(root, ".regen-backup", "page"), { recursive: true, force: true });

    expect(() => restoreSnapshot(root, "home")).toThrow(/incomplete/);

    // The route must still be there. The old order deleted it and then threw on
    // the copy, leaving nothing to restore it from.
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("finding 3: a missing manifest half is refused too, non-destructively", () => {
    const root = twoRouteProject();
    finishedSnapshot(root, "home");
    rmSync(join(root, ".regen-backup", "manifest.json"), { force: true });

    expect(() => restoreSnapshot(root, "home")).toThrow(/incomplete/);
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("finding 5: the owner record is normalised on write, not only on read", () => {
    const root = twoRouteProject();
    // A read-side `.trim()` alone made `" home"` and `"home"` compare equal, so
    // a snapshot of one could be restored into the other. Normalising both
    // sides makes the stored value canonical instead.
    mkdirSync(join(root, "src", "pages", " home"), { recursive: true });
    writeFileSync(join(root, "src", "pages", " home", "spaced.tsx"), "// spaced\n", "utf8");
    finishedSnapshot(root, " home");

    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
  });
});

/**
 * P1 (docs/decisions.md 2026-08-10, "F13 review, finding 1"): there is ONE
 * snapshot slot per project and it had no lock of any kind, while
 * `MAX_ACTIVE_JOBS_PER_USER` bounds concurrency per USER (2) and never per
 * project. So ONE tester with two browser tabs can start two regenerations of
 * two different routes on the same project; they share one preview child and
 * one slot, the second `snapshotRoute` wiped the first's, and a later revert
 * restored a manifest predating the first route's commit while that route's
 * CODE stayed regenerated. Silent, and reported as "my page broke".
 *
 * "Pending" here means a regeneration is STILL RUNNING — not merely that a
 * slot exists on disk. Nothing frees the slot except a revert or the next
 * snapshot (the editor sets `revertSection` after a successful regen and
 * offers no discard), so refusing on the mere EXISTENCE of another route's
 * slot would 500 the ordinary SEQUENTIAL flow — regenerate `home`, keep it,
 * then regenerate `about` — with no way out but reverting the kept work. The
 * tests below pin both halves: the concurrent case is refused, the sequential
 * case is not.
 *
 * WHOLE-BRANCH REVIEW, C1: the first version of this guard did not actually
 * hold that property, and the review reproduced the full P1 corruption through
 * it with a probe test. Two holes: `releaseSnapshotClaim(root)` decremented
 * whatever claim the PROJECT had rather than the one the caller took, and
 * `restoreSnapshot` deleted the claim outright — so an ungated
 * `POST /__regen-revert` from a second tab freed a running regeneration's
 * claim and let the next request clobber its snapshot. The permanent version
 * of that probe is the "C1" block at the bottom of this describe.
 */
describe("snapshotRoute: a second CONCURRENT regeneration may not replace the pending slot (P1)", () => {
  const dirs: string[] = [];
  const held: SnapshotClaim[] = [];
  afterEach(() => {
    // A test that never "finished" its regeneration still holds a live claim;
    // released by handle, since a claim can no longer be freed by root alone
    // (C1). Module state, so a leak would follow the process, not the dir.
    for (const claim of held) claim.release();
    held.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    delete process.env.WG_REGEN_MOCK;
  });

  /** Two routes, each with a uniquely-named file, so a swap is unmistakable. */
  function twoRouteProject(nodes: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "regen-p1-"));
    dirs.push(dir);
    for (const route of ["home", "about"]) {
      mkdirSync(join(dir, "src", "pages", route), { recursive: true });
      writeFileSync(join(dir, "src", "pages", route, `${route}-only.tsx`), `// ${route}\n`, "utf8");
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ nodes }), "utf8");
    return dir;
  }

  /** Snapshots a route and remembers the claim for cleanup — a regeneration
   *  that is STILL RUNNING, which is what makes the slot claimed at all. */
  function running(root: string, route: string): SnapshotClaim {
    const claim = snapshotRoute(root, route);
    held.push(claim);
    return claim;
  }

  /* ---------- the two functions directly ---------- */

  it("refuses a second concurrent snapshot rather than silently replacing the first", () => {
    const root = twoRouteProject();
    running(root, "home");

    // `about`'s regen must not be allowed to discard `home`'s pending snapshot.
    expect(() => snapshotRoute(root, "about")).toThrow(/is still running/i);
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
  });

  it("leaves the refused-against snapshot fully intact and still restorable", () => {
    const root = twoRouteProject();
    const first = running(root, "home");
    expect(() => snapshotRoute(root, "about")).toThrow(/is still running/i);

    // Asserting on the CONTENTS, not just on route.txt: the failure this
    // guards against wiped `page/` and `manifest.json` and then wrote a new
    // owner record, so a route.txt-only assertion would not discriminate
    // between "refused" and "replaced but mislabelled".
    expect(existsSync(join(root, ".regen-backup", "page", "home-only.tsx"))).toBe(true);
    expect(existsSync(join(root, ".regen-backup", "manifest.json"))).toBe(true);
    rmSync(join(root, "src", "pages", "home"), { recursive: true, force: true });
    // `home`'s own run finishes (the endpoint's `finally`) and only THEN is the
    // revert offered — reverting while it runs is refused, C1 below.
    first.release();
    restoreSnapshot(root, "home");
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("names the running route and the only action that actually works (I2)", () => {
    const root = twoRouteProject();
    running(root, "home");

    // Exact wording, not a loose substring: a message that merely says "busy"
    // leaves the user with nothing to act on, and the endpoint's only channel
    // for this is the 500 body (the handler's existing catch).
    //
    // It used to say "revert or discard that regeneration before regenerating
    // …", and the whole-branch review's I2 found both halves wrong: a revert is
    // step 2 of C1's corruption sequence (and is now refused outright), and
    // "discard" named a control the editor has never had. Waiting is the only
    // correct action, so the message says exactly that.
    expect(() => snapshotRoute(root, "about")).toThrow(
      'a regeneration of route "home" is still running and holds this project\'s single ' +
        'snapshot slot; wait for it to finish, then regenerate "about". It cannot be cancelled, ' +
        "and it cannot be reverted while it runs. Nothing was changed.",
    );
  });

  it("allows the SAME route to re-snapshot (the retry and page-regen paths)", () => {
    const root = twoRouteProject();
    running(root, "home");

    // The editor re-runs a failed regen against the same section, and the page
    // path snapshots the route it is about to loop over. Refusing here would
    // break both — this is the regression the second required perturbation
    // (make the refusal reject the same route too) must make fail.
    expect(() => running(root, "home")).not.toThrow();
    expect(() => running(root, "home.hero".split(".")[0]!)).not.toThrow();
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
  });

  it("allows a fresh snapshot once the pending one has been consumed", () => {
    const root = twoRouteProject();
    running(root, "home").release(); // the run finishes, then the user reverts
    restoreSnapshot(root, "home");
    expect(() => snapshotRoute(root, "about")).not.toThrow();
  });

  it("allows another route once the pending regeneration has FINISHED, not only once reverted", () => {
    const root = twoRouteProject();
    running(root, "home").release(); // what the endpoint's `finally` does

    // The slot still exists on disk and still says "home" — a user who kept
    // their regeneration never reverts, and nothing else clears it. Refusing
    // on the slot's mere existence would wedge every multi-route site behind
    // an undo the editor gives no button for.
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
    expect(() => snapshotRoute(root, "about")).not.toThrow();
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("about");
  });

  it("still reports a missing page directory rather than the claim, so finding 4 keeps its message", () => {
    const root = twoRouteProject();
    running(root, "home");
    // Ordering, pinned: the page-directory check must stay AHEAD of the claim
    // check. Both are non-destructive, but the F13-review finding-4 test reads
    // the message, and a claim-first order silently changes what that test is
    // actually exercising.
    expect(() => snapshotRoute(root, "contact")).toThrow(/no page directory/);
  });

  /* ---------- through the real middleware, the way two tabs reach it ---------- */

  /** Waits for a request that is still in flight to have taken its snapshot. */
  async function waitForSlot(root: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (existsSync(join(root, ".regen-backup", "route.txt"))) return;
      await new Promise((tick) => setTimeout(tick, 5));
    }
    throw new Error("the first request never took its snapshot");
  }

  it("refuses the second of two OVERLAPPING page regenerations, then frees the slot when the first ends", async () => {
    // One active section per route: enough for mockRegenPage to do real work
    // (its 1.5s per-section delay is what keeps request one genuinely in
    // flight while request two arrives — exactly the two-tab race).
    const root = twoRouteProject({
      "home.hero": { status: "active", component: "Hero" },
      "about.hero": { status: "active", component: "Hero" },
    });
    process.env.WG_REGEN_MOCK = "1";
    const { call } = mountRegenApi(root);

    const first = call("POST", "/__regen-page", { route: "home", instruction: "x" });
    await waitForSlot(root);
    const second = await call("POST", "/__regen-page", { route: "about", instruction: "x" });

    expect(second.status).toBe(500);
    expect(second.body).toContain("is still running");
    // The in-flight run's snapshot is still its own.
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
    expect(await first).toMatchObject({ status: 200 });

    // ...and the claim is released by the request that took it, so the refusal
    // lasts exactly as long as the run does. Without the release this third
    // call would be refused too, and the editor would be wedged for the rest
    // of the session.
    const third = await call("POST", "/__regen-page", { route: "about", instruction: "x" });
    expect(third.status).toBe(200);
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("about");
  }, 30_000);

  it("frees the slot when the first regeneration FAILS, not only when it succeeds", async () => {
    // An empty manifest makes mockRegenPage throw ("no active sections"), so
    // the handler answers 500 — the path where a `finally`-less release would
    // leak the claim and refuse every later regeneration on the project.
    const root = twoRouteProject();
    process.env.WG_REGEN_MOCK = "1";
    const { call } = mountRegenApi(root);

    const first = await call("POST", "/__regen-page", { route: "home", instruction: "x" });
    expect(first.status).toBe(500);
    expect(first.body).toContain("no active sections");

    const second = await call("POST", "/__regen-page", { route: "about", instruction: "x" });
    expect(second.body).not.toContain("is still running");
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("about");
  });

  it("does not release a claim it never took, when a request is the one being refused", async () => {
    // The trap in wiring the release: a request refused by SOMEONE ELSE's
    // claim must not run the release in its own `finally`, or the refusal
    // hands the slot straight to the next clobberer — the second of three
    // tabs would fail and the third would succeed.
    const root = twoRouteProject({ "home.hero": { status: "active", component: "Hero" } });
    process.env.WG_REGEN_MOCK = "1";
    const { call } = mountRegenApi(root);

    const first = call("POST", "/__regen-page", { route: "home", instruction: "x" });
    await waitForSlot(root);
    const second = await call("POST", "/__regen-page", { route: "about", instruction: "x" });
    const third = await call("POST", "/__regen-page", { route: "about", instruction: "x" });

    expect(second.status).toBe(500);
    expect(third.status).toBe(500);
    expect(third.body).toContain("is still running");
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
    await first;
  }, 30_000);

  /* ---------- C1: the claim may only be freed by its own holder ---------- */

  /**
   * WHOLE-BRANCH REVIEW, C1 — the permanent version of the review's probe test.
   *
   * The P1 guard above was real but did not hold, because a THIRD party could
   * delete the claim between the `snapshotRoute` that took it and the `finally`
   * that frees it. `/__regen-revert` was exactly that third party: gated by no
   * claim at all, it deleted `.regen-backup/` and, with it, the in-flight run's
   * claim. The reproduced sequence, in two browser tabs:
   *
   *   1. `POST /__regen-page {route:"home"}` — takes the claim, runs for minutes.
   *   2. `POST /__regen-revert {section:"home"}` from tab 2 — SUCCEEDED. It
   *      destroyed the only pre-regen copy of the files the orchestrator was
   *      still writing, and freed the claim.
   *   3. `POST /__regen-page {route:"about"}` — allowed, claim gone.
   *   4. Tab 1's request finally ends and its `finally` decrements — `about`'s
   *      claim — to zero.
   *   5. The next regeneration wipes `about`'s pending snapshot mid-run: the P1
   *      corruption, verbatim.
   *
   * Two changes close it, and each of the four tests below fails if either is
   * undone: a claim is released only by the handle that took it (never by
   * root), and a revert is refused outright while a claim is live.
   */
  it("C1 step 2: refuses a revert while that route's regeneration is still running", () => {
    const root = twoRouteProject();
    running(root, "home");

    expect(() => restoreSnapshot(root, "home")).toThrow(/is still running/i);

    // Nothing was changed: not the slot the running regen will need to be
    // revertable from, and not the live route the orchestrator is writing into.
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
    expect(existsSync(join(root, ".regen-backup", "page", "home-only.tsx"))).toBe(true);
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("C1 step 3: a refused revert leaves the claim held, so another route is still refused", () => {
    const root = twoRouteProject();
    running(root, "home");
    expect(() => restoreSnapshot(root, "home")).toThrow();

    // This is the step that turned a bad revert into data loss: with the claim
    // gone, `about` took the slot while `home` was still writing.
    expect(() => snapshotRoute(root, "about")).toThrow(/is still running/i);
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
  });

  it("C1 step 4: a finished run's release cannot free a LATER run's claim", () => {
    const root = twoRouteProject();
    const first = running(root, "home");
    first.release(); // tab 1's own `finally`
    const second = running(root, "about"); // tab 2 legitimately takes the slot
    expect(second.route).toBe("about");

    // The old release was keyed by project root, so ANY second call decremented
    // whatever claim the project currently had — here, `about`'s. A handle can
    // only ever free its own claim, so this frees nothing.
    first.release();

    expect(() => snapshotRoute(root, "home")).toThrow(/is still running/i);
    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("about");
  });

  it("C1: a revert works once the run it was refused for has finished", () => {
    // The refusal message tells the user to wait and then revert, so that
    // sequence must actually work — otherwise the fix trades corruption for a
    // dead end (`pending.md` C-2: no endpoint clears a slot).
    const root = twoRouteProject();
    const claim = running(root, "home");
    expect(() => restoreSnapshot(root, "home")).toThrow(/is still running/i);

    claim.release();
    rmSync(join(root, "src", "pages", "home"), { recursive: true, force: true });
    restoreSnapshot(root, "home");
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("C1: the whole two-tab sequence, through the real middleware", async () => {
    const root = twoRouteProject({
      "home.hero": { status: "active", component: "Hero" },
      "about.hero": { status: "active", component: "Hero" },
    });
    process.env.WG_REGEN_MOCK = "1";
    const { call } = mountRegenApi(root);

    // 1. tab 1 starts a page regeneration of `home` and stays in flight.
    const first = call("POST", "/__regen-page", { route: "home", instruction: "x" });
    await waitForSlot(root);

    // 2. tab 2 reverts `home` — refused, loudly, at the endpoint.
    const revert = await call("POST", "/__regen-revert", { section: "home" });
    expect(revert.status).toBe(500);
    expect(revert.body).toContain("is still running");
    expect(existsSync(join(root, ".regen-backup", "page", "home-only.tsx"))).toBe(true);

    // 3. ...so `about` is still refused, which is the step that used to succeed.
    const other = await call("POST", "/__regen-page", { route: "about", instruction: "x" });
    expect(other.status).toBe(500);
    expect(other.body).toContain("is still running");

    // 4. tab 1 finishes and releases its own claim.
    expect(await first).toMatchObject({ status: 200 });

    // 5. and only now does the revert the message asked the user to wait for
    //    actually run.
    const afterwards = await call("POST", "/__regen-revert", { section: "home" });
    expect(afterwards.status).toBe(200);
    expect(existsSync(join(root, ".regen-backup"))).toBe(false);
  }, 30_000);
});
