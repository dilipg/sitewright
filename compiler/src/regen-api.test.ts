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
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { runProcess, usageEnvFor } from "./regen-api.ts";
import { USAGE_ID_HEADER, usageLogPathFor } from "./usage-log-path.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** A stand-in for `IncomingMessage`, since these tests never open a socket:
 *  only `.headers` is ever read by `usageEnvFor`. */
function fakeRequest(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

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

  it("merges a 4th-argument env addition over the inherited environment", async () => {
    // The orchestrator needs PATH (inherited) AND the per-request addition
    // (WEBGEN_USAGE_LOG) at once — a replace instead of a merge would either
    // lose PATH (and, under the hosted server, ANTHROPIC_API_KEY) or lose the
    // addition. Asserting both env vars in the same child proves it is a
    // merge, not one or the other.
    const { stdout } = await runProcess(
      process.execPath,
      ["-e", "console.log(JSON.stringify([process.env.WEBGEN_USAGE_LOG, typeof process.env.PATH]))"],
      REPO_ROOT,
      { WEBGEN_USAGE_LOG: "/tmp/example.jsonl" },
    );

    expect(JSON.parse(stdout.trim())).toEqual(["/tmp/example.jsonl", "string"]);
  });
});

describe("usageEnvFor", () => {
  const validId = "0123456789abcdef0123456789abcdef";

  it("turns a well-formed usage-id header into a WEBGEN_USAGE_LOG addition", () => {
    const env = usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: validId }));
    expect(env).toEqual({ WEBGEN_USAGE_LOG: usageLogPathFor(validId) });
  });

  it("returns undefined when the header is absent", () => {
    // The load-bearing default: no header, no addition, so the local
    // unauthenticated preview (which never sends this header) is unaffected.
    expect(usageEnvFor(fakeRequest({}))).toBeUndefined();
  });

  it("returns undefined rather than throwing when the header is malformed", () => {
    // A bad id is not the child's problem to police (Task 1 brief); the
    // request still proceeds, just without usage attribution.
    expect(usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: "../../etc/passwd" }))).toBeUndefined();
  });

  it("takes the first value when the header arrives duplicated", () => {
    const env = usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: [validId, "ignored"] }));
    expect(env).toEqual({ WEBGEN_USAGE_LOG: usageLogPathFor(validId) });
  });
});

describe("usageEnvFor + runProcess (end to end)", () => {
  it("a well-formed x-webgen-usage-id header reaches the child as WEBGEN_USAGE_LOG", async () => {
    // This is the actual point of Task 1: a per-request header, translated by
    // usageEnvFor, must survive all the way into the orchestrator child's
    // environment — not just that runProcess can merge SOME env object.
    const id = "fedcba9876543210fedcba9876543210";
    const env = usageEnvFor(fakeRequest({ [USAGE_ID_HEADER]: id }));

    const { stdout } = await runProcess(
      process.execPath,
      ["-e", "console.log(process.env.WEBGEN_USAGE_LOG ?? '')"],
      REPO_ROOT,
      env,
    );

    expect(stdout.trim()).toBe(usageLogPathFor(id));
  });
});
