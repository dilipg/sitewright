/**
 * Validation gates 1-6 (contract section 8), run after every agent and
 * before export. Static analysis only — fast, no install, no build; the
 * exporter's verification build (contract 7.4) enforces "build passes".
 *
 * Failure messages are injected verbatim into gate-failure retry prompts
 * (pipeline 5.4): each names the offending value, file, and the rule.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Project, SyntaxKind, ts } from "ts-morph";
import type { Manifest, OwnershipMap } from "./manifest";

export interface GateFailure {
  gate: number;
  reason: string;
  message: string;
  file?: string;
  line?: number;
}

export interface GateResult {
  gate: number;
  name: string;
  passed: boolean;
  failures: GateFailure[];
}

export interface GateReport {
  projectDir: string;
  passed: boolean;
  gates: GateResult[];
}

export interface RegenGateContext {
  /** Node IDs carrying user overrides before this regeneration. */
  overriddenNodeIds: string[];
  /** IDs the regenerating agent declared as removed (orphanedOverrides). */
  declaredOrphans: string[];
}

export interface RunGatesOptions {
  ownershipMap?: OwnershipMap;
  /** Orchestrator-side write log per owner; boundary check is skipped without it. */
  writtenFiles?: Record<string, string[]>;
  /** Present only on regeneration runs; enables gate 7 (contract 5.3/8.7). */
  regen?: RegenGateContext;
  /** Restricts gate 4 to one route (build prompt 5.3 fan-out) — see gateNodeIdsRegistered's doc comment. */
  scopeRoute?: string;
  /**
   * Exempts section-ROOT node ids (exactly `<route>.<section>`, two dot
   * segments) from gate 4's "missing-node-id" direction (build prompt 5.3
   * fan-out): a root id is only ever literally attached via the page's
   * index.tsx (`<Hero nodeId="home.hero" />`) — inside the section's own
   * file the root carries `data-node-id={nodeId}`, a JSX EXPRESSION, never
   * a literal, by contract design (the id comes from the nodeId prop). A
   * section's own gate check runs BEFORE page assembly in fan-out, so
   * index.tsx does not exist yet and every root on the route (including
   * already-committed siblings) would always look "missing" regardless of
   * scoping. Child ids (3+ segments) are NOT exempted — their literal
   * `nodeId="..."` attachments (or contract-5.2 map-derived attachments,
   * see gateNodeIdsRegistered) live in the section file itself and must
   * already be correct within the section's own retry budget; letting them
   * slip through here would only surface a genuine defect too late, at
   * assembly time, with no retries left. "unregistered-node-id" and
   * "duplicate-node-id" stay fully enforced regardless. The deferred
   * whole-page/whole-project check (after assembly) always runs without
   * this flag.
   */
  skipMissingCheck?: boolean;
}

const GATE_NAMES: Record<number, string> = {
  1: "imports-resolve",
  2: "hrefs-valid",
  3: "tokens-only",
  4: "node-ids-registered",
  5: "content-via-props",
  6: "ownership-boundaries",
  7: "regen-id-survival",
};

const EXTERNAL_HREF = /^(?:https?:\/\/|mailto:|tel:|#)/;
const RAW_HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const RAW_PX = /\b\d+(?:\.\d+)?px\b/;
const RESOLVE_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", ".json", ".css"];

export function runGates(projectDir: string, options: RunGatesOptions = {}): GateReport {
  const root = resolve(projectDir);
  const codeFiles = walkFiles(join(root, "src"), [".ts", ".tsx"]);
  const styleScanFiles = walkFiles(join(root, "src"), [".ts", ".tsx", ".css"]);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true },
  });
  const sourceFiles = codeFiles.map((file) => project.addSourceFileAtPath(file));

  const failures: GateFailure[] = [
    ...gateImportsResolve(root, sourceFiles),
    ...gateHrefsValid(root, sourceFiles),
    ...gateTokensOnly(root, styleScanFiles),
    ...gateNodeIdsRegistered(root, sourceFiles, options.scopeRoute, options.skipMissingCheck),
    ...gateContentViaProps(root, sourceFiles),
    ...gateOwnership(root, sourceFiles, options),
    ...(options.regen !== undefined ? gateRegenIdSurvival(sourceFiles, options.regen) : []),
  ];

  const gateIds = options.regen !== undefined ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6];
  const gates: GateResult[] = gateIds.map((gate) => {
    const gateFailures = failures.filter((failure) => failure.gate === gate);
    return { gate, name: GATE_NAMES[gate]!, passed: gateFailures.length === 0, failures: gateFailures };
  });

  return { projectDir: root, passed: failures.length === 0, gates };
}

/**
 * Gate 7 (contract 5.3/8.7): on regeneration, every previously-overridden
 * node ID must either be attached in the output or declared in the agent's
 * orphanedOverrides — never silently dropped. A declared orphan that is
 * still attached is equally a failure: the editor would surface a false
 * orphan and the user would discard a live edit.
 */
function gateRegenIdSurvival(
  sourceFiles: import("ts-morph").SourceFile[],
  regen: RegenGateContext,
): GateFailure[] {
  const attached = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      const name = attribute.getNameNode().getText();
      if (name !== "data-node-id" && name !== "nodeId") continue;
      const literal = attribute.getInitializer()?.asKind(SyntaxKind.StringLiteral);
      if (literal !== undefined) attached.add(literal.getLiteralValue());
    }
  }

  const declared = new Set(regen.declaredOrphans);
  const failures: GateFailure[] = [];
  for (const nodeId of regen.overriddenNodeIds) {
    if (!attached.has(nodeId) && !declared.has(nodeId)) {
      failures.push({
        gate: 7,
        reason: "undeclared-orphan",
        message: `Previously-overridden node "${nodeId}" is missing from the regenerated output and was not declared in orphanedOverrides. Preserve the ID if the element still exists conceptually; if it was legitimately removed, declare it in orphanedOverrides (contract 5.3).`,
      });
    }
  }
  for (const nodeId of declared) {
    if (attached.has(nodeId)) {
      failures.push({
        gate: 7,
        reason: "false-orphan",
        message: `Node "${nodeId}" is declared in orphanedOverrides but is still attached in the output. Remove it from orphanedOverrides — a false orphan would make the user discard a live edit.`,
      });
    }
  }
  return failures;
}

/** Gate 1: every relative import resolves to a file; bare imports appear in package.json. */
function gateImportsResolve(
  root: string,
  sourceFiles: import("ts-morph").SourceFile[],
): GateFailure[] {
  const failures: GateFailure[] = [];
  const dependencies = readDependencyNames(root);

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    const declarations = [
      ...sourceFile.getImportDeclarations(),
      ...sourceFile.getExportDeclarations(),
    ];
    for (const declaration of declarations) {
      const specifier = declaration.getModuleSpecifier()?.getLiteralValue();
      if (specifier === undefined) continue;

      if (specifier.startsWith(".")) {
        const base = resolve(dirname(filePath), specifier);
        const resolves = RESOLVE_CANDIDATES.some((ext) => existsSync(`${base}${ext}`))
          || existsSync(join(base, "index.ts"))
          || existsSync(join(base, "index.tsx"));
        if (!resolves) {
          failures.push({
            gate: 1,
            reason: "unresolved-import",
            file: rel(root, filePath),
            line: declaration.getStartLineNumber(),
            message: `Import "${specifier}" in ${rel(root, filePath)} does not resolve to a file. Fix the path or create the module; sections may only create files inside their own page directory (contract 4.2).`,
          });
        }
      } else if (dependencies !== undefined && !specifier.startsWith("node:")) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]!;
        if (!dependencies.has(packageName)) {
          failures.push({
            gate: 1,
            reason: "missing-dependency",
            file: rel(root, filePath),
            line: declaration.getStartLineNumber(),
            message: `Import "${specifier}" in ${rel(root, filePath)} references package "${packageName}", which is not declared in package.json.`,
          });
        }
      }
    }
  }
  return failures;
}

/** Gate 2: every literal href is a known route from shell/routes.ts or explicitly external. */
function gateHrefsValid(
  root: string,
  sourceFiles: import("ts-morph").SourceFile[],
): GateFailure[] {
  const failures: GateFailure[] = [];
  const routesFile = sourceFiles.find((sf) => rel(root, sf.getFilePath()) === "src/shell/routes.ts");
  if (routesFile === undefined) {
    return [
      {
        gate: 2,
        reason: "missing-routes-table",
        message: "src/shell/routes.ts not found: the route table is the ground truth for every internal href (contract section 2).",
      },
    ];
  }

  const knownRoutes = new Set<string>();
  for (const property of routesFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (property.getName() === "path") {
      const literal = property.getInitializerIfKind(SyntaxKind.StringLiteral);
      if (literal !== undefined) knownRoutes.add(literal.getLiteralValue());
    }
  }

  for (const { value, file, line } of collectHrefLiterals(sourceFiles)) {
    if (EXTERNAL_HREF.test(value)) continue;
    if (knownRoutes.has(value)) continue;
    failures.push({
      gate: 2,
      reason: "dangling-href",
      file: rel(root, file),
      line,
      message: `href "${value}" in ${rel(root, file)} does not exist in shell/routes.ts (known routes: ${[...knownRoutes].join(", ")}) and is not an external URL. Link only to planned routes or explicit external URLs (contract 4.3).`,
    });
  }
  return failures;
}

/** Gate 3: no raw hex colors or raw px values outside src/tokens/. */
function gateTokensOnly(root: string, files: string[]): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const file of files) {
    const relPath = rel(root, file);
    if (relPath.startsWith("src/tokens/")) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((rawLine, index) => {
      // Arbitrary-value utility classes (w-[480px]) are the compiled form of
      // the user's deliberate free-value escape (contract 6.1/7.2) — exempt.
      const lineText = rawLine.replace(/-\[[^\]]*\]/g, "-[]");
      const hex = RAW_HEX.exec(lineText);
      if (hex !== null) {
        failures.push({
          gate: 3,
          reason: "raw-hex",
          file: relPath,
          line: index + 1,
          message: `Raw hex color "${hex[0]}" at ${relPath}:${index + 1}. Components must reference semantic tokens (e.g. var(--color-semantic-accent)); never raw hex (contract 3.2).`,
        });
      }
      const px = RAW_PX.exec(lineText);
      if (px !== null) {
        failures.push({
          gate: 3,
          reason: "raw-px",
          file: relPath,
          line: index + 1,
          message: `Raw px value "${px[0]}" at ${relPath}:${index + 1}. Spacing must use space-scale tokens (e.g. var(--space-4)); never raw px (contract 3.2).`,
        });
      }
    });
  }
  return failures;
}

/** True when `node` is lexically inside an arrow/function expression passed as a `.map(...)` callback. */
function isInsideMapCallback(node: import("ts-morph").Node): boolean {
  let current: import("ts-morph").Node | undefined = node;
  while (current !== undefined) {
    if (current.isKind(SyntaxKind.ArrowFunction) || current.isKind(SyntaxKind.FunctionExpression)) {
      const parent = current.getParent();
      if (parent !== undefined && parent.isKind(SyntaxKind.CallExpression)) {
        const callee = parent.getExpression();
        if (callee.isKind(SyntaxKind.PropertyAccessExpression) && callee.getName() === "map") {
          return true;
        }
      }
    }
    current = current.getParent();
  }
  return false;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Builds a match-any-instance regex from a template literal's static spans,
 * e.g. `` `${nodeId}.card-${key}` `` -> /^.+\.card\-.+$/ — used to recognize
 * a manifest id as "plausibly produced by this list's nodeId expression"
 * without statically evaluating the substitutions (contract 5.2: list items
 * derive ids from data keys, so the exact value isn't known until runtime).
 */
function templateToPattern(template: import("ts-morph").TemplateExpression): RegExp {
  const spans = [
    template.getHead().getLiteralText(),
    ...template.getTemplateSpans().map((span) => span.getLiteral().getLiteralText()),
  ];
  return new RegExp(`^${spans.map((span) => span.replace(REGEX_SPECIAL, "\\$&")).join(".+")}$`);
}

const isSectionRootId = (id: string): boolean => id.split(".").length === 2;

/**
 * Resolves an expression to the template literal that actually produces its
 * value: either the expression itself, or — when the model factors a list
 * item's id into a local `const itemId = `${nodeId}.card-${key}`` and
 * references it by name on every sub-element (idiomatic, semantically
 * identical to repeating the literal) — the template literal that local
 * const was declared with.
 */
function resolveTemplateExpression(
  expression: import("ts-morph").Expression | undefined,
): import("ts-morph").TemplateExpression | undefined {
  if (expression === undefined) return undefined;
  const direct = expression.asKind(SyntaxKind.TemplateExpression);
  if (direct !== undefined) return direct;
  const identifier = expression.asKind(SyntaxKind.Identifier);
  if (identifier === undefined) return undefined;
  for (const definition of identifier.getDefinitionNodes()) {
    const declaration =
      definition.asKind(SyntaxKind.VariableDeclaration) ??
      definition.getParentIfKind(SyntaxKind.VariableDeclaration);
    const template = declaration?.getInitializer()?.asKind(SyntaxKind.TemplateExpression);
    if (template !== undefined) return template;
  }
  return undefined;
}

/**
 * Gate 4: node-ID literals and manifest actives match 1:1, no duplicates.
 *
 * scopeRoute (build prompt 5.3 fan-out): when a section's own gate check
 * runs while SIBLING page workers are concurrently writing/committing
 * elsewhere in the same project, an unscoped project-wide scan can catch a
 * sibling's transient mid-commit or just-rolled-back state — a false
 * failure that has nothing to do with THIS section. Scoping restricts both
 * which files are scanned for attached IDs and which manifest entries are
 * expected to be attached to exactly this route, so a section only ever
 * fails gate 4 for its OWN problems. The final whole-project gate run
 * (after every worker finishes, contract 5.4/pipeline 5.3) stays unscoped.
 *
 * List-item ids (contract 5.2): a `nodeId`/`data-node-id` attribute whose
 * value is a template literal built inside a `.map(...)` callback is a
 * sanctioned dynamic attachment — the exact string isn't known statically,
 * it's derived from mock data at runtime. Such an attribute can't be
 * checked against a single literal id; instead every active manifest id
 * matching its static spans is treated as attached, so genuinely
 * unattached ids (typos, forgotten elements) still fail.
 */
function gateNodeIdsRegistered(
  root: string,
  sourceFiles: import("ts-morph").SourceFile[],
  scopeRoute?: string,
  skipMissingCheck?: boolean,
): GateFailure[] {
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    return [
      {
        gate: 4,
        reason: "missing-manifest",
        message: "manifest.json not found at the project root; the node registry is required (contract 5.4).",
      },
    ];
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const inScope = (nodeId: string): boolean =>
    scopeRoute === undefined || nodeId === scopeRoute || nodeId.startsWith(`${scopeRoute}.`);
  const activeIds = new Set(
    Object.entries(manifest.nodes)
      .filter(([nodeId, node]) => node.status === "active" && inScope(nodeId))
      .map(([nodeId]) => nodeId),
  );
  const scannedFiles =
    scopeRoute === undefined
      ? sourceFiles
      : sourceFiles.filter((sourceFile) =>
          rel(root, sourceFile.getFilePath()).startsWith(`src/pages/${scopeRoute}/`),
        );

  const attachments = new Map<string, Array<{ file: string; line: number }>>();
  const dynamicPatternsByFile = new Map<string, RegExp[]>();
  for (const sourceFile of scannedFiles) {
    const relPath = rel(root, sourceFile.getFilePath());
    for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      const name = attribute.getNameNode().getText();
      if (name !== "data-node-id" && name !== "nodeId") continue;
      const initializer = attribute.getInitializer();
      const literal = initializer?.asKind(SyntaxKind.StringLiteral);
      if (literal !== undefined) {
        const id = literal.getLiteralValue();
        const list = attachments.get(id) ?? [];
        list.push({ file: sourceFile.getFilePath(), line: attribute.getStartLineNumber() });
        attachments.set(id, list);
        continue;
      }
      const expression = initializer?.asKind(SyntaxKind.JsxExpression)?.getExpression();
      const template = resolveTemplateExpression(expression);
      if (template !== undefined && isInsideMapCallback(attribute)) {
        const patterns = dynamicPatternsByFile.get(relPath) ?? [];
        patterns.push(templateToPattern(template));
        dynamicPatternsByFile.set(relPath, patterns);
      }
    }
  }

  const failures: GateFailure[] = [];
  for (const [id, locations] of attachments) {
    if (!activeIds.has(id)) {
      const location = locations[0]!;
      failures.push({
        gate: 4,
        reason: "unregistered-node-id",
        file: rel(root, location.file),
        line: location.line,
        message: `Element at ${rel(root, location.file)}:${location.line} carries data-node-id "${id}", which is not an active node in manifest.json. Propose a manifest entry for it or remove the attribute (contract 5.4).`,
      });
    }
    if (locations.length > 1) {
      const second = locations[1]!;
      failures.push({
        gate: 4,
        reason: "duplicate-node-id",
        file: rel(root, second.file),
        line: second.line,
        message: `data-node-id "${id}" is attached to ${locations.length} elements (${locations.map((l) => `${rel(root, l.file)}:${l.line}`).join(", ")}); node IDs must be unique (contract 5.4).`,
      });
    }
  }
  for (const id of activeIds) {
    if (attachments.has(id)) continue;
    if (skipMissingCheck && isSectionRootId(id)) continue;
    const node = manifest.nodes[id]!;
    const patterns = dynamicPatternsByFile.get(node.file) ?? [];
    if (patterns.some((pattern) => pattern.test(id))) continue;
    failures.push({
      gate: 4,
      reason: "missing-node-id",
      file: node.file,
      message: `Manifest node "${id}" is never attached: no element carries data-node-id="${id}" (expected in ${node.file}). Attach it or tombstone the manifest entry (contract 5.1).`,
    });
  }
  return failures;
}

/** Gate 5: no user-visible string literals inside section JSX — content flows through props. */
function gateContentViaProps(
  root: string,
  sourceFiles: import("ts-morph").SourceFile[],
): GateFailure[] {
  const failures: GateFailure[] = [];
  const sectionPattern = /^src\/pages\/[^/]+\/sections\/[^/]+\.tsx$/;

  for (const sourceFile of sourceFiles) {
    const relPath = rel(root, sourceFile.getFilePath());
    if (!sectionPattern.test(relPath)) continue;

    const report = (text: string, line: number): void => {
      const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      failures.push({
        gate: 5,
        reason: "hardcoded-string",
        file: relPath,
        line,
        message: `Hardcoded user-visible string "${preview}" in section JSX at ${relPath}:${line}. All content must flow through the section's props interface and mock data file (contract 4.3).`,
      });
    };

    for (const jsxText of sourceFile.getDescendantsOfKind(SyntaxKind.JsxText)) {
      const text = jsxText.getLiteralText().trim();
      if (text.length > 0) report(text, jsxText.getStartLineNumber());
    }
    for (const expression of sourceFile.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
      const inner = expression.getExpression();
      if (inner === undefined) continue;
      if (
        inner.isKind(SyntaxKind.StringLiteral) ||
        inner.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
      ) {
        report(inner.getLiteralText(), inner.getStartLineNumber());
      }
    }
  }
  return failures;
}

/** Gate 6: no cross-page imports; written files (when logged) stay inside ownership boundaries. */
function gateOwnership(
  root: string,
  sourceFiles: import("ts-morph").SourceFile[],
  options: RunGatesOptions,
): GateFailure[] {
  const failures: GateFailure[] = [];

  for (const sourceFile of sourceFiles) {
    const relPath = rel(root, sourceFile.getFilePath());
    const pageMatch = /^src\/pages\/([^/]+)\//.exec(relPath);
    if (pageMatch === null) continue;
    const ownPage = pageMatch[1]!;

    for (const declaration of [
      ...sourceFile.getImportDeclarations(),
      ...sourceFile.getExportDeclarations(),
    ]) {
      const specifier = declaration.getModuleSpecifier()?.getLiteralValue();
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      const resolved = rel(root, resolve(dirname(sourceFile.getFilePath()), specifier));
      const targetMatch = /^src\/pages\/([^/]+)\//.exec(resolved);
      if (targetMatch !== null && targetMatch[1] !== ownPage) {
        failures.push({
          gate: 6,
          reason: "cross-page-import",
          file: relPath,
          line: declaration.getStartLineNumber(),
          message: `Cross-page import in ${relPath}: "${specifier}" resolves into src/pages/${targetMatch[1]}/. Pages may not import from other pages; shared needs escalate to primitives (contract 4.2).`,
        });
      }
    }
  }

  const { ownershipMap, writtenFiles } = options;
  if (ownershipMap !== undefined && writtenFiles !== undefined) {
    for (const [owner, files] of Object.entries(writtenFiles)) {
      const prefixes = ownershipMap[owner];
      for (const file of files) {
        const normalized = file.replace(/\\/g, "/");
        if (prefixes === undefined || !prefixes.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, "/")))) {
          failures.push({
            gate: 6,
            reason: "out-of-boundary-write",
            file: normalized,
            message: `Agent "${owner}" wrote "${normalized}" outside its ownership boundary (allowed prefixes: ${(prefixes ?? []).join(", ") || "none"}). Ownership rules make write contention impossible (contract section 2).`,
          });
        }
      }
    }
  }
  return failures;
}

function collectHrefLiterals(
  sourceFiles: import("ts-morph").SourceFile[],
): Array<{ value: string; file: string; line: number }> {
  const hrefs: Array<{ value: string; file: string; line: number }> = [];
  for (const sourceFile of sourceFiles) {
    for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      if (attribute.getNameNode().getText() !== "href") continue;
      const literal = attribute.getInitializer()?.asKind(SyntaxKind.StringLiteral);
      if (literal !== undefined) {
        hrefs.push({
          value: literal.getLiteralValue(),
          file: sourceFile.getFilePath(),
          line: attribute.getStartLineNumber(),
        });
      }
    }
    for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (property.getName() !== "href") continue;
      const literal = property.getInitializerIfKind(SyntaxKind.StringLiteral);
      if (literal !== undefined) {
        hrefs.push({
          value: literal.getLiteralValue(),
          file: sourceFile.getFilePath(),
          line: property.getStartLineNumber(),
        });
      }
    }
  }
  return hrefs;
}

function readDependencyNames(root: string): Set<string> | undefined {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  return new Set([
    ...Object.keys(packageJson["dependencies"] ?? {}),
    ...Object.keys(packageJson["devDependencies"] ?? {}),
    ...Object.keys(packageJson["peerDependencies"] ?? {}),
  ]);
}

function walkFiles(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkFiles(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function rel(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, "/");
}
