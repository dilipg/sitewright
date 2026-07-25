/**
 * Preview server: serves a project (fixture or generated) through Vite with
 * the bridge shim injected. The project's own vite.config.ts is loaded, so
 * its plugins (react, tailwind) resolve from the project's node_modules;
 * the shim plugin is added from outside — the project files never reference
 * shim code (see docs/decisions.md).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { bridgeShimPlugin } from "./shim/vite-plugin.ts";

export interface PreviewOptions {
  port?: number;
}

export async function startPreviewServer(
  projectDir: string,
  options: PreviewOptions = {},
): Promise<ViteDevServer> {
  const root = resolve(projectDir);
  const configFile = join(root, "vite.config.ts");
  if (!existsSync(configFile)) {
    throw new Error(`No vite.config.ts found in "${root}"; cannot serve preview.`);
  }

  const server = await createServer({
    root,
    configFile,
    plugins: [bridgeShimPlugin()],
    server: { port: options.port ?? 5273, strictPort: true },
  });
  await server.listen();
  return server;
}
