import { describe, expect, it } from "vitest";
import { generatePassword, hashPassword, verifyPassword } from "./passwords.ts";

describe("hashPassword / verifyPassword", () => {
  it("accepts the correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("never stores the plaintext in the hash", async () => {
    // The obvious catastrophe, cheap to assert.
    const hash = await hashPassword("hunter2");
    expect(hash).not.toContain("hunter2");
  });

  it("salts: the same password hashes differently every time", async () => {
    // Without a per-hash salt, identical passwords produce identical hashes and
    // one rainbow table breaks every account at once.
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same")).toBe(true);
    expect(await verifyPassword(b, "same")).toBe(true);
  });

  it("uses argon2id, not argon2i or argon2d", async () => {
    // argon2id is the hybrid the spec requires; the variant is encoded in the
    // hash string, so this pins it rather than trusting a default.
    expect(await hashPassword("x")).toMatch(/^\$argon2id\$/);
  });

  it("returns false for a malformed hash instead of throwing", async () => {
    // A corrupted row must fail the login, not crash the request handler.
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
    expect(await verifyPassword("", "anything")).toBe(false);
  });
});

describe("generatePassword", () => {
  it("is long and unpredictable", () => {
    const first = generatePassword();
    expect(first).toHaveLength(20);
    const many = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(many.size).toBe(50);
  });

  it("avoids characters that break shell copy-paste", () => {
    // The operator copies this out of a terminal; quotes and backslashes cause
    // silent mangling.
    for (let i = 0; i < 50; i += 1) {
      expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
