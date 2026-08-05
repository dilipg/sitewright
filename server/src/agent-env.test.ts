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
import { createUser, setDisabled } from "./users.ts";
import { setApiKey } from "./api-keys.ts";
import {
  buildAgentEnv, DisabledUserError, MissingApiKeyError, resolveApiKey, scrubbedEnv,
  UnknownUserError,
} from "./agent-env.ts";
import { MASTER_KEY_ENV_VAR } from "./master-key.ts";

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

  it("refuses a stored key once the user is disabled", () => {
    // `disable` revokes sessions, closing the HTTP surface — but slice 4
    // resolves keys from a project's owner_id, not a live session, so the
    // key itself must be refused here too.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    setDisabled(db, user.id, true);
    expect(() => resolveApiKey(db, masterKey, user.id)).toThrow(DisabledUserError);
  });

  it("refuses even a pasted key once the user is disabled", () => {
    // The sub-decision this pins: disabled means no work through this
    // system, whoever's key it is — the pasted-key short circuit must not
    // bypass the disabled check.
    const { db, user } = fresh();
    setDisabled(db, user.id, true);
    expect(() => resolveApiKey(db, masterKey, user.id, PASTED)).toThrow(DisabledUserError);
  });

  it("distinguishes an unknown user from a disabled one", () => {
    // Both fail closed, and that is the security property — but the messages
    // must differ. Slice 4 resolves keys from a project's owner_id, so a bad
    // id is a realistic bug, and telling the operator "this account is
    // disabled" when there is no row at all sends them looking in the wrong
    // place. Asserting NOT DisabledUserError is the load-bearing half.
    const { db } = fresh();
    expect(() => resolveApiKey(db, masterKey, "no-such-user-id")).toThrow(UnknownUserError);
    expect(() => resolveApiKey(db, masterKey, "no-such-user-id")).not.toThrow(DisabledUserError);
  });

  it("still resolves normally for an enabled user", () => {
    // The disabled check must not be a false positive for the common case.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    expect(resolveApiKey(db, masterKey, user.id)).toBe(STORED);
    expect(resolveApiKey(db, masterKey, user.id, PASTED)).toBe(PASTED);
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

  it("refuses to build an env for a disabled user, even with a stored key", () => {
    // The child never spawns for a disabled user's work — checked here, not
    // just in resolveApiKey, because this is the actual call site slice 4
    // will use to spawn the orchestrator.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    setDisabled(db, user.id, true);
    expect(() => buildAgentEnv({ db, masterKey, userId: user.id })).toThrow(DisabledUserError);
  });
});

describe("scrubbedEnv", () => {
  it("removes the host's own ANTHROPIC_API_KEY, so an absent user key is absent rather than the operator's", () => {
    const env = scrubbedEnv({ ANTHROPIC_API_KEY: "sk-ant-host", PATH: "/usr/bin" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("removes the master key", () => {
    const env = scrubbedEnv({ [MASTER_KEY_ENV_VAR]: "secret" });
    expect(env[MASTER_KEY_ENV_VAR]).toBeUndefined();
  });

  it("does not mutate the environment it was given", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-host" };
    scrubbedEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-host");
  });
});
