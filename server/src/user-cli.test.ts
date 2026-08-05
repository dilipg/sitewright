/**
 * Account creation lives here and ONLY here — no HTTP route creates a user
 * (spec, threat model). These tests are as much about what the CLI refuses to
 * do as what it does.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "./db.ts";
import { findUserByEmail, listUsers } from "./users.ts";
import { verifyPassword } from "./passwords.ts";
import { createSession, resolveSession } from "./sessions.ts";
import { getApiKeyFingerprint, setApiKey } from "./api-keys.ts";
import { createProject } from "./projects.ts";
import { recordUsageEvent } from "./usage.ts";
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

  it("does not let a missing --email value swallow the next flag's name", async () => {
    // Without the flag() guard, argv[index+1] would be "--usd" and the CLI
    // would silently create a user literally named "--usd", dropping the 50.
    // Asserts the specific "is required" message (not just /--email/), so
    // this test actually exercises the flag() guard rather than being
    // incidentally satisfied by the separate email-format check below.
    const db = freshDb();
    await expect(runUserCommand(db, ["create", "--email", "--usd", "50"])).rejects.toThrow(/--email is required/);
    expect(listUsers(db)).toHaveLength(0);
  });

  it("rejects a malformed email", async () => {
    const db = freshDb();
    await expect(runUserCommand(db, ["create", "--email", "not-an-email"])).rejects.toThrow(/email address/i);
    expect(listUsers(db)).toHaveLength(0);
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

describe("user clear-key", () => {
  it("removes a stored key without needing the master key", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    const user = findUserByEmail(db, "a@example.com")!;
    setApiKey(db, randomBytes(32), user.id, "sk-ant-api03-something-stored-XY9z");

    await runUserCommand(db, ["clear-key", "--email", "a@example.com"]);

    expect(getApiKeyFingerprint(db, user.id)).toBeNull();
    // No db.close() here: freshDb() already registers this handle in `dbs`
    // for the shared afterAll to close. Closing it again threw "database is
    // not open" from inside afterAll and turned the whole file into a
    // reported failed suite even though all 18 tests passed — confirmed live
    // before this line was removed. Every other test in this file relies on
    // the same afterAll-only cleanup; these two now match that convention.
  });

  it("errors on an unknown email rather than silently succeeding", async () => {
    const db = freshDb();
    await expect(runUserCommand(db, ["clear-key", "--email", "ghost@example.com"]))
      .rejects.toThrow(/no user/i);
  });
});

describe("user list-projects", () => {
  it("prints every project's directory and owner email, and never a password hash", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    await runUserCommand(db, ["create", "--email", "b@example.com"]);
    const alice = findUserByEmail(db, "a@example.com")!;
    const bob = findUserByEmail(db, "b@example.com")!;
    createProject(db, alice.id, "alice-run", "Alice");
    createProject(db, bob.id, "bob-run", "Bob");

    const output = await runUserCommand(db, ["list-projects"]);

    expect(output).toContain("alice-run");
    expect(output).toContain("a@example.com");
    expect(output).toContain("bob-run");
    expect(output).toContain("b@example.com");
    expect(output).not.toContain("argon2");
  });

  it("reports no projects rather than an empty string", async () => {
    const output = await runUserCommand(freshDb(), ["list-projects"]);
    expect(output).toBe("no projects");
  });
});

describe("user usage", () => {
  it("reports a user's 24h spend against their cap", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "a@example.com"]);
    const user = findUserByEmail(db, "a@example.com")!;
    recordUsageEvent(db, {
      userId: user.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 4.5, at: Date.now(),
    });
    const output = await runUserCommand(db, ["usage", "--email", "a@example.com"]);
    expect(output).toContain("$4.50");
    expect(output).toContain("$10.00");
    expect(output).toContain("under the cap");
  });

  it("says plainly when a user is over the cap, and when they can resume", async () => {
    const db = freshDb();
    await runUserCommand(db, ["create", "--email", "b@example.com"]);
    const user = findUserByEmail(db, "b@example.com")!;
    recordUsageEvent(db, {
      userId: user.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 12, at: Date.now(),
    });
    const output = await runUserCommand(db, ["usage", "--email", "b@example.com"]);
    expect(output).toContain("AT OR OVER THE CAP");
    expect(output).toContain("resets");
  });

  it("refuses usage for an unknown email", async () => {
    const db = freshDb();
    await expect(runUserCommand(db, ["usage", "--email", "nobody@example.com"])).rejects.toThrow();
  });
});

describe("unknown command", () => {
  it("lists the valid commands", async () => {
    await expect(runUserCommand(freshDb(), ["frobnicate"])).rejects.toThrow(/create/);
  });
});
