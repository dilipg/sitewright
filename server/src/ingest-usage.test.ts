import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser, type User } from "./users.ts";
import { createProject } from "./projects.ts";
import { spendSince } from "./usage.ts";
import { ingestUsageLog, type IngestResult } from "./ingest-usage.ts";

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
  try {
    db.close();
  } catch {
    // Already closed by the "database itself fails" test, which closes db
    // mid-test to exercise the outer backstop. A second close throws
    // "database is not open" in node:sqlite; swallow it here rather than
    // giving that one test a bespoke teardown.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("ingestUsageLog", () => {
  it("attributes every row to the user and sums to the file's total", () => {
    const path = writeLog("a.jsonl", [row(), row({ cost_usd: 0.25 }), ""]);
    const result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    expect(result).toEqual({ ingested: 2, skipped: 0, unreadable: false });
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
    expect(result).toEqual({ ingested: 1, skipped: 1, unreadable: false });
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
    expect(result).toEqual({ ingested: 0, skipped: 0, unreadable: false });
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

  it("reports every line as skipped, rather than throwing, when the user has gone", () => {
    const path = writeLog("j.jsonl", [row(), row()]);
    let result: IngestResult | undefined;
    expect(() => {
      result = ingestUsageLog(db, { path, userId: "no-such-user", projectId: null, now: NOW });
    }).not.toThrow();
    expect(result).toEqual({ ingested: 0, skipped: 2, unreadable: false });
  });

  it("survives a line that is the literal JSON null", () => {
    // typeof null === "object", so the null guard is what stops this crashing.
    const path = writeLog("k.jsonl", [row(), "null"]);
    const result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    expect(result).toEqual({ ingested: 1, skipped: 1, unreadable: false });
  });

  it("treats a negative cost as unpriced rather than letting it reduce the total", () => {
    const path = writeLog("l.jsonl", [row({ cost_usd: 2 }), row({ cost_usd: -5 })]);
    ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    const window = spendSince(db, user.id, 0);
    expect(window.costUsd).toBe(2);
    expect(window.unpricedEvents).toBe(1);
  });

  it("returns rather than throwing when the database itself fails", () => {
    const path = writeLog("m.jsonl", [row(), row()]);
    db.close();
    let result: IngestResult | undefined;
    expect(() => {
      result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    }).not.toThrow();
    // findUserById is the first db call reached (projectId is null, so
    // findProjectById is short-circuited), and it throws "database is not
    // open" before either row is processed. The line count is read from the
    // file BEFORE that call runs, so the loss is still the true "2", not a
    // guessed-at "whatever was counted before the failure" — see the next
    // test for the case this used to get wrong.
    expect(result).toEqual({ ingested: 0, skipped: 2, unreadable: false });
  });

  it("reports the true loss when the database dies mid-file, not a no-op", () => {
    const path = writeLog("n.jsonl", [row(), row(), row()]);
    db.close();
    let result: IngestResult | undefined;
    expect(() => {
      result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    }).not.toThrow();
    // The distinction that matters: NOT {0, 0}, which is what a run with no
    // model calls returns. Three rows of spend were lost and the caller must
    // be able to tell.
    expect(result).toEqual({ ingested: 0, skipped: 3, unreadable: false });
  });

  it("flags an unreadable file distinctly from a run that made no model calls", () => {
    // A directory at the log's path: exists, but readFileSync throws EISDIR.
    const path = join(dir, "as-a-directory.jsonl");
    mkdirSync(path);
    const result = ingestUsageLog(db, { path, userId: user.id, projectId: null, now: NOW });
    expect(result).toEqual({ ingested: 0, skipped: 0, unreadable: true });
  });
});

/**
 * `fixtures/usage-log-contract.jsonl` (repo root) is the contract shared with
 * the orchestrator's writer, `record_usage`
 * (orchestrator/src/orchestrator/accounting.py) — the two sides were built
 * from separate briefs and, before this test and its Python counterpart in
 * orchestrator/tests/test_accounting.py, were never checked against each
 * other. This half ingests the checked-in file directly (never a hardcoded
 * absolute path — resolved from this file's own URL, since the golden file
 * lives outside this package) and asserts the reader can still make sense of
 * exactly what the writer produces.
 */
describe("the golden-file contract with the orchestrator's writer", () => {
  const goldenPath = fileURLToPath(new URL("../../fixtures/usage-log-contract.jsonl", import.meta.url));

  it("ingests all three golden rows, treating the unpriced model as a floor rather than losing it", () => {
    const result = ingestUsageLog(db, { path: goldenPath, userId: user.id, projectId: null, now: NOW });
    expect(result).toEqual({ ingested: 3, skipped: 0, unreadable: false });

    const window = spendSince(db, user.id, 0);
    expect(window.events).toBe(3);
    expect(window.unpricedEvents).toBe(1);

    // The sonnet row is the golden file's "all four token fields non-zero"
    // case. Its full token counts, not just its cost, must survive the round
    // trip, and its own timestamp — not the ingest time `NOW` — is what it
    // must be attributed to.
    const goldenRows = readFileSync(goldenPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const sonnetRow = goldenRows.find((r) => r.model === "claude-sonnet-5");
    if (sonnetRow === undefined) throw new Error("golden file has no claude-sonnet-5 row");

    const stored = db.prepare(
      "SELECT * FROM usage_event WHERE model = 'claude-sonnet-5'",
    ).get() as Record<string, unknown>;
    expect(stored.input_tokens).toBe(sonnetRow.input_tokens);
    expect(stored.output_tokens).toBe(sonnetRow.output_tokens);
    expect(stored.cache_creation_input_tokens).toBe(sonnetRow.cache_creation_input_tokens);
    expect(stored.cache_read_input_tokens).toBe(sonnetRow.cache_read_input_tokens);
    expect(stored.at).toBe(Date.parse(sonnetRow.timestamp as string));
  });
});
