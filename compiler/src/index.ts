/**
 * Compiler package: manifest service, token deriver, validation gates,
 * exporter, and the bridge-shim protocol. Built against the hand-written
 * fixture project in milestones 1-2 (see docs/build-plan-v1.md).
 *
 * EVERY RELATIVE SPECIFIER BELOW CARRIES ITS `.ts` EXTENSION, and that is
 * load-bearing rather than tidy (fix round B, found by running `npm run check`
 * end to end). This file is the package ENTRY POINT — `package.json`'s `main` —
 * so it is what a cross-package consumer loads, and both packages are
 * `"type": "module"`. Under Node's ESM resolver an extensionless relative
 * specifier is NOT searched for candidate extensions, so `export { deriveTokens }
 * from "./derive-tokens"` threw `ERR_MODULE_NOT_FOUND` the moment anything
 * outside `compiler/` imported this module: round A pointed
 * `editor/e2e/prepare-project.ts` at `@sitewright/compiler`, and the
 * editor's Playwright `webServer` then failed to start at all.
 *
 * It went unnoticed because nothing here is exercised by Node until then: vitest
 * and Vite both resolve extensionless specifiers, `tsc` only type-checks, and
 * this package's other Node entry points (`scripts/gates.ts`, `scripts/preview.ts`)
 * reach the same modules through specifiers that already carry `.ts`.
 * `node-loadable.test.ts` cannot see it either — it checks that a file can be
 * STRIPPED, not that its imports RESOLVE — which is why `import type` lines
 * elsewhere survive without extensions (they are erased before any resolution
 * happens) and why a value export like the ones below does not.
 */
export const COMPILER_PACKAGE = "@sitewright/compiler";

export { deriveTokens } from "./derive-tokens.ts";
export type { DeriveTokensResult, TailwindTheme } from "./derive-tokens.ts";

export { ExportError, exportProject } from "./exporter.ts";
// Re-exported so callers outside `compiler/` stop hand-rolling it. The
// whole-branch review found a NINTH copy of the `rmdirSync`-on-a-symlink defect
// in `editor/e2e/prepare-project.ts`, outside the reach of the Python-only
// portability guard: `rmdirSync` removes a Windows junction but is `ENOTDIR` on
// a POSIX symlink, so a contributor on Linux or macOS could not run the e2e
// setup twice. This helper already branches on `lstatSync` and is tested.
export { removeDirectoryLink, linkDirectory } from "./exporter.ts";
export type { ExportOptions, ExportResult, OverrideEntry } from "./exporter.ts";

export { PROPERTY_UTILITIES, STYLE_PROPERTIES, isSupportedStyleProperty } from "./style-properties.ts";
export type { UtilitySpec } from "./style-properties.ts";

export { runGates } from "./gates.ts";
export type { GateFailure, GateReport, GateResult, RegenGateContext, RunGatesOptions } from "./gates.ts";

export { EDITABLE_CHANNELS, commit, createManifest, propose, replaceSection, tombstone } from "./manifest.ts";
export type { ReplaceSectionResult } from "./manifest.ts";
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
} from "./manifest.ts";