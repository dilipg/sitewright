// server/src/code-version.test.ts
import { describe, expect, it } from "vitest";
import { CODE_VERSION_ENV_VAR, resolveCodeVersion, UNKNOWN_CODE_VERSION } from "./code-version.ts";

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
