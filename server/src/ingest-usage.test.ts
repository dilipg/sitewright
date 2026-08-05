import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser, type User } from "./users.ts";
import { createProject } from "./projects.ts";
import { spendSince } from "./usage.ts";
import { ingestUsageLog } from "./ingest-usage.ts";

const NOW = 1_800_000_000_000;

let dir: string;
let db: DatabaseSync;
let user: User;

function writeLog(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function row(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: new Date(NOW).toISOString(),
    role: "section",
    model: "claude-sonnet-5",
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
    cost_usd: 0.5,
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-"));
  db = openDatabase(join(dir, "identity.db"));
  user = createUser(db, "a@example.com", "hash");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ingestUsageLog", () => {
  it("attributes every row to the user and sums to the file's total", () => {
    const path = writeLog("a.jsonl", [row(), row({ cost_usd: 0.25 }), ""]);
    const result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    expect(result).toEqual({ ingested: 2, skipped: 0 });
    expect(spendSince(db, user.id, 0).costUsd).toBe(0.75);
  });

  it("stores the token counts and the role, not just the cost", () => {
    const path = writeLog("b.jsonl", [row({ role: "edit" })]);
    ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    const stored = db.prepare("SELECT * FROM usage_event").get() as Record<string, unknown>;
    expect(stored.role).toBe("edit");
    expect(stored.model).toBe("claude-sonnet-5");
    expect(stored.input_tokens).toBe(10);
    expect(stored.output_tokens).toBe(20);
    expect(stored.cache_creation_input_tokens).toBe(1);
    expect(stored.cache_read_input_tokens).toBe(2);
    expect(stored.at).toBe(NOW);
  });

  it("keeps the rows before a truncated final line", () => {
    // A killed subprocess leaves exactly this: complete lines, then half of one.
    const path = writeLog("c.jsonl", [row(), row(), '{"role":"section","mod']);
    const result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    expect(result.ingested).toBe(2);
    expect(result.skipped).toBe(1);
    expect(spendSince(db, user.id, 0).costUsd).toBe(1);
  });

  it("skips a row with no model rather than inventing one", () => {
    const path = writeLog("d.jsonl", [row(), JSON.stringify({ role: "section", cost_usd: 5 })]);
    const result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    expect(result).toEqual({ ingested: 1, skipped: 1 });
    expect(spendSince(db, user.id, 0).costUsd).toBe(0.5);
  });

  it("stores a null cost as unpriced rather than as free", () => {
    const path = writeLog("e.jsonl", [row({ model: "gemini-flash-latest", cost_usd: null })]);
    ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    const window = spendSince(db, user.id, 0);
    expect(window.events).toBe(1);
    expect(window.unpricedEvents).toBe(1);
    expect(window.costUsd).toBe(0);
  });

  it("falls back to the ingest time when a timestamp is missing or unparseable", () => {
    const path = writeLog("f.jsonl", [row({ timestamp: "not a date" })]);
    ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    const stored = db.prepare("SELECT at FROM usage_event").get() as { at: number };
    // Attributed to now, not dropped: losing the row would understate the
    // bill, and understating is the dangerous direction for a cap.
    expect(stored.at).toBe(NOW);
  });

  it("clamps a future timestamp to the ingest time", () => {
    const path = writeLog("i.jsonl", [
      row({ timestamp: new Date(NOW + 40 * 24 * 60 * 60 * 1000).toISOString() }),
    ]);
    ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    const stored = db.prepare("SELECT at FROM usage_event").get() as { at: number };
    expect(stored.at).toBe(NOW);
  });

  it("is a no-op for a run that made no model calls", () => {
    const result = ingestUsageLog(db, {
      path: join(dir, "absent.jsonl"), userId: user.id, projectId: null, now: NOW,
    });
    expect(result).toEqual({ ingested: 0, skipped: 0 });
  });

  it("links rows to a project that exists", () => {
    // createProject is POSITIONAL: (db, ownerId, directory, name).
    const project = createProject(db, user.id, "run-a", "Run A");
    const path = writeLog("g.jsonl", [row()]);
    ingestUsageLog(db, { path, userId: user.id, projectId: project.id, now: NOW });
    const stored = db.prepare("SELECT project_id FROM usage_event").get() as { project_id: unknown };
    expect(stored.project_id).toBe(project.id);
  });

  it("still records the spend when the project row has gone", () => {
    // A foreign-key violation here would throw away an entire run's billing.
    const path = writeLog("h.jsonl", [row()]);
    const result = ingestUsageLog(db, {
      path, userId: user.id, projectId: "no-such-project", now: NOW,
    });
    expect(result.ingested).toBe(1);
    const stored = db.prepare("SELECT project_id FROM usage_event").get() as { project_id: unknown };
    expect(stored.project_id).toBe(null);
    expect(spendSince(db, user.id, 0).costUsd).toBe(0.5);
  });
});
