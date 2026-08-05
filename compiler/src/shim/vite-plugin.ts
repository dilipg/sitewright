/**
 * Bridge-shim Vite plugin. `apply: "serve"` makes it dev-only by
 * construction — production builds and exports never see the shim; there is
 * nothing to strip. The shim runtime is bundled from ./shim.ts at first
 * request via esbuild and served as a virtual module.
 */

import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SHIM_PATH = "/@website-generator/bridge-shim.js";
const RESOLVED_SHIM_ID = `\0${SHIM_PATH}`;

export function bridgeShimPlugin(): Plugin {
  let bundledShim: string | undefined;

  return {
    name: "website-generator:bridge-shim",
    apply: "serve",
    transformIndexHtml(_html, ctx) {
      // The injected `src` must be BASE-AWARE. Vite's own internally
      // generated tags (/@vite/client, the react-refresh preamble) are
      // automatically rewritten against the dev server's configured `base`;
      // a PLUGIN's own transformIndexHtml-injected tag is not — Vite takes
      // whatever `src` it is given at face value. Every use of this plugin
      // ran at the default root base ("/") until the hosted server's preview
      // pool put a real child behind `/preview/<projectId>/` for the first
      // time (server/, task 4): the browser then requested this exact bare
      // path with no prefix, which the reverse proxy has no route for, so
      // the shim 404'd and the editor lost its one communication channel
      // with the preview — found live, against a real Vite child, not by
      // any test (every prior test of this plugin runs at the default base).
      const base = ctx.server?.config.base ?? "/";
      return [
        {
          tag: "script",
          attrs: { type: "module", src: `${base}${SHIM_PATH.slice(1)}` },
          injectTo: "head",
        },
      ];
    },
    resolveId(id) {
      if (id === SHIM_PATH) return RESOLVED_SHIM_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_SHIM_ID) return undefined;
      bundledShim ??= bundleShim();
      return bundledShim;
    },
  };
}

function bundleShim(): string {
  const entry = fileURLToPath(new URL("./shim.ts", import.meta.url));
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  return result.outputFiles[0]!.text;
}
