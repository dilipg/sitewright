// server/src/usage.ts
/**
 * Per-user token spend: one row per model call, the spend cap's source of
 * truth (spec, "Data model").
 *
 * Rows arrive from the orchestrator's own usage log (see ingest-usage.ts),
 * which records EVERY model call — the pipeline's and the edit agent's alike.
 * That matters: `cost_for_run` reads the per-run log, which edit-agent calls
 * never reach, so every cost figure this project has reported understates
 * reality. This table is the one place that does not.
 *
 * Cost arrives already priced, in dollars. The rate card stays in
 * `orchestrator/src/orchestrator/pricing.py`, which is already the only copy;
 * a second one here would drift the moment Anthropic changes a price, and the
 * two would disagree about a real user's real bill.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface UsageEventInput {
  userId: string;
  /** Null for work that belongs to no project yet (slice 5's first generation). */
  projectId: string | null;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Null when the model has no published rate — never 0, which would read as free. */
  costUsd: number | null;
  at: number;
}

export interface SpendWindow {
  costUsd: number;
  events: number;
  /**
   * How many in-window events carried no price. Non-zero means costUsd is a
   * floor, not a total — surfaced so a caller can say so rather than quietly
   * reporting a confident number.
   */
  unpricedEvents: number;
}

export function recordUsageEvent(db: DatabaseSync, event: UsageEventInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO usage_event (
       id, user_id, project_id, role, model,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       cost_usd, at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.userId,
    event.projectId,
    event.role,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheCreationInputTokens,
    event.cacheReadInputTokens,
    event.costUsd,
    event.at,
  );
  return id;
}

/**
 * Spend in [sinceMs, now]. The boundary is inclusive, and `resetAtFor` in
 * spend-cap.ts depends on that being true — an event at exactly `sinceMs`
 * still counts, which is why the reset instant is one millisecond past the
 * point where the oldest event ages out.
 *
 * COALESCE on both aggregates: SUM over no rows is NULL, not 0, and a NULL
 * reaching the cap comparison makes every comparison false — i.e. silently
 * unlimited spending for any user whose window happens to be empty.
 */
export function spendSince(db: DatabaseSync, userId: string, sinceMs: number): SpendWindow {
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COUNT(*) AS events,
            COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
       FROM usage_event
      WHERE user_id = ? AND at >= ?`,
  ).get(userId, sinceMs) as { cost_usd: number; events: number; unpriced: number };
  return { costUsd: row.cost_usd, events: row.events, unpricedEvents: row.unpriced };
}

/** In-window events, oldest first — the input to the reset-time calculation. */
export function eventsSince(
  db: DatabaseSync,
  userId: string,
  sinceMs: number,
): Array<{ at: number; costUsd: number | null }> {
  const rows = db.prepare(
    "SELECT at, cost_usd FROM usage_event WHERE user_id = ? AND at >= ? ORDER BY at ASC",
  ).all(userId, sinceMs) as unknown as Array<{ at: number; cost_usd: number | null }>;
  return rows.map((row) => ({ at: row.at, costUsd: row.cost_usd }));
}
