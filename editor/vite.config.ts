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
    // The same `fs.deny` hardening `compiler/src/preview.ts` already carries,
    // for the same reason and now with a sharper one: this dev server serves
    // `/@fs/...` on an UNAUTHENTICATED port, and Docker made it the everyday way
    // to reach the product. `searchForWorkspaceRoot` walks up to the repo root,
    // so `server/data/identity.db` — argon2 hashes, live session ids, encrypted
    // API keys — sat inside the served root, as did `.env.docker`'s master key
    // and `orchestrator/.env`'s provider keys. The whole-branch review found the
    // gap; the preview server was hardened long ago and this file never was.
    //
    // Vite takes an EXPLICIT `deny` as-is rather than merging it with its own
    // defaults, so those defaults (env files, certs, .npmrc, .git) are repeated
    // verbatim here rather than silently dropped. `*.db` and its WAL sidecars
    // are NOT in Vite's defaults and are the whole point of this addition.
    fs: {
      deny: [
        ".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc", ".yarnrc.yml", "**/.git/**",
        "**/*.db", "**/*.db-{wal,shm}",
      ],
    },
    proxy: {
      "/api": { target: HOSTED_SERVER_URL, changeOrigin: true },
      // A plain "/__" string key matches by PREFIX (`doesProxyContextMatchUrl`,
      // vite/dist/node/chunks/node.js), which covers every compiler endpoint
      // (`/__regen`, `/__overrides/...`, `/__plan`, ...) with one entry --
      // but ALSO Vite's own built-in `/__open-in-editor` endpoint (the dev
      // overlay's click-to-open-in-editor), which would otherwise forward to
      // the hosted server IN LOCAL MODE TOO (task-8 review): the proxy
      // middleware runs before Vite's own `/__open-in-editor` handler
      // regardless of mode, so a plain prefix match wins even when nothing
      // about this request has anything to do with hosted mode. A leading
      // "^" makes Vite treat the key as a RegExp tested against the full
      // `req.url` (verified against vite@8.1.5's own source, not assumed);
      // the negative lookahead excludes exactly that one Vite-owned path
      // while still matching every compiler endpoint.
      "^/__(?!open-in-editor)": { target: HOSTED_SERVER_URL, changeOrigin: true },
      // `ws: true` so the child preview's own HMR socket survives this
      // hop too (server/src/preview-upgrade.ts handles the SECOND hop, from
      // the hosted server into the project's own preview child).
      "/preview": { target: HOSTED_SERVER_URL, changeOrigin: true, ws: true },
    },
  },
});