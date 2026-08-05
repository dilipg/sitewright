// server/src/ingest-usage.ts
/**
 * Moves one invocation's model spend out of the orchestrator's usage log and
 * into `usage_event`, attributed to the user who paid for it.
 *
 * The orchestrator writes that log through `record_usage`, which every model
 * call goes through — the pipeline's and the edit agent's alike. That is why
 * this is the ingest source rather than the per-run log: the per-run log never
 * sees an edit-agent call, which is the gap the spec names.
 *
 * Written to be unbreakable by a subprocess that died mid-write. It is called
 * from a `finally` after a spawn that may itself have failed, so it must never
 * throw and must never let one bad line discard the rest of a run's billing.
 *
 * NOT idempotent. Ingesting the same file twice records the spend twice. The
 * caller must ingest exactly once, from a path unique to that invocation, and
 * delete the file afterwards. The safe-looking retry — re-ingesting after a
 * partial failure — is the one that silently doubles a user's bill.
 */
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { findProjectById } from "./projects.ts";
import { recordUsageEvent } from "./usage.ts";
import { findUserById } from "./users.ts";

export interface IngestResult {
  ingested: number;
  /** Lines that were not usable. Non-zero is worth logging; it means spend was lost. */
  skipped: number;
}

function intField(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

export function ingestUsageLog(
  db: DatabaseSync,
  args: { path: string; userId: string; projectId: string | null; now: number },
): IngestResult {
  const { path, userId, now } = args;
  // A run that made no model calls writes no file. That is a no-op, not an
  // error — do not make the caller distinguish the two.
  if (!existsSync(path)) return { ingested: 0, skipped: 0 };

  // Resolved ONCE, up front. project_id is a foreign key, so ingesting
  // against a project row that has gone would throw on the first insert and
  // discard the whole run's billing. Attributing the spend to the user with
  // no project is strictly better than losing it — the user still paid.
  const projectId =
    args.projectId !== null && findProjectById(db, args.projectId) !== null ? args.projectId : null;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ingested: 0, skipped: 0 };
  }

  const usableLines = text.split("\n").filter((line) => line.trim() !== "");

  // Symmetric with the projectId check above, and for the same reason:
  // user_id is NOT NULL REFERENCES user(id), so a stale id throws on the
  // FIRST insert and takes the whole run's billing with it — unlike
  // projectId, there is no "fall back to null" escape, because userId is who
  // paid. userId is constant for the entire file, so this is one lookup, not
  // one per row. Reporting every line as skipped rather than throwing is
  // what makes the loss VISIBLE — a caller that sees skipped > 0 knows money
  // went unrecorded and can log it, instead of an unhandled throw inside the
  // caller's `finally` masking the original spawn error.
  if (findUserById(db, userId) === null) {
    return { ingested: 0, skipped: usableLines.length };
  }

  let ingested = 0;
  let skipped = 0;
  // No enclosing transaction: a run produces tens of rows, so the speed is
  // irrelevant, and a BEGIN here would be a nested-transaction hazard for
  // whatever calls this in future.
  for (const line of usableLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The half-written final line of a killed subprocess lands here.
      skipped += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }

    const source = parsed as Record<string, unknown>;
    const model = source.model;
    const role = source.role;
    if (typeof model !== "string" || typeof role !== "string") {
      skipped += 1;
      continue;
    }

    // An unparseable timestamp becomes the ingest time rather than dropping
    // the row: losing spend understates the bill, and understating is the
    // dangerous direction for a cap.
    //
    // A FUTURE timestamp is clamped to the ingest time, and that is
    // load-bearing rather than tidy-minded. `resetAtFor` in spend-cap.ts is
    // exact only because spend can only ever DECREASE as the window slides —
    // which holds precisely because every recorded event is in the past. One
    // future-dated row (clock skew on the host, a mangled but parseable date)
    // would sit in the trailing-24h window until its own timestamp passed,
    // blocking the user until then and making the computed reset instant a
    // lie. Clamping keeps the invariant true at the only place rows enter.
    const parsedAt = typeof source.timestamp === "string" ? Date.parse(source.timestamp) : NaN;
    const at = Number.isFinite(parsedAt) ? Math.min(parsedAt, now) : now;

    // Missing or non-numeric cost is NULL — unpriced, not free. A NEGATIVE
    // cost is rejected the same way: spendSince SUMs cost_usd, so a negative
    // value would SUBTRACT from the window and under-count spend, which is
    // the dangerous direction for a cap. Better to treat it as unpriced (a
    // floor the operator is told about) than to trust a number that can only
    // ever make the reported total wrong on the side that lets someone spend
    // more than the cap believes they have.
    const rawCost = source.cost_usd;
    const costUsd =
      typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null;

    try {
      recordUsageEvent(db, {
        userId,
        projectId,
        role,
        model,
        inputTokens: intField(source, "input_tokens"),
        outputTokens: intField(source, "output_tokens"),
        cacheCreationInputTokens: intField(source, "cache_creation_input_tokens"),
        cacheReadInputTokens: intField(source, "cache_read_input_tokens"),
        costUsd,
        at,
      });
      ingested += 1;
    } catch {
      // Last line of defence. Every KNOWN failure mode is guarded above
      // (missing file, stale user, stale project, malformed line); this
      // exists so an UNFORESEEN constraint violation costs one row rather
      // than throwing out of the loop and taking every remaining row in the
      // file with it. Not silent — the row lands in `skipped`, which the
      // caller is expected to log.
      skipped += 1;
    }
  }

  return { ingested, skipped };
}
