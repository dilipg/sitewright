/**
 * Export CLI: compiles overrides into source and verifies the result.
 * Usage: npm run export -w compiler -- <projectDir> <outDir> [--clean] [--zip <path>]
 * --clean removes an existing outDir first (exportProject itself refuses
 * to write into an existing directory).
 * --zip also writes the deterministic handover archive.
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ExportError, exportProject } from "../src/exporter.ts";

const args = process.argv.slice(2);
const clean = args.includes("--clean");
const zipIndex = args.indexOf("--zip");
const zip = zipIndex === -1 ? undefined : args[zipIndex + 1];
if (zipIndex !== -1 && (zip === undefined || zip.startsWith("--"))) {
  console.error("--zip requires a path");
  process.exit(2);
}
// The `zipIndex !== -1` guard matters: without it, `zipIndex + 1` is 0 when
// --zip is absent and the projectDir gets filtered out as if it were a flag's
// value (the same off-by-one that once broke the gates CLI's --regen parsing).
const zipValueIndex = zipIndex === -1 ? -1 : zipIndex + 1;
const positional = args.filter((arg, index) => !arg.startsWith("--") && index !== zipValueIndex);
const [src, out] = positional;

if (src === undefined || out === undefined) {
  console.error("Usage: export <projectDir> <outDir> [--clean] [--zip <path>]");
  process.exit(2);
}

const outDir = resolve(out);
if (clean && existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

try {
  const result = exportProject(resolve(src), {
    outDir,
    ...(zip === undefined ? {} : { zipPath: resolve(zip) }),
  });
  console.log(`Exported with ${result.appliedOverrides} override(s) -> ${result.outDir}`);
  if (result.tombstoned.length > 0) {
    console.log(`Tombstoned: ${result.tombstoned.join(", ")}`);
  }
  console.log(
    `${result.files.length} file(s) packaged; ${result.integrationCount} integration TODO(s), ` +
      `${result.offScaleCount} off-scale override(s) — see HANDOVER.md`,
  );
  if (result.zipPath !== undefined) {
    console.log(`Zip -> ${result.zipPath}`);
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
