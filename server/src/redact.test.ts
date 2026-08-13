// server/src/redact.test.ts
/**
 * A backstop, not the primary defence. The primary defence is never passing a
 * key to a log call — but this codebase logs error objects it did not construct
 * (a spawn failure, a subprocess stderr), and those can carry anything.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.ts";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-XY9z";
/** `AIza` + exactly 35 characters — a real Google "standard" key's verified shape. */
const GEMINI_KEY = "AIzaSyIsNotARealKeyJustTheRightShape123";
/** The format AI Studio issues today. */
const GEMINI_AUTH_KEY = "AQ.AbNotARealAuthKeyJustTheRightShape";

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

/**
 * BYOK task 1: a Gemini key now reaches the same preview child by the same
 * route, so it reaches the same untrusted stdout. Redacting only Anthropic keys
 * would have held the "never logged" guarantee for one provider out of two.
 */
describe("redactSecrets, every provider whose key can reach a child", () => {
  it("masks a Google standard key (AIza…) embedded in a longer message", () => {
    const output = redactSecrets(`spawn failed with env GEMINI_API_KEY=${GEMINI_KEY} and cwd /x`);
    expect(output).not.toContain(GEMINI_KEY);
    expect(output).toMatch(/redacted/i);
    expect(output).toContain("/x");
  });

  it("masks a Google AI Studio auth key (AQ.…), the format issued today", () => {
    const output = redactSecrets(`GEMINI_API_KEY=${GEMINI_AUTH_KEY}`);
    expect(output).not.toContain(GEMINI_AUTH_KEY);
    expect(output).toMatch(/redacted/i);
  });

  it("masks a TRUNCATED Gemini key, since whatever printed it may have cut it short", () => {
    const truncated = GEMINI_KEY.slice(0, 24);
    expect(redactSecrets(`key=${truncated} end`)).not.toContain(truncated);
  });

  it("masks all providers' keys appearing in one message", () => {
    const output = redactSecrets(`${KEY} then ${GEMINI_KEY} then ${GEMINI_AUTH_KEY}`);
    for (const secret of [KEY, GEMINI_KEY, GEMINI_AUTH_KEY]) {
      expect(output).not.toContain(secret);
    }
  });

  it("does NOT redact the word 'FAQ.' from a generated site's own build output", () => {
    // The false positive a bare /AQ\./ would cause. Generated sites have FAQ
    // sections, so this text really does appear in preview-child stdout, and
    // mangling it would corrupt the log an operator is trying to read.
    expect(redactSecrets("building FAQ. done")).toBe("building FAQ. done");
    expect(redactSecrets("see the FAQ.AccordionItem component")).toBe("see the FAQ.AccordionItem component");
  });

  it("leaves ordinary short text containing the prefixes alone", () => {
    expect(redactSecrets("AQ. Next question")).toBe("AQ. Next question");
    expect(redactSecrets("AIza")).toBe("AIza");
  });
});
