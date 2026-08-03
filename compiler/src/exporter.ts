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
import type { CallExpression, Expression, JsxOpeningElement, JsxSelfClosingElement, ObjectLiteralExpression, PropertyAccessExpression, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
// Runtime imports carry explicit .ts extensions: scripts/ run this module
// through Node's native type-stripping, which resolves ESM paths literally.
import { isInsideMapCallback, resolveTemplateExpression } from "./gates.ts";
import type { GateReport } from "./gates.ts";
import { runGates } from "./gates.ts";
import { collectHandoverData, renderHandover } from "./handover.ts";
import type { Manifest, ManifestNode } from "./manifest.ts";
import { tombstone as tombstoneNodes } from "./manifest.ts";
import { PROPERTY_UTILITIES } from "./style-properties.ts";
import { isTokenReference } from "./style-value.ts";
import { createZip } from "./zip.ts";

export interface OverrideEntry {
  nodeId: string;
  channel: "text" | "style" | "layout" | "visibility" | "sectionOrder";
  value: unknown;
  /**
   * Which prop of the node the text override rewrites. Absent means the
   * node's single text-bearing child (`<Heading>{headline}</Heading>`), which
   * is every ordinary copy edit.
   *
   * Image replace (PRD 3.5) is deliberately NOT a new channel: it is this
   * channel with `key: "src"` — "content, not style" — so an image swap
   * compiles through the same mock-data rewrite as any other content edit,
   * and needs no new compilation path, no new gate, and no new override kind.
   * An Image is self-closing and has no text child, so the key is what tells
   * the exporter to resolve the field from the `src` ATTRIBUTE instead.
   */
  key?: string;
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
  /** When set, writes the handover zip here (outside outDir). */
  zipPath?: string;
}

export interface ExportResult {
  outDir: string;
  appliedOverrides: number;
  tombstoned: string[];
  /** Every packaged file, repo-relative with forward slashes, sorted — the editor's file-tree preview. */
  files: string[];
  /** Rendered HANDOVER.md content (also written into outDir). */
  handover: string;
  /** Set when options.zipPath was provided. */
  zipPath?: string;
  /** Handler seams the developer must wire up (HANDOVER.md section 2). */
  integrationCount: number;
  /** Edits that compiled to arbitrary-value classes (HANDOVER.md section 3). */
  offScaleCount: number;
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

/**
 * Never copied into the export:
 * - node_modules/dist — regenerable (`npm install && npm run build`), and
 *   shipping them would make the package huge and non-deterministic.
 * - overrides/ — consumed by compilation; archived separately (see below).
 * - plan/ — generator state (the brief, the site plan, an approval flag).
 *   It describes what was ASKED FOR, not the code being handed over, and
 *   reads as build-system residue to a receiving developer.
 * - .regen-backup — a mid-session regeneration snapshot, never part of a
 *   handover.
 *
 * manifest.json and design-inventory.json DO ship: both describe the code in
 * the package (the node registry and the primitive set), and the manifest is
 * what makes the export re-importable into the editor (PRD 6).
 */
const COPY_SKIP = new Set(["node_modules", "dist", "overrides", ".git", ".regen-backup", "plan"]);

/** Build artifacts the verification build creates INSIDE the export; never packaged. */
const PACKAGE_SKIP = new Set(["node_modules", "dist"]);

/**
 * Where the applied override files land inside the export. Contract 7:
 * "post-export, override files are archived, not deleted, so the user can
 * trace what changed" — the SOURCE project keeps its own overrides/
 * untouched (export never writes in place), so the pre-export state stays
 * fully editable and re-exportable (PRD 5).
 */
const OVERRIDE_ARCHIVE_DIR = "overrides-archive";


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
  const routedSlugs = routeSlugsOf(projectRoot);
  cpSync(projectRoot, outDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(projectRoot, src);
      if (rel === "") return true;
      if (COPY_SKIP.has(rel.split(sep)[0]!)) return false;
      return !isOrphanPage(rel, routedSlugs);
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

    // Manifest is re-read from the output: applyOverrides may have
    // tombstoned nodes there, and the handover's node count should describe
    // the package the developer receives, not the pre-compilation project.
    const exportedManifest = readManifest(outDir);
    const handoverData = collectHandoverData(outDir, exportedManifest, overrides);
    const handover = renderHandover(handoverData);
    writeFileSync(join(outDir, "HANDOVER.md"), handover);
    archiveOverrides(projectRoot, outDir);

    if (options.skipBuild !== true) {
      runVerificationBuild(projectRoot, outDir);
    }

    const files = packagedFiles(outDir);
    let zipPath: string | undefined;
    if (options.zipPath !== undefined) {
      zipPath = resolve(options.zipPath);
      if (zipPath === outDir || zipPath.startsWith(outDir + sep)) {
        throw new ExportError("Zip target must be outside the export directory.");
      }
      mkdirSync(dirname(zipPath), { recursive: true });
      writeFileSync(
        zipPath,
        createZip(files.map((file) => ({ path: file, content: readFileSync(join(outDir, file)) }))),
      );
    }

    return {
      outDir,
      appliedOverrides: overrides.length,
      tombstoned,
      files,
      handover,
      ...(zipPath === undefined ? {} : { zipPath }),
      integrationCount: handoverData.integrations.length,
      offScaleCount: handoverData.offScale.length,
    };
  } catch (error) {
    removeOutput(outDir);
    throw error;
  }
}

/** Copies the applied override files into the export as a read-only record (contract 7). */
function archiveOverrides(projectRoot: string, outDir: string): void {
  const overridesDir = join(projectRoot, "overrides");
  if (!existsSync(overridesDir)) return;
  // Only files that actually carry edits: a route the user never touched has
  // an empty overrides array, and archiving those would put a directory of
  // empty records in every handover package that had nothing to record.
  const files = readdirSync(overridesDir)
    .filter((name) => name.endsWith(".overrides.json"))
    .filter((name) => {
      const parsed = JSON.parse(readFileSync(join(overridesDir, name), "utf8")) as {
        overrides?: unknown[];
      };
      return (parsed.overrides?.length ?? 0) > 0;
    })
    .sort();
  if (files.length === 0) return;
  const archiveDir = join(outDir, OVERRIDE_ARCHIVE_DIR);
  mkdirSync(archiveDir, { recursive: true });
  for (const name of files) {
    cpSync(join(overridesDir, name), join(archiveDir, name));
  }
  writeFileSync(
    join(archiveDir, "README.md"),
    "# Applied overrides (archive)\n\n" +
      "These are the canvas edits that were compiled into the source of this export.\n" +
      "They are a record for tracing what changed — the code in `src/` already\n" +
      "reflects every one of them, and nothing reads these files at runtime.\n",
  );
}

/** Every file that goes into the handover package, repo-relative, forward slashes, sorted. */
/**
 * Route slugs from the project's own routes.ts — the ground-truth route table
 * (contract section 2). Returns undefined if it cannot be read, which means
 * "do not filter": dropping files on a parse failure would be far worse than
 * shipping one extra directory.
 */
function routeSlugsOf(projectRoot: string): Set<string> | undefined {
  const routesPath = join(projectRoot, "src", "shell", "routes.ts");
  if (!existsSync(routesPath)) return undefined;
  const source = readFileSync(routesPath, "utf8");
  const slugs = new Set([...source.matchAll(/slug:\s*"([^"]+)"/g)].map((match) => match[1]!));
  return slugs.size > 0 ? slugs : undefined;
}

/**
 * A page directory with no route pointing at it — unreachable code in a
 * deliverable.
 *
 * The case that surfaced this: the Design System Agent writes a dev-only
 * primitive gallery to src/pages/home/index.tsx so there is something to look
 * at while no sections exist yet (5.2). When the plan turns out to have no
 * `home` route, nothing ever cleans it up, and the handover zip ships an
 * unreachable page importing every primitive. Filtering on routes.ts rather
 * than special-casing the gallery catches any orphan, whatever produced it.
 */
function isOrphanPage(rel: string, routedSlugs: Set<string> | undefined): boolean {
  if (routedSlugs === undefined) return false;
  const parts = rel.split(sep);
  if (parts.length < 3 || parts[0] !== "src" || parts[1] !== "pages") return false;
  return !routedSlugs.has(parts[2]!);
}

/**
 * The MOCK-DATA array behind whatever a section maps over.
 *
 * `items.map(...)` names the prop directly, but a section may derive the list
 * first — `const visibleFields = fields.filter((f) => f.hidden !== true)` and
 * then `visibleFields.map(...)`. That is behaviourally identical to the
 * `if (item.hidden) return null` form the templates teach, and it is what a
 * model reasonably writes; but it left the compiler looking for a
 * `visibleFields` array in mock data that only exports `fields`, so ANY
 * list-item override on such a section failed the export outright.
 *
 * So: follow the derivation to its source. Through a chained call
 * (`fields.filter(...)`, `.slice(...)`) take the receiver; through a local
 * `const` take its initializer; stop at the first identifier that is not a
 * local const, which is the destructured prop backing the mock data. Bounded
 * hop count so a circular or pathological chain terminates rather than hangs,
 * and `undefined` on anything unrecognised — the caller then skips this node
 * rather than guessing at an array name.
 */
function resolveDataArrayName(expression: Node): string | undefined {
  let current: Node | undefined = expression;
  for (let hops = 0; current !== undefined && hops < 8; hops += 1) {
    if (Node.isCallExpression(current)) {
      const access: PropertyAccessExpression | undefined = current
        .getExpression()
        .asKind(SyntaxKind.PropertyAccessExpression);
      if (access === undefined) return undefined;
      current = access.getExpression();
      continue;
    }
    if (Node.isIdentifier(current)) {
      const name: string = current.getText();
      // A local `const x = ...` in the same component; a destructured prop has
      // no VariableDeclaration and so ends the walk here, which is the answer.
      const declaration: VariableDeclaration | undefined = current
        .getFirstAncestor((ancestor: Node): boolean => Node.isFunctionDeclaration(ancestor) || Node.isArrowFunction(ancestor))
        ?.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
        .find((variable) => variable.getName() === name);
      const initializer: Expression | undefined = declaration?.getInitializer();
      if (initializer === undefined) return name;
      current = initializer;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function packagedFiles(outDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (prefix === "" && PACKAGE_SKIP.has(entry.name)) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), relPath);
      else if (entry.isFile()) found.push(relPath);
    }
  };
  walk(outDir, "");
  return found.sort();
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

/**
 * A page-level reorder (PRD 3.3). Deliberately strict: a partial or unknown
 * list would silently drop a section from the exported page, which is the
 * kind of silent content loss this project's whole override design exists to
 * prevent — so it names exactly what is wrong instead.
 */
function validateSectionOrder(override: OverrideEntry, manifest: Manifest): void {
  const route = override.nodeId;
  if (!Array.isArray(override.value) || override.value.some((id) => typeof id !== "string")) {
    throw new ExportError(`sectionOrder for route "${route}" must be an array of section ids.`);
  }
  const order = override.value as string[];

  const sectionsOnRoute = new Set(
    Object.entries(manifest.nodes)
      .filter(([id, node]) => node.status === "active" && id.split(".").length === 2 && id.startsWith(`${route}.`))
      .map(([id]) => id),
  );

  const unknown = order.filter((id) => !sectionsOnRoute.has(id));
  if (unknown.length > 0) {
    throw new ExportError(
      `sectionOrder for route "${route}" names ${unknown.map((id) => `"${id}"`).join(", ")}, ` +
        `which ${unknown.length === 1 ? "is not an active section" : "are not active sections"} on that route.`,
    );
  }
  if (new Set(order).size !== order.length) {
    throw new ExportError(`sectionOrder for route "${route}" lists the same section more than once.`);
  }
  const missing = [...sectionsOnRoute].filter((id) => !order.includes(id)).sort();
  if (missing.length > 0) {
    throw new ExportError(
      `sectionOrder for route "${route}" omits ${missing.map((id) => `"${id}"`).join(", ")}; ` +
        "a reorder must list every section on the route, or the omitted ones would vanish from the export.",
    );
  }
}

function validateOverrides(overrides: OverrideEntry[], manifest: Manifest): void {
  for (const override of overrides) {
    // sectionOrder is the one PAGE-level override (PRD 3.3): it reorders a
    // route's sections in its index.tsx, so its "nodeId" is a route slug and
    // there is deliberately no manifest node to look up. Its value is a list
    // of section-root ids, each of which IS a node and is checked as such.
    if (override.channel === "sectionOrder") {
      validateSectionOrder(override, manifest);
      continue;
    }
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
    const removedFromSource = removeElement(project, outDir, override.nodeId, manifest.nodes[override.nodeId]!, changed);
    if (removedFromSource) tombstoned.push(override.nodeId);
  }
  // Last: reordering rewrites the page's index.tsx wholesale, so it must run
  // after any visibility removal has already taken its section out.
  for (const override of byChannel("sectionOrder")) {
    applySectionOrder(project, outDir, override.nodeId, override.value as string[], changed);
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

/*
 * ---------- list-item overrides (contract 5.2 + the per-item override-slot
 * convention, docs/codegen-contract-v1.md section 5.2) ----------
 *
 * A list item's node id only exists as a template-literal pattern inside a
 * `.map()` callback — there is no literal JSX element per rendered instance,
 * since one `.map()` body renders every item. findAttachedElement (literal
 * match only) can never resolve one. Overrides on a list-item node instead
 * compile into that ONE item's own mock-data array element:
 *
 *   text                -> rewrite the matching field directly (same
 *                           "content flows through props" model as a
 *                           section-level text override, contract 4.3)
 *   visibility           -> set `hidden: true` (item root) or
 *                           `childHidden: { "<suffix>": true }` (a child)
 *   style / layout        -> merge a compiled utility class into
 *                           `className` (item root) or
 *                           `childClassNames: { "<suffix>": "..." }` (a child)
 *
 * The section component must read these fields back (className/hidden on
 * the item's own root, childClassNames/childHidden indexed by each child's
 * id suffix) — the convention every list-based archetype template teaches.
 */

interface ListItemContext {
  /** The array element's own stable key value (e.g. "growth"). */
  key: string;
  /** The suffix after the item's own id (e.g. "name"), or undefined when the override targets the item's own root. */
  childSuffix: string | undefined;
  /** The destructured prop holding the array (e.g. "tiers"). */
  arrayPropName: string;
  /** The field on each item used as its stable key (e.g. "key"). */
  keyPropName: string;
}

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Prefix-capturing counterpart to gates.ts's exact-match templateToPattern:
 * matches only as far as the item-id template's own shape reaches (the
 * first substitution — a reference to the section's own nodeId — stays
 * unrestricted `.+`; the item's own key substitution is captured and
 * restricted to `[^.]+`, contract 5.2's dot-boundary rule), leaving any
 * remainder (a child's ".suffix") for the caller to interpret.
 */
function templateToPrefixPattern(template: import("ts-morph").TemplateExpression): RegExp {
  const headText = template.getHead().getLiteralText().replace(REGEX_SPECIAL_CHARS, "\\$&");
  const spans = template.getTemplateSpans();
  let pattern = headText;
  spans.forEach((span, index) => {
    const literal = span.getLiteral().getLiteralText().replace(REGEX_SPECIAL_CHARS, "\\$&");
    pattern += (index === 0 ? "(?:.+)" : "([^.]+)") + literal;
  });
  return new RegExp(`^${pattern}`);
}

/** Walks up to the nearest enclosing `X.map(...)` call, mirroring gates.ts's isInsideMapCallback but returning the call itself. */
function findEnclosingMapCall(node: Node): CallExpression | undefined {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (current.isKind(SyntaxKind.ArrowFunction) || current.isKind(SyntaxKind.FunctionExpression)) {
      const parent = current.getParent();
      if (parent?.isKind(SyntaxKind.CallExpression)) {
        const callee = parent.getExpression();
        if (callee.isKind(SyntaxKind.PropertyAccessExpression) && callee.getName() === "map") {
          return parent;
        }
      }
    }
    current = current.getParent();
  }
  return undefined;
}

/**
 * Resolves a list-item node id to the array/key/child-suffix it was derived
 * from. Only recognizes the shape every archetype template teaches (contract
 * 5.2's canonical example): a local `const itemId = `${nodeId}.slug-${item.key}``
 * declared inside a `.map()` callback, referenced directly on the item's own
 * root (`nodeId={itemId}`) and via further template literals on its children
 * (`` nodeId={`${itemId}.suffix`} ``).
 */
function resolveListItemContext(project: Project, nodeId: string): ListItemContext | undefined {
  for (const sourceFile of project.getSourceFiles()) {
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const template = declaration.getInitializer()?.asKind(SyntaxKind.TemplateExpression);
      if (template === undefined || !isInsideMapCallback(declaration)) continue;
      const spans = template.getTemplateSpans();
      if (spans.length !== 2) continue;
      const keyAccess = spans[1]!.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
      if (keyAccess === undefined) continue;

      const mapCall = findEnclosingMapCall(declaration);
      if (mapCall === undefined) continue;
      const callee = mapCall.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
      const mapped = callee?.getExpression();
      const arrayPropName = mapped === undefined ? undefined : resolveDataArrayName(mapped);
      if (arrayPropName === undefined) continue;

      const prefixPattern = templateToPrefixPattern(template);
      const match = prefixPattern.exec(nodeId);
      if (match === null) continue;

      const matchedLength = match[0]!.length;
      const remainder = nodeId.slice(matchedLength);
      if (remainder !== "" && !remainder.startsWith(".")) continue;

      return {
        key: match[1]!,
        childSuffix: remainder === "" ? undefined : remainder.slice(1),
        arrayPropName,
        keyPropName: keyAccess.getName(),
      };
    }
  }
  return undefined;
}

/** Locates the ONE mock-data array element matching a resolved list-item context. */
function findMockArrayElement(
  project: Project,
  outDir: string,
  node: ManifestNode,
  context: ListItemContext,
): { element: ObjectLiteralExpression; mockFile: SourceFile } {
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
  const array = dataObject
    .getProperty(context.arrayPropName)
    ?.asKind(SyntaxKind.PropertyAssignment)
    ?.getInitializer()
    ?.asKind(SyntaxKind.ArrayLiteralExpression);
  if (array === undefined) {
    throw new ExportError(`Mock array "${context.arrayPropName}" not found in ${mockPath}.`);
  }
  for (const element of array.getElements()) {
    const object = element.asKind(SyntaxKind.ObjectLiteralExpression);
    const keyLiteral = object
      ?.getProperty(context.keyPropName)
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.asKind(SyntaxKind.StringLiteral);
    if (keyLiteral?.getLiteralValue() === context.key) {
      return { element: object!, mockFile };
    }
  }
  throw new ExportError(
    `No item with ${context.keyPropName}="${context.key}" found in mock array "${context.arrayPropName}" (${mockPath}).`,
  );
}

/** Finds a direct property on an object literal by its exact source name (handles quoted keys like `"one-click-import"`, which ts-morph's own getProperty does not match against a plain-string argument). */
function findProperty(
  object: ObjectLiteralExpression,
  name: string,
): import("ts-morph").PropertyAssignment | undefined {
  return object
    .getProperties()
    .find(
      (property): property is import("ts-morph").PropertyAssignment =>
        property.isKind(SyntaxKind.PropertyAssignment) && property.getName() === name,
    );
}

/** Gets the nested object-literal value of a property, creating an empty one if the property is absent. */
function getOrCreateNestedObject(object: ObjectLiteralExpression, groupName: string): ObjectLiteralExpression {
  const existing = findProperty(object, groupName)?.getInitializer()?.asKind(SyntaxKind.ObjectLiteralExpression);
  if (existing !== undefined) return existing;
  const added = object.addPropertyAssignment({ name: groupName, initializer: "{}" });
  return added.getInitializerOrThrow().asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
}

/** Sets (or inserts) a plain property on an object literal to a boolean literal. */
function setBooleanProperty(object: ObjectLiteralExpression, name: string, value: boolean): void {
  const existing = findProperty(object, name);
  if (existing !== undefined) existing.setInitializer(String(value));
  else object.addPropertyAssignment({ name, initializer: String(value) });
}

/** Merges compiled utility classes into a string-literal property (creating it if absent), replacing same-category utilities — the mock-data analogue of mergeClassName for a literal JSX attribute. */
function mergeIntoStringProperty(object: ObjectLiteralExpression, propertyName: string, newClasses: string[]): void {
  const existing = findProperty(object, propertyName);
  const existingLiteral = existing?.getInitializer()?.asKind(SyntaxKind.StringLiteral);
  let kept = (existingLiteral?.getLiteralValue() ?? "").split(/\s+/).filter((cls) => cls.length > 0);
  for (const cls of newClasses) {
    kept = kept.filter((current) => !conflictsWith(current, cls));
    kept.push(cls);
  }
  const value = kept.join(" ");
  if (existingLiteral !== undefined) existingLiteral.setLiteralValue(value);
  else object.addPropertyAssignment({ name: propertyName, initializer: JSON.stringify(value) });
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
): JsxOpeningElement | JsxSelfClosingElement | undefined {
  const attached = findAttachedElement(project, nodeId);
  if (attached === undefined) return undefined;
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

function applyListItemTextOverride(
  project: Project,
  outDir: string,
  override: OverrideEntry,
  node: ManifestNode,
  context: ListItemContext,
  changed: Set<SourceFile>,
): void {
  if (context.childSuffix === undefined) {
    throw new ExportError(
      `Text override on "${override.nodeId}" targets a list item's own root; text overrides need a child field to rewrite.`,
    );
  }
  const { element, mockFile } = findMockArrayElement(project, outDir, node, context);
  const leaf = element
    .getProperty(context.childSuffix)
    ?.asKind(SyntaxKind.PropertyAssignment)
    ?.getInitializer()
    ?.asKind(SyntaxKind.StringLiteral);
  if (leaf === undefined) {
    throw new ExportError(
      `Mock field "${context.childSuffix}" for node "${override.nodeId}" is not a string literal; text overrides rewrite string literals only.`,
    );
  }
  leaf.setLiteralValue(override.value as string);
  changed.add(mockFile);
}

/**
 * The expression bound to a named JSX attribute, e.g. `src={product.imageSrc}`
 * -> the `product.imageSrc` node. Used by keyed text overrides (image replace,
 * PRD 3.5) to find which mock-data field feeds an attribute.
 */
function attributeExpression(
  element: JsxOpeningElement | JsxSelfClosingElement,
  name: string,
): import("ts-morph").Node | undefined {
  for (const attribute of element.getAttributes()) {
    const jsxAttribute = attribute.asKind(SyntaxKind.JsxAttribute);
    if (jsxAttribute === undefined) continue;
    if (jsxAttribute.getNameNode().getText() !== name) continue;
    return jsxAttribute.getInitializer()?.asKind(SyntaxKind.JsxExpression)?.getExpression();
  }
  return undefined;
}

/**
 * Page-level reorder (PRD 3.3): "Reordering sections within a page is P1 and
 * is expressed as an index.tsx-level override (`sectionOrder` array in the
 * route's override file), NOT a DOM operation."
 *
 * So this reorders the JSX children of the page's returned fragment, matching
 * each child to a section id by its literal `nodeId` attribute. Anything
 * without one — a FailedSectionPlaceholder, which deliberately carries no id
 * (pipeline 5.4) — keeps its position relative to the sections around it
 * rather than being dropped or shuffled to an end.
 */
function applySectionOrder(
  project: Project,
  outDir: string,
  routeSlug: string,
  order: string[],
  changed: Set<SourceFile>,
): void {
  const indexPath = join(outDir, "src", "pages", routeSlug, "index.tsx").replace(/\\/g, "/");
  const indexFile = project.getSourceFile(indexPath);
  if (indexFile === undefined) {
    throw new ExportError(`Cannot reorder route "${routeSlug}": ${indexPath} not found.`);
  }

  // The sections' actual PARENT, not "the fragment". A marketing page returns a
  // bare fragment, but a page archetype may wrap its sections in a layout
  // element — an app screen puts them in a flex row so its panes sit side by
  // side instead of stacking. Both are lists of sections; only the container
  // differs. Locating the parent by looking for a section rather than assuming
  // the shape also matches what the shim does at runtime (it takes the
  // parentElement of the first section), so preview and export agree on which
  // element they are reordering.
  // Anchor on the ATTRIBUTE, not on "a node whose text contains the id":
  // getDescendants() is document order, so every ancestor's text contains the
  // id too and the outermost element matches first.
  const attribute = indexFile
    .getDescendantsOfKind(SyntaxKind.JsxAttribute)
    .find(
      (attr) =>
        attr.getNameNode().getText() === "nodeId" &&
        attr.getInitializer()?.getText() === `"${order[0]!}"`,
    );
  const sectionElement =
    attribute?.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement) ??
    attribute?.getFirstAncestorByKind(SyntaxKind.JsxElement);
  const container = sectionElement?.getParent();
  if (
    container === undefined ||
    (container.getKind() !== SyntaxKind.JsxFragment && container.getKind() !== SyntaxKind.JsxElement)
  ) {
    throw new ExportError(
      `Cannot reorder route "${routeSlug}": its page renders a single element, not a list of sections.`,
    );
  }
  const fragment = container as unknown as { getJsxChildren: () => Node[]; replaceWithText: (t: string) => void };

  const children = fragment
    .getJsxChildren()
    .filter((child) => child.getText().trim() !== "");
  const idOf = (text: string): string | undefined =>
    /nodeId="([^"]+)"/.exec(text)?.[1];

  const sectionChildren = children.filter((child) => idOf(child.getText()) !== undefined);
  const byId = new Map(sectionChildren.map((child) => [idOf(child.getText())!, child.getText()]));

  // Walk the original slots, replacing each section slot with the next id in
  // the requested order and leaving id-less children (placeholders) untouched.
  let next = 0;
  const rewritten = children.map((child) => {
    if (idOf(child.getText()) === undefined) return child.getText();
    const id = order[next];
    next += 1;
    const replacement = id === undefined ? undefined : byId.get(id);
    if (replacement === undefined) {
      throw new ExportError(
        `Cannot reorder route "${routeSlug}": no rendered section carries nodeId "${String(id)}".`,
      );
    }
    return replacement;
  });

  // Rebuild the container with its OWN opening and closing tags preserved: a
  // page archetype's layout wrapper carries the classNames that arrange the
  // sections, so emitting a bare fragment here would reorder them correctly and
  // silently strip the layout that positions them.
  const containerText = container.getText();
  const openTag =
    container.getKind() === SyntaxKind.JsxFragment
      ? "<>"
      : containerText.slice(0, containerText.indexOf(">") + 1);
  const closeTag =
    container.getKind() === SyntaxKind.JsxFragment
      ? "</>"
      : containerText.slice(containerText.lastIndexOf("</"));
  const inner = rewritten.map((text) => text.trim()).join("\n      ");
  fragment.replaceWithText(`${openTag}\n      ${inner}\n    ${closeTag}`);
  changed.add(indexFile);
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
    const context = resolveListItemContext(project, override.nodeId);
    if (context !== undefined) {
      applyListItemTextOverride(project, outDir, override, node, context, changed);
      return;
    }
    throw new ExportError(`No element carries data-node-id "${override.nodeId}"; cannot apply text override.`);
  }

  const keyedExpression =
    override.key === undefined ? undefined : attributeExpression(attached, override.key);
  if (override.key !== undefined && keyedExpression === undefined) {
    throw new ExportError(
      `Node "${override.nodeId}" has no "${override.key}" attribute bound to a prop; ` +
        `a keyed text override rewrites the mock-data field feeding that attribute (PRD 3.5).`,
    );
  }

  let inner: import("ts-morph").Node | undefined;
  if (keyedExpression !== undefined) {
    inner = keyedExpression;
  } else {
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
    inner = expressions[0]!.asKindOrThrow(SyntaxKind.JsxExpression).getExpression();
  }
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

function applyListItemClassOverride(
  project: Project,
  outDir: string,
  override: OverrideEntry,
  node: ManifestNode,
  context: ListItemContext,
  tokenVars: Set<string>,
  changed: Set<SourceFile>,
): void {
  const { element, mockFile } = findMockArrayElement(project, outDir, node, context);
  // Trailing "!" (Tailwind v4's important modifier): a literal node's base
  // classes and override classes live in the SAME className string, so
  // mergeClassName can resolve conflicts by physically removing the old
  // same-category utility (compileUtilityClass alone is enough there). A
  // list item's base classes are hardcoded in the component's shared JSX —
  // one template, rendered for every item — so the exporter has no source
  // location to remove them FROM for just this one instance; the override
  // class ends up concatenated alongside the base class instead of replacing
  // it, and without a forced-important tiebreaker, Tailwind's stylesheet
  // order (not source order) decides the winner, same failure mode the live
  // shim's !important-injected override stylesheet exists to avoid.
  const compiled = Object.entries(override.value as Record<string, unknown>).map(
    ([property, rawValue]) => `${compileUtilityClass(override.nodeId, property, String(rawValue), tokenVars)}!`,
  );

  if (context.childSuffix === undefined) {
    mergeIntoStringProperty(element, "className", compiled);
  } else {
    const group = getOrCreateNestedObject(element, "childClassNames");
    mergeIntoStringProperty(group, JSON.stringify(context.childSuffix), compiled);
  }
  changed.add(mockFile);
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
  if (target === undefined) {
    const context = resolveListItemContext(project, override.nodeId);
    if (context !== undefined) {
      applyListItemClassOverride(project, outDir, override, node, context, tokenVars, changed);
      return;
    }
    throw new ExportError(`No element carries data-node-id "${override.nodeId}"; cannot compile its override.`);
  }

  for (const [property, rawValue] of Object.entries(override.value as Record<string, unknown>)) {
    // Trailing "!" (Tailwind v4's important modifier), matching
    // applyListItemClassOverride below and the live shim's !important-injected
    // override stylesheet. mergeClassName removes any same-category utility
    // sitting in THIS element's own className string, which is sufficient
    // when the competing class was authored there too (e.g. a page template's
    // own default background on a section root) -- but a primitive component
    // (Heading, Button, Input, ...) can ALSO hardcode a same-category utility
    // in its own shared base classes, invisible to and unreachable by that
    // string surgery since it lives in a different file, applies to every
    // usage, and only ever appears once compiled. Without a forced-important
    // tiebreaker there, Tailwind's stylesheet order -- not source order --
    // decides the winner, which found a real preview/export mismatch on a
    // Heading's default text color (contract's preview = handover invariant):
    // the live shim always forces its override important, so preview showed
    // the override; the built export's generated CSS happened to place the
    // Heading's own default color rule after the override's, so the export
    // silently kept the default color instead.
    const compiled = `${compileUtilityClass(override.nodeId, property, String(rawValue), tokenVars)}!`;
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
  if (isTokenReference(value)) {
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

/** Category key for conflict detection: utility root, with text- split into size/color/keyword.
 *
 * Strips a trailing "!" (Tailwind's important modifier, appended by
 * applyClassOverride/applyListItemClassOverride) before deriving the root:
 * the bracket/paren-anchored form (`/^(.*?)-[([]/`) does not care either way,
 * since it only matches up to the FIRST "(" or "[", but the keyword fallback
 * (`-[a-z0-9]+$`) anchors on the END of the string, and an un-stripped "!"
 * sits after that anchor and defeats the match entirely — so a keyword
 * utility (alignSelf/justifySelf/textAlign; every other PROPERTY_UTILITIES
 * entry compiles to a `-(` or `-[` form the bracket-anchored branch already
 * handles) would return itself, whole, as a category no other class can ever
 * equal, and mergeClassName would stop detecting it as a conflict — leaving
 * an old and a new same-category utility sitting side by side in export
 * source, e.g. `text-center text-left!`. Rendering still resolves correctly
 * (the "!" wins), so this was invisible to the pixel-diff invariant suite;
 * it only costs handover source cleanliness, which is why it's worth fixing
 * rather than leaving as a rendering-harmless wart. */
function utilityCategory(cls: string): string {
  const bare = cls.endsWith("!") ? cls.slice(0, -1) : cls;
  const rootMatch = /^(.*?)-[([]/.exec(bare);
  const root = rootMatch !== null ? rootMatch[1]! : bare.replace(/-[a-z0-9]+$/, "");
  if (root === "text") {
    if (/^text-\((?:length:)/.test(bare) || /^text-\[\d/.test(bare)) return "text:size";
    if (/^text-(?:\(|\[)/.test(bare)) return "text:color";
    return "text:keyword";
  }
  return root;
}

/** Hides one item (or one of its children) via mock data — the item's own JSX template still renders every OTHER item, so nothing is removed from source (and nothing needs tombstoning: the id's pattern-based attachment is untouched, only its current data is). */
function applyListItemVisibilityOverride(
  project: Project,
  outDir: string,
  node: ManifestNode,
  context: ListItemContext,
  changed: Set<SourceFile>,
): void {
  const { element, mockFile } = findMockArrayElement(project, outDir, node, context);
  if (context.childSuffix === undefined) {
    setBooleanProperty(element, "hidden", true);
  } else {
    const group = getOrCreateNestedObject(element, "childHidden");
    setBooleanProperty(group, JSON.stringify(context.childSuffix), true);
  }
  changed.add(mockFile);
}

/** Returns true when the manifest entry should be tombstoned (a literal element was actually removed from source); false for a list-item data-only hide. */
function removeElement(
  project: Project,
  outDir: string,
  nodeId: string,
  node: ManifestNode,
  changed: Set<SourceFile>,
): boolean {
  const attached = findAttachedElement(project, nodeId);
  if (attached === undefined) {
    const context = resolveListItemContext(project, nodeId);
    if (context !== undefined) {
      applyListItemVisibilityOverride(project, outDir, node, context, changed);
      return false;
    }
    throw new ExportError(`No element carries data-node-id "${nodeId}"; cannot apply visibility override.`);
  }
  const jsxNode = attached.isKind(SyntaxKind.JsxOpeningElement)
    ? attached.getFirstAncestorByKind(SyntaxKind.JsxElement)!
    : attached;
  changed.add(jsxNode.getSourceFile());
  jsxNode.replaceWithText("");
  return true;
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
