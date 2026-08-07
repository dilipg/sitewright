// server/src/jobs.ts
/**
 * Long-running work, tracked server-side so a disconnect never loses it.
 *
 * Slice 5's generation runs outlast a single HTTP request (measured ~286s
 * against a 5-minute target), and every existing `/__*` endpoint is
 * synchronous by decision 11. This table is the seam: a request enqueues a
 * job and returns immediately, a worker claims and runs it, and the browser
 * polls current state rather than trusting its own request's outcome (spec,
 * decision 13 — work in flight must survive a disconnect).
 *
 * This file is ONLY the table and its store. Nothing enqueues onto it and no
 * worker loop drains it yet — those are later tasks in the same slice.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JobKind = "generate" | "regen" | "regen-page" | "add-section" | "edit-prompt" | "export";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface Job {
  id: string;
  userId: string;
  /** Null for work that belongs to no project yet (slice 5's first generation). */
  projectId: string | null;
  kind: JobKind;
  status: JobStatus;
  /**
   * A route, a section id, an instruction — whatever the triggering endpoint
   * needs to replay the work. NEVER an API key: the key lives server-side,
   * decrypted only at the point a job actually runs, never serialized into a
   * row a later listing endpoint could echo back to a browser.
   */
  requestJson: string;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface Row {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: string;
  status: string;
  request_json: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    requestJson: row.request_json,
    resultJson: row.result_json,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface CreateJobInput {
  userId: string;
  projectId: string | null;
  kind: JobKind;
  requestJson: string;
  now: number;
}

export function createJob(db: DatabaseSync, input: CreateJobInput): Job {
  const job: Job = {
    id: randomUUID(),
    userId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    status: "queued",
    requestJson: input.requestJson,
    resultJson: null,
    error: null,
    createdAt: input.now,
    startedAt: null,
    finishedAt: null,
  };
  db.prepare(
    `INSERT INTO job (
       id, user_id, project_id, kind, status,
       request_json, result_json, error,
       created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.userId,
    job.projectId,
    job.kind,
    job.status,
    job.requestJson,
    job.resultJson,
    job.error,
    job.createdAt,
    job.startedAt,
    job.finishedAt,
  );
  return job;
}

export function findJobById(db: DatabaseSync, id: string): Job | null {
  const row = db.prepare("SELECT * FROM job WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toJob(row);
}

/** Most recent first — a project's job list is read as recent activity. */
export function listJobsByProject(db: DatabaseSync, projectId: string, limit: number): Job[] {
  return (
    db.prepare(
      "SELECT * FROM job WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(projectId, limit) as unknown as Row[]
  ).map(toJob);
}

/** `queued` + `running` — the spend cap's in-flight reservation reads this shape. */
export function countActiveJobsForUser(db: DatabaseSync, userId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM job WHERE user_id = ? AND status IN ('queued', 'running')",
  ).get(userId) as { count: number };
  return row.count;
}

/**
 * Atomically claims the oldest `queued` job and flips it to `running`, or
 * returns null if none is queued.
 *
 * This MUST be a single statement, not a SELECT followed by an UPDATE: a
 * second caller (a test, a future second worker) could observe the same
 * `queued` row between those two steps and claim it too. A single UPDATE
 * whose WHERE still tests `status = 'queued'` is what SQLite itself executes
 * as one atomic operation — the second concurrent caller's UPDATE simply
 * matches zero rows once the first has already flipped the status, no
 * transaction or app-level lock needed. RETURNING hands back the row that
 * was actually changed, so a caller never has to guess which id "won".
 */
export function claimNextJob(db: DatabaseSync, now: number): Job | null {
  const row = db.prepare(
    `UPDATE job SET status = 'running', started_at = ?
       WHERE id = (
         SELECT id FROM job WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1
       )
       AND status = 'queued'
     RETURNING *`,
  ).get(now) as Row | undefined;
  return row === undefined ? null : toJob(row);
}

export interface FinishJobInput {
  status: JobStatus;
  resultJson?: string | null;
  error?: string | null;
  now: number;
}

export function finishJob(db: DatabaseSync, id: string, input: FinishJobInput): void {
  db.prepare(
    "UPDATE job SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?",
  ).run(input.status, input.resultJson ?? null, input.error ?? null, input.now, id);
}

/**
 * Boot recovery: a job left `running` when the process died (crash, deploy,
 * kill -9) is not actually running anymore, and nothing will ever claim or
 * finish it again. Converting it to a terminal `interrupted` status is what
 * lets a poller stop waiting on it instead of hanging forever. Returns how
 * many rows were converted, for a boot log line.
 */
export function markRunningJobsInterrupted(db: DatabaseSync, now: number): number {
  const result = db.prepare(
    "UPDATE job SET status = 'interrupted', finished_at = ? WHERE status = 'running'",
  ).run(now);
  return Number(result.changes);
}
