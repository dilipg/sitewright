/**
 * Compiler package: manifest service, token deriver, validation gates,
 * exporter, and the bridge-shim protocol. Built against the hand-written
 * fixture project in milestones 1-2 (see docs/build-plan-v1.md).
 */
export const COMPILER_PACKAGE = "@website-generator/compiler";

export { deriveTokens } from "./derive-tokens";
export type { DeriveTokensResult, TailwindTheme } from "./derive-tokens";

export { ExportError, exportProject } from "./exporter";
export type { ExportOptions, ExportResult, OverrideEntry } from "./exporter";

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