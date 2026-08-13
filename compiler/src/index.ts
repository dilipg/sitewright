/**
 * Compiler package: manifest service, token deriver, validation gates,
 * exporter, and the bridge-shim protocol. Built against the hand-written
 * fixture project in milestones 1-2 (see docs/build-plan-v1.md).
 */
export const COMPILER_PACKAGE = "@website-generator/compiler";

export { deriveTokens } from "./derive-tokens";
export type { DeriveTokensResult, TailwindTheme } from "./derive-tokens";

export { ExportError, exportProject } from "./exporter";
// Re-exported so callers outside `compiler/` stop hand-rolling it. The
// whole-branch review found a NINTH copy of the `rmdirSync`-on-a-symlink defect
// in `editor/e2e/prepare-project.ts`, outside the reach of the Python-only
// portability guard: `rmdirSync` removes a Windows junction but is `ENOTDIR` on
// a POSIX symlink, so a contributor on Linux or macOS could not run the e2e
// setup twice. This helper already branches on `lstatSync` and is tested.
export { removeDirectoryLink, linkDirectory } from "./exporter";
export type { ExportOptions, ExportResult, OverrideEntry } from "./exporter";

export { PROPERTY_UTILITIES, STYLE_PROPERTIES, isSupportedStyleProperty } from "./style-properties";
export type { UtilitySpec } from "./style-properties";

export { runGates } from "./gates";
export type { GateFailure, GateReport, GateResult, RegenGateContext, RunGatesOptions } from "./gates";

export { EDITABLE_CHANNELS, commit, createManifest, propose, replaceSection, tombstone } from "./manifest";
export type { ReplaceSectionResult } from "./manifest";
export type {
  EditableChannel,
  Manifest,
  ManifestEntryProposal,
  ManifestNode,
  OwnershipMap,
  ProposalConfig,
  ProposalResult,
  ValidationIssue,
  ValidationRule,
} from "./manifest";