/**
 * Gate CLI: runs validation gates against a project directory.
 * Usage: gates <projectDir> [--json] [--regen <context.json>]
 * --regen enables gate 7; the file holds { overriddenNodeIds, declaredOrphans }.
 * Exit code 0 = all gates passed, 1 = failures, 2 = usage error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RegenGateContext } from "../src/gates.ts";
import { runGates } from "../src/gates.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const regenFlag = args.indexOf("--regen");
const positional = args.filter((arg, i) => !arg.startsWith("--") && i !== regenFlag + 1);
const dir = positional[0];

if (dir === undefined) {
  console.error("Usage: gates <projectDir> [--json] [--regen <context.json>]");
  process.exit(2);
}

const regen: RegenGateContext | undefined =
  regenFlag !== -1
    ? (JSON.parse(readFileSync(args[regenFlag + 1]!, "utf8")) as RegenGateContext)
    : undefined;

const report = runGates(resolve(dir), regen !== undefined ? { regen } : {});

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
