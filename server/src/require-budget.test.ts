import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDatabase } from "./db.ts";
import { createUser, setSpendCap, findUserById, type User } from "./users.ts";
import { recordUsageEvent } from "./usage.ts";
import { requireBudget } from "./require-budget.ts";

let dir: string;
let db: DatabaseSync;
let user: User;

/** Minimal ServerResponse stand-in: records what sendJson wrote. */
function fakeRes() {
  const recorded = { status: 0, body: "" as string, headers: {} as Record<string, string> };
  const res = {
    setHeader(name: string, value: string) { recorded.headers[name] = value; },
    writeHead(status: number, headers?: Record<string, string>) {
      recorded.status = status;
      Object.assign(recorded.headers, headers ?? {});
      return res;
    },
    end(chunk?: string) { recorded.body = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, recorded };
}

const req = {} as IncomingMessage;

function ctxFor(current: User) {
  return { url: new URL("http://localhost/x"), params: {}, user: current };
}

function reload(): User {
  const fresh = findUserById(db, user.id);
  if (fresh === null) throw new Error("user vanished");
  return fresh;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "require-budget-"));
  db = openDatabase(join(dir, "identity.db"));
  user = createUser(db, "a@example.com", "hash");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("requireBudget", () => {
  it("runs the handler when the user is under the cap", async () => {
    let ran = false;
    const { res, recorded } = fakeRes();
    await requireBudget(db, () => { ran = true; })(req, res, ctxFor(user));
    // Status first: if the wrapper refused, `ran` alone would not say why.
    expect(recorded.status).toBe(0);
    expect(ran).toBe(true);
  });

  it("refuses with 402 and never calls the handler when over the cap", async () => {
    let ran = false;
    recordUsageEvent(db, {
      userId: user.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 11, at: Date.now(),
    });
    const { res, recorded } = fakeRes();
    await requireBudget(db, () => { ran = true; })(req, res, ctxFor(user));
    expect(recorded.status).toBe(402);
    expect(ran).toBe(false);
  });

  it("carries the cap, the spend and the reset time in the body", async () => {
    recordUsageEvent(db, {
      userId: user.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 11, at: Date.now(),
    });
    const { res, recorded } = fakeRes();
    await requireBudget(db, () => {})(req, res, ctxFor(user));
    const body = JSON.parse(recorded.body) as {
      error: string; capUsd: number; spentUsd: number; resetAt: number | null;
    };
    expect(body.capUsd).toBe(10);
    expect(body.spentUsd).toBe(11);
    expect(typeof body.resetAt).toBe("number");
    expect(body.error).toContain("$11.00");
    expect(body.error).toContain("$10.00");
  });

  it("reflects a cap the operator changed, without a restart", async () => {
    recordUsageEvent(db, {
      userId: user.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 11, at: Date.now(),
    });
    setSpendCap(db, user.id, 50);
    let ran = false;
    const { res, recorded } = fakeRes();
    await requireBudget(db, () => { ran = true; })(req, res, ctxFor(reload()));
    expect(recorded.status).toBe(0);
    expect(ran).toBe(true);
  });

  it("passes the context through untouched", async () => {
    let seen: unknown;
    const { res } = fakeRes();
    const ctx = { ...ctxFor(user), project: { id: "p1" } };
    await requireBudget(db, (_r, _s, received) => { seen = received; })(req, res, ctx);
    expect(seen).toBe(ctx);
  });

  it("awaits an async handler before returning", async () => {
    let finished = false;
    const { res } = fakeRes();
    await requireBudget(db, async () => {
      await new Promise((r) => setTimeout(r, 5));
      finished = true;
    })(req, res, ctxFor(user));
    expect(finished).toBe(true);
  });
});
