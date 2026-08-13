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
  buildAgentEnv, DisabledUserError, injectedCredential, MissingApiKeyError,
  MODEL_PROVIDER_ENV_VAR, PROVIDER_KEY_ENV_VAR, resolveApiKey, scrubbedEnv, UnknownUserError,
} from "./agent-env.ts";
import { MASTER_KEY_ENV_VAR } from "./master-key.ts";

const masterKey = randomBytes(32);
const STORED = "sk-ant-api03-stored-key-value-goes-here-XY9z";
const PASTED = "sk-ant-api03-pasted-key-value-goes-here-AB12";
/** `AIza` + exactly 35 characters — a real Google standard key's verified shape. */
const GEMINI_STORED = "AIzaSyIsNotARealKeyJustTheRightShape123";
const GEMINI_PASTED = "AQ.AbNotARealAuthKeyJustTheRightShape";

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
    expect(resolveApiKey(db, masterKey, user.id)).toEqual({ apiKey: STORED, provider: "anthropic" });
  });

  it("returns the stored PROVIDER, not a guess, for a Gemini key", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, GEMINI_STORED, "gemini");
    expect(resolveApiKey(db, masterKey, user.id)).toEqual({ apiKey: GEMINI_STORED, provider: "gemini" });
  });

  it("prefers a pasted key over the stored one", () => {
    // Storing is a convenience (spec, BYOK requirement 4). A user who pastes a
    // different key for one run must get that key, not the saved default.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    expect(resolveApiKey(db, masterKey, user.id, PASTED)).toEqual({ apiKey: PASTED, provider: "anthropic" });
  });

  it("infers a PASTED key's provider from its own shape, since it has no stored one", () => {
    // A pasted key was never stored, so there is no provider column to read.
    // Its shape is the only source of truth — sound precisely because
    // setApiKey refuses a key whose shape disagrees with its provider, so
    // shape and provider cannot diverge for a key this system accepts.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED); // stored is ANTHROPIC
    expect(resolveApiKey(db, masterKey, user.id, GEMINI_PASTED))
      .toEqual({ apiKey: GEMINI_PASTED, provider: "gemini" });
  });

  it("falls back to anthropic for a pasted key whose shape names no provider", () => {
    // Preserves this path's pre-existing behaviour exactly: it used to hand
    // every pasted value to Anthropic.
    const { db, user } = fresh();
    expect(resolveApiKey(db, masterKey, user.id, "unplaceable-pasted-value"))
      .toEqual({ apiKey: "unplaceable-pasted-value", provider: "anthropic" });
  });

  it("works with a pasted key and nothing stored — paste-per-request never requires saving", () => {
    const { db, user } = fresh();
    expect(resolveApiKey(db, masterKey, user.id, PASTED)).toEqual({ apiKey: PASTED, provider: "anthropic" });
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
    expect(resolveApiKey(db, masterKey, user.id)).toEqual({ apiKey: STORED, provider: "anthropic" });
    expect(resolveApiKey(db, masterKey, user.id, PASTED)).toEqual({ apiKey: PASTED, provider: "anthropic" });
  });
});

describe("buildAgentEnv", () => {
  it("sets ANTHROPIC_API_KEY for the child", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    const env = buildAgentEnv({ db, masterKey, userId: user.id, baseEnv: {} });
    expect(env.ANTHROPIC_API_KEY).toBe(STORED);
  });

  it("sets GEMINI_API_KEY and ORCH_MODEL_PROVIDER=gemini for a Gemini key, and no Anthropic key at all", () => {
    // The orchestrator's existing opt-in escape hatch
    // (orchestrator/src/orchestrator/config.py's model_provider(),
    // model_call.py's GEMINI_API_KEY read). BOTH variables are required: the
    // key alone leaves the run dispatching to Anthropic, and the selector
    // alone sends it to a provider with no key.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, GEMINI_STORED, "gemini");
    const env = buildAgentEnv({ db, masterKey, userId: user.id, baseEnv: {} });
    expect(env.GEMINI_API_KEY).toBe(GEMINI_STORED);
    expect(env.ORCH_MODEL_PROVIDER).toBe("gemini");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("sets ORCH_MODEL_PROVIDER=anthropic explicitly, so orchestrator/.env cannot vote", () => {
    // Not cosmetic. python-dotenv loads orchestrator/.env with
    // override=False, so an ABSENT variable falls through to that file: an
    // operator with ORCH_MODEL_PROVIDER=gemini there would silently redirect
    // every Anthropic-key user's run onto the Gemini path and then onto the
    // OPERATOR's own GEMINI_API_KEY from the same file. Setting it explicitly
    // for anthropic too is what closes that.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    const env = buildAgentEnv({ db, masterKey, userId: user.id, baseEnv: {} });
    expect(env.ORCH_MODEL_PROVIDER).toBe("anthropic");
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("overrides an inherited ORCH_MODEL_PROVIDER rather than letting the host decide the provider", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, STORED);
    const env = buildAgentEnv({
      db, masterKey, userId: user.id,
      baseEnv: { ORCH_MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "AIzaTheHostsOwnGeminiKeyNotTheUsers1" },
    });
    expect(env.ORCH_MODEL_PROVIDER).toBe("anthropic");
    expect(env.ANTHROPIC_API_KEY).toBe(STORED);
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("names the child's variables from a fixed table, never one built from the stored value", () => {
    // The env-var NAME is the same hazard class as a path or a URL built from
    // a client-influenced string — four such defects have shipped in this
    // repo. A closed table is what makes the set of producible names finite.
    expect(PROVIDER_KEY_ENV_VAR).toEqual({ anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" });
    expect(MODEL_PROVIDER_ENV_VAR).toBe("ORCH_MODEL_PROVIDER");
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

  it("removes the host's own GEMINI_API_KEY, for the identical reason", () => {
    // orchestrator/.env holds a real GEMINI_API_KEY. Left inherited, a
    // keyless or Anthropic-key child could reach the operator's Gemini
    // account — the same silent transfer the ANTHROPIC_API_KEY deletion above
    // exists to prevent, and worse here, because Gemini spend is recorded
    // with cost_usd = NULL and so does not even show up against the cap.
    const env = scrubbedEnv({ GEMINI_API_KEY: "AIzaTheHostsOwnGeminiKeyNotTheUsers1", PATH: "/usr/bin" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("removes EVERY provider's key variable, so adding a provider cannot silently skip one", () => {
    // Table-driven over PROVIDER_KEY_ENV_VAR itself: a third provider added to
    // that table without being scrubbed fails here rather than in production.
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const name of Object.values(PROVIDER_KEY_ENV_VAR)) base[name] = "host-value";
    const env = scrubbedEnv(base);
    for (const name of Object.values(PROVIDER_KEY_ENV_VAR)) expect(env[name]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("removes an inherited ORCH_MODEL_PROVIDER, which selects a credential even though it is not one", () => {
    const env = scrubbedEnv({ [MODEL_PROVIDER_ENV_VAR]: "gemini" });
    expect(env[MODEL_PROVIDER_ENV_VAR]).toBeUndefined();
  });

  it("removes the master key", () => {
    const env = scrubbedEnv({ [MASTER_KEY_ENV_VAR]: "secret" });
    expect(env[MASTER_KEY_ENV_VAR]).toBeUndefined();
  });

  it("does not mutate the environment it was given", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-host", GEMINI_API_KEY: "AIza-host" };
    scrubbedEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-host");
    expect(base.GEMINI_API_KEY).toBe("AIza-host");
  });
});

describe("injectedCredential", () => {
  it("reports the provider and fingerprint an env actually carries, never the key", () => {
    const env = buildAgentEnvFor("gemini");
    expect(injectedCredential(env)).toEqual({ provider: "gemini", fingerprint: "e123" });
    expect(JSON.stringify(injectedCredential(env))).not.toContain(GEMINI_STORED);
  });

  it("reports anthropic for an Anthropic env", () => {
    expect(injectedCredential(buildAgentEnvFor("anthropic")))
      .toEqual({ provider: "anthropic", fingerprint: "XY9z" });
  });

  it("reports null for a keyless env, and for an env whose selected provider has no key", () => {
    expect(injectedCredential({ PATH: "/usr/bin" })).toBeNull();
    // The selector says gemini but only an Anthropic key is present: nothing
    // usable is injected, so this must not claim the Anthropic key is a
    // Gemini one. It answers what the child WILL do, not what it could.
    expect(injectedCredential({ [MODEL_PROVIDER_ENV_VAR]: "gemini", ANTHROPIC_API_KEY: STORED })).toBeNull();
  });

  it("treats an unrecognised selector as the default provider, matching the orchestrator's own dispatch", () => {
    // config.py's model_provider() returns the raw string and only "gemini"
    // takes the Gemini branch, so anything else IS anthropic there too.
    expect(injectedCredential({ [MODEL_PROVIDER_ENV_VAR]: "openai", ANTHROPIC_API_KEY: STORED }))
      .toEqual({ provider: "anthropic", fingerprint: "XY9z" });
  });

  /** A real buildAgentEnv output for `provider`, so these tests cannot drift from it. */
  function buildAgentEnvFor(provider: "anthropic" | "gemini"): NodeJS.ProcessEnv {
    const { db, user } = fresh();
    const key = provider === "gemini" ? GEMINI_STORED : STORED;
    setApiKey(db, masterKey, user.id, key, provider);
    return buildAgentEnv({ db, masterKey, userId: user.id, baseEnv: {} });
  }
});
