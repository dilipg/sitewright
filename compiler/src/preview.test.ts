import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startPreviewServer } from "./preview";

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
