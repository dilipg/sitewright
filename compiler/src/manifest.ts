/**
 * Manifest service (contract sections 5.2-5.4): the node registry is
 * append-and-update through propose/commit/tombstone, never freehand.
 * All functions are pure — they return new manifests and never mutate input.
 *
 * Issue messages are written to be injected verbatim into gate-failure
 * retry prompts (pipeline 5.4): specific, actionable, quoting the rule.
 */

export const EDITABLE_CHANNELS = ["text", "style", "layout", "visibility"] as const;
export type EditableChannel = (typeof EDITABLE_CHANNELS)[number];

export interface ManifestNode {
  route: string;
  file: string;
  component: string;
  element: string;
  editable: EditableChannel[];
  status: "active" | "tombstoned";
}

export interface Manifest {
  version: 1;
  nodes: Record<string, ManifestNode>;
}

/** What an agent emits in structured output; `editable` is unvalidated until propose(). */
export interface ManifestEntryProposal {
  nodeId: string;
  route: string;
  file: string;
  component: string;
  element: string;
  editable: string[];
}

/** Owner id (e.g. "page:home", "shell") → path prefixes it may register files under. */
export type OwnershipMap = Record<string, string[]>;

export interface ProposalConfig {
  owner: string;
  ownershipMap: OwnershipMap;
}

export type ValidationRule =
  | "id-format"
  | "duplicate-id"
  | "ownership"
  | "editable-channel"
  | "tombstone-resurrection";

export interface ValidationIssue {
  nodeId: string;
  rule: ValidationRule;
  message: string;
}

export interface ProposalResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** Lowercase slug: letters/digits, hyphen-separated. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Positional-looking segments: generic structural names with a numeric
 * suffix. Deliberately a blocklist, not "any -N suffix" — the contract's
 * own example blesses data-derived slugs like "tier-1" (see decisions.md).
 */
const POSITIONAL_SEGMENT = /^(?:child|children|item|element|node|el|div|span|wrapper)-\d+$/;

export function createManifest(): Manifest {
  return { version: 1, nodes: {} };
}

export function propose(
  manifest: Manifest,
  proposals: ManifestEntryProposal[],
  config: ProposalConfig,
): ProposalResult {
  const issues: ValidationIssue[] = [];
  const seenInBatch = new Set<string>();

  for (const proposal of proposals) {
    const { nodeId } = proposal;

    issues.push(...validateIdFormat(nodeId));

    if (seenInBatch.has(nodeId)) {
      issues.push({
        nodeId,
        rule: "duplicate-id",
        message: `Node ID "${nodeId}" appears more than once in this proposal batch; every node ID must be unique.`,
      });
    }
    seenInBatch.add(nodeId);

    const existing = manifest.nodes[nodeId];
    if (existing !== undefined && existing.status === "active") {
      issues.push({
        nodeId,
        rule: "duplicate-id",
        message: `Node ID "${nodeId}" is already registered and active; IDs are immutable once registered (contract 5.2). Choose a new semantic ID for a new element.`,
      });
    }
    if (
      existing !== undefined &&
      existing.status === "tombstoned" &&
      (existing.file !== proposal.file || existing.component !== proposal.component)
    ) {
      issues.push({
        nodeId,
        rule: "tombstone-resurrection",
        message:
          `Node ID "${nodeId}" is tombstoned and may not be re-registered with a different file/component ` +
          `(was ${existing.file} / ${existing.component}, proposed ${proposal.file} / ${proposal.component}).`,
      });
    }

    issues.push(...validateOwnership(proposal, config));

    for (const channel of proposal.editable) {
      if (!(EDITABLE_CHANNELS as readonly string[]).includes(channel)) {
        issues.push({
          nodeId,
          rule: "editable-channel",
          message: `Unknown editable channel "${channel}" on node "${nodeId}"; allowed channels: ${EDITABLE_CHANNELS.join(", ")}.`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Validates then applies proposals, returning a new manifest. Throws on any issue. */
export function commit(
  manifest: Manifest,
  proposals: ManifestEntryProposal[],
  config: ProposalConfig,
): Manifest {
  const result = propose(manifest, proposals, config);
  if (!result.valid) {
    const details = result.issues.map((issue) => `- ${issue.message}`).join("\n");
    throw new Error(`Cannot commit invalid proposals:\n${details}`);
  }
  const nodes = { ...manifest.nodes };
  for (const proposal of proposals) {
    nodes[proposal.nodeId] = {
      route: proposal.route,
      file: proposal.file,
      component: proposal.component,
      element: proposal.element,
      editable: [...proposal.editable] as EditableChannel[],
      status: "active",
    };
  }
  return { version: manifest.version, nodes };
}

export interface ReplaceSectionResult {
  ok: boolean;
  issues: ValidationIssue[];
  manifest?: Manifest;
  tombstoned: string[];
}

/**
 * Regeneration commit (contract 5.2/5.3): a section's entries are replaced
 * wholesale — surviving IDs update in place (immutable IDs, refreshed
 * file/component/editable), removed IDs tombstone, new IDs register.
 * Tombstone-resurrection rules still apply across regenerations.
 */
export function replaceSection(
  manifest: Manifest,
  sectionPrefix: string,
  proposals: ManifestEntryProposal[],
  config: ProposalConfig,
): ReplaceSectionResult {
  const inSection = (nodeId: string): boolean =>
    nodeId === sectionPrefix || nodeId.startsWith(`${sectionPrefix}.`);

  const strayIssues: ValidationIssue[] = proposals
    .filter((proposal) => !inSection(proposal.nodeId))
    .map((proposal) => ({
      nodeId: proposal.nodeId,
      rule: "ownership" as const,
      message: `Proposal "${proposal.nodeId}" is outside the section being regenerated (${sectionPrefix}); a regeneration may only touch its own section's entries.`,
    }));
  if (strayIssues.length > 0) {
    return { ok: false, issues: strayIssues, tombstoned: [] };
  }

  // Validate against the manifest with the section's ACTIVE entries removed:
  // surviving IDs must not trip the duplicate guard, while tombstoned entries
  // stay in place so resurrection rules keep applying.
  const activeSectionIds = Object.entries(manifest.nodes)
    .filter(([nodeId, node]) => inSection(nodeId) && node.status === "active")
    .map(([nodeId]) => nodeId);
  const strippedNodes = { ...manifest.nodes };
  for (const nodeId of activeSectionIds) delete strippedNodes[nodeId];
  const stripped: Manifest = { version: manifest.version, nodes: strippedNodes };

  const validation = propose(stripped, proposals, config);
  if (!validation.valid) {
    return { ok: false, issues: validation.issues, tombstoned: [] };
  }

  const committed = commit(stripped, proposals, config);
  const proposalIds = new Set(proposals.map((proposal) => proposal.nodeId));
  const tombstoned = activeSectionIds.filter((nodeId) => !proposalIds.has(nodeId)).sort();
  for (const nodeId of tombstoned) {
    committed.nodes[nodeId] = { ...manifest.nodes[nodeId]!, status: "tombstoned" };
  }
  return { ok: true, issues: [], manifest: committed, tombstoned };
}

/** Marks nodes tombstoned, returning a new manifest. Idempotent for already-tombstoned IDs. */
export function tombstone(manifest: Manifest, nodeIds: string[]): Manifest {
  const nodes = { ...manifest.nodes };
  for (const nodeId of nodeIds) {
    const node = nodes[nodeId];
    if (node === undefined) {
      throw new Error(`Cannot tombstone unknown node ID "${nodeId}"`);
    }
    nodes[nodeId] = { ...node, status: "tombstoned" };
  }
  return { version: manifest.version, nodes };
}

function validateIdFormat(nodeId: string): ValidationIssue[] {
  const segments = nodeId.split(".");
  if (segments.length < 2) {
    return [
      {
        nodeId,
        rule: "id-format",
        message: `Node ID "${nodeId}" has too few segments: expected at least route.section (e.g. "home.hero"), with element paths below that (e.g. "home.hero.cta-primary").`,
      },
    ];
  }
  for (const segment of segments) {
    if (!SLUG.test(segment)) {
      return [
        {
          nodeId,
          rule: "id-format",
          message: `Node ID "${nodeId}" contains an invalid segment "${segment}": segments must be lowercase hyphenated slugs (contract 5.2).`,
        },
      ];
    }
    if (POSITIONAL_SEGMENT.test(segment)) {
      return [
        {
          nodeId,
          rule: "id-format",
          message: `Node ID "${nodeId}" looks positional ("${segment}"): IDs must be semantic ("home.hero.cta-primary", never "home.hero.child-3") so they survive regeneration (contract 5.2).`,
        },
      ];
    }
  }
  return [];
}

function validateOwnership(
  proposal: ManifestEntryProposal,
  config: ProposalConfig,
): ValidationIssue[] {
  const prefixes = config.ownershipMap[config.owner];
  if (prefixes === undefined) {
    return [
      {
        nodeId: proposal.nodeId,
        rule: "ownership",
        message: `Owner "${config.owner}" is not present in the ownership map; no files may be registered for it.`,
      },
    ];
  }
  const file = normalizePath(proposal.file);
  if (!prefixes.some((prefix) => file.startsWith(normalizePath(prefix)))) {
    return [
      {
        nodeId: proposal.nodeId,
        rule: "ownership",
        message:
          `File "${proposal.file}" for node "${proposal.nodeId}" is outside the ownership boundary of "${config.owner}" ` +
          `(allowed prefixes: ${prefixes.join(", ")}). Agents may only write inside their own directory (contract section 2).`,
      },
    ];
  }
  return [];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
