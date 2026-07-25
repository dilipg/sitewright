/**
 * Preview CLI: serves a project with the bridge shim injected.
 * Usage: npm run preview -w compiler -- <projectDir> [--port <n>]
 */
import { resolve } from "node:path";
import { startPreviewServer } from "../src/preview.ts";

const args = process.argv.slice(2);
const portFlagIndex = args.indexOf("--port");
const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : 5273;
const dir = args.filter((arg, i) => !arg.startsWith("--") && i !== portFlagIndex + 1)[0];

if (dir === undefined || Number.isNaN(port)) {
  console.error("Usage: preview <projectDir> [--port <n>]");
  process.exit(2);
}

const server = await startPreviewServer(resolve(dir), { port });
const address = server.httpServer?.address();
const actualPort = typeof address === "object" && address !== null ? address.port : port;
console.log(`Preview with bridge shim: http://localhost:${actualPort}/`);
