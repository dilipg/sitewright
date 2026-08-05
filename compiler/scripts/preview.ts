/**
 * Preview CLI: serves a project with the bridge shim injected.
 * Usage: npm run preview -w compiler -- <projectDir> [--port <n>] [--base <path>]
 */
import { resolve } from "node:path";
import { startPreviewServer } from "../src/preview.ts";

const args = process.argv.slice(2);
const portFlagIndex = args.indexOf("--port");
const baseFlagIndex = args.indexOf("--base");
const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : 5273;
const base = baseFlagIndex >= 0 ? args[baseFlagIndex + 1] : undefined;
// Positional <projectDir> detection: drop every recognized flag and its value.
// A flag's value only gets excluded when the flag itself is actually present —
// otherwise `flagIndex + 1` is `0` (since indexOf returns -1) and would wrongly
// swallow the first positional argument.
const flagValueIndices = new Set<number>();
if (portFlagIndex >= 0) flagValueIndices.add(portFlagIndex + 1);
if (baseFlagIndex >= 0) flagValueIndices.add(baseFlagIndex + 1);
const dir = args.filter((arg, i) => !arg.startsWith("--") && !flagValueIndices.has(i))[0];

if (dir === undefined || Number.isNaN(port)) {
  console.error("Usage: preview <projectDir> [--port <n>] [--base <path>]");
  process.exit(2);
}

const server = await startPreviewServer(resolve(dir), { port, base });
const address = server.httpServer?.address();
const actualPort = typeof address === "object" && address !== null ? address.port : port;
console.log(`Preview with bridge shim: http://localhost:${actualPort}/`);
// Machine-readable, for the hosted server's preview pool: the parent needs
// the OS-assigned port when it spawned us with `--port 0`. Prefixed like
// REGEN_RESULT in regen-api.ts, the existing convention for a line a parent
// process parses. The human line above stays for local use. Reports the
// resolved base (always a string, defaulting to "/") rather than the raw
// CLI arg, mirroring actualPort's use of the resolved value over the request.
console.log(`PREVIEW_READY ${JSON.stringify({ port: actualPort, base: server.config.base })}`);
