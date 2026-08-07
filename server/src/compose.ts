// server/src/compose.ts
/**
 * The route table, assembled from every route-array module.
 *
 * Pulled out of scripts/serve.ts so it can be unit tested without booting a
 * real server. scripts/serve.ts cannot be imported for that purpose: its
 * module body has side effects the moment it runs (parses argv, may
 * `process.exit`, loads the master key, opens the database, binds a real
 * port) — none of which belong in a test. This module has none of that; it
 * only assembles the array createRequestListener consumes.
 */
import type { DatabaseSync } from "node:sqlite";
import { authRoutes } from "./auth-routes.ts";
import { compilerRoutes } from "./compiler-routes.ts";
import { jobRoutes } from "./job-routes.ts";
import { keyRoutes } from "./key-routes.ts";
import type { PreviewPool } from "./preview-pool.ts";
import { previewRoutes } from "./preview-routes.ts";
import { projectRoutes } from "./project-routes.ts";
import type { Route } from "./router.ts";

export function buildRoutes(args: {
  db: DatabaseSync;
  masterKey: Buffer;
  secureCookies: boolean;
  /**
   * Optional: a caller with no pool (every pre-existing test, and any future
   * caller with no need for it) gets the exact same route table as before —
   * the preview route and the compiler's own `/__*` endpoints are added only
   * when there is a pool to serve them, never mounted half-wired.
   */
  pool?: PreviewPool;
  /**
   * Optional, and INDEPENDENT of `pool` — slice 5's job routes (job-routes.ts)
   * need a place to create a fresh project's directory (`POST /api/generate`)
   * but touch no preview child at all, so they need no `PreviewPool` object.
   * `PreviewPool` never exposes its own `projectsRoot` (it is a private
   * field), so this cannot be derived from `pool` even when one is given —
   * scripts/serve.ts always supplies both together, from the same local
   * variable, but the two are independently optional here so a caller with
   * no need for job routes (every pre-existing test) is not forced to
   * construct one just to keep compiling.
   */
  projectsRoot?: string;
}): Route[] {
  const { db, masterKey, secureCookies, pool, projectsRoot } = args;
  return [
    ...authRoutes({ db, secureCookies }),
    ...keyRoutes({ db, masterKey }),
    ...projectRoutes({ db }),
    ...(projectsRoot === undefined ? [] : jobRoutes({ db, projectsRoot })),
    ...(pool === undefined ? [] : previewRoutes({ db, pool })),
    ...(pool === undefined ? [] : compilerRoutes({ db, pool })),
  ];
}
