// compiler/src/usage-log-path.ts
/**
 * Where a regeneration's token-usage log goes, and the request header that
 * selects it.
 *
 * The hosted server needs one usage log per billable request so it can
 * attribute that request's spend to one user (server/src/ingest-usage.ts).
 * The orchestrator already honours WEBGEN_USAGE_LOG; what was missing is a
 * way for a per-request value to reach it, since a preview child is
 * long-lived and its environment is fixed at spawn.
 *
 * An opaque id, never a path. A header naming a path would let whoever sets
 * it choose where a subprocess writes — on the local unauthenticated preview
 * that is the caller, and on the hosted server it would be safe only for as
 * long as nobody forgot to strip the inbound copy before proxying. An id
 * constrained to 32 hex characters cannot name a path at all, and both sides
 * derive the same location from it.
 *
 * The temp directory rather than the project's own: a file inside the project
 * would have to be excluded from the exporter's copy and from the preview
 * server's file watcher, and forgetting either is a silent bug.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const USAGE_ID_HEADER = "x-webgen-usage-id";

const USAGE_ID = /^[0-9a-f]{32}$/;

export function isValidUsageId(value: unknown): value is string {
  return typeof value === "string" && USAGE_ID.test(value);
}

/**
 * The directory every usage log lives in — exported so a caller that needs
 * the directory itself (server/src/usage-log-sweep.ts, sweeping stale files
 * at startup) derives it from the same one literal `usageLogPathFor` uses,
 * rather than a second copy of "webgen-usage" that could silently drift.
 */
export function usageLogDir(): string {
  return join(tmpdir(), "webgen-usage");
}

export function usageLogPathFor(usageId: string): string {
  if (!isValidUsageId(usageId)) throw new Error("invalid usage id");
  return join(usageLogDir(), `${usageId}.jsonl`);
}
