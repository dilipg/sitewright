import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createProject } from "./projects.ts";
import { eventsSince, recordUsageEvent, spendSince } from "./usage.ts";

let dir: string;
let db: DatabaseSync;
let userId: string;

function seed(overrides: Partial<Parameters<typeof recordUsageEvent>[1]> = {}): string {
  return recordUsageEvent(db, {
    userId,
    projectId: null,
    role: "section",
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 1.5,
    at: 1_000,
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-"));
  db = openDatabase(join(dir, "identity.db"));
  userId = createUser(db, "a@example.com", "hash").id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("recordUsageEvent", () => {
  it("returns a distinct id per row and stores every field", () => {
    const first = seed();
    const second = seed({ at: 2_000 });
    expect(first).not.toBe(second);

    const row = db.prepare("SELECT * FROM usage_event WHERE id = ?").get(first) as Record<string, unknown>;
    expect(row.user_id).toBe(userId);
    expect(row.project_id).toBe(null);
    expect(row.role).toBe("section");
    expect(row.model).toBe("claude-sonnet-5");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(200);
    expect(row.cost_usd).toBe(1.5);
    expect(row.at).toBe(1_000);
  });

  it("accepts a null cost for a model with no published rate", () => {
    const id = seed({ model: "gemini-flash-latest", costUsd: null });
    const row = db.prepare("SELECT cost_usd FROM usage_event WHERE id = ?").get(id) as { cost_usd: unknown };
    expect(row.cost_usd).toBe(null);
  });

  it("links a project when one is given", () => {
    // createProject is POSITIONAL: (db, ownerId, directory, name).
    const project = createProject(db, userId, "run-a", "Run A");
    const id = seed({ projectId: project.id });
    const row = db.prepare("SELECT project_id FROM usage_event WHERE id = ?").get(id) as { project_id: unknown };
    expect(row.project_id).toBe(project.id);
  });
});

describe("spendSince", () => {
  it("is zero for a user with no events, not null", () => {
    const window = spendSince(db, userId, 0);
    expect(window.costUsd).toBe(0);
    expect(window.events).toBe(0);
    expect(window.unpricedEvents).toBe(0);
  });

  it("sums only events at or after the boundary", () => {
    seed({ at: 999, costUsd: 5 });
    seed({ at: 1_000, costUsd: 2 });
    seed({ at: 1_001, costUsd: 3 });
    const window = spendSince(db, userId, 1_000);
    expect(window.costUsd).toBe(5);
    expect(window.events).toBe(2);
  });

  it("counts an unpriced event without letting it corrupt the sum", () => {
    seed({ costUsd: 2.5 });
    seed({ at: 1_001, costUsd: null });
    const window = spendSince(db, userId, 0);
    expect(window.costUsd).toBe(2.5);
    expect(window.events).toBe(2);
    expect(window.unpricedEvents).toBe(1);
  });

  it("never counts another user's spend", () => {
    const other = createUser(db, "b@example.com", "hash").id;
    seed({ costUsd: 4 });
    recordUsageEvent(db, {
      userId: other, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 99, at: 1_000,
    });
    expect(spendSince(db, userId, 0).costUsd).toBe(4);
    expect(spendSince(db, other, 0).costUsd).toBe(99);
  });
});

describe("eventsSince", () => {
  it("returns in-window events oldest first", () => {
    seed({ at: 3_000, costUsd: 3 });
    seed({ at: 1_000, costUsd: 1 });
    seed({ at: 2_000, costUsd: 2 });
    seed({ at: 500, costUsd: 9 });
    expect(eventsSince(db, userId, 1_000)).toEqual([
      { at: 1_000, costUsd: 1 },
      { at: 2_000, costUsd: 2 },
      { at: 3_000, costUsd: 3 },
    ]);
  });
});

describe("retention", () => {
  it("keeps the billing record when the project it referenced is deleted", () => {
    const project = createProject(db, userId, "run-b", "Run B");
    const id = seed({ projectId: project.id });
    db.prepare("DELETE FROM project WHERE id = ?").run(project.id);
    const row = db.prepare("SELECT project_id, cost_usd FROM usage_event WHERE id = ?").get(id) as
      | { project_id: unknown; cost_usd: unknown }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.project_id).toBe(null);
    expect(row?.cost_usd).toBe(1.5);
  });
});
