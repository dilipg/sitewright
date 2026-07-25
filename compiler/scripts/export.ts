/**
 * Export CLI: compiles overrides into source and verifies the result.
 * Usage: npm run export -w compiler -- <projectDir> <outDir> [--clean]
 * --clean removes an existing outDir first (exportProject itself refuses
 * to write into an existing directory).
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ExportError, exportProject } from "../src/exporter.ts";

const args = process.argv.slice(2);
const clean = args.includes("--clean");
const positional = args.filter((arg) => !arg.startsWith("--"));
const [src, out] = positional;

if (src === undefined || out === undefined) {
  console.error("Usage: export <projectDir> <outDir> [--clean]");
  process.exit(2);
}

const outDir = resolve(out);
if (clean && existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

try {
  const result = exportProject(resolve(src), { outDir });
  console.log(`Exported with ${result.appliedOverrides} override(s) -> ${result.outDir}`);
  if (result.tombstoned.length > 0) {
    console.log(`Tombstoned: ${result.tombstoned.join(", ")}`);
  }
} catch (error) {
  if (error instanceof ExportError) {
    console.error(error.message);
    if (error.buildLog !== undefined) console.error(error.buildLog);
  } else {
    console.error(error);
  }
  process.exit(1);
}
