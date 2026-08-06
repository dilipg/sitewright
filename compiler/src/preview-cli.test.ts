/**
 * Tests for the preview CLI's argument parsing only (`parsePreviewArgs`).
 * This file lives in src/, not scripts/, because vitest.config.ts's
 * `include` is `["src/**\/*.test.ts"]` — scripts/ is not scanned. Importing
 * `parsePreviewArgs` from `../scripts/preview.ts` must not start a server or
 * exit the process; see that file's entry-point guard.
 */
import { describe, expect, it } from "vitest";
import { parsePreviewArgs } from "../scripts/preview";

describe("parsePreviewArgs", () => {
  it(
    "regression: a bare directory with no flags is not eaten as a flag value",
    () => {
      // The old expression was
      // `args.filter((arg, i) => !arg.startsWith("--") && i !== portFlagIndex + 1)[0]`.
      // With no `--port` present, `portFlagIndex` is `-1` (from `indexOf`),
      // so `portFlagIndex + 1` is `0` — the same index as the directory
      // itself — and the filter silently dropped it, leaving `dir`
      // `undefined` for a perfectly valid invocation.
      const result = parsePreviewArgs(["dir"]);
      expect(result).toEqual({ dir: "dir", port: 5273, base: undefined, baseMissingValue: false });
    },
  );

  it("dir with an explicit --port", () => {
    const result = parsePreviewArgs(["dir", "--port", "1234"]);
    expect(result).toEqual({ dir: "dir", port: 1234, base: undefined, baseMissingValue: false });
  });

  it("dir with an explicit --base", () => {
    const result = parsePreviewArgs(["dir", "--base", "/x/"]);
    expect(result).toEqual({ dir: "dir", port: 5273, base: "/x/", baseMissingValue: false });
  });

  it("dir with both --port and --base, flags after the directory", () => {
    const result = parsePreviewArgs(["dir", "--port", "1234", "--base", "/x/"]);
    expect(result).toEqual({ dir: "dir", port: 1234, base: "/x/", baseMissingValue: false });
  });

  it("dir with --port before the directory", () => {
    const result = parsePreviewArgs(["--port", "1234", "dir"]);
    expect(result.dir).toBe("dir");
    expect(result.port).toBe(1234);
  });

  it("dir with --base before the directory", () => {
    const result = parsePreviewArgs(["--base", "/x/", "dir"]);
    expect(result.dir).toBe("dir");
    expect(result.base).toBe("/x/");
  });

  it("dir with both flags before the directory", () => {
    const result = parsePreviewArgs(["--port", "1234", "--base", "/x/", "dir"]);
    expect(result.dir).toBe("dir");
    expect(result.port).toBe(1234);
    expect(result.base).toBe("/x/");
  });

  describe("the --base / --port dangling-value asymmetry (deliberately closed)", () => {
    it("flags a --base with no following token as invalid, not as 'no base'", () => {
      const result = parsePreviewArgs(["dir", "--base"]);
      expect(result.baseMissingValue).toBe(true);
      expect(result.base).toBeUndefined();
    });

    it("flags a --base immediately followed by another flag as invalid", () => {
      const result = parsePreviewArgs(["dir", "--base", "--port", "1234"]);
      expect(result.baseMissingValue).toBe(true);
      expect(result.base).toBeUndefined();
      // The dangling --base does not swallow the --port that follows it.
      expect(result.port).toBe(1234);
    });

    it("does not flag a normal --base as missing", () => {
      expect(parsePreviewArgs(["dir", "--base", "/x/"]).baseMissingValue).toBe(false);
    });

    it("does not flag the absence of --base at all as missing", () => {
      expect(parsePreviewArgs(["dir"]).baseMissingValue).toBe(false);
    });
  });
});
