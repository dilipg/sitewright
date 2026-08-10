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
import { regenApiPlugin, restoreSnapshot, runProcess, snapshotRoute, usageEnvFor } from "./regen-api.ts";
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

  it("refuses to restore `home`'s snapshot into `about`, leaving `about` untouched", () => {
    const root = twoRouteProject();
    snapshotRoute(root, "home");

    expect(() => restoreSnapshot(root, "about")).toThrow(/belongs to route "home"/);

    // The actual defect: `about` must still be `about`.
    expect(existsSync(join(root, "src", "pages", "about", "about-only.tsx"))).toBe(true);
    expect(existsSync(join(root, "src", "pages", "about", "home-only.tsx"))).toBe(false);
  });

  it("does not consume the snapshot, so the legitimate revert still works after a refused one", () => {
    const root = twoRouteProject();
    snapshotRoute(root, "home");
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
    snapshotRoute(root, "home");
    rmSync(join(root, "src", "pages", "home"), { recursive: true, force: true });

    restoreSnapshot(root, "home");

    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("accepts a section id for the owning route, not just a bare slug", () => {
    const root = twoRouteProject();
    snapshotRoute(root, "home");
    expect(() => restoreSnapshot(root, "home.hero")).not.toThrow();
  });

  it("refuses a snapshot slot with no owner record (taken before this guard)", () => {
    const root = twoRouteProject();
    snapshotRoute(root, "home");
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

  it("finding 4: a valid slug with no page directory must not destroy the pending snapshot", () => {
    const root = twoRouteProject();
    snapshotRoute(root, "home");

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
    snapshotRoute(root, "home");
    // Simulate a slot whose page half is gone but whose owner record is intact.
    rmSync(join(root, ".regen-backup", "page"), { recursive: true, force: true });

    expect(() => restoreSnapshot(root, "home")).toThrow(/incomplete/);

    // The route must still be there. The old order deleted it and then threw on
    // the copy, leaving nothing to restore it from.
    expect(existsSync(join(root, "src", "pages", "home", "home-only.tsx"))).toBe(true);
  });

  it("finding 3: a missing manifest half is refused too, non-destructively", () => {
    const root = twoRouteProject();
    snapshotRoute(root, "home");
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
    snapshotRoute(root, " home");

    expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
  });
});
