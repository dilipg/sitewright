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
import type { Route } from "./router.ts";

export function buildRoutes(args: {
  db: DatabaseSync;
  masterKey: Buffer;
  secureCookies: boolean;
}): Route[] {
  const { db, masterKey, secureCookies } = args;
  return [
    ...authRoutes({ db, secureCookies }),
    ...keyRoutes({ db, masterKey }),
  ];
}
