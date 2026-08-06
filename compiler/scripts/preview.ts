/**
 * Preview CLI: serves a project with the bridge shim injected.
 * Usage: npm run preview -w compiler -- <projectDir> [--port <n>] [--base <path>]
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startPreviewServer } from "../src/preview.ts";

export interface ParsedPreviewArgs {
  dir: string | undefined;
  port: number;
  base: string | undefined;
  /**
   * True when `--base` was passed but has no usable value: it was the last
   * argument, or the very next token is itself another recognized flag.
   * `--port` gets this protection for free (`Number(undefined)` is `NaN`,
   * which the caller already rejects via `Number.isNaN(port)`); `base` has
   * no equivalent "obviously invalid" string, since almost anything is a
   * syntactically valid path. Without this flag a dangling `--base` would
   * silently behave exactly like no `--base` at all — the server falls back
   * to serving at "/", and under the pool's reverse proxy every asset 404s
   * with nothing pointing back at a missing CLI value. Deliberately kept out
   * of `base` itself (rather than, say, using `""` as a sentinel) so the
   * pure-extraction result (`base`) and the validity judgment stay separate,
   * the same way `port`'s numeric value and its validity (`Number.isNaN`)
   * stay separate.
   */
  baseMissingValue: boolean;
}

/**
 * Pure argument parsing, deliberately free of `process.exit`/console output
 * so it can be unit-tested without spawning the server or the process. The
 * usage-error decision stays at the call site (`main`, below).
 *
 * Positional <projectDir> detection: drop every recognized flag and its
 * value. A flag's value only gets excluded when the flag itself is actually
 * present — otherwise `flagIndex + 1` is `0` (since `indexOf` returns `-1`
 * for an absent flag) and would wrongly swallow the first positional
 * argument. That was a real, previously-shipped bug: a bare
 * `preview <dir>` call with no flags at all ate `<dir>` as if it were a
 * flag's value. See preview-cli.test.ts's "regression" case, which fails
 * against the old expression and passes against this one.
 */
export function parsePreviewArgs(args: string[]): ParsedPreviewArgs {
  const portFlagIndex = args.indexOf("--port");
  const baseFlagIndex = args.indexOf("--base");
  const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : 5273;
  const rawBase = baseFlagIndex >= 0 ? args[baseFlagIndex + 1] : undefined;
  const baseMissingValue = baseFlagIndex >= 0 && (rawBase === undefined || rawBase.startsWith("--"));
  const base = baseMissingValue ? undefined : rawBase;

  const flagValueIndices = new Set<number>();
  if (portFlagIndex >= 0) flagValueIndices.add(portFlagIndex + 1);
  if (baseFlagIndex >= 0) flagValueIndices.add(baseFlagIndex + 1);
  const dir = args.filter((arg, i) => !arg.startsWith("--") && !flagValueIndices.has(i))[0];

  return { dir, port, base, baseMissingValue };
}

async function main(): Promise<void> {
  const { dir, port, base, baseMissingValue } = parsePreviewArgs(process.argv.slice(2));

  if (dir === undefined || Number.isNaN(port) || baseMissingValue) {
    console.error("Usage: preview <projectDir> [--port <n>] [--base <path>]");
    process.exit(2);
  }

  const server = await startPreviewServer(resolve(dir), { port, base });
  const address = server.httpServer?.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`Preview with bridge shim: http://localhost:${actualPort}/`);
  // Machine-readable, for the hosted server's preview pool. NOT how the pool
  // learns the port: it probes a free port itself and passes it concretely
  // via --port (Vite cannot honour `--port 0` -- it treats 0 as "unset" and
  // falls back to its own fixed default, so two callers passing 0 would
  // collide), and the pool deliberately DISCARDS whatever port this line
  // claims (see server/src/preview-pool.ts's spawnAndAwaitReady, around the
  // `succeed` closure) because this process's stdout is not a trust boundary
  // -- it runs the project's own unvalidated vite.config.ts, which could print
  // an early, well-formed line naming any port it likes. This line is read
  // only as a READINESS HINT (the pool still independently verifies the port
  // it chose actually accepts a connection before proxying to it), never as
  // the source of truth for where traffic goes. Prefixed like REGEN_RESULT in
  // regen-api.ts, the existing convention for a line a parent process parses.
  // The human line above stays for local use. Reports the resolved base
  // (always a string, defaulting to "/") rather than the raw CLI arg,
  // mirroring actualPort's use of the resolved value over the request.
  console.log(`PREVIEW_READY ${JSON.stringify({ port: actualPort, base: server.config.base })}`);
}

// Run only when this file is the process's entry point, not when it is
// imported (a test imports it to reach `parsePreviewArgs`, and importing it
// must not start a real server or call `process.exit`).
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  await main();
}
