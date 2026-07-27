/**
 * Derives tokens.css from a project's tokens.json via deriveTokens.
 * Usage: node scripts/derive-fixture-tokens.ts [projectDir]
 * (defaults to the fixture; the orchestrator's Design System Agent calls it
 * with generated workspaces). Exit 1 with the deriver's message on invalid
 * tokens — the message feeds the DS agent's retry prompt.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveTokens } from "../src/derive-tokens.ts";

const projectDir =
  process.argv[2] !== undefined
    ? resolve(process.argv[2])
    : fileURLToPath(new URL("../../fixtures/acme-landing", import.meta.url));
const tokensDir = join(projectDir, "src", "tokens");

try {
  const tokens: unknown = JSON.parse(readFileSync(join(tokensDir, "tokens.json"), "utf8"));
  writeFileSync(join(tokensDir, "tokens.css"), deriveTokens(tokens).tokensCss);
  console.log(`wrote ${join(tokensDir, "tokens.css")}`);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
