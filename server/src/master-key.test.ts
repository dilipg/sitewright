/**
 * The master key is the one secret that is NOT in the database — everything
 * encrypted at rest is worthless without it, and a default would make every
 * deployment's ciphertext readable by anyone with the source. So the only
 * acceptable behaviour on a missing or malformed key is refusing to start.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadMasterKey, MASTER_KEY_ENV_VAR } from "./master-key.ts";

const valid = randomBytes(32).toString("base64");

describe("loadMasterKey", () => {
  it("returns 32 raw bytes for a valid base64 key", () => {
    const key = loadMasterKey({ [MASTER_KEY_ENV_VAR]: valid });
    expect(key).toHaveLength(32);
  });

  it("throws when the variable is absent — no default, ever", () => {
    // A default master key is worse than no encryption: it reads as protection
    // while every deployment shares one key that is in the source history.
    expect(() => loadMasterKey({})).toThrow(new RegExp(MASTER_KEY_ENV_VAR));
  });

  it("throws when the variable is present but empty", () => {
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: "" })).toThrow(new RegExp(MASTER_KEY_ENV_VAR));
  });

  it("throws when the key decodes to the wrong length", () => {
    // AES-256 needs exactly 32 bytes. A 16-byte key would silently be a
    // different, weaker cipher choice if we let node pick.
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: randomBytes(16).toString("base64") }))
      .toThrow(/32 bytes/);
  });

  it("throws when the value is not valid base64", () => {
    expect(() => loadMasterKey({ [MASTER_KEY_ENV_VAR]: "!!!not base64!!!" })).toThrow(/base64/);
  });

  it("never puts the key value in the error message", () => {
    // An operator pastes this into a terminal and a shell history; a boot error
    // that echoes it back defeats the point of keeping it out of the repo.
    const wrongLength = randomBytes(16).toString("base64");
    try {
      loadMasterKey({ [MASTER_KEY_ENV_VAR]: wrongLength });
      throw new Error("expected loadMasterKey to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(wrongLength);
    }
  });

  it("reads process.env by default", () => {
    // The production call site passes no argument.
    const previous = process.env[MASTER_KEY_ENV_VAR];
    process.env[MASTER_KEY_ENV_VAR] = valid;
    try {
      expect(loadMasterKey()).toHaveLength(32);
    } finally {
      if (previous === undefined) delete process.env[MASTER_KEY_ENV_VAR];
      else process.env[MASTER_KEY_ENV_VAR] = previous;
    }
  });
});
