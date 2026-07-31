/**
 * HANDOVER.md generation (PRD section 5, build prompt 6.2): the document a
 * receiving developer reads first. Three sections, each answering a question
 * the export alone can't:
 *
 * 1. Props/mock seam map — where the copy for each section lives, so content
 *    edits go to a data file and never into JSX.
 * 2. Integration TODOs — every handler prop wired to a no-op in mock data
 *    (contract 4.3's interactive seam). This is the "what to wire up" list:
 *    a cart's checkout, a form's submit. Derived by AST scan, not by grepping
 *    for the TODO comment, so a handler whose comment was dropped is still
 *    reported (and flagged as missing its marker).
 * 3. Off-scale overrides — edits the user made outside the token scale
 *    (contract 6.1/7.2's deliberate escape hatch). Not errors; a list a
 *    developer may want to normalize back into the design system.
 *
 * Fully deterministic: everything is derived from the exported source + the
 * manifest and sorted, so repeat exports of the same project produce a
 * byte-identical document (build prompt 6.2's repeatability requirement).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { InterfaceDeclaration, SourceFile } from "ts-morph";
import { Project, SyntaxKind, ts } from "ts-morph";
import type { Manifest } from "./manifest.ts";
import { isTokenReference } from "./style-value.ts";

/** A section's content seam: which file holds the copy, which holds the markup. */
export interface SectionSeam {
  routeSlug: string;
  routePath: string;
  component: string;
  sectionFile: string;
  /** undefined when the section has no mock data file (no content props). */
  mockFile: string | undefined;
  /** Content prop names (everything on the props interface that is not a handler). */
  contentProps: string[];
}

/** A handler prop wired to a no-op in mock data — something to integrate. */
export interface IntegrationSeam {
  routeSlug: string;
  component: string;
  propName: string;
  /** Type text from the props interface, e.g. "(quantity: number) => void". */
  signature: string;
  /** Mock data file holding the no-op. */
  mockFile: string;
  line: number;
  /** The `// TODO: integrate ...` note, or undefined when the marker is missing. */
  note: string | undefined;
}

/** An override compiled to an arbitrary-value class rather than a token reference. */
export interface OffScaleOverride {
  nodeId: string;
  channel: "style" | "layout";
  property: string;
  value: string;
}

export interface HandoverData {
  sections: SectionSeam[];
  integrations: IntegrationSeam[];
  offScale: OffScaleOverride[];
  routeCount: number;
  nodeCount: number;
  appliedOverrides: number;
}

interface OverrideLike {
  nodeId: string;
  channel: string;
  value: unknown;
}

/** Reads route slug -> path from the exported shell/routes.ts (ground truth, contract section 2). */
function readRoutePaths(exportDir: string, project: Project): Map<string, string> {
  const paths = new Map<string, string>();
  const routesFile = project.getSourceFile((file) =>
    file.getFilePath().replace(/\\/g, "/").endsWith("src/shell/routes.ts"),
  );
  if (routesFile === undefined) return paths;
  for (const literal of routesFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const slug = literal.getProperty("slug")?.asKind(SyntaxKind.PropertyAssignment);
    const path = literal.getProperty("path")?.asKind(SyntaxKind.PropertyAssignment);
    const slugValue = slug?.getInitializerIfKind(SyntaxKind.StringLiteral)?.getLiteralValue();
    const pathValue = path?.getInitializerIfKind(SyntaxKind.StringLiteral)?.getLiteralValue();
    if (slugValue !== undefined && pathValue !== undefined) paths.set(slugValue, pathValue);
  }
  return paths;
}

function propsInterfaceOf(sectionFile: SourceFile, component: string): InterfaceDeclaration | undefined {
  return sectionFile.getInterface(`${component}Props`);
}

/** True for a props-interface member whose type is a function (a handler seam, contract 4.3). */
function isHandlerType(typeText: string): boolean {
  return /=>/.test(typeText);
}

export function collectHandoverData(
  exportDir: string,
  manifest: Manifest,
  overrides: OverrideLike[],
): HandoverData {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  });
  project.addSourceFilesAtPaths(`${exportDir.replace(/\\/g, "/")}/src/**/*.{ts,tsx}`);

  const routePaths = readRoutePaths(exportDir, project);
  const pagesDir = join(exportDir, "src", "pages");
  const sections: SectionSeam[] = [];
  const integrations: IntegrationSeam[] = [];

  const routeSlugs = existsSync(pagesDir)
    ? readdirSync(pagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

  for (const routeSlug of routeSlugs) {
    const sectionsDir = join(pagesDir, routeSlug, "sections");
    if (!existsSync(sectionsDir)) continue;
    const componentFiles = readdirSync(sectionsDir)
      .filter((name) => name.endsWith(".tsx"))
      .sort();

    for (const fileName of componentFiles) {
      const component = fileName.replace(/\.tsx$/, "");
      const sectionRel = `src/pages/${routeSlug}/sections/${fileName}`;
      const mockRel = `src/pages/${routeSlug}/mock/${component}.data.ts`;
      const mockAbsolute = join(exportDir, "src", "pages", routeSlug, "mock", `${component}.data.ts`);
      const hasMock = existsSync(mockAbsolute);

      const sectionSource = project.getSourceFile(join(sectionsDir, fileName));
      const contentProps: string[] = [];
      const handlerSignatures = new Map<string, string>();
      if (sectionSource !== undefined) {
        const propsInterface = propsInterfaceOf(sectionSource, component);
        for (const member of propsInterface?.getProperties() ?? []) {
          const name = member.getName();
          const typeText = member.getTypeNode()?.getText() ?? "";
          if (isHandlerType(typeText)) handlerSignatures.set(name, typeText);
          else contentProps.push(name);
        }
      }

      sections.push({
        routeSlug,
        routePath: routePaths.get(routeSlug) ?? "",
        component,
        sectionFile: sectionRel,
        mockFile: hasMock ? mockRel : undefined,
        contentProps,
      });

      if (!hasMock) continue;
      const mockSource = project.getSourceFile(mockAbsolute);
      if (mockSource === undefined) continue;

      // Every property in the mock data whose value is a function is a no-op
      // standing in for real behavior — found by AST shape, not by the TODO
      // comment, so a handler missing its marker is still reported (and
      // flagged), which is exactly the gap a handover reader would hit.
      for (const property of mockSource.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        const initializer = property.getInitializer();
        if (
          initializer === undefined ||
          !(
            initializer.isKind(SyntaxKind.ArrowFunction) ||
            initializer.isKind(SyntaxKind.FunctionExpression)
          )
        ) {
          continue;
        }
        const propName = property.getName().replace(/^["']|["']$/g, "");
        integrations.push({
          routeSlug,
          component,
          propName,
          signature: handlerSignatures.get(propName) ?? "(unknown signature)",
          mockFile: mockRel,
          line: property.getStartLineNumber(),
          note: extractTodoNote(initializer.getText()),
        });
      }
    }
  }

  const offScale: OffScaleOverride[] = [];
  for (const override of overrides) {
    if (override.channel !== "style" && override.channel !== "layout") continue;
    if (typeof override.value !== "object" || override.value === null) continue;
    for (const [property, raw] of Object.entries(override.value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const value = String(raw);
      if (isTokenReference(value)) continue;
      offScale.push({
        nodeId: override.nodeId,
        channel: override.channel,
        property,
        value,
      });
    }
  }

  const activeNodes = Object.values(manifest.nodes).filter((node) => node.status === "active");
  const routes = new Set(Object.keys(manifest.nodes).map((nodeId) => nodeId.split(".")[0]));

  integrations.sort(
    (a, b) =>
      a.routeSlug.localeCompare(b.routeSlug) ||
      a.component.localeCompare(b.component) ||
      a.propName.localeCompare(b.propName),
  );
  offScale.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.property.localeCompare(b.property));

  return {
    sections,
    integrations,
    offScale,
    routeCount: routes.size,
    nodeCount: activeNodes.length,
    appliedOverrides: overrides.length,
  };
}

/** Pulls the `TODO: integrate ...` line out of a no-op handler body. */
function extractTodoNote(body: string): string | undefined {
  const match = /\/\/\s*TODO:\s*(.+)/.exec(body);
  return match === null ? undefined : match[1]!.trim();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function renderHandover(data: HandoverData): string {
  const lines: string[] = [];

  lines.push("# Handover");
  lines.push("");
  lines.push(
    "Generated by the exporter. This is production-shaped React + TypeScript source: " +
      `${String(data.routeCount)} route(s), ${String(data.nodeCount)} addressable nodes, ` +
      `${String(data.appliedOverrides)} canvas edit(s) already compiled into the source.`,
  );
  lines.push("");
  lines.push(
    "Every visual edit made on the canvas is already in this code — there is no runtime " +
      "override layer to install, and no editor dependency. The sections below map the " +
      "seams you will actually touch.",
  );
  lines.push("");

  lines.push("## 1. Where the content lives");
  lines.push("");
  lines.push(
    "Each section is a component plus a mock data file. Copy flows through props, " +
      "so **static text changes belong in the `.data.ts` file, never in the JSX**.",
  );
  lines.push("");
  lines.push(
    "For anything **async or stateful** (fetching from an API, updating after a user " +
      "action) a data file is not enough — it exports a module-level `const`, so it " +
      "cannot hold a promise or react to a change. Put that logic in the **page " +
      "container**, `src/pages/<route>/index.tsx`: own the state there with hooks, and " +
      "pass it down as props. The section stays untouched. Its docblock says \"page " +
      "assembly only, no styling decisions\" — that means keep *styling* out, not " +
      "logic; the container is yours to edit after handover.",
  );
  lines.push("");
  lines.push(
    "Two consequences worth knowing before you start:",
  );
  lines.push("");
  lines.push(
    "- **Sections do no arithmetic.** A total or count is a display string you supply. " +
      "Removing a list item does not recalculate it — recompute it in the container, or " +
      "it will silently go stale.",
  );
  lines.push(
    "- **Sections have no loading or error state.** An empty list renders the section's " +
      "own empty-state copy, so a list that is still loading looks identical to one that " +
      "is genuinely empty. Gate on your own loading flag in the container before " +
      "rendering the section, or you will ship a flash of \"nothing here\" on every load.",
  );
  lines.push("");

  if (data.sections.length === 0) {
    lines.push("_No sections found._");
    lines.push("");
  } else {
    let currentRoute = "";
    for (const section of data.sections) {
      if (section.routeSlug !== currentRoute) {
        currentRoute = section.routeSlug;
        lines.push(
          `### Route \`${section.routeSlug}\`${section.routePath === "" ? "" : ` — \`${section.routePath}\``}`,
        );
        lines.push("");
        lines.push("| Section | Component | Mock data | Content props |");
        lines.push("| --- | --- | --- | --- |");
      }
      const props =
        section.contentProps.length === 0 ? "_none_" : section.contentProps.map((p) => `\`${p}\``).join(", ");
      lines.push(
        `| ${section.component} | \`${section.sectionFile}\` | ${
          section.mockFile === undefined ? "_none_" : `\`${section.mockFile}\``
        } | ${escapeCell(props)} |`,
      );
      const isLastOfRoute =
        data.sections[data.sections.indexOf(section) + 1]?.routeSlug !== section.routeSlug;
      if (isLastOfRoute) lines.push("");
    }
  }

  lines.push("## 2. Integration TODOs");
  lines.push("");
  if (data.integrations.length === 0) {
    lines.push("No handler seams — this export has no interactive elements to wire up.");
    lines.push("");
  } else {
    lines.push(
      `${String(data.integrations.length)} handler prop(s) are wired to no-op stubs. Each is a typed ` +
        "seam, and the component needs no changes to use it. For a synchronous handler, " +
        "replace the stub in the mock data file. For anything **async** — which is most " +
        "real integrations — the stub cannot help you (it is a module-level `const`, with " +
        "no access to React state); pass your own handler from the page container instead, " +
        "as described in section 1.",
    );
    lines.push("");
    lines.push(
      "Before wiring one, read its section's props interface: a handler that can be " +
        "triggered twice usually has a companion flag beside it (for example a " +
        "`…Disabled?: boolean`) that exists precisely so you can block a double-submit " +
        "while a request is in flight. It is optional, so mock data never sets it, and it " +
        "is easy to miss.",
    );
    lines.push("");
    lines.push("| Route | Section | Handler | Signature | Stub location | Note |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const seam of data.integrations) {
      lines.push(
        `| \`${seam.routeSlug}\` | ${seam.component} | \`${seam.propName}\` | ` +
          `\`${escapeCell(seam.signature)}\` | \`${seam.mockFile}\`:${String(seam.line)} | ` +
          `${seam.note === undefined ? "**marker missing**" : escapeCell(seam.note)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 3. Off-scale overrides");
  lines.push("");
  if (data.offScale.length === 0) {
    lines.push("None — every canvas edit resolved to a design token.");
    lines.push("");
  } else {
    lines.push(
      `${String(data.offScale.length)} edit(s) used a free value instead of a design token, and ` +
        "compiled to Tailwind arbitrary-value classes. They are intentional, not errors — " +
        "listed here in case you would rather normalize them into the token scale " +
        "(`src/tokens/tokens.json`).",
    );
    lines.push("");
    lines.push("| Node | Channel | Property | Value |");
    lines.push("| --- | --- | --- | --- |");
    for (const entry of data.offScale) {
      lines.push(
        `| \`${entry.nodeId}\` | ${entry.channel} | \`${entry.property}\` | \`${escapeCell(entry.value)}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## 4. Node ids, and why your data keys matter");
  lines.push("");
  lines.push(
    "`data-node-id` attributes are canvas addressing metadata. They are inert at " +
      "runtime, they make convenient stable test selectors, and they are safe to strip " +
      "if you never plan to re-open this project in the editor.",
  );
  lines.push("");
  lines.push(
    "**If you do plan to re-open it, one rule matters.** A list item's node id is built " +
      "from that item's own `key` field — `<section-id>.item-${item.key}` — so the keys " +
      "your data source supplies become part of the id namespace. Keep them stable, " +
      "human-meaningful slugs (`driftwood-shore`). Do **not** feed in database integers " +
      "or array indices: ids like `…item-1` are positional, they change the moment the " +
      "list reorders, and every canvas edit anchored to them is silently lost.",
  );
  lines.push("");

  lines.push("## 5. What is yours to edit");
  lines.push("");
  lines.push("| Path | Who owns it |");
  lines.push("| --- | --- |");
  lines.push("| `src/pages/<route>/index.tsx` | **yours** — the page container, and where integration logic belongs |");
  lines.push("| `src/pages/<route>/mock/*.data.ts` | **yours** — content and handler wiring |");
  lines.push("| `src/lib/`, `src/pages/<route>/sections/*.tsx`, `src/primitives/`, `src/shell/`, `src/tokens/` | regenerated — safe to read, and safe to add NEW files to, but edits to existing files are overwritten if the project is regenerated |");
  lines.push("| `HANDOVER.md` | regenerated on every export — put your own notes in a separate file |");
  lines.push("");
  lines.push(
    "`src/tokens/tokens.css` is derived from `src/tokens/tokens.json` — edit the JSON, " +
      "not the CSS. `src/shell/routes.ts` is the route table every internal link " +
      "resolves against. `design-inventory.json` lists every primitive with its full " +
      "prop signature (faster than reading the components). `manifest.json` is the " +
      "editor's node registry: nothing imports it at runtime, and it is only needed if " +
      "you re-import the project into the editor.",
  );
  lines.push("");

  lines.push("## 6. Running it");
  lines.push("");
  lines.push("```sh");
  lines.push("npm install");
  lines.push("npm run dev     # local dev server");
  lines.push("npm run build   # typecheck + production build");
  lines.push("```");
  lines.push("");
  lines.push(
    "**Keep anything that writes to disk out of the project root.** The dev server " +
      "watches the root, so a file your back-end or tooling writes there (a `db.json`, a " +
      "sqlite file, a browser profile) triggers a full page reload that destroys React " +
      "state mid-interaction — and a locked file can crash the dev server outright. " +
      "Neither looks like a config problem: the reload silently re-fetches, so your DATA " +
      "still looks correct and only state you hold locally (a confirmation message, a " +
      "wizard step) vanishes. If you must keep the file in the root, exclude it: " +
      "`server: { watch: { ignored: [\"**/db.json\"] } }` in `vite.config.ts`.",
  );
  lines.push("");
  lines.push(
    "Two smaller things worth knowing before you debug something that is not a bug: " +
      "`main.tsx` renders under React `StrictMode`, so **every mount effect runs twice in " +
      "development** — a `useEffect` fetch fires two requests, and an unguarded abort will " +
      "surface as a spurious error on first load (guard it, or ignore `AbortError`). And " +
      "`tsconfig.json` only includes `src`, so `npm run build` does not typecheck " +
      "`vite.config.ts` itself.",
  );
  lines.push("");

  return lines.join("\n");
}

export function generateHandover(
  exportDir: string,
  manifest: Manifest,
  overrides: OverrideLike[],
): string {
  return renderHandover(collectHandoverData(exportDir, manifest, overrides));
}
