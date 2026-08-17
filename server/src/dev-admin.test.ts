/**
 * The default `admin` / `admin` account exists for one reason — a tester should
 * not have to run a CLI command before they can log in — and it is only
 * defensible because of the bounds these tests pin. Each `it` below names a
 * bound whose removal turns a convenience into a way for someone else to spend
 * a tester's API key.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEV_ADMIN_DISABLE_ENV_VAR,
  DEV_ADMIN_EMAIL,
  DEV_ADMIN_PASSWORD,
  DEV_ADMIN_SPEND_CAP_USD,
  isLoopbackHost,
  seedDevAdmin,
} from "./dev-admin.ts";
import { openDatabase } from "./db.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { createUser, findUserByEmail, listUsers } from "./users.ts";

// A real file, not `:memory:` — the same idiom `users.test.ts` uses, so the
// migration path these tests run through is the one production runs through.
//
// The handles are CLOSED before the directories are removed, which
// `users.test.ts` does not need to do and this file does. `openDatabase` puts
// SQLite in WAL mode, so an open connection keeps `-wal` and `-shm` files
// alongside the database; on Windows `rmSync` on the containing directory then
// fails `EPERM` even with `force: true`, because force covers a missing path,
// not a locked one. Measured: this file failed the gate exactly that way before
// the `close()` below existed.
const dirs: string[] = [];
const opened: { close(): void }[] = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "server-dev-admin-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  opened.push(db);
  return db;
}
afterAll(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // Already closed, or never fully opened — either way there is nothing
      // holding the file, which is all this loop is for.
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const LOOPBACK = { host: "127.0.0.1", env: {}, log: () => {} };

describe("seedDevAdmin: the happy path it exists for", () => {
  it("creates an account a tester can actually sign in with", async () => {
    const db = freshDb();
    expect(await seedDevAdmin(db, LOOPBACK)).toBe("seeded");

    const user = findUserByEmail(db, DEV_ADMIN_EMAIL);
    expect(user).not.toBeNull();
    // The password must genuinely verify — storing the literal string, or
    // hashing something else, would leave a tester unable to log in with the
    // credential the console just told them to use.
    expect(await verifyPassword(user!.passwordHash, DEV_ADMIN_PASSWORD)).toBe(true);
  });

  it("never stores the password in plaintext", async () => {
    const db = freshDb();
    await seedDevAdmin(db, LOOPBACK);
    const user = findUserByEmail(db, DEV_ADMIN_EMAIL)!;
    expect(user.passwordHash).not.toContain(DEV_ADMIN_PASSWORD);
    expect(user.passwordHash.startsWith("$argon2")).toBe(true);
  });

  it("gives the seeded account a modest cap, not an unbounded one", async () => {
    // A default credential should not also carry a large default spending
    // authority: the two risks multiply.
    const db = freshDb();
    await seedDevAdmin(db, LOOPBACK);
    expect(findUserByEmail(db, DEV_ADMIN_EMAIL)!.spendCapUsd).toBe(DEV_ADMIN_SPEND_CAP_USD);
  });

  it("announces the credential, since a silent default account is worse than none", async () => {
    const lines: string[] = [];
    await seedDevAdmin(freshDb(), { ...LOOPBACK, log: (m) => lines.push(m) });
    const output = lines.join("\n");
    expect(output).toContain(DEV_ADMIN_EMAIL);
    expect(output).toContain(DEV_ADMIN_PASSWORD);
    // And it must say the password is known, or a reader takes it for a secret.
    expect(output).toMatch(/known password/i);
  });
});

describe("seedDevAdmin: the bounds that make it defensible", () => {
  it("refuses on a non-loopback bind, because the account would be reachable off this machine", async () => {
    // THE most important bound. `serve.ts` used to pass no host to `listen`,
    // which binds every interface — a known credential on a LAN, with a session
    // cookie that carries no Secure flag.
    const db = freshDb();
    expect(await seedDevAdmin(db, { ...LOOPBACK, host: "0.0.0.0" })).toBe("skipped-not-loopback");
    expect(listUsers(db)).toHaveLength(0);
  });

  it("refuses on any concrete external address too, not just 0.0.0.0", async () => {
    const db = freshDb();
    expect(await seedDevAdmin(db, { ...LOOPBACK, host: "192.168.1.42" })).toBe("skipped-not-loopback");
    expect(listUsers(db)).toHaveLength(0);
  });

  it("honours the off switch", async () => {
    const db = freshDb();
    const result = await seedDevAdmin(db, { ...LOOPBACK, env: { [DEV_ADMIN_DISABLE_ENV_VAR]: "1" } });
    expect(result).toBe("skipped-disabled");
    expect(listUsers(db)).toHaveLength(0);
  });

  it("does nothing when the database already has ANY user", async () => {
    // Keyed on the table being empty, not on `admin` being absent: an operator
    // who created their own account never asked for this one.
    const db = freshDb();
    createUser(db, "someone@example.com", await hashPassword("pw"));

    expect(await seedDevAdmin(db, LOOPBACK)).toBe("skipped-users-exist");
    expect(findUserByEmail(db, DEV_ADMIN_EMAIL)).toBeNull();
    expect(listUsers(db)).toHaveLength(1);
  });

  it("does not resurrect the account after it has been deleted or replaced", async () => {
    // The second boot must be a no-op. Otherwise "delete the default account"
    // is impossible advice, and an operator who rotated the password would find
    // the known one working again.
    const db = freshDb();
    await seedDevAdmin(db, LOOPBACK);
    const first = findUserByEmail(db, DEV_ADMIN_EMAIL)!;

    expect(await seedDevAdmin(db, LOOPBACK)).toBe("skipped-users-exist");
    expect(listUsers(db)).toHaveLength(1);
    expect(findUserByEmail(db, DEV_ADMIN_EMAIL)!.id).toBe(first.id);
  });
});

describe("isLoopbackHost", () => {
  it("accepts the forms Node actually resolves localhost to", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST", " ::ffff:127.0.0.1 "]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects every external form, including the ones that merely look local", () => {
    // `0.0.0.0` is the dangerous one: it reads like "nothing" and means
    // "everything". The 127.x.x.x-adjacent strings are here because a
    // substring or prefix check would wave them through.
    for (const host of ["0.0.0.0", "::", "192.168.1.42", "10.0.0.5", "127.0.0.1.evil.com", "localhost.evil.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
