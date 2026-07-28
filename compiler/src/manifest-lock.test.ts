import { closeSync, existsSync, mkdtempSync, openSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withManifestLock } from "./manifest-lock";

let dir: string;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function freshManifestPath(): string {
  dir = mkdtempSync(join(tmpdir(), "manifest-lock-"));
  return join(dir, "manifest.json");
}

describe("withManifestLock", () => {
  it("runs fn and leaves no lock file behind on success", () => {
    const manifestPath = freshManifestPath();
    const result = withManifestLock(manifestPath, () => 42);
    expect(result).toBe(42);
    expect(existsSync(`${manifestPath}.lock`)).toBe(false);
  });

  it("releases the lock even when fn throws", () => {
    const manifestPath = freshManifestPath();
    expect(() =>
      withManifestLock(manifestPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${manifestPath}.lock`)).toBe(false);
  });

  it("times out with a clear error when a fresh lock is never released", () => {
    const manifestPath = freshManifestPath();
    closeSync(openSync(`${manifestPath}.lock`, "wx")); // simulate another process holding it

    expect(() =>
      withManifestLock(manifestPath, () => "unreachable", { timeoutMs: 150, retryDelayMs: 20 }),
    ).toThrow(/Timed out/);
  });

  it("steals a stale lock (crashed holder) instead of waiting out the full timeout", () => {
    const manifestPath = freshManifestPath();
    const lockPath = `${manifestPath}.lock`;
    closeSync(openSync(lockPath, "wx"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old); // back-date past staleMs

    const result = withManifestLock(manifestPath, () => "acquired", {
      timeoutMs: 500,
      retryDelayMs: 20,
      staleMs: 1_000,
    });
    expect(result).toBe("acquired");
    expect(existsSync(lockPath)).toBe(false);
  });
});
