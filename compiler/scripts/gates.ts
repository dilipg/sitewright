/**
 * Gate CLI: runs validation gates 1-6 against a project directory.
 * Usage: npm run gates -w compiler -- <projectDir> [--json]
 * Exit code 0 = all gates passed, 1 = failures, 2 = usage error.
 */
import { resolve } from "node:path";
import { runGates } from "../src/gates.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const dir = args.find((arg) => !arg.startsWith("--"));

if (dir === undefined) {
  console.error("Usage: gates <projectDir> [--json]");
  process.exit(2);
}

const report = runGates(resolve(dir));

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
