import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

let callCount = 0;
let lastCallArg: number | undefined;
const dirs: string[] = [];

vi.mock("node:crypto", async () => {
  const actualCrypto = await vi.importActual("node:crypto");
  return {
    randomBytes: (size: number) => {
      callCount += 1;
      lastCallArg = size;
      return (actualCrypto as any).randomBytes(size);
    },
    randomUUID: () => (actualCrypto as any).randomUUID(),
  };
});

describe("sessions entropy", () => {
  beforeEach(() => {
    callCount = 0;
    lastCallArg = undefined;
    vi.resetModules();
  });

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("uses crypto.randomBytes(32) for session id generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-sessions-entropy-"));
    dirs.push(dir);

    const { openDatabase } = await import("./db.ts");
    const { createUser } = await import("./users.ts");
    const { createSession } = await import("./sessions.ts");

    const db = openDatabase(join(dir, "identity.db"));
    const user = createUser(db, "a@example.com", "h");

    const beforeCallCount = callCount;
    createSession(db, user.id);

    expect(callCount - beforeCallCount).toBe(1);
    expect(lastCallArg).toBe(32);
    db.close();
  });
});
