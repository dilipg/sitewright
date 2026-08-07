// server/src/require-enqueue-slot.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDatabase } from "./db.ts";
import { createUser, type User } from "./users.ts";
import { claimNextJob, createJob, finishJob, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER } from "./jobs.ts";
import { requireEnqueueSlot } from "./require-enqueue-slot.ts";

let dir: string;
let db: DatabaseSync;
let user: User;

/** Minimal ServerResponse stand-in: records what sendJson wrote — same idiom require-budget.test.ts uses. */
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

/** Creates `count` queued billable jobs for `userId` so the bound is already partly (or fully) spent. */
function seedActiveBillable(userId: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    createJob(db, { userId, projectId: null, kind: "regen", requestJson: "{}", now: 1_000 + i });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "require-enqueue-slot-"));
  db = openDatabase(join(dir, "identity.db"));
  user = createUser(db, "a@example.com", "hash");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("requireEnqueueSlot", () => {
  it("runs the handler when the user has no active billable jobs", async () => {
    let ran = false;
    const { res, recorded } = fakeRes();
    await requireEnqueueSlot(db, () => { ran = true; })(req, res, ctxFor(user));
    expect(recorded.status).toBe(0);
    expect(ran).toBe(true);
  });

  it(`runs the handler right up to MAX_ENQUEUED_BILLABLE_JOBS_PER_USER - 1 active jobs (${MAX_ENQUEUED_BILLABLE_JOBS_PER_USER - 1})`, async () => {
    seedActiveBillable(user.id, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER - 1);
    let ran = false;
    const { res, recorded } = fakeRes();
    await requireEnqueueSlot(db, () => { ran = true; })(req, res, ctxFor(user));
    expect(recorded.status).toBe(0);
    expect(ran).toBe(true);
  });

  it("refuses with 429, not the handler, once the user is AT the bound", async () => {
    seedActiveBillable(user.id, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
    let ran = false;
    const { res, recorded } = fakeRes();
    await requireEnqueueSlot(db, () => { ran = true; })(req, res, ctxFor(user));
    expect(recorded.status).toBe(429);
    expect(ran).toBe(false);
  });

  it("names the bound in the error body", async () => {
    seedActiveBillable(user.id, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
    const { res, recorded } = fakeRes();
    await requireEnqueueSlot(db, () => {})(req, res, ctxFor(user));
    const body = JSON.parse(recorded.body) as { error: string };
    expect(body.error).toContain(String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER));
  });

  it("never counts export jobs against the bound, however many are active", async () => {
    for (let i = 0; i < MAX_ENQUEUED_BILLABLE_JOBS_PER_USER + 5; i += 1) {
      createJob(db, { userId: user.id, projectId: null, kind: "export", requestJson: "{}", now: 1_000 + i });
    }
    let ran = false;
    const { res, recorded } = fakeRes();
    await requireEnqueueSlot(db, () => { ran = true; })(req, res, ctxFor(user));
    expect(recorded.status).toBe(0);
    expect(ran).toBe(true);
  });

  it("a slot frees itself once a job reaches a terminal status — no separate release call needed", async () => {
    seedActiveBillable(user.id, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
    const blocked = fakeRes();
    let ranWhileBlocked = false;
    await requireEnqueueSlot(db, () => { ranWhileBlocked = true; })(req, blocked.res, ctxFor(user));
    expect(blocked.recorded.status).toBe(429);
    expect(ranWhileBlocked).toBe(false);

    const claimed = claimNextJob(db, 2_000);
    finishJob(db, claimed!.id, { status: "succeeded", now: 3_000 });

    let ranAfterFinish = false;
    const after = fakeRes();
    await requireEnqueueSlot(db, () => { ranAfterFinish = true; })(req, after.res, ctxFor(user));
    expect(after.recorded.status).toBe(0);
    expect(ranAfterFinish).toBe(true);
  });

  it("is scoped per user -- another user at the bound does not block this one", async () => {
    const other = createUser(db, "b@example.com", "hash");
    seedActiveBillable(other.id, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
    let ran = false;
    const { res, recorded } = fakeRes();
    await requireEnqueueSlot(db, () => { ran = true; })(req, res, ctxFor(user));
    expect(recorded.status).toBe(0);
    expect(ran).toBe(true);
  });

  it("passes the context through untouched", async () => {
    let seen: unknown;
    const { res } = fakeRes();
    const ctx = { ...ctxFor(user), project: { id: "p1" } };
    await requireEnqueueSlot(db, (_r, _s, received) => { seen = received; })(req, res, ctx);
    expect(seen).toBe(ctx);
  });
});
