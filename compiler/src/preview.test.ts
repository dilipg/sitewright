import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFsAllow, startPreviewServer } from "./preview";

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
    expect(allow.some((p) => p.replace(/\\/g, "/") === sharedInstall.replace(/\\/g, "/"))).toBe(true);
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
