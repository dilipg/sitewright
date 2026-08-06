import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isValidUsageId, usageLogPathFor, USAGE_ID_HEADER } from "./usage-log-path.ts";

describe("isValidUsageId", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(isValidUsageId("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("rejects anything that could name a path", () => {
    // The whole point: an id can never be a path, so a subprocess's log
    // location is not client-controlled.
    for (const bad of [
      "../../etc/passwd", "0123456789abcdef0123456789abcde", "0123456789ABCDEF0123456789abcdef",
      "0123456789abcdef0123456789abcdef0", "", "abc/def", "abc\\def", 42, null, undefined,
    ]) {
      expect(isValidUsageId(bad)).toBe(false);
    }
  });
});

describe("usageLogPathFor", () => {
  it("puts the log in a temp subdirectory named by the id", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(usageLogPathFor(id)).toBe(join(tmpdir(), "webgen-usage", `${id}.jsonl`));
  });

  it("names the header both sides agree on", () => {
    expect(USAGE_ID_HEADER).toBe("x-webgen-usage-id");
  });
});
