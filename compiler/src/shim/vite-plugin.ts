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
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module", src: SHIM_PATH },
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
