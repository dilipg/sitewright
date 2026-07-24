/**
 * Regenerates the fixture's tokens.css from its tokens.json via deriveTokens.
 * Run with: npm run derive:fixture -w compiler
 * (Node 24 executes TypeScript natively.)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveTokens } from "../src/derive-tokens.ts";

const tokensDir = fileURLToPath(
  new URL("../../fixtures/acme-landing/src/tokens/", import.meta.url),
);
const tokens: unknown = JSON.parse(readFileSync(join(tokensDir, "tokens.json"), "utf8"));
writeFileSync(join(tokensDir, "tokens.css"), deriveTokens(tokens).tokensCss);
console.log(`wrote ${join(tokensDir, "tokens.css")}`);
