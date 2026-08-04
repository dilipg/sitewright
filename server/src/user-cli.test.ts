/**
 * Account creation lives here and ONLY here — no HTTP route creates a user
 * (spec, threat model). These tests are as much about what the CLI refuses to
 * do as what it does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "./db.ts";
import { findUserByEmail } from "./users.ts";
import { verifyPassword } from "./passwords.ts";
import { createSession, resolveSession } from "./sessions.ts";
import { runUserCommand } from "./user-cli.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "server-cli-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  return db;
}
afterAll(() => {
  // Close every handle before removing its directory: on Windows an open
  // SQLite (WAL) handle blocks directory removal.
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The generated password is the only place it is ever shown. */
function passwordFrom(output: string): string {
  return output.match(/password:\s*(\S+)/)![1]!;
}

describe("user create", () => {
  it("creates a user and prints a generated password that actually works", async () => {
    const db = freshDb();
    const output = await runUserCommand(db, ["create", "--email", "a@example.com"]);
    const user = findUserByEmail(db, "a@example.com");
    expect(user).not.toBeNull();
    expect(await verifyPassword(user!.passwordHash, passwordFrom(output))).toBe(true);
  });

  it("refuses to accept a password as an argument", async () => {
    // A password passed on the command line lands in shell history and the
    // process table. The CLI must generate it instead.
    const db = freshDb();
    await expect(
      runUserCommand(db, ["create", "--email", "a@example.com", "--password", "hunter2"]),
    ).rejects.toThrow(/generated/i);
  });

  it("refuses a duplicate email with a clear message", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    await expect(runUserCommand(db, ["create", "--email", "A@Example.com"])).rejects.toThrow(/already exists/i);
  });

  it("requires an email", async () => {
    await expect(runUserCommand(freshDb(), ["create"])).rejects.toThrow(/--email/);
  });
});

describe("user disable", () => {
  it("disables the account and revokes live sessions immediately", async () => {
    // Revocation is the reason sessions are server-side. Disabling must lock
    // out someone who is already logged in, not just block the next login.
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    const user = findUserByEmail(db, "a@example.com")!;
    const session = createSession(db, user.id);

    await runUserCommand(db, ["disable", "--email", "a@example.com"]);

    expect(findUserByEmail(db, "a@example.com")!.disabledAt).toBeTypeOf("number");
    expect(resolveSession(db, session.id)).toBeNull();
  });

  it("errors on an unknown email rather than silently succeeding", async () => {
    await expect(runUserCommand(freshDb(), ["disable", "--email", "ghost@example.com"])).rejects.toThrow(/no user/i);
  });
});

describe("user enable", () => {
  it("clears disabledAt on a previously disabled user, without resurrecting revoked sessions", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    const user = findUserByEmail(db, "a@example.com")!;
    const session = createSession(db, user.id);

    await runUserCommand(db, ["disable", "--email", "a@example.com"]);
    expect(findUserByEmail(db, "a@example.com")!.disabledAt).toBeTypeOf("number");
    expect(resolveSession(db, session.id)).toBeNull();

    await runUserCommand(db, ["enable", "--email", "a@example.com"]);
    expect(findUserByEmail(db, "a@example.com")!.disabledAt).toBeNull();

    // A re-enabled account must require a fresh login, not walk back in on a
    // session that was already revoked by the disable.
    expect(resolveSession(db, session.id)).toBeNull();
  });

  it("errors on an unknown email rather than silently succeeding", async () => {
    await expect(runUserCommand(freshDb(), ["enable", "--email", "ghost@example.com"])).rejects.toThrow(/no user/i);
  });
});

describe("user reset-password", () => {
  it("issues a new working password and revokes existing sessions", async () => {
    const db = freshDb();
    const created = await runUserCommand(db, ["create", "--email", "a@example.com"]);
    const user = findUserByEmail(db, "a@example.com")!;
    const session = createSession(db, user.id);

    const reset = await runUserCommand(db, ["reset-password", "--email", "a@example.com"]);
    const fresh = findUserByEmail(db, "a@example.com")!;

    expect(await verifyPassword(fresh.passwordHash, passwordFrom(reset))).toBe(true);
    expect(await verifyPassword(fresh.passwordHash, passwordFrom(created))).toBe(false);
    expect(resolveSession(db, session.id)).toBeNull();
  });
});

describe("user set-cap and list", () => {
  it("sets a spend cap", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    await runUserCommand(db, ["set-cap", "--email", "a@example.com", "--usd", "50"]);
    expect(findUserByEmail(db, "a@example.com")!.spendCapUsd).toBe(50);
  });

  it("rejects a non-numeric cap", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    await expect(runUserCommand(db, ["set-cap", "--email", "a@example.com", "--usd", "lots"])).rejects.toThrow(/number/i);
  });

  it("rejects a negative cap", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    await expect(runUserCommand(db, ["set-cap", "--email", "a@example.com", "--usd", "-5"])).rejects.toThrow(/number/i);
  });

  it("lists users without ever printing a hash", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    const output = await runUserCommand(db, ["list"]);
    expect(output).toContain("a@example.com");
    expect(output).not.toContain("argon2");
  });
});

describe("unknown command", () => {
  it("lists the valid commands", async () => {
    await expect(runUserCommand(freshDb(), ["frobnicate"])).rejects.toThrow(/create/);
  });
});
