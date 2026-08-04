/**
 * GCM, not CBC: it authenticates as well as encrypts. Without authentication,
 * someone with write access to the database could flip bits in the ciphertext
 * and the decrypted "key" would be garbage we then send to Anthropic — or, with
 * effort, a chosen value.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Sealed } from "./secrets.ts";

let nonceCalls = 0;
let lastNonceCallArg: number | undefined;

vi.mock("node:crypto", async () => {
  const actualCrypto = await vi.importActual("node:crypto");
  return {
    createCipheriv: (actualCrypto as any).createCipheriv,
    createDecipheriv: (actualCrypto as any).createDecipheriv,
    randomBytes: (size: number) => {
      nonceCalls += 1;
      lastNonceCallArg = size;
      return (actualCrypto as any).randomBytes(size);
    },
  };
});

const key = randomBytes(32);
const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

describe("seal / open", () => {
  beforeEach(() => {
    nonceCalls = 0;
    lastNonceCallArg = undefined;
    vi.resetModules();
  });

  it("round-trips a value", async () => {
    const { seal, open } = await import("./secrets.ts");
    expect(open(key, seal(key, secret))).toBe(secret);
  });

  it("produces a different ciphertext every time for the same plaintext", async () => {
    // A deterministic ciphertext tells an observer that two users pasted the
    // same key, and GCM is catastrophically broken if a nonce is ever reused.
    const { seal } = await import("./secrets.ts");
    const a = seal(key, secret);
    const b = seal(key, secret);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("uses a 12-byte nonce", async () => {
    // 96 bits is GCM's standard nonce size; anything else forces node into a
    // different derivation path.
    const { seal } = await import("./secrets.ts");
    expect(seal(key, secret).nonce).toHaveLength(12);
  });

  it("refuses a tampered ciphertext rather than returning garbage", async () => {
    const { seal, open } = await import("./secrets.ts");
    const sealed = seal(key, secret) as Sealed;
    // @ts-expect-error - Manipulating buffer for tamper test
    sealed.ciphertext[0] ^= 0xff;
    expect(() => open(key, sealed)).toThrow();
  });

  it("refuses a tampered nonce", async () => {
    const { seal, open } = await import("./secrets.ts");
    const sealed = seal(key, secret) as Sealed;
    // @ts-expect-error - Manipulating buffer for tamper test
    sealed.nonce[0] ^= 0xff;
    expect(() => open(key, sealed)).toThrow();
  });

  it("refuses a truncated ciphertext instead of reading past the tag", async () => {
    const { seal, open } = await import("./secrets.ts");
    const sealed = seal(key, secret);
    sealed.ciphertext = sealed.ciphertext.subarray(0, 8);
    expect(() => open(key, sealed)).toThrow();
  });

  it("refuses the wrong master key", async () => {
    // The case that matters operationally: someone rotates WEBGEN_MASTER_KEY
    // and restarts. This must fail loudly, not decrypt to nonsense.
    const { seal, open } = await import("./secrets.ts");
    expect(() => open(randomBytes(32), seal(key, secret))).toThrow();
  });

  it("draws the nonce from node:crypto, not Math.random", async () => {
    // A predictable nonce breaks GCM outright. No behavioural test can see the
    // difference, so the source is asserted directly — the same idiom as
    // passwords.test.ts and sessions-entropy.test.ts.
    const { seal } = await import("./secrets.ts");
    const beforeCallCount = nonceCalls;
    seal(key, secret);
    expect(nonceCalls - beforeCallCount).toBe(1);
    expect(lastNonceCallArg).toBe(12);
  });

  it("rejects a master key that is not 32 bytes", async () => {
    const { seal } = await import("./secrets.ts");
    expect(() => seal(randomBytes(16), secret)).toThrow(/32/);
  });
});
