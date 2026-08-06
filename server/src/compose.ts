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
   * the preview route is added only when there is a pool to serve it, never
   * mounted half-wired.
   */
  pool?: PreviewPool;
}): Route[] {
  const { db, masterKey, secureCookies, pool } = args;
  return [
    ...authRoutes({ db, secureCookies }),
    ...keyRoutes({ db, masterKey }),
    ...projectRoutes({ db }),
    ...(pool === undefined ? [] : previewRoutes({ db, pool })),
  ];
}
