// server/src/agent-env.test.ts
/**
 * The moment the plaintext key exists in memory and crosses into a child
 * process. Everything here is about blast radius: the child gets exactly one
 * secret, this process's own environment is not touched, and the master key
 * never travels with it.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { setApiKey } from "./api-keys.ts";
import { buildAgentEnv, MissingApiKeyError, resolveApiKey } from "./agent-env.ts";

const masterKey = randomBytes(32);
const STORED = "sk-ant-api03-stored-key-value-goes-here-XY9z";
const PASTED = "sk-ant-api03-pasted-key-value-goes-here-AB12";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "server-agentenv-"));
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

describe("resolveApiKey", () => {
  it("uses the stored key when nothing is pasted", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    expect(resolveApiKey(db, masterKey, user.id)).toBe(STORED);
  });

  it("prefers a pasted key over the stored one", () => {
    // Storing is a convenience (spec, BYOK requirement 4). A user who pastes a
    // different key for one run must get that key, not the saved default.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    expect(resolveApiKey(db, masterKey, user.id, PASTED)).toBe(PASTED);
  });

  it("works with a pasted key and nothing stored — paste-per-request never requires saving", () => {
    const { db, user } = fresh();
    expect(resolveApiKey(db, masterKey, user.id, PASTED)).toBe(PASTED);
  });

  it("throws MissingApiKeyError when there is neither", () => {
    const { db, user } = fresh();
    expect(() => resolveApiKey(db, masterKey, user.id)).toThrow(MissingApiKeyError);
  });

  it("does not put a key in the error when one is malformed-but-present", () => {
    const { db, user } = fresh();
    try {
      resolveApiKey(db, masterKey, user.id, "");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-ant");
    }
  });
});

describe("buildAgentEnv", () => {
  it("sets ANTHROPIC_API_KEY for the child", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    const env = buildAgentEnv({ db, masterKey, userId: user.id, baseEnv: {} });
    expect(env.ANTHROPIC_API_KEY).toBe(STORED);
  });

  it("does not mutate the parent process environment", () => {
    // A global mutation would leak this user's key into every later subprocess
    // and into any diagnostic dump of process.env.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    buildAgentEnv({ db, masterKey, userId: user.id });
    expect(process.env.ANTHROPIC_API_KEY).not.toBe(STORED);
  });

  it("never passes the master key to the child", () => {
    // The child runs model-generated code paths. Handing it the key that
    // decrypts every user's credential would make one escape total.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    const env = buildAgentEnv({
      db, masterKey, userId: user.id,
      baseEnv: { WEBGEN_MASTER_KEY: masterKey.toString("base64"), PATH: "/usr/bin" },
    });
    expect(env.WEBGEN_MASTER_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(masterKey.toString("base64"));
  });

  it("keeps the rest of the base environment, so the child can still find its tools", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    const env = buildAgentEnv({
      db, masterKey, userId: user.id,
      baseEnv: { PATH: "/usr/bin", HOME: "/home/x" },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
  });

  it("overrides an inherited ANTHROPIC_API_KEY rather than letting it win", () => {
    // The host may have its own key in the environment (the local dev flow reads
    // orchestrator/.env). Under the hosted server the request's user pays, so
    // theirs must take precedence — otherwise one user's work bills another.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    const env = buildAgentEnv({
      db, masterKey, userId: user.id,
      baseEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-the-hosts-own-key-ZZZZ" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe(STORED);
  });

  it("throws MissingApiKeyError instead of spawning with no key", () => {
    // Better a clear 400 than a subprocess that runs for a minute and then
    // fails inside the orchestrator with an auth error.
    const { db, user } = fresh();
    expect(() => buildAgentEnv({ db, masterKey, userId: user.id })).toThrow(MissingApiKeyError);
  });
});
