/**
 * Preview server: serves a project (fixture or generated) through Vite with
 * the bridge shim injected. The project's own vite.config.ts is loaded, so
 * its plugins (react, tailwind) resolve from the project's node_modules;
 * the shim plugin is added from outside — the project files never reference
 * shim code (see docs/decisions.md).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { createServer } from "vite";
import { exportApiPlugin } from "./export-api.ts";
import { planApiPlugin } from "./plan-api.ts";
import { regenApiPlugin } from "./regen-api.ts";
import { bridgeShimPlugin } from "./shim/vite-plugin.ts";

export interface PreviewOptions {
  /**
   * NOTE: 0 does not mean "let the OS choose". Vite treats 0 as "no port
   * configured" and falls back to its own default, so two callers passing 0
   * collide. Callers that need a dynamic port must probe for one and pass it
   * concretely (see server/src/preview-pool.ts's findFreePort).
   */
  port?: number;
  /**
   * Vite's base path. The hosted server proxies each preview at
   * `/preview/<projectId>/`, and without a matching base every asset URL the
   * dev server generates (`/src/main.tsx`, `/@vite/client`) points at the
   * PROXY's root instead of the project's, so the page loads and every module
   * 404s. Undefined leaves Vite's own default ("/"), which is what the local
   * `npm run preview` wants.
   */
  base?: string;
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
    base: options.base,
    plugins: [
      bridgeShimPlugin(),
      overridesApiPlugin(root),
      regenApiPlugin(root),
      planApiPlugin(root),
      exportApiPlugin(root),
    ],
    // The editor runs on a different origin (port) and fetches manifest.json
    // from this server; cors must be explicit. overrides/ is written by the
    // editor while the preview is live — the preview app never consumes it,
    // so the watcher must not react (a reload would interrupt editing).
    server: {
      // Explicit, not left to Vite's own "localhost" default: on at least one
      // real Windows dev machine, Node resolves the bare hostname "localhost"
      // to the IPv6 loopback (::1) ONLY, not 127.0.0.1 — confirmed empirically
      // (task 4's manual verification, the first time a real Vite child ran
      // behind server/src/preview-pool.ts's real, non-mocked `verifyPort`).
      // That check, and preview-proxy.ts's upstream requests, both target the
      // IPv4 loopback address by a literal IP, so a child that bound only to
      // ::1 was unreachable to both — `acquire()` failed every single spawn,
      // on every retry, with no test able to see it (every unit test injects
      // a fake `verifyPort`). Binding by IP number removes the ambiguity
      // "localhost" carries across machines/OS DNS configuration.
      host: "127.0.0.1",
      port: options.port ?? 5273,
      strictPort: true,
      cors: true,
      watch: { ignored: ["**/overrides/**", "**/.regen-backup/**"] },
    },
  });
  await server.listen();
  return server;
}

const ROUTE_SLUG = /^[a-z0-9-]+$/;

/**
 * Editor persistence endpoints (PRD 6): the preview server owns the project
 * directory, so it is the natural writer for the editor's two files —
 * GET/PUT /__overrides/<route-slug>  -> overrides/<route-slug>.overrides.json
 * GET/PUT /__overrides-history       -> overrides/.editor-history.json
 * Only the editor writes overrides; agents never touch this directory.
 */
function overridesApiPlugin(projectRoot: string): Plugin {
  return {
    name: "website-generator:overrides-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (url === "/__overrides-history") {
          handleFileEndpoint(req, res, join(projectRoot, "overrides", ".editor-history.json"), {
            version: 1,
            snapshots: [{}],
            index: 0,
          });
          return;
        }
        const match = /^\/__overrides\/([^/]+)$/.exec(url);
        if (match !== null) {
          const slug = match[1]!;
          if (!ROUTE_SLUG.test(slug)) {
            res.statusCode = 400;
            res.end("invalid route slug");
            return;
          }
          handleFileEndpoint(req, res, join(projectRoot, "overrides", `${slug}.overrides.json`), {
            version: 1,
            route: "/",
            overrides: [],
          });
          return;
        }
        next();
      });
    },
  };
}

function handleFileEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  emptyDefault: unknown,
): void {
  if (req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.end(existsSync(filePath) ? readFileSync(filePath, "utf8") : JSON.stringify(emptyDefault));
    return;
  }
  if (req.method === "PUT") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
        res.statusCode = 204;
        res.end();
      } catch {
        res.statusCode = 400;
        res.end("invalid JSON body");
      }
    });
    return;
  }
  res.statusCode = 405;
  res.end();
}
