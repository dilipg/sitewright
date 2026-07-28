/**
 * Gate CLI: runs validation gates against a project directory.
 * Usage: gates <projectDir> [--json] [--regen <context.json>]
 *                           [--write-log <file.json>] [--ownership-map <file.json>]
 *                           [--scope-route <slug>] [--skip-missing-check]
 * --regen enables gate 7; the file holds { overriddenNodeIds, declaredOrphans }.
 * --write-log + --ownership-map enable gate 6's dynamic ownership-boundary
 * check (owner -> written files, owner -> allowed path prefixes) — the
 * fan-out orchestrator's real cross-process record of who wrote what
 * (build prompt 5.3); without them gate 6 still runs its static
 * cross-page-import check.
 * --scope-route restricts gate 4 to one route — a section's own gate check
 * during parallel fan-out must not see a SIBLING page's transient mid-commit
 * state as its own failure (build prompt 5.3; see gateNodeIdsRegistered's
 * doc comment in src/gates.ts). Never pass this for the final whole-project
 * gate run.
 * --skip-missing-check exempts section-ROOT node ids (route.section, no
 * deeper) from gate 4's "missing" direction — a root id is only literally
 * attached once the page is ASSEMBLED (index.tsx), which hasn't happened
 * yet during a section's own mid-retry check in fan-out. Child ids stay
 * fully checked. See RunGatesOptions.skipMissingCheck's doc comment.
 * Exit code 0 = all gates passed, 1 = failures, 2 = usage error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RegenGateContext, RunGatesOptions } from "../src/gates.ts";
import { runGates } from "../src/gates.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const valueFlags = ["--regen", "--write-log", "--ownership-map", "--scope-route"];
const flagIndices = new Set(
  valueFlags.map((flag) => args.indexOf(flag)).filter((i) => i !== -1),
);
const positional = args.filter(
  (arg, i) => !arg.startsWith("--") && !flagIndices.has(i - 1),
);
const dir = positional[0];

if (dir === undefined) {
  console.error(
    "Usage: gates <projectDir> [--json] [--regen <context.json>] [--write-log <file.json>] [--ownership-map <file.json>]",
  );
  process.exit(2);
}

function readFlag(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const regenFile = readFlag("--regen");
const regen: RegenGateContext | undefined =
  regenFile !== undefined ? (JSON.parse(readFileSync(regenFile, "utf8")) as RegenGateContext) : undefined;

const writeLogFile = readFlag("--write-log");
const ownershipMapFile = readFlag("--ownership-map");
const scopeRoute = readFlag("--scope-route");
const skipMissingCheck = args.includes("--skip-missing-check");
const options: RunGatesOptions = {
  ...(regen !== undefined ? { regen } : {}),
  ...(writeLogFile !== undefined ? { writtenFiles: JSON.parse(readFileSync(writeLogFile, "utf8")) } : {}),
  ...(ownershipMapFile !== undefined
    ? { ownershipMap: JSON.parse(readFileSync(ownershipMapFile, "utf8")) }
    : {}),
  ...(scopeRoute !== undefined ? { scopeRoute } : {}),
  ...(skipMissingCheck ? { skipMissingCheck } : {}),
};

const report = runGates(resolve(dir), options);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const gate of report.gates) {
    console.log(`${gate.passed ? "PASS" : "FAIL"}  gate ${gate.gate} (${gate.name})`);
    for (const failure of gate.failures) {
      console.log(`      - ${failure.message}`);
    }
  }
  console.log(report.passed ? "\nAll gates passed." : "\nGate failures found.");
}

process.exit(report.passed ? 0 : 1);
