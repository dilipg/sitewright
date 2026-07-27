/**
 * Manifest CLI: the orchestrator's doorway to the manifest service —
 * manifest.json is append-and-update ONLY through this service (contract 5.4).
 *
 * Usage:
 *   manifest propose         <projectDir> --proposals <file.json> --owner <owner>
 *   manifest commit          <projectDir> --proposals <file.json> --owner <owner>
 *   manifest replace-section <projectDir> --proposals <file.json> --owner <owner> --section <prefix>
 *
 * propose validates only; commit validates then writes manifest.json;
 * replace-section is the regeneration commit (surviving IDs update, removed
 * IDs tombstone). Output: JSON { ok, issues, committed, tombstoned } on
 * stdout. Exit 0 valid / 1 invalid.
 * The owner's boundary is derived: "page:<slug>" -> src/pages/<slug>/.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Manifest, ManifestEntryProposal } from "../src/manifest.ts";
import { commit, createManifest, propose, replaceSection } from "../src/manifest.ts";

const args = process.argv.slice(2);
const command = args[0];
const projectDir = args[1];
const proposalsFlag = args.indexOf("--proposals");
const ownerFlag = args.indexOf("--owner");
const sectionFlag = args.indexOf("--section");

if (
  (command !== "propose" && command !== "commit" && command !== "replace-section") ||
  projectDir === undefined ||
  proposalsFlag === -1 ||
  ownerFlag === -1 ||
  (command === "replace-section" && sectionFlag === -1)
) {
  console.error(
    "Usage: manifest <propose|commit|replace-section> <projectDir> --proposals <file.json> --owner <owner> [--section <prefix>]",
  );
  process.exit(2);
}

const owner = args[ownerFlag + 1]!;
const pageMatch = /^page:([a-z0-9-]+)$/.exec(owner);
if (pageMatch === null) {
  console.error(`Unsupported owner "${owner}"; expected page:<slug>.`);
  process.exit(2);
}
const ownershipMap = { [owner]: [`src/pages/${pageMatch[1]}/`] };

const proposals = JSON.parse(
  readFileSync(args[proposalsFlag + 1]!, "utf8"),
) as ManifestEntryProposal[];

const manifestPath = join(resolve(projectDir), "manifest.json");
const manifest: Manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
  : createManifest();

if (command === "replace-section") {
  const section = args[sectionFlag + 1]!;
  const result = replaceSection(manifest, section, proposals, { owner, ownershipMap });
  if (result.ok) {
    writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  }
  console.log(
    JSON.stringify({
      ok: result.ok,
      issues: result.issues,
      committed: result.ok,
      tombstoned: result.tombstoned,
    }),
  );
  process.exit(result.ok ? 0 : 1);
}

const result = propose(manifest, proposals, { owner, ownershipMap });

if (result.valid && command === "commit") {
  const next = commit(manifest, proposals, { owner, ownershipMap });
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}

console.log(
  JSON.stringify({
    ok: result.valid,
    issues: result.issues,
    committed: result.valid && command === "commit",
    tombstoned: [],
  }),
);
process.exit(result.valid ? 0 : 1);
