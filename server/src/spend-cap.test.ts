import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser, setSpendCap, findUserById, type User } from "./users.ts";
import { recordUsageEvent } from "./usage.ts";
import { checkSpendCap, describeSpendCap, SPEND_WINDOW_MS } from "./spend-cap.ts";

const NOW = 1_800_000_000_000;

let dir: string;
let db: DatabaseSync;
let user: User;

function spend(costUsd: number | null, at: number): void {
  recordUsageEvent(db, {
    userId: user.id, projectId: null, role: "section", model: "claude-sonnet-5",
    inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    costUsd, at,
  });
}

function reload(): User {
  const fresh = findUserById(db, user.id);
  if (fresh === null) throw new Error("user vanished");
  return fresh;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spend-cap-"));
  db = openDatabase(join(dir, "identity.db"));
  user = createUser(db, "a@example.com", "hash");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the window", () => {
  it("is exactly 24 hours", () => {
    expect(SPEND_WINDOW_MS).toBe(86_400_000);
  });

  it("defaults to a $10 cap and permits a user who has spent nothing", () => {
    const status = checkSpendCap(db, user, NOW);
    expect(status.allowed).toBe(true);
    expect(status.capUsd).toBe(10);
    expect(status.spentUsd).toBe(0);
    expect(status.resetAt).toBe(null);
  });

  it("ignores spend that has aged out of the window", () => {
    spend(50, NOW - SPEND_WINDOW_MS - 1);
    const status = checkSpendCap(db, user, NOW);
    expect(status.allowed).toBe(true);
    expect(status.spentUsd).toBe(0);
  });

  it("counts spend at the exact boundary as still inside the window", () => {
    spend(50, NOW - SPEND_WINDOW_MS);
    expect(checkSpendCap(db, user, NOW).spentUsd).toBe(50);
  });
});

describe("the cap comparison", () => {
  it("refuses at exactly the cap, not only above it", () => {
    spend(2.5, NOW - 1_000);
    spend(7.5, NOW - 500);
    const status = checkSpendCap(db, user, NOW);
    expect(status.spentUsd).toBe(10);
    expect(status.allowed).toBe(false);
  });

  it("permits a cent below the cap", () => {
    spend(9.99, NOW - 1_000);
    expect(checkSpendCap(db, user, NOW).allowed).toBe(true);
  });

  it("honours a raised per-user cap", () => {
    spend(12, NOW - 1_000);
    expect(checkSpendCap(db, user, NOW).allowed).toBe(false);
    setSpendCap(db, user.id, 25);
    const status = checkSpendCap(db, reload(), NOW);
    expect(status.capUsd).toBe(25);
    expect(status.allowed).toBe(true);
  });

  it("refuses everything at a zero cap, with no reset that would ever help", () => {
    setSpendCap(db, user.id, 0);
    const status = checkSpendCap(db, reload(), NOW);
    expect(status.allowed).toBe(false);
    expect(status.spentUsd).toBe(0);
    expect(status.resetAt).toBe(null);
  });
});

describe("the reset time", () => {
  it("is the instant the blocking spend ages out — checked against the policy itself", () => {
    spend(6, NOW - 10_000);
    spend(6, NOW - 5_000);
    const status = checkSpendCap(db, user, NOW);
    expect(status.allowed).toBe(false);
    expect(status.resetAt).not.toBe(null);

    const resetAt = status.resetAt as number;
    expect(checkSpendCap(db, user, resetAt).allowed).toBe(true);
    expect(checkSpendCap(db, user, resetAt - 1).allowed).toBe(false);
  });

  it("drops as many events as it takes, not just the oldest", () => {
    // Four $3 events; the cap is $10. Dropping one leaves $9 — under. So the
    // reset is tied to the FIRST event, and dropping exactly one suffices.
    spend(3, NOW - 40_000);
    spend(3, NOW - 30_000);
    spend(3, NOW - 20_000);
    spend(3, NOW - 10_000);
    const status = checkSpendCap(db, user, NOW);
    expect(status.spentUsd).toBe(12);
    expect(status.resetAt).toBe(NOW - 40_000 + SPEND_WINDOW_MS + 1);
  });

  it("needs two events dropped when one is not enough", () => {
    // $2 + $2 + $9 = $13 against a $10 cap. Dropping the first leaves $11 —
    // still over. Dropping the second leaves $9 — under.
    spend(2, NOW - 40_000);
    spend(2, NOW - 30_000);
    spend(9, NOW - 20_000);
    const status = checkSpendCap(db, user, NOW);
    expect(status.resetAt).toBe(NOW - 30_000 + SPEND_WINDOW_MS + 1);
    expect(checkSpendCap(db, user, status.resetAt as number).allowed).toBe(true);
  });
});

describe("unpriced models", () => {
  it("reports how many in-window events had no price", () => {
    spend(1, NOW - 1_000);
    spend(null, NOW - 900);
    spend(null, NOW - 800);
    const status = checkSpendCap(db, user, NOW);
    expect(status.spentUsd).toBe(1);
    expect(status.unpricedEvents).toBe(2);
  });
});

describe("describeSpendCap", () => {
  it("names the cap, the spend and the reset time", () => {
    spend(6, NOW - 10_000);
    spend(6, NOW - 5_000);
    const status = checkSpendCap(db, user, NOW);
    const message = describeSpendCap(status);
    expect(message).toContain("$12.00");
    expect(message).toContain("$10.00");
    expect(message).toContain(new Date(status.resetAt as number).toISOString());
  });

  it("says so plainly when the cap is zero and no reset will help", () => {
    setSpendCap(db, user.id, 0);
    const message = describeSpendCap(checkSpendCap(db, reload(), NOW));
    expect(message).toContain("$0.00");
    expect(message.toLowerCase()).not.toContain("resets");
  });
});
