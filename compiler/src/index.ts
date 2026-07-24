/**
 * Compiler package: manifest service, token deriver, validation gates,
 * exporter, and the bridge-shim protocol. Built against the hand-written
 * fixture project in milestones 1-2 (see docs/build-plan-v1.md).
 */
export const COMPILER_PACKAGE = "@website-generator/compiler";

export { deriveTokens } from "./derive-tokens";
export type { DeriveTokensResult, TailwindTheme } from "./derive-tokens";