/**
 * The stored key is a bearer credential for someone else's Anthropic account.
 * If it leaks it is their money and their data, so the interesting assertions
 * here are about what does NOT come back out.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import {
  deleteApiKey, fingerprintOf, getApiKeyFingerprint, getApiKeyPlaintext, setApiKey,
} from "./api-keys.ts";

const masterKey = randomBytes(32);
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-XY9z";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "server-keys-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const user = createUser(db, "a@example.com", "hash");
  return { db, user };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("fingerprintOf", () => {
  it("is the last four characters", () => {
    expect(fingerprintOf(KEY)).toBe("XY9z");
  });

  it("is never longer than four characters, whatever the input", () => {
    // Stated as what is actually true rather than as "reveals nothing": for an
    // input shorter than four characters `slice(-4)` returns the whole string.
    // That is unreachable — the route's shape check requires 20+ characters
    // after the prefix — but the bound is the honest claim, so assert the bound.
    expect(fingerprintOf("abc").length).toBeLessThanOrEqual(4);
    expect(fingerprintOf(KEY).length).toBe(4);
  });
});

describe("setApiKey / getApiKeyPlaintext", () => {
  it("round-trips through the database", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBe(KEY);
  });

  it("returns the fingerprint from setApiKey", () => {
    const { db, user } = fresh();
    expect(setApiKey(db, masterKey, user.id, KEY)).toBe("XY9z");
  });

  it("stores no plaintext anywhere in the row", () => {
    // The whole point of the slice. Read the raw row and assert the key is not
    // sitting in any column.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    const row = db.prepare("SELECT * FROM api_key WHERE user_id = ?").get(user.id);
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain("sk-ant");
  });

  it("replaces an existing key rather than failing or adding a second", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    setApiKey(db, masterKey, user.id, "sk-ant-api03-second-key-value-AAAA");
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBe("sk-ant-api03-second-key-value-AAAA");
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").get()).toEqual({ n: 1 });
  });

  it("returns null for a user with no key", () => {
    const { db, user } = fresh();
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBeNull();
    expect(getApiKeyFingerprint(db, user.id)).toBeNull();
  });

  it("throws rather than returning nonsense when the master key has changed", () => {
    // Operationally real: someone rotates WEBGEN_MASTER_KEY and restarts.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    expect(() => getApiKeyPlaintext(db, randomBytes(32), user.id)).toThrow();
  });
});

describe("getApiKeyFingerprint", () => {
  it("needs no master key, so a fingerprint read cannot decrypt", () => {
    // Structural: the function's signature has no master-key parameter, so a
    // caller that only wants to display "…XY9z" is incapable of decrypting.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    expect(getApiKeyFingerprint(db, user.id)).toBe("XY9z");
  });
});

describe("deleteApiKey", () => {
  it("removes the key", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    deleteApiKey(db, user.id);
    expect(getApiKeyFingerprint(db, user.id)).toBeNull();
  });

  it("is silent for a user with no key, so revoking twice is not an error", () => {
    const { db, user } = fresh();
    expect(() => deleteApiKey(db, user.id)).not.toThrow();
  });
});

describe("schema", () => {
  it("deletes the key when the user is deleted", () => {
    // ON DELETE CASCADE, matching session. A key outliving its owner is a
    // credential nobody is accountable for.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    db.prepare("DELETE FROM user WHERE id = ?").run(user.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").get()).toEqual({ n: 0 });
  });
});
