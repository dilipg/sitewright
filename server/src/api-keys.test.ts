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
  API_KEY_PROVIDERS, API_KEY_SHAPES, assertProviderAgreesWithKey, DEFAULT_API_KEY_PROVIDER,
  deleteApiKey, fingerprintOf, getApiKeyFingerprint, getApiKeyPlaintext, isApiKeyProvider,
  providerOfKeyShape, ProviderMismatchError, setApiKey, UndecryptableApiKeyError,
  UnknownStoredProviderError,
} from "./api-keys.ts";

const masterKey = randomBytes(32);
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-XY9z";
/**
 * A real Google "standard" key's exact shape: `AIza` + 35 URL-safe characters,
 * 39 total. Not a real key — the body is filler — but the LENGTH is the point,
 * verified against an actually-issued key (see this task's report). Its last
 * four characters are "e123", which is what the fingerprint must come out as.
 */
const GEMINI_KEY = "AIzaSyIsNotARealKeyJustTheRightShape123";
/** A new AI Studio "auth" key's prefix. Its length is not pinned; see API_KEY_SHAPES. */
const GEMINI_AUTH_KEY = "AQ.AbNotARealKeyJustTheRightShapeAB12";

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
    // The PAIR, not the key: a caller's next act is choosing an environment
    // variable, so the provider must come back with it.
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toEqual({ apiKey: KEY, provider: "anthropic" });
  });

  it("returns the fingerprint from setApiKey", () => {
    const { db, user } = fresh();
    expect(setApiKey(db, masterKey, user.id, KEY)).toBe("XY9z");
  });

  it("stores no plaintext anywhere in the row", () => {
    // The whole point of the slice. `node:sqlite` returns a plain Uint8Array
    // for a BLOB column, and JSON.stringify on a typed array enumerates
    // indices ({"0":115,"1":107,...}) rather than rendering it as text — so a
    // JSON.stringify(row) check can never contain the key regardless of what
    // bytes are actually stored. Decode the BLOB columns to text explicitly:
    // latin1 maps every byte to one character, so no byte sequence is lost or
    // mangled the way an invalid utf8 sequence would be.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    const row = db.prepare("SELECT * FROM api_key WHERE user_id = ?").get(user.id) as {
      ciphertext: Uint8Array;
      nonce: Uint8Array;
      fingerprint: string;
      created_at: number;
    };
    const ciphertextText = Buffer.from(row.ciphertext).toString("latin1");
    const nonceText = Buffer.from(row.nonce).toString("latin1");
    expect(ciphertextText).not.toContain(KEY);
    expect(ciphertextText).not.toContain("sk-ant");
    expect(nonceText).not.toContain(KEY);
    expect(nonceText).not.toContain("sk-ant");
    // The fingerprint legitimately contains the last 4 characters of the key
    // ("XY9z"), so this checks the full key and the "sk-ant" prefix only —
    // never the fingerprint itself — across the whole row.
    const rowText = JSON.stringify(row);
    expect(rowText).not.toContain(KEY);
    expect(rowText).not.toContain("sk-ant");
  });

  it("replaces an existing key rather than failing or adding a second", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    setApiKey(db, masterKey, user.id, "sk-ant-api03-second-key-value-AAAA");
    expect(getApiKeyPlaintext(db, masterKey, user.id))
      .toEqual({ apiKey: "sk-ant-api03-second-key-value-AAAA", provider: "anthropic" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").get()).toEqual({ n: 1 });
  });

  it("replaces the PROVIDER too, so switching providers does not leave the old label behind", () => {
    // The upsert's own `provider = excluded.provider` clause. Without it the
    // row keeps saying "anthropic" while holding a Gemini key — the exact
    // mismatch that fails 401 after work is queued, now stored rather than
    // submitted.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY, "anthropic");
    setApiKey(db, masterKey, user.id, GEMINI_KEY, "gemini");
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toEqual({ apiKey: GEMINI_KEY, provider: "gemini" });
    expect(getApiKeyFingerprint(db, user.id)).toEqual({ fingerprint: "e123", provider: "gemini" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").get()).toEqual({ n: 1 });
  });

  it("returns null for a user with no key", () => {
    const { db, user } = fresh();
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toBeNull();
    expect(getApiKeyFingerprint(db, user.id)).toBeNull();
  });

  it("throws a typed UndecryptableApiKeyError rather than returning nonsense when the master key has changed", () => {
    // Operationally real: someone rotates WEBGEN_MASTER_KEY and restarts. A
    // bare `.toThrow()` with no matcher would also pass for node's untyped
    // GCM error ("Unsupported state or unable to authenticate data"), which
    // is exactly the shape that let this ship unnoticed: router.ts's
    // catch-all turns anything untyped into an opaque 500 with no log line,
    // and a caller further up has no typed error to map to a legible 4xx.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    expect(() => getApiKeyPlaintext(db, randomBytes(32), user.id)).toThrow(UndecryptableApiKeyError);
  });

  it("does not put a key in the message when the master key has changed", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    try {
      getApiKeyPlaintext(db, randomBytes(32), user.id);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).not.toContain("sk-ant");
    }
  });
});

describe("getApiKeyFingerprint", () => {
  it("needs no master key, so a fingerprint read cannot decrypt", () => {
    // Structural: the function's signature has no master-key parameter, so a
    // caller that only wants to display "…XY9z" is incapable of decrypting.
    // Adding `provider` to the result must not change that — hence a
    // three-argument call would not even compile, and the provider is read
    // from its own column rather than derived from the key.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    expect(getApiKeyFingerprint(db, user.id)).toEqual({ fingerprint: "XY9z", provider: "anthropic" });
    expect(getApiKeyFingerprint.length).toBe(2);
  });

  it("reports BOTH the fingerprint and the provider, never one without the other", () => {
    // The perturbation target. A fingerprint with no provider is what a UI
    // renders as the wrong provider's key; a provider with no fingerprint
    // leaves the user unable to tell which key is stored. `toEqual` is exact,
    // so dropping either field fails here.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, GEMINI_KEY, "gemini");
    expect(getApiKeyFingerprint(db, user.id)).toEqual({ fingerprint: "e123", provider: "gemini" });
  });

  it("reports 'anthropic' for a row written before the provider column existed", () => {
    // The migration's whole promise. The row is inserted WITHOUT a provider,
    // exactly as slice 3's own INSERT did, and the column's DEFAULT supplies
    // the value — nothing rewrites the row.
    const { db, user } = fresh();
    db.prepare(
      "INSERT INTO api_key (user_id, ciphertext, nonce, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(user.id, Buffer.from("ct"), Buffer.from("nn"), "OLD1", Date.now());
    expect(getApiKeyFingerprint(db, user.id)).toEqual({ fingerprint: "OLD1", provider: "anthropic" });
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

describe("provider shapes", () => {
  it("places a Google standard key (AIza + 35) as gemini", () => {
    expect(GEMINI_KEY).toHaveLength(39); // AIza + exactly 35, the verified real length
    expect(providerOfKeyShape(GEMINI_KEY)).toBe("gemini");
  });

  it("places a Google AI Studio AUTH key (AQ.…) as gemini", () => {
    // Load-bearing, not completeness: AI Studio now issues ONLY this format,
    // so a regex accepting AIza alone rejects every key a new tester can get.
    expect(providerOfKeyShape(GEMINI_AUTH_KEY)).toBe("gemini");
  });

  it("does not pin the AUTH key's length, because no source states one", () => {
    // Deliberately permissive: rejecting a valid key is the more expensive
    // mistake. A short-but-plausible and a long AQ. key are both accepted.
    expect(providerOfKeyShape(`AQ.Ab${"x".repeat(20)}`)).toBe("gemini");
    expect(providerOfKeyShape(`AQ.Ab${"x".repeat(200)}`)).toBe("gemini");
  });

  it("places an Anthropic key as anthropic", () => {
    expect(providerOfKeyShape(KEY)).toBe("anthropic");
  });

  it("places nothing it cannot recognise, rather than guessing", () => {
    // Null is not "invalid" — it is "unplaceable". The HTTP boundary is what
    // refuses an unrecognised value; storage must not guess a provider.
    expect(providerOfKeyShape("hunter2")).toBeNull();
    expect(providerOfKeyShape("")).toBeNull();
    expect(providerOfKeyShape("AIzaTooShort")).toBeNull();
    expect(providerOfKeyShape("AQ.tooshort")).toBeNull();
  });

  it("keeps the anthropic pattern exactly as slice 3 shipped it", () => {
    // "Do not loosen it." Pinned by the property that matters: 20+ characters
    // after the prefix, so a truncated copy is not mistaken for a key.
    expect(API_KEY_SHAPES.anthropic.source).toBe("^sk-ant-[A-Za-z0-9_-]{20,}$");
    expect(API_KEY_SHAPES.anthropic.test("sk-ant-tooshort")).toBe(false);
  });

  it("cannot place one key under two providers", () => {
    // What makes providerOfKeyShape well defined, and what makes the
    // boundary's "cannot throw ProviderMismatchError" comment true.
    for (const key of [KEY, GEMINI_KEY, GEMINI_AUTH_KEY]) {
      const matches = API_KEY_PROVIDERS.filter((p) => API_KEY_SHAPES[p].test(key));
      expect(matches).toHaveLength(1);
    }
  });

  it("recognises exactly the two supported providers", () => {
    expect(isApiKeyProvider("anthropic")).toBe(true);
    expect(isApiKeyProvider("gemini")).toBe(true);
    expect(isApiKeyProvider("openai")).toBe(false);
    expect(isApiKeyProvider(undefined)).toBe(false);
    expect(DEFAULT_API_KEY_PROVIDER).toBe("anthropic");
  });
});

describe("the declared provider and the key's shape must agree", () => {
  it("stores a Gemini key and reports its provider back", () => {
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, GEMINI_KEY, "gemini");
    expect(getApiKeyFingerprint(db, user.id)).toEqual({ fingerprint: "e123", provider: "gemini" });
  });

  it("rejects an Anthropic-shaped key submitted as gemini, and vice versa", () => {
    // The shape and the declared provider must agree, or the agent gets a key
    // the provider will reject 401 AFTER the job is queued and billed.
    const { db, user } = fresh();
    expect(() => setApiKey(db, masterKey, user.id, "sk-ant-aaaaaaaaaaaaaaaaaaaaaa", "gemini"))
      .toThrow(ProviderMismatchError);
    expect(() => setApiKey(db, masterKey, user.id, GEMINI_KEY, "anthropic"))
      .toThrow(ProviderMismatchError);
    expect(() => setApiKey(db, masterKey, user.id, GEMINI_AUTH_KEY, "anthropic"))
      .toThrow(ProviderMismatchError);
  });

  it("stores NOTHING when the provider and the shape disagree", () => {
    // Refused BEFORE encrypting, so a mismatched submission cannot overwrite
    // the good key already stored. Otherwise a user's working credential is
    // destroyed by a mis-click on the provider selector.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY, "anthropic");
    expect(() => setApiKey(db, masterKey, user.id, GEMINI_KEY, "anthropic")).toThrow(ProviderMismatchError);
    expect(getApiKeyPlaintext(db, masterKey, user.id)).toEqual({ apiKey: KEY, provider: "anthropic" });
  });

  it("names both providers in the mismatch error and neither in the key", () => {
    // Exact wording, not a substring: this message reaches an operator log.
    try {
      assertProviderAgreesWithKey(GEMINI_KEY, "anthropic");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toBe(
        "this key's shape belongs to gemini, not anthropic: "
        + "storing it under the wrong provider fails 401 only after work is queued",
      );
      expect((error as Error).message).not.toContain(GEMINI_KEY);
      expect((error as Error).message).not.toContain("AIza");
    }
  });

  it("accepts a key whose shape names no provider at all, under either provider", () => {
    // The deliberate asymmetry: this asserts AGREEMENT, not well-formedness.
    // Storage's job is to stop a REAL key of the wrong provider (silent, and
    // expensive); refusing an unplaceable string is the boundary's job, where
    // it becomes a legible 400. Documented here so a reader does not mistake
    // this for a hole.
    const { db, user } = fresh();
    expect(() => setApiKey(db, masterKey, user.id, "some-unplaceable-value", "gemini")).not.toThrow();
    expect(() => setApiKey(db, masterKey, user.id, "some-unplaceable-value", "anthropic")).not.toThrow();
  });

  it("defaults to anthropic, and the default still cannot mislabel a real key", () => {
    // Why a defaulted parameter is safe here: the agreement check runs
    // regardless, so the default can leave a key unlabelled but never
    // mislabel a Gemini key as Anthropic.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    expect(getApiKeyFingerprint(db, user.id)).toEqual({ fingerprint: "XY9z", provider: "anthropic" });
    expect(() => setApiKey(db, masterKey, user.id, GEMINI_KEY)).toThrow(ProviderMismatchError);
  });
});

describe("schema", () => {
  it("refuses an unsupported provider at the database, not just in TypeScript", () => {
    // The CHECK constraint. `setApiKey`'s parameter type stops this at compile
    // time for any caller inside this package; the constraint stops it for a
    // raw SQL writer, a migration, or a hand-edited database too.
    const { db, user } = fresh();
    expect(() =>
      db.prepare(
        "INSERT INTO api_key (user_id, ciphertext, nonce, fingerprint, provider, created_at) VALUES (?,?,?,?,?,?)",
      ).run(user.id, Buffer.from("ct"), Buffer.from("nn"), "AAAA", "openai", Date.now()),
    ).toThrow(/CHECK constraint failed/);
  });

  it("fails closed on an unrecognised stored provider rather than guessing anthropic", () => {
    // Unreachable through any supported path (the CHECK above is why), so the
    // constraint has to be suspended to reach it at all. Worth pinning
    // anyway: the alternative to throwing is defaulting, and defaulting would
    // send a Gemini key to Anthropic — the mismatch this task exists to stop.
    const { db, user } = fresh();
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(
      "INSERT INTO api_key (user_id, ciphertext, nonce, fingerprint, provider, created_at) VALUES (?,?,?,?,?,?)",
    ).run(user.id, Buffer.from("ct"), Buffer.from("nn"), "AAAA", "openai", Date.now());
    db.exec("PRAGMA ignore_check_constraints = OFF");
    expect(() => getApiKeyFingerprint(db, user.id)).toThrow(UnknownStoredProviderError);
    expect(() => getApiKeyPlaintext(db, masterKey, user.id)).toThrow(UnknownStoredProviderError);
  });

  it("deletes the key when the user is deleted", () => {
    // ON DELETE CASCADE, matching session. A key outliving its owner is a
    // credential nobody is accountable for.
    const { db, user } = fresh();
    setApiKey(db, masterKey, user.id, KEY);
    db.prepare("DELETE FROM user WHERE id = ?").run(user.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").get()).toEqual({ n: 0 });
  });
});
