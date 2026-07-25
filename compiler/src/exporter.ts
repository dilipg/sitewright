/**
 * Exporter core (contract sections 6-7): compiles override files into
 * source and verifies the result. Deterministic, no LLM in the loop.
 *
 * - text: rewrites mock-data literals via AST (never JSX, never regex)
 * - style/layout: token refs -> var() utility classes; free values ->
 *   arbitrary-value classes; merged into className last, with same-category
 *   utilities replaced (Tailwind resolves conflicts by stylesheet order,
 *   not class order, so naive append would not win)
 * - visibility: removes the element's JSX and tombstones its manifest entry
 * - verification: gates 1-6 + the project's own typecheck/production build
 *
 * Export writes to a new directory, never in place. Any failure removes
 * the output directory entirely — no partial exports (contract 7.4).
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { JsxOpeningElement, JsxSelfClosingElement, SourceFile } from "ts-morph";
import { Project, SyntaxKind, ts } from "ts-morph";
// Runtime imports carry explicit .ts extensions: scripts/ run this module
// through Node's native type-stripping, which resolves ESM paths literally.
import type { GateReport } from "./gates.ts";
import { runGates } from "./gates.ts";
import type { Manifest, ManifestNode } from "./manifest.ts";
import { tombstone as tombstoneNodes } from "./manifest.ts";

export interface OverrideEntry {
  nodeId: string;
  channel: "text" | "style" | "layout" | "visibility";
  value: unknown;
  updatedAt?: string;
}

interface OverrideFile {
  version: number;
  route: string;
  overrides: OverrideEntry[];
}

export interface ExportOptions {
  /** Must not exist yet; removed entirely if the export fails. */
  outDir: string;
  /** Skips the verification build (gates always run). Test/dev hook. */
  skipBuild?: boolean;
}

export interface ExportResult {
  outDir: string;
  appliedOverrides: number;
  tombstoned: string[];
}

export class ExportError extends Error {
  readonly gateReport?: GateReport;
  readonly buildLog?: string;

  // No parameter properties: Node runs scripts/ via native type-stripping,
  // which only supports erasable TypeScript syntax.
  constructor(message: string, gateReport?: GateReport, buildLog?: string) {
    super(message);
    this.name = "ExportError";
    this.gateReport = gateReport;
    this.buildLog = buildLog;
  }
}

const COPY_SKIP = new Set(["node_modules", "dist", "overrides", ".git"]);

/** style/layout property -> utility compilation spec. Unknown properties fail loudly. */
const PROPERTY_UTILITIES: Record<string, { prefix: string; hint?: string; keyword?: boolean }> = {
  background: { prefix: "bg" },
  backgroundColor: { prefix: "bg" },
  color: { prefix: "text" },
  fontSize: { prefix: "text", hint: "length" },
  fontWeight: { prefix: "font" },
  lineHeight: { prefix: "leading" },
  letterSpacing: { prefix: "tracking" },
  margin: { prefix: "m" },
  marginTop: { prefix: "mt" },
  marginRight: { prefix: "mr" },
  marginBottom: { prefix: "mb" },
  marginLeft: { prefix: "ml" },
  padding: { prefix: "p" },
  paddingTop: { prefix: "pt" },
  paddingRight: { prefix: "pr" },
  paddingBottom: { prefix: "pb" },
  paddingLeft: { prefix: "pl" },
  gap: { prefix: "gap" },
  width: { prefix: "w" },
  height: { prefix: "h" },
  maxWidth: { prefix: "max-w" },
  minWidth: { prefix: "min-w" },
  maxHeight: { prefix: "max-h" },
  minHeight: { prefix: "min-h" },
  borderRadius: { prefix: "rounded" },
  boxShadow: { prefix: "shadow" },
  alignSelf: { prefix: "self", keyword: true },
  justifySelf: { prefix: "justify-self", keyword: true },
  textAlign: { prefix: "text", keyword: true },
};

const TOKEN_PATH = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+$/;

export function exportProject(projectDir: string, options: ExportOptions): ExportResult {
  const projectRoot = resolve(projectDir);
  const outDir = resolve(options.outDir);

  if (existsSync(outDir)) {
    throw new ExportError(`Export target "${outDir}" already exists; export never writes in place.`);
  }
  if (outDir === projectRoot || outDir.startsWith(projectRoot + sep)) {
    throw new ExportError("Export target must be outside the source project directory.");
  }

  const overrides = loadOverrides(projectRoot);
  const manifest = readManifest(projectRoot);
  validateOverrides(overrides, manifest);

  mkdirSync(dirname(outDir), { recursive: true });
  cpSync(projectRoot, outDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(projectRoot, src);
      if (rel === "") return true;
      return !COPY_SKIP.has(rel.split(sep)[0]!);
    },
  });

  try {
    const tombstoned = applyOverrides(outDir, overrides, manifest);

    const gateReport = runGates(outDir);
    if (!gateReport.passed) {
      const failures = gateReport.gates
        .flatMap((gate) => gate.failures)
        .map((failure) => `- ${failure.message}`)
        .join("\n");
      throw new ExportError(`Export failed validation gates:\n${failures}`, gateReport);
    }

    if (options.skipBuild !== true) {
      runVerificationBuild(projectRoot, outDir);
    }

    return { outDir, appliedOverrides: overrides.length, tombstoned };
  } catch (error) {
    removeOutput(outDir);
    throw error;
  }
}

function loadOverrides(projectRoot: string): OverrideEntry[] {
  const overridesDir = join(projectRoot, "overrides");
  if (!existsSync(overridesDir)) return [];
  const entries: OverrideEntry[] = [];
  for (const name of readdirSync(overridesDir).sort()) {
    if (!name.endsWith(".overrides.json")) continue;
    const file = JSON.parse(readFileSync(join(overridesDir, name), "utf8")) as OverrideFile;
    entries.push(...file.overrides);
  }
  return entries;
}

function readManifest(projectRoot: string): Manifest {
  const manifestPath = join(projectRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new ExportError("manifest.json not found; the node registry is required for export (contract 5.4).");
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function validateOverrides(overrides: OverrideEntry[], manifest: Manifest): void {
  for (const override of overrides) {
    const node = manifest.nodes[override.nodeId];
    if (node === undefined || node.status !== "active") {
      throw new ExportError(
        `Override targets unknown or inactive node "${override.nodeId}"; only active manifest nodes are editable.`,
      );
    }
    if (override.channel === "text" && typeof override.value !== "string") {
      throw new ExportError(`Text override on "${override.nodeId}" must have a string value.`);
    }
    if (
      (override.channel === "style" || override.channel === "layout") &&
      (typeof override.value !== "object" || override.value === null)
    ) {
      throw new ExportError(`${override.channel} override on "${override.nodeId}" must have an object value.`);
    }
  }
}

function applyOverrides(outDir: string, overrides: OverrideEntry[], manifest: Manifest): string[] {
  if (overrides.length === 0) return [];

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  });
  project.addSourceFilesAtPaths(`${outDir.replace(/\\/g, "/")}/src/**/*.{ts,tsx}`);
  const tokenVars = readTokenVars(outDir);
  const changed = new Set<SourceFile>();
  const tombstoned: string[] = [];

  const byChannel = (channel: OverrideEntry["channel"]) =>
    overrides.filter((override) => override.channel === channel);

  for (const override of byChannel("text")) {
    applyTextOverride(project, outDir, override, manifest.nodes[override.nodeId]!, changed);
  }
  for (const override of [...byChannel("style"), ...byChannel("layout")]) {
    applyClassOverride(project, outDir, override, manifest.nodes[override.nodeId]!, tokenVars, changed);
  }
  for (const override of byChannel("visibility")) {
    if (override.value === false) continue;
    removeElement(project, override.nodeId, changed);
    tombstoned.push(override.nodeId);
  }

  for (const sourceFile of changed) sourceFile.saveSync();

  if (tombstoned.length > 0) {
    const nextManifest = tombstoneNodes(manifest, tombstoned);
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(nextManifest, null, 2)}\n`);
  }
  return tombstoned;
}

/** Finds the JSX element carrying the node ID as a literal nodeId/data-node-id attribute. */
function findAttachedElement(
  project: Project,
  nodeId: string,
): JsxOpeningElement | JsxSelfClosingElement | undefined {
  for (const sourceFile of project.getSourceFiles()) {
    for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      const name = attribute.getNameNode().getText();
      if (name !== "data-node-id" && name !== "nodeId") continue;
      const literal = attribute.getInitializer()?.asKind(SyntaxKind.StringLiteral);
      if (literal?.getLiteralValue() !== nodeId) continue;
      return (
        attribute.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement) ??
        attribute.getFirstAncestorByKind(SyntaxKind.JsxOpeningElement)
      );
    }
  }
  return undefined;
}

/**
 * Resolves the element whose className receives compiled classes. When the
 * manifest says the node is a native element ("section") but the literal
 * attachment is a component usage (<Hero nodeId="home.hero" />), the true
 * target is the element inside the section file carrying
 * data-node-id={expression}.
 */
function findClassTarget(
  project: Project,
  outDir: string,
  nodeId: string,
  node: ManifestNode,
): JsxOpeningElement | JsxSelfClosingElement {
  const attached = findAttachedElement(project, nodeId);
  if (attached === undefined) {
    throw new ExportError(`No element carries data-node-id "${nodeId}"; cannot compile its override.`);
  }
  const isComponentUsage = /^[A-Z]/.test(attached.getTagNameNode().getText());
  const isNativeNode = /^[a-z]/.test(node.element);
  if (!isComponentUsage || !isNativeNode) return attached;

  const sectionFile = project.getSourceFile(join(outDir, node.file).replace(/\\/g, "/"));
  if (sectionFile === undefined) {
    throw new ExportError(`Manifest file "${node.file}" for node "${nodeId}" not found in export.`);
  }
  for (const attribute of sectionFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (attribute.getNameNode().getText() !== "data-node-id") continue;
    if (attribute.getInitializer()?.isKind(SyntaxKind.JsxExpression) !== true) continue;
    return (
      attribute.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement) ??
      attribute.getFirstAncestorByKind(SyntaxKind.JsxOpeningElement)!
    );
  }
  throw new ExportError(`No data-node-id root element found in "${node.file}" for node "${nodeId}".`);
}

function applyTextOverride(
  project: Project,
  outDir: string,
  override: OverrideEntry,
  node: ManifestNode,
  changed: Set<SourceFile>,
): void {
  const attached = findAttachedElement(project, override.nodeId);
  if (attached === undefined) {
    throw new ExportError(`No element carries data-node-id "${override.nodeId}"; cannot apply text override.`);
  }

  const container = attached.isKind(SyntaxKind.JsxOpeningElement)
    ? attached.getFirstAncestorByKind(SyntaxKind.JsxElement)
    : undefined;
  if (container === undefined) {
    throw new ExportError(`Node "${override.nodeId}" has no JSX children; text overrides need a text-bearing child.`);
  }

  const expressions = container
    .getJsxChildren()
    .filter((child) => child.isKind(SyntaxKind.JsxExpression));
  if (expressions.length !== 1) {
    throw new ExportError(
      `Node "${override.nodeId}" has ${expressions.length} child expressions; expected exactly one text-bearing prop (contract 7.1).`,
    );
  }
  const inner = expressions[0]!.asKindOrThrow(SyntaxKind.JsxExpression).getExpression();
  const propPath = expressionToPath(inner?.getText() ?? "");
  if (propPath === undefined) {
    throw new ExportError(
      `Cannot map node "${override.nodeId}" to a mock-data field: child expression "${inner?.getText()}" is not a plain prop reference.`,
    );
  }

  const mockPath = join(outDir, dirname(node.file), "..", "mock", `${node.component}.data.ts`);
  const mockFile = project.getSourceFile(mockPath.replace(/\\/g, "/"));
  if (mockFile === undefined) {
    throw new ExportError(`Mock data file for "${node.component}" not found at ${mockPath}.`);
  }

  const dataObject = mockFile
    .getVariableDeclarations()
    .find((declaration) => declaration.getTypeNode()?.getText() === `${node.component}Props`)
    ?.getInitializer()
    ?.asKind(SyntaxKind.ObjectLiteralExpression);
  if (dataObject === undefined) {
    throw new ExportError(`No ${node.component}Props mock object found in ${mockPath}.`);
  }

  let current = dataObject;
  for (const segment of propPath.slice(0, -1)) {
    const next = current
      .getProperty(segment)
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.asKind(SyntaxKind.ObjectLiteralExpression);
    if (next === undefined) {
      throw new ExportError(`Mock field path "${propPath.join(".")}" not found for node "${override.nodeId}".`);
    }
    current = next;
  }
  const leaf = current
    .getProperty(propPath[propPath.length - 1]!)
    ?.asKind(SyntaxKind.PropertyAssignment)
    ?.getInitializer()
    ?.asKind(SyntaxKind.StringLiteral);
  if (leaf === undefined) {
    throw new ExportError(
      `Mock field "${propPath.join(".")}" for node "${override.nodeId}" is not a string literal; text overrides rewrite string literals only.`,
    );
  }
  leaf.setLiteralValue(override.value as string);
  changed.add(mockFile);
}

/** "headline" -> ["headline"]; "ctaPrimary.label" -> ["ctaPrimary", "label"]. */
function expressionToPath(text: string): string[] | undefined {
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(text)) return undefined;
  return text.split(".");
}

function applyClassOverride(
  project: Project,
  outDir: string,
  override: OverrideEntry,
  node: ManifestNode,
  tokenVars: Set<string>,
  changed: Set<SourceFile>,
): void {
  const target = findClassTarget(project, outDir, override.nodeId, node);

  for (const [property, rawValue] of Object.entries(override.value as Record<string, unknown>)) {
    const compiled = compileUtilityClass(override.nodeId, property, String(rawValue), tokenVars);
    mergeClassName(target, compiled);
  }
  changed.add(target.getSourceFile());
}

function compileUtilityClass(
  nodeId: string,
  property: string,
  value: string,
  tokenVars: Set<string>,
): string {
  const spec = PROPERTY_UTILITIES[property];
  if (spec === undefined) {
    throw new ExportError(
      `Style property "${property}" on node "${nodeId}" has no utility mapping; supported properties: ${Object.keys(PROPERTY_UTILITIES).join(", ")}.`,
    );
  }
  if (spec.keyword === true) {
    return /^[a-z-]+$/.test(value) ? `${spec.prefix}-${value}` : `${spec.prefix}-[${value}]`;
  }
  if (TOKEN_PATH.test(value)) {
    const varName = value.replace(/\./g, "-");
    if (!tokenVars.has(varName)) {
      throw new ExportError(
        `Override on "${nodeId}" references token "${value}", but no --${varName} exists in tokens.css.`,
      );
    }
    return spec.hint !== undefined
      ? `${spec.prefix}-(${spec.hint}:--${varName})`
      : `${spec.prefix}-(--${varName})`;
  }
  return `${spec.prefix}-[${value.replace(/\s+/g, "_")}]`;
}

/** Merges a compiled class into the element's className, last position, replacing same-category utilities. */
function mergeClassName(
  element: JsxOpeningElement | JsxSelfClosingElement,
  compiledClass: string,
): void {
  const attribute = element
    .getAttributes()
    .find(
      (attr) =>
        attr.isKind(SyntaxKind.JsxAttribute) && attr.getNameNode().getText() === "className",
    )
    ?.asKind(SyntaxKind.JsxAttribute);

  if (attribute === undefined) {
    element.addAttribute({ name: "className", initializer: `"${compiledClass}"` });
    return;
  }

  const literal = attribute.getInitializer()?.asKind(SyntaxKind.StringLiteral);
  if (literal === undefined) {
    throw new ExportError(
      `className on the element for compiled class "${compiledClass}" is not a string literal; cannot merge deterministically.`,
    );
  }
  const kept = literal
    .getLiteralValue()
    .split(/\s+/)
    .filter((cls) => cls.length > 0 && !conflictsWith(cls, compiledClass));
  literal.setLiteralValue([...kept, compiledClass].join(" "));
}

function conflictsWith(existing: string, incoming: string): boolean {
  return utilityCategory(existing) === utilityCategory(incoming);
}

/** Category key for conflict detection: utility root, with text- split into size/color/keyword. */
function utilityCategory(cls: string): string {
  const rootMatch = /^(.*?)-[([]/.exec(cls);
  const root = rootMatch !== null ? rootMatch[1]! : cls.replace(/-[a-z0-9]+$/, "");
  if (root === "text") {
    if (/^text-\((?:length:)/.test(cls) || /^text-\[\d/.test(cls)) return "text:size";
    if (/^text-(?:\(|\[)/.test(cls)) return "text:color";
    return "text:keyword";
  }
  return root;
}

function removeElement(project: Project, nodeId: string, changed: Set<SourceFile>): void {
  const attached = findAttachedElement(project, nodeId);
  if (attached === undefined) {
    throw new ExportError(`No element carries data-node-id "${nodeId}"; cannot apply visibility override.`);
  }
  const node = attached.isKind(SyntaxKind.JsxOpeningElement)
    ? attached.getFirstAncestorByKind(SyntaxKind.JsxElement)!
    : attached;
  changed.add(node.getSourceFile());
  node.replaceWithText("");
}

function readTokenVars(outDir: string): Set<string> {
  const tokensCssPath = join(outDir, "src", "tokens", "tokens.css");
  if (!existsSync(tokensCssPath)) return new Set();
  const vars = new Set<string>();
  for (const match of readFileSync(tokensCssPath, "utf8").matchAll(/--([A-Za-z0-9-]+):/g)) {
    vars.add(match[1]!);
  }
  return vars;
}

/** Runs the output project's own typecheck+build, borrowing source node_modules via a junction. */
function runVerificationBuild(projectRoot: string, outDir: string): void {
  const sourceModules = join(projectRoot, "node_modules");
  const outModules = join(outDir, "node_modules");
  let linked = false;
  if (!existsSync(outModules) && existsSync(sourceModules)) {
    symlinkSync(sourceModules, outModules, "junction");
    linked = true;
  }
  try {
    const result = spawnSync("npm run build", {
      cwd: outDir,
      shell: true,
      encoding: "utf8",
      timeout: 240_000,
    });
    if (result.status !== 0) {
      throw new ExportError(
        "Export verification build failed; export aborted (contract 7.4).",
        undefined,
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      );
    }
  } finally {
    if (linked) rmdirSync(outModules);
  }
}

function removeOutput(outDir: string): void {
  const outModules = join(outDir, "node_modules");
  if (existsSync(outModules)) {
    rmdirSync(outModules); // junction: removes the link, never the source tree
  }
  rmSync(outDir, { recursive: true, force: true });
}
