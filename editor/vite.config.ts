import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The hosted server's own default port (server/scripts/serve.ts's own
 * `--port` default) — overridable so a differently-configured hosted
 * server can still be reached without editing this file.
 *
 * Proxying `/api`, `/__*` and `/preview` here is what makes hosted mode
 * (`editor/src/lib/backend.ts`) same-origin: the browser only ever talks to
 * THIS dev server, which forwards to the hosted one behind the scenes. That
 * is the whole point (task-8 brief) — the session cookie flows under
 * `SameSite=Lax` with no CORS involved, and none of slice 2's CSRF posture
 * is loosened. A cross-origin request from the editor straight to the
 * hosted server was rejected for exactly that reason.
 *
 * Local mode (no `?project=` on the editor's own URL) never exercises any
 * of this: `backend.ts`'s local-mode URLs are absolute
 * (`http://localhost:5273/...`, a DIFFERENT origin from this dev server),
 * so those requests never match these same-origin proxy prefixes at all —
 * this config is inert for every existing (local-mode) test.
 */
const HOSTED_SERVER_URL = process.env.WEBGEN_HOSTED_SERVER_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: HOSTED_SERVER_URL, changeOrigin: true },
      // Vite's string-key proxy matches by PREFIX, so this covers every
      // compiler endpoint (`/__regen`, `/__overrides/...`, `/__plan`, ...)
      // with one entry.
      "/__": { target: HOSTED_SERVER_URL, changeOrigin: true },
      // `ws: true` so the child preview's own HMR socket survives this
      // hop too (server/src/preview-upgrade.ts handles the SECOND hop, from
      // the hosted server into the project's own preview child).
      "/preview": { target: HOSTED_SERVER_URL, changeOrigin: true, ws: true },
    },
  },
});