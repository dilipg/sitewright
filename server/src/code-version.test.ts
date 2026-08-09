// server/src/code-version.test.ts
import { describe, expect, it } from "vitest";
import { CODE_VERSION_ENV_VAR, codeVersionsIncompatible, resolveCodeVersion, UNKNOWN_CODE_VERSION } from "./code-version.ts";

describe("resolveCodeVersion", () => {
  it("prefers the env override over git", () => {
    const gitRevParse = () => "should-not-be-called";
    const value = resolveCodeVersion({
      env: { [CODE_VERSION_ENV_VAR]: "build-42" },
      gitRevParse,
    });
    expect(value).toBe("build-42");
  });

  it("trims the env override", () => {
    const value = resolveCodeVersion({ env: { [CODE_VERSION_ENV_VAR]: "  build-42  " } });
    expect(value).toBe("build-42");
  });

  it("treats an empty or whitespace-only override as unset and falls through to git", () => {
    let called = false;
    const gitRevParse = () => {
      called = true;
      return "abc123";
    };
    expect(resolveCodeVersion({ env: { [CODE_VERSION_ENV_VAR]: "" }, gitRevParse })).toBe("abc123");
    expect(called).toBe(true);

    called = false;
    expect(resolveCodeVersion({ env: { [CODE_VERSION_ENV_VAR]: "   " }, gitRevParse })).toBe("abc123");
    expect(called).toBe(true);
  });

  it("falls back to git rev-parse HEAD, trimmed, when no override is set", () => {
    const gitRevParse = (cwd: string) => `sha-for-${cwd}\n`;
    expect(resolveCodeVersion({ env: {}, cwd: "/some/repo", gitRevParse })).toBe("sha-for-/some/repo");
  });

  it("passes the given cwd (defaulting to the repo root) to gitRevParse", () => {
    let seenCwd: string | undefined;
    resolveCodeVersion({
      env: {},
      cwd: "/explicit/repo",
      gitRevParse: (cwd) => {
        seenCwd = cwd;
        return "sha";
      },
    });
    expect(seenCwd).toBe("/explicit/repo");
  });

  it("falls back to UNKNOWN_CODE_VERSION when git throws (not installed, not a repo, ...)", () => {
    const value = resolveCodeVersion({
      env: {},
      gitRevParse: () => {
        throw new Error("fatal: not a git repository");
      },
    });
    expect(value).toBe(UNKNOWN_CODE_VERSION);
  });

  it("falls back to UNKNOWN_CODE_VERSION when git returns an empty string", () => {
    expect(resolveCodeVersion({ env: {}, gitRevParse: () => "" })).toBe(UNKNOWN_CODE_VERSION);
  });

  it("the real default (no overrides) returns this actual repo's HEAD sha, since this IS a git repository", () => {
    // Not the load-bearing test (the injected-dependency tests above are) --
    // a light integration check that the real, non-injected path works too.
    const value = resolveCodeVersion();
    expect(value).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("codeVersionsIncompatible", () => {
  it("is compatible (false) when recorded is null — nothing ran, so there is nothing to compare", () => {
    expect(codeVersionsIncompatible(null, "sha-1")).toBe(false);
    expect(codeVersionsIncompatible(null, UNKNOWN_CODE_VERSION)).toBe(false);
  });

  it("is compatible (false) when recorded equals current, both real shas", () => {
    expect(codeVersionsIncompatible("sha-1", "sha-1")).toBe(false);
  });

  it("is incompatible (true) when recorded differs from current, both real shas", () => {
    expect(codeVersionsIncompatible("sha-1", "sha-2")).toBe(true);
  });

  /**
   * Task-7-review finding 1, the load-bearing case: two DIFFERENT boots that
   * both fail to determine a version produce the IDENTICAL sentinel string.
   * A bare `recorded !== current` would read this as a MATCH and permit
   * resuming a job across arbitrarily many deploys — precisely the case
   * this whole mechanism exists to refuse. Perturbing this function back to
   * `return recorded !== null && recorded !== current;` (dropping the
   * `current === UNKNOWN_CODE_VERSION` clause) makes this fail.
   */
  it("is incompatible (true) when CURRENT is UNKNOWN_CODE_VERSION, even if recorded is the identical string", () => {
    expect(codeVersionsIncompatible(UNKNOWN_CODE_VERSION, UNKNOWN_CODE_VERSION)).toBe(true);
  });

  it("is incompatible (true) when current is UNKNOWN_CODE_VERSION and recorded is a real sha", () => {
    expect(codeVersionsIncompatible("sha-1", UNKNOWN_CODE_VERSION)).toBe(true);
  });

  it("is incompatible (true) when recorded is UNKNOWN_CODE_VERSION and current is a real, known sha", () => {
    // Already covered by the plain-mismatch branch, but asserted explicitly
    // so this direction is not accidentally assumed rather than checked.
    expect(codeVersionsIncompatible(UNKNOWN_CODE_VERSION, "sha-1")).toBe(true);
  });
});
