import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "./max-body-bytes";
import { overridesApiPlugin, resolveFsAllow, startPreviewServer } from "./preview";

const fixtureDir = fileURLToPath(new URL("../../fixtures/acme-landing", import.meta.url));

/** Binds a throwaway server on an OS-assigned port, closes it, and reports the number. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      probe.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else if (port === undefined) reject(new Error("freePort: could not resolve an address"));
        else resolve(port);
      });
    });
  });
}

// Vite's own hardcoded dev-server default (`DEFAULT_DEV_PORT` in its source).
// Verified empirically (see task-1-report.md) that this is exactly what
// `port: 0` resolves to today -- pinned by name here rather than left as an
// unexplained magic number.
const VITE_DEFAULT_DEV_PORT = 5173;

describe("startPreviewServer: preview pool support (dynamic port, base path)", () => {
  it("honours the concrete port it is given", async () => {
    // The pool picks the port itself and passes it, so this is the contract
    // that actually matters.
    const port = await freePort();
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
    // treats 0 as "no port configured" and falls back to its own fixed
    // default, so asking for 0 gives every child the SAME port and the
    // second one dies on strictPort. This is why the parent probes for a
    // port itself and passes it concretely instead of passing 0 through.
    //
    // A weaker assertion here (`> 0`, `!== 0`) would pass under BOTH the
    // current broken behaviour and a hypothetical future Vite that genuinely
    // honoured 0 as "pick an ephemeral port" -- either way the resolved port
    // is a nonzero number, so that comparison can never fail and proves
    // nothing. Pinning the exact, reproducible fallback value is what
    // actually distinguishes "still broken" from "fixed": if this assertion
    // ever fails because Vite starts handing out varying ports for `port: 0`,
    // that is this defect being fixed upstream, and the pool's
    // probe-then-pass-concrete-port workaround should be revisited.
    const server = await startPreviewServer(fixtureDir, { port: 0 });
    try {
      const port = (server.httpServer?.address() as { port: number }).port;
      expect(port).toBe(VITE_DEFAULT_DEV_PORT);
      // Confirmed empirically that `config.server.port` is mutated to the
      // actually-resolved port after `.listen()` (not left at the raw `0`
      // that was passed in), so it is a second, independent read of the same
      // fact via a different code path.
      expect(server.config.server.port).toBe(VITE_DEFAULT_DEV_PORT);
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

  it("injects the bridge-shim script src prefixed with a non-root base, and that src is actually reachable", async () => {
    // Pins the CRITICAL this branch fixed: under a non-root base, the shim's
    // injected <script src> must carry the SAME base the reverse proxy routes
    // on. Before the fix, the src was root-relative regardless of base, so the
    // browser requested a bare path the proxy has no route for -- the page
    // came back 200 (the HTML itself loaded fine) but rendered nothing,
    // because the one channel the editor has to the preview 404'd silently.
    const server = await startPreviewServer(fixtureDir, { port: 0, base: "/preview/abc/" });
    try {
      const port = (server.httpServer?.address() as { port: number }).port;
      const html = await (await fetch(`http://127.0.0.1:${port}/preview/abc/`)).text();
      const match = /src="([^"]*bridge-shim\.js)"/.exec(html);
      expect(match).not.toBeNull();
      const src = match![1]!;
      expect(src.startsWith("/preview/abc/")).toBe(true);
      // The critical second half: a base-prefixed-LOOKING src that still
      // 404s would be just as broken. Fetching it against the real running
      // server is what actually proves the asset resolves, not just that the
      // string has the right shape.
      const scriptRes = await fetch(`http://127.0.0.1:${port}${src}`);
      expect(scriptRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("keeps the injected bridge-shim script src root-relative at the default base", async () => {
    const server = await startPreviewServer(fixtureDir, { port: 0 });
    try {
      const port = (server.httpServer?.address() as { port: number }).port;
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      const match = /src="([^"]*bridge-shim\.js)"/.exec(html);
      expect(match).not.toBeNull();
      const src = match![1]!;
      expect(src).toBe("/@sitewright/bridge-shim.js");
      const scriptRes = await fetch(`http://127.0.0.1:${port}${src}`);
      expect(scriptRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("resolveFsAllow", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("allows exactly the project directory when node_modules is a real directory", () => {
    const root = mkdtempSync(join(tmpdir(), "preview-fsallow-"));
    dirs.push(root);
    // No node_modules at all -- resolveFsAllow must not require one to exist.
    expect(resolveFsAllow(root)).toEqual([root]);
  });

  it("adds the REAL resolved location when node_modules is a symlink/junction, not the project directory itself", () => {
    // Mirrors orchestrator/src/orchestrator/soak.py's (and shell_pipeline's,
    // design_pipeline's) ensure_node_modules: every generated project's
    // node_modules is a junction to ONE shared install, not a real directory
    // of its own. Narrowing fs.allow to just the project directory without
    // this would 403 every module import the moment fs.allow stopped
    // defaulting to the repo root.
    const sharedInstall = mkdtempSync(join(tmpdir(), "preview-fsallow-shared-"));
    dirs.push(sharedInstall);
    writeFileSync(join(sharedInstall, "marker.txt"), "shared install");
    const root = mkdtempSync(join(tmpdir(), "preview-fsallow-project-"));
    dirs.push(root);
    // "junction" on Windows needs no elevated privilege, unlike a plain
    // symlink -- the same reason the orchestrator's Python side uses
    // `mklink /J` rather than a symlink.
    symlinkSync(sharedInstall, join(root, "node_modules"), "junction");
    const allow = resolveFsAllow(root);
    expect(allow).toContain(root);
    // `realpathSync` on the EXPECTED side too, because the function under test
    // returns the REAL resolved location by design. On macOS `tmpdir()` is itself
    // a symlink (`/var/folders/...` -> `/private/var/folders/...`), so comparing
    // against the path `mkdtempSync` handed back fails on the `/private` prefix
    // alone while the function is behaving correctly. Passed on Windows and Linux,
    // where `tmpdir()` is a real directory -- the same platform asymmetry as the
    // X1/X2 portability findings.
    expect(allow.some((p) => p.replace(/\\/g, "/") === realpathSync(sharedInstall).replace(/\\/g, "/"))).toBe(true);
  });
});

describe("startPreviewServer: fs.allow / fs.deny (security)", () => {
  it("refuses a real file OUTSIDE the project directory via Vite's /@fs/ endpoint", async () => {
    // The vulnerability this pins: Vite's own default fs.allow is
    // searchForWorkspaceRoot(root), which in this monorepo walks up to the
    // REPO ROOT -- so before this fix, any file anywhere in the repo
    // (another project's overrides, another project's source, the identity
    // database) was readable through ANY project's dev server via /@fs/.
    const server = await startPreviewServer(fixtureDir, { port: 0 });
    try {
      const port = (server.httpServer?.address() as { port: number }).port;
      // A real file that exists but is genuinely outside fixtureDir: the
      // repo root's own CLAUDE.md, one directory up from fixtures/.
      const outsideFile = fileURLToPath(new URL("../../CLAUDE.md", import.meta.url));
      const res = await fetch(`http://127.0.0.1:${port}/@fs/${outsideFile.replace(/\\/g, "/")}`);
      expect(res.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("keeps fs.allow narrowed even when the project's own vite.config.ts declares a wider one", async () => {
    // Vite merges the project's loaded configFile with this file's own
    // inline config via mergeConfig(fileConfig, inlineConfig), and
    // mergeConfig CONCATENATES array values rather than overriding them -- so
    // a project vite.config.ts declaring `server: { fs: { allow: [".."] } }`
    // (".." resolving to this project's PARENT directory) would, without the
    // configResolved backstop in preview.ts, get APPENDED to the narrow list
    // rather than ignored, reopening the exact cross-tenant /@fs/ read the
    // test above closes -- the project's own vite.config.ts is unowned,
    // UNVALIDATED input (scaffold copied verbatim, never generated by any
    // agent, but nobody has reviewed it either), so a project cannot be
    // trusted to declare its own fs.allow at all.
    // Cleaned up locally (this describe block has no shared `dirs`/afterEach
    // of its own, unlike the "resolveFsAllow" block above) via the outer
    // finally below, alongside the running server.
    const parent = mkdtempSync(join(tmpdir(), "preview-fsallow-widen-"));
    try {
      const root = join(parent, "project");
      mkdirSync(root, { recursive: true });
      // A real, readable file one directory ABOVE the project root -- exactly
      // what the widening `".."` entry in the project's own config would
      // newly expose if it were honoured.
      const secretPath = join(parent, "secret.txt");
      writeFileSync(secretPath, "outside content");
      // A junction to this repo's own real node_modules, so the arbitrary
      // vite.config.ts below can resolve `import { defineConfig } from
      // "vite"` -- mirrors resolveFsAllow's OWN "node_modules is a symlink"
      // test above, and every generated project's real node_modules setup
      // (see that test's comment).
      const repoNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
      symlinkSync(repoNodeModules, join(root, "node_modules"), "junction");
      writeFileSync(
        join(root, "vite.config.ts"),
        'import { defineConfig } from "vite";\n'
        + "export default defineConfig({\n"
        + "  server: { fs: { allow: [\"..\"] } },\n"
        + "});\n",
      );
      // A plain, otherwise-uninteresting file inside the project directory --
      // NOT vite.config.ts itself, which Vite refuses to serve via /@fs/
      // unconditionally (confirmed empirically: even fixtureDir's own,
      // never-widened config 403s the same way), independent of fs.allow and
      // of anything this fix touches.
      const ownFilePath = join(root, "marker.txt");
      writeFileSync(ownFilePath, "own content");

      const server = await startPreviewServer(root, { port: 0 });
      try {
        // The resolved allow list must still contain every one of our own
        // trusted entries (not a strict-equality check: the fix also adds
        // Vite's own package directory to the safe set -- see
        // enforceFsAllowPlugin's comment on the CLIENT_DIR regression that
        // caused -- which, given this test's OWN node_modules junction below,
        // happens to nest under one of resolveFsAllow's own entries too;
        // that overlap is incidental to this test's setup, not something the
        // fix relies on) -- and it must NOT contain the widened parent
        // directory the project's own config tried to add.
        const expectedAllow = resolveFsAllow(root).map((p) => p.replace(/\\/g, "/"));
        const actualAllow = server.config.server.fs.allow.map((p) => p.replace(/\\/g, "/"));
        for (const expected of expectedAllow) {
          expect(actualAllow).toContain(expected);
        }
        expect(actualAllow).not.toContain(parent.replace(/\\/g, "/"));

        const port = (server.httpServer?.address() as { port: number }).port;
        const outsideRes = await fetch(`http://127.0.0.1:${port}/@fs/${secretPath.replace(/\\/g, "/")}`);
        expect(outsideRes.status).toBe(403);

        // Not a false positive from over-narrowing: the project's own file
        // must still be servable.
        const ownRes = await fetch(`http://127.0.0.1:${port}/@fs/${ownFilePath.replace(/\\/g, "/")}`);
        expect(ownRes.status).toBe(200);
      } finally {
        await server.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("still serves the project's own files inside the project directory", async () => {
    // The negative case (above) must not be a false positive from
    // over-narrowing -- a file genuinely inside the project must still work.
    const server = await startPreviewServer(fixtureDir, { port: 0 });
    try {
      const port = (server.httpServer?.address() as { port: number }).port;
      const ownFile = join(fixtureDir, "package.json");
      const res = await fetch(`http://127.0.0.1:${port}/@fs/${ownFile.replace(/\\/g, "/")}`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

/**
 * Residual 2 (2026-08-06 decisions.md row / CLAUDE.md's slice-4c paragraph):
 * `PUT /__overrides/<slug>` collects the whole request body into a
 * `Buffer[]` before ever calling `JSON.parse`. `server/src/preview-proxy.ts`
 * pipes a proxied request straight through rather than buffering it, so
 * router.ts's own MAX_BODY_BYTES never sees this body at all — the failure
 * that matters is unbounded memory HERE, in this process, the one serving
 * every other request for the project (and, unauthenticated, the local
 * `npm run preview` too).
 *
 * A lightweight harness rather than a real Vite dev server (unlike the
 * `startPreviewServer` tests above): `handleFileEndpoint` reads `req` via
 * plain `"data"`/`"end"` events, so a bare `EventEmitter` with the handful
 * of members it and `overridesApiPlugin`'s own URL/method checks read is
 * enough — the same "give it only what it actually reads" idiom
 * regen-api.test.ts uses to drive `regenApiPlugin` directly.
 */
describe("overridesApiPlugin: bounds a proxied body before ever parsing it (residual 2)", () => {
  function mountOverridesApi(root: string) {
    const plugin: Plugin = overridesApiPlugin(root);
    let handler: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined;
    const fakeServer = {
      middlewares: { use: (fn: typeof handler) => { handler = fn; } },
    };
    (plugin.configureServer as unknown as (server: typeof fakeServer) => void)(fakeServer);
    if (handler === undefined) throw new Error("overridesApiPlugin never registered its middleware");
    const middleware = handler;

    /** Drives one PUT with a RAW body (not JSON.stringify'd for it), sent as a single chunk. */
    function put(slug: string, body: Buffer): Promise<{ status: number; body: string }> {
      return new Promise((resolveCall) => {
        const outChunks: string[] = [];
        let destroyed = false;
        const res = {
          statusCode: 200,
          end(chunk?: string) {
            if (chunk !== undefined) outChunks.push(String(chunk));
            resolveCall({ status: res.statusCode, body: outChunks.join("") });
          },
        } as unknown as ServerResponse;

        const req = new EventEmitter() as unknown as IncomingMessage;
        Object.assign(req, {
          method: "PUT", url: `/__overrides/${slug}`, headers: {},
          destroy: () => { destroyed = true; },
        });

        middleware(req, res, () => resolveCall({ status: 404, body: "" }));

        const emitter = req as unknown as EventEmitter;
        if (!destroyed) emitter.emit("data", body);
        if (!destroyed) emitter.emit("end");
      });
    }

    return { put };
  }

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });
  function freshRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "overrides-bodycap-"));
    dirs.push(dir);
    return dir;
  }

  it("answers 413 and never calls JSON.parse on a body over MAX_BODY_BYTES, and never writes the overrides file", async () => {
    const root = freshRoot();
    const { put } = mountOverridesApi(root);
    // Well-formed JSON, genuinely oversized: if the cap were removed, this
    // would parse fine and write the overrides file, which is exactly the
    // difference this test needs to be able to see.
    const overrides = "x".repeat(MAX_BODY_BYTES + 10_000);
    const payload = Buffer.from(JSON.stringify({ version: 1, route: "/", overrides }));
    const result = await put("home", payload);
    expect(result.status).toBe(413);
    expect(existsSync(join(root, "overrides", "home.overrides.json"))).toBe(false);
  });

  it("still accepts a body comfortably under MAX_BODY_BYTES", async () => {
    const root = freshRoot();
    const { put } = mountOverridesApi(root);
    const overrides = "x".repeat(MAX_BODY_BYTES - 1_000);
    const payload = Buffer.from(JSON.stringify({ version: 1, route: "/", overrides }));
    const result = await put("home", payload);
    expect(result.status).toBe(204);
    expect(existsSync(join(root, "overrides", "home.overrides.json"))).toBe(true);
  });
});
