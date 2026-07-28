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
 * IDs tombstone). Output: JSON { ok, issues, committed, tombstoned,
 * previousManifest } on stdout. Exit 0 valid / 1 invalid.
 * The owner's boundary is derived: "page:<slug>" -> src/pages/<slug>/.
 *
 * previousManifest is the file's exact content immediately before this
 * locked operation, captured ATOMICALLY inside the lock — never read by the
 * caller beforehand. Under concurrent page workers (build prompt 5.3
 * fan-out), a caller-side pre-read would go stale the instant another
 * worker commits in between; a caller that then rolls back a failed gate
 * check using that stale snapshot would silently erase the other worker's
 * commit. Rollback must always restore to "state right before MY commit",
 * which only the locked critical section can observe correctly.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Manifest, ManifestEntryProposal } from "../src/manifest.ts";
import { commit, createManifest, propose, removeNodes, replaceSection } from "../src/manifest.ts";
import { withManifestLock } from "../src/manifest-lock.ts";

const args = process.argv.slice(2);
const command = args[0];
const projectDir = args[1];
const proposalsFlag = args.indexOf("--proposals");
const ownerFlag = args.indexOf("--owner");
const sectionFlag = args.indexOf("--section");

const KNOWN_COMMANDS = ["propose", "commit", "replace-section", "rollback-commit"];
if (
  !KNOWN_COMMANDS.includes(command ?? "") ||
  projectDir === undefined ||
  proposalsFlag === -1 ||
  ownerFlag === -1 ||
  (command === "replace-section" && sectionFlag === -1)
) {
  console.error(
    `Usage: manifest <${KNOWN_COMMANDS.join("|")}> <projectDir> --proposals <file.json> --owner <owner> [--section <prefix>]`,
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

// The whole read -> validate -> write cycle is the critical section: parallel
// page-agent processes (build prompt 5.3 fan-out) commit to this ONE file
// concurrently, and an unlocked read-modify-write would silently lose a
// writer's proposals. propose (read-only) does not need the lock.
function loadManifest(): { manifest: Manifest; raw: string } {
  const raw = existsSync(manifestPath)
    ? readFileSync(manifestPath, "utf8")
    : `${JSON.stringify(createManifest(), null, 2)}\n`;
  return { manifest: JSON.parse(raw) as Manifest, raw };
}

if (command === "rollback-commit") {
  // Undoes exactly THIS attempt's own additions (by node ID), never a
  // concurrent worker's — see removeNodes' doc comment for why a blind
  // file-overwrite rollback is unsafe under parallel fan-out.
  const nodeIds = proposals.map((proposal) => proposal.nodeId);
  withManifestLock(manifestPath, () => {
    const { manifest } = loadManifest();
    const next = removeNodes(manifest, nodeIds);
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  });
  console.log(JSON.stringify({ ok: true, issues: [], committed: true, tombstoned: [], removed: nodeIds }));
  process.exit(0);
}

if (command === "replace-section") {
  const section = args[sectionFlag + 1]!;
  const outcome = withManifestLock(manifestPath, () => {
    const { manifest, raw } = loadManifest();
    const result = replaceSection(manifest, section, proposals, { owner, ownershipMap });
    if (result.ok) {
      writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
    }
    return { ...result, previousManifest: raw };
  });
  console.log(
    JSON.stringify({
      ok: outcome.ok,
      issues: outcome.issues,
      committed: outcome.ok,
      tombstoned: outcome.tombstoned,
      previousManifest: outcome.previousManifest,
    }),
  );
  process.exit(outcome.ok ? 0 : 1);
}

if (command === "commit") {
  const outcome = withManifestLock(manifestPath, () => {
    const { manifest, raw } = loadManifest();
    const result = propose(manifest, proposals, { owner, ownershipMap });
    if (result.valid) {
      const next = commit(manifest, proposals, { owner, ownershipMap });
      writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    }
    return { ...result, previousManifest: raw };
  });
  console.log(
    JSON.stringify({
      ok: outcome.valid,
      issues: outcome.issues,
      committed: outcome.valid,
      tombstoned: [],
      previousManifest: outcome.previousManifest,
    }),
  );
  process.exit(outcome.valid ? 0 : 1);
}

// propose: validation only, no write — safe to read without the lock
const result = propose(loadManifest().manifest, proposals, { owner, ownershipMap });
console.log(JSON.stringify({ ok: result.valid, issues: result.issues, committed: false, tombstoned: [] }));
process.exit(result.valid ? 0 : 1);
