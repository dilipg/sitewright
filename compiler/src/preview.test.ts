import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startPreviewServer } from "./preview";

const fixtureDir = fileURLToPath(new URL("../../fixtures/acme-landing", import.meta.url));

describe("startPreviewServer: preview pool support (dynamic port, base path)", () => {
  it("binds an OS-assigned port when asked for port 0", async () => {
    // The pool needs a dynamic port: six fixed ports would collide with a
    // developer's own `npm run preview`, and strictPort means a collision is
    // a hard failure rather than a silent increment.
    const server = await startPreviewServer(fixtureDir, { port: 0 });
    try {
      const address = server.httpServer?.address();
      expect(typeof address === "object" && address !== null).toBe(true);
      const port = (address as { port: number }).port;
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(5273);
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
