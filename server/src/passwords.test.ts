import { describe, expect, it, vi, beforeEach } from "vitest";

let callCount = 0;

vi.mock("node:crypto", async () => {
  const actualCrypto = await vi.importActual("node:crypto");
  return {
    randomInt: (max: number) => {
      callCount += 1;
      return (actualCrypto as any).randomInt(max);
    },
  };
});

describe("password functions", () => {
  beforeEach(() => {
    callCount = 0;
    vi.resetModules();
  });

  describe("hashPassword / verifyPassword", () => {
    it("accepts the correct password", async () => {
      const { hashPassword, verifyPassword } = await import("./passwords.ts");
      const hash = await hashPassword("correct horse battery staple");
      expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    });

    it("rejects the wrong password", async () => {
      const { hashPassword, verifyPassword } = await import("./passwords.ts");
      const hash = await hashPassword("correct horse battery staple");
      expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
    });

    it("never stores the plaintext in the hash", async () => {
      const { hashPassword } = await import("./passwords.ts");
      // The obvious catastrophe, cheap to assert.
      const hash = await hashPassword("hunter2");
      expect(hash).not.toContain("hunter2");
    });

    it("salts: the same password hashes differently every time", async () => {
      const { hashPassword, verifyPassword } = await import("./passwords.ts");
      // Without a per-hash salt, identical passwords produce identical hashes and
      // one rainbow table breaks every account at once.
      const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
      expect(a).not.toBe(b);
      expect(await verifyPassword(a, "same")).toBe(true);
      expect(await verifyPassword(b, "same")).toBe(true);
    });

    it("uses argon2id, not argon2i or argon2d", async () => {
      const { hashPassword } = await import("./passwords.ts");
      // argon2id is the hybrid the spec requires; the variant is encoded in the
      // hash string, so this pins it rather than trusting a default.
      expect(await hashPassword("x")).toMatch(/^\$argon2id\$/);
    });

    it("returns false for a malformed hash instead of throwing", async () => {
      const { verifyPassword } = await import("./passwords.ts");
      // A corrupted row must fail the login, not crash the request handler.
      expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
      expect(await verifyPassword("", "anything")).toBe(false);
    });
  });

  describe("generatePassword", () => {
    it("is long and unpredictable", async () => {
      const { generatePassword } = await import("./passwords.ts");
      const first = generatePassword();
      expect(first).toHaveLength(20);
      const many = new Set(Array.from({ length: 50 }, () => generatePassword()));
      expect(many.size).toBe(50);
    });

    it("avoids characters that break shell copy-paste", async () => {
      const { generatePassword } = await import("./passwords.ts");
      // The operator copies this out of a terminal; quotes and backslashes cause
      // silent mangling.
      for (let i = 0; i < 50; i += 1) {
        expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it("uses crypto.randomInt for CSPRNG, not Math.random", async () => {
      // This is a security property that could silently regress if someone replaces
      // randomInt with Math.random() — none of the other tests would catch it because
      // they only check output properties, not entropy source.
      const beforeCallCount = callCount;
      const { generatePassword } = await import("./passwords.ts");
      const password = generatePassword();

      expect(password).toHaveLength(20);
      expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(callCount - beforeCallCount).toBe(20);
    });
  });
});
