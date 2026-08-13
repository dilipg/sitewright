// server/src/job-provider.test.ts
/**
 * FIX ROUND B, I7. `code-version.test.ts`'s sibling, case for case, because the
 * guard is the sibling of that one: the interesting content of both is the set of
 * carve-outs, and each carve-out is a decision that can be silently inverted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { setApiKey } from "./api-keys.ts";
import { openDatabase } from "./db.ts";
import { currentProviderFor, describeProviderMismatch, providersIncompatible } from "./job-provider.ts";
import { createUser } from "./users.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
/** Any 32 bytes: nothing here decrypts — `currentProviderFor` reads the provider column. */
const MASTER_KEY = Buffer.alloc(32, 3);

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "job-provider-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  return db;
}

afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("providersIncompatible", () => {
  it("is false for a null recorded provider, whatever the account uses now", () => {
    // THE carve-out that keeps every legitimate resume working: null means the
    // job never reached `recordJobRun` (or made no model call at all, e.g.
    // `export`), so no cached checkpoint exists under any family. Making this
    // refuse breaks resume for every job that failed before it started, and for
    // every row that predates the column.
    expect(providersIncompatible(null, "anthropic")).toBe(false);
    expect(providersIncompatible(null, "gemini")).toBe(false);
    expect(providersIncompatible(null, null)).toBe(false);
  });

  it("is false when the recorded provider is the one the account still uses", () => {
    expect(providersIncompatible("anthropic", "anthropic")).toBe(false);
    expect(providersIncompatible("gemini", "gemini")).toBe(false);
  });

  it("is TRUE when the provider changed — either direction", () => {
    // The defect I7 names: a key swapped between a failed job and its resume
    // continues one `run_id` across two model families.
    expect(providersIncompatible("anthropic", "gemini")).toBe(true);
    expect(providersIncompatible("gemini", "anthropic")).toBe(true);
  });

  it("is TRUE for a recorded value that is not a known provider — fails closed", () => {
    // Unreachable while the column's CHECK holds (db.ts), so this covers a
    // hand-edited database. Guessing "probably anthropic" is exactly the
    // mistake that sends one family's cached work to another.
    expect(providersIncompatible("openai", "anthropic")).toBe(true);
    expect(providersIncompatible("", "anthropic")).toBe(true);
    expect(providersIncompatible("ANTHROPIC", "anthropic")).toBe(true);
  });

  it("is false when the account has NO key now, so the missing-key refusal owns that case", () => {
    // Not a family switch, and answering 409 here would name a provider the
    // account does not have while hiding the one fact the user can act on
    // ("save a key"). `assertApiKeyUsable`/`buildAgentEnv` refuse the run.
    expect(providersIncompatible("anthropic", null)).toBe(false);
    expect(providersIncompatible("gemini", null)).toBe(false);
  });
});

describe("currentProviderFor", () => {
  it("is null for a user with no stored key", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    expect(currentProviderFor(db, user.id)).toBe(null);
  });

  it("reads the provider the stored key was saved under, for both providers", () => {
    const db = freshDb();
    const anthropic = createUser(db, "anthropic@example.com", "h");
    const gemini = createUser(db, "gemini@example.com", "h");
    setApiKey(db, MASTER_KEY, anthropic.id, "sk-ant-a-real-looking-key-value", "anthropic");
    setApiKey(db, MASTER_KEY, gemini.id, "AIza0123456789012345678901234567890123", "gemini");

    expect(currentProviderFor(db, anthropic.id)).toBe("anthropic");
    expect(currentProviderFor(db, gemini.id)).toBe("gemini");
  });

  it("follows a replaced key onto its new provider — the exact event I7 guards against", () => {
    const db = freshDb();
    const user = createUser(db, "swap@example.com", "h");
    setApiKey(db, MASTER_KEY, user.id, "sk-ant-a-real-looking-key-value", "anthropic");
    expect(currentProviderFor(db, user.id)).toBe("anthropic");

    setApiKey(db, MASTER_KEY, user.id, "AIza0123456789012345678901234567890123", "gemini");
    expect(currentProviderFor(db, user.id)).toBe("gemini");
  });

  it("is null for an unknown user id rather than throwing", () => {
    // A resume handler reaches this only for its own session's user, but a
    // throw here would surface as a 500 on a request that should refuse
    // cleanly.
    const db = freshDb();
    expect(currentProviderFor(db, "no-such-user")).toBe(null);
  });
});

describe("describeProviderMismatch", () => {
  it("names BOTH providers, exactly — the wording is the point of the item", () => {
    // Asserted as a whole string, not by substring: a `toContain("gemini")`
    // still passes if the message loses the provider it came FROM, which is the
    // half a user needs to understand what they changed.
    expect(describeProviderMismatch("anthropic", "gemini")).toBe(
      "this job ran with a anthropic key and this account now uses gemini; a resume continues "
      + "the same run, which cannot switch model providers partway — start a fresh job instead",
    );
  });

  it("says 'none' rather than 'null' when the account has no key at all", () => {
    // Not reachable from the resume guard (which does not refuse that case),
    // but the message must never render the literal string "null" at a user.
    expect(describeProviderMismatch("gemini", null)).toContain("now uses none");
    expect(describeProviderMismatch("gemini", null)).not.toContain("null");
  });

  it("prints an unrecognised recorded value verbatim instead of smoothing it into a real provider", () => {
    expect(describeProviderMismatch("openai", "anthropic")).toContain("ran with a openai key");
  });
});
