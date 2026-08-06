// server/src/usage-log-sweep.test.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepStaleUsageLogs } from "./usage-log-sweep.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-sweep-"));
  dirs.push(dir);
  return dir;
}

describe("sweepStaleUsageLogs", () => {
  it("removes every file in the directory and reports how many", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "aaa.jsonl"), '{"role":"section"}\n');
    writeFileSync(join(dir, "bbb.jsonl"), '{"role":"section"}\n');

    const result = sweepStaleUsageLogs(dir);

    expect(result.swept).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("actually deletes from disk, not merely counts — a file left behind fails this", () => {
    // The most important perturbation this module has: an implementation
    // that returned the right COUNT without calling unlinkSync at all would
    // pass a test that only checks `swept`. This checks the disk directly.
    const dir = freshDir();
    const path = join(dir, "orphan.jsonl");
    writeFileSync(path, '{"role":"section"}\n');

    sweepStaleUsageLogs(dir);

    expect(existsSync(path)).toBe(false);
  });

  it("returns swept: 0 and does not throw when the directory does not exist yet", () => {
    const dir = join(freshDir(), "never-created");
    expect(() => sweepStaleUsageLogs(dir)).not.toThrow();
    expect(sweepStaleUsageLogs(dir)).toEqual({ swept: 0 });
  });

  it("is a no-op on an empty directory", () => {
    const dir = freshDir();
    expect(sweepStaleUsageLogs(dir)).toEqual({ swept: 0 });
  });

  it("does not throw and still sweeps what it can when one entry cannot be removed", () => {
    // A subdirectory at one of the names unlinkSync cannot remove (EISDIR on
    // POSIX, EPERM on Windows) stands in for "a file another process still
    // holds open" — best-effort, not fatal to the whole sweep.
    const dir = freshDir();
    mkdirSync(join(dir, "stuck-dir"));
    writeFileSync(join(dir, "removable.jsonl"), '{"role":"section"}\n');

    const result = sweepStaleUsageLogs(dir);

    expect(existsSync(join(dir, "removable.jsonl"))).toBe(false);
    // The un-removable entry is left behind rather than crashing the sweep.
    expect(existsSync(join(dir, "stuck-dir"))).toBe(true);
    expect(result.swept).toBe(1);
  });

  it("has a working default directory when called with no argument at all", () => {
    // Proves the default parameter resolves to a real, well-formed path
    // (usageLogDir()) rather than `undefined` — `readdirSync(undefined)`
    // would throw a TypeError, a different failure than the ENOENT this
    // function is built to tolerate for "directory not created yet".
    expect(() => sweepStaleUsageLogs()).not.toThrow();
  });
});
