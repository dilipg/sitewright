// server/src/redact.test.ts
/**
 * A backstop, not the primary defence. The primary defence is never passing a
 * key to a log call — but this codebase logs error objects it did not construct
 * (a spawn failure, a subprocess stderr), and those can carry anything.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.ts";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-XY9z";

describe("redactSecrets", () => {
  it("masks a key embedded in a longer message", () => {
    const output = redactSecrets(`spawn failed with env ANTHROPIC_API_KEY=${KEY} and cwd /x`);
    expect(output).not.toContain(KEY);
    expect(output).toContain("/x"); // the rest of the message survives
  });

  it("masks every occurrence, not just the first", () => {
    expect(redactSecrets(`${KEY} then ${KEY}`)).not.toContain(KEY);
  });

  it("masks two different keys in one message", () => {
    const other = "sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzz-AAAA";
    const output = redactSecrets(`${KEY} ${other}`);
    expect(output).not.toContain(KEY);
    expect(output).not.toContain(other);
  });

  it("leaves a bare fingerprint alone, so the UI's own display still works", () => {
    expect(redactSecrets("key ending XY9z")).toBe("key ending XY9z");
  });

  it("leaves text with no key untouched", () => {
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });

  it("says something recognisable in place of the key", () => {
    // An operator reading a log needs to know a value was removed, not wonder
    // whether the message was truncated.
    expect(redactSecrets(KEY)).toMatch(/redacted/i);
  });
});
