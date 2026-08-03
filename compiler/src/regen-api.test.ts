/**
 * The one thing about the regen/edit endpoints that is testable without a model
 * and without a running server: HOW they spawn the orchestrator.
 *
 * Every one of /__regen, /__regen-page, /__add-section and /__edit-prompt ends
 * its argument list with `--instruction <free-form user text>`. If that text
 * does not survive the spawn exactly, argparse exits 2, no result line is ever
 * printed, and the endpoint 500s on every call — which is what `shell: true`
 * did: Node concatenates argv into one unquoted command string (its own
 * DEP0190 deprecation says so), so "make the headline shorter" arrived as five
 * arguments.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { runProcess } from "./regen-api.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Echoes its own argv as JSON — a stand-in for argparse, minus the uv startup
 * cost. The `--` before the flags is for NODE's own option parsing of `-e`
 * scripts (without it node itself rejects `--instruction` as a bad option); it
 * says nothing about the spawn, which is what is under test here. The product
 * path spawns `uv run python -m <module> … --instruction <text>`, where python
 * stops parsing options at `-m`'s module and argparse receives the rest.
 */
const ECHO_ARGV = "console.log(JSON.stringify(process.argv.slice(1)))";

describe("runProcess", () => {
  it("delivers an instruction containing spaces and a quote as ONE argument", async () => {
    // A space is the common case; the quote is the one that a shell, or naive
    // hand-quoting, mangles rather than merely splits.
    const instruction = 'make the "big" headline shorter';
    const { stdout, code } = await runProcess(
      process.execPath,
      ["-e", ECHO_ARGV, "--", "--instruction", instruction],
      REPO_ROOT,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(["--instruction", instruction]);
  });

  it("preserves shell metacharacters instead of letting a shell interpret them", async () => {
    // The same code path is fed straight from a text box, so this is the
    // injection surface as much as it is a correctness one.
    const instruction = 'shorten it & echo hi > out.txt | whoami `id` $(pwd)';
    const { stdout } = await runProcess(
      process.execPath,
      ["-e", ECHO_ARGV, "--", "--instruction", instruction],
      REPO_ROOT,
    );

    expect(JSON.parse(stdout.trim())).toEqual(["--instruction", instruction]);
  });

  it("rejects rather than hanging when the executable does not exist", async () => {
    await expect(
      runProcess("wg-no-such-executable", ["--version"], REPO_ROOT),
    ).rejects.toThrow();
  });
});
