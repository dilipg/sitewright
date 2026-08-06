/**
 * Regeneration endpoints for the preview server (PRD section 4):
 *
 *   POST /__regen        { section, instruction } -> { passed, orphanedOverrides,
 *                                                     tombstoned, failureReport, canRevert }
 *   POST /__regen-page   { route, instruction }   -> same, plus { sections, perSection }
 *   POST /__regen-revert { section | route }      -> { ok }
 *   GET  /__archetypes                            -> { archetypes: [{name, description}] }
 *   POST /__add-section  { route, archetype, instruction }
 *                                                 -> { passed, sectionId, failureReport }
 *   POST /__edit-prompt  { route, instruction, selection? }
 *                                                 -> { operations, clarify, structural, notes }
 *
 * Before every regen the section's page directory + manifest are snapshotted;
 * revert restores the snapshot — the one-step "revert regeneration" (PRD 4.4).
 *
 * Page-level regen (PRD section 4, 7.9) reuses that snapshot unchanged: it was
 * always the whole route's directory, so one revert already restores a whole
 * page. What matters is that the page path snapshots ONCE, before any section
 * runs — snapshotting per section would leave the backup holding the previous
 * section's freshly regenerated output, and "revert" would then undo only the
 * last section while claiming to undo the page.
 *
 * Real mode spawns the orchestrator CLI (Kitaru replay fork, 4.1). Mock mode
 * (WG_REGEN_MOCK=1) applies deterministic file transformations mirroring the
 * real contract so the editor UX is e2e-testable in CI without model spend;
 * the real engine path is proven by the 4.1 live checks and the 4.3 stress
 * suite. Mock-mode manifest edits are direct JSON writes — acceptable ONLY
 * because mock mode is test infrastructure, never the product path.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import type { EditAgentResult } from "./edit-protocol.ts";
import { mockEditOperations } from "./edit-mock.ts";
import { ROUTE_SLUG } from "./route-slug.ts";
import { isValidUsageId, USAGE_ID_HEADER, usageLogPathFor } from "./usage-log-path.ts";

const MOCK_DELAY_MS = 1500; // keeps the in-place progress state observable in e2e

/**
 * Guards every filesystem path this plugin builds from proxied, otherwise-
 * unvalidated request input. `route` and `section`'s route component both
 * end up joined straight into a project-relative path (`snapshotRoute`,
 * below) — `path.join` normalises `..` segments, so an unchecked value can
 * walk outside the project root before any handler logic even runs. Found in
 * review: the hosted server proxies `route`/`section` bytes verbatim and
 * neither it nor this file validated them, so
 * `route = "../../../../victim/src"` escaped the project directory and
 * copied another tenant's files into the caller's own `.regen-backup`.
 *
 * Shares `ROUTE_SLUG` with `preview.ts`'s `/__overrides/<route-slug>` guard
 * rather than redefining it — one definition, so the two call sites cannot
 * silently drift apart.
 */
function isValidRouteSlug(value: unknown): value is string {
  return typeof value === "string" && ROUTE_SLUG.test(value);
}

/**
 * The route component of a section (or bare-route) id — same rule
 * `snapshotSection`/`restoreSnapshot` use to derive a route slug from a
 * section id, applied here so the VALIDATION sees exactly what the
 * filesystem call will. A `..`-shaped id (e.g. `"../../secret.hero"`) starts
 * with a literal `.`, so this always yields `""` for that specific shape —
 * not itself exploitable — but the guard is applied regardless, for the same
 * reason `route` is: an unvalidated value has no business reaching
 * `path.join` at all, and a non-string body field must fail closed here
 * rather than throw deeper in `.split()`.
 */
function routeSlugOfSection(section: unknown): string | undefined {
  return typeof section === "string" ? section.split(".")[0] : undefined;
}

/** Sends the uniform 400 every route-slug rejection below uses. */
function respondInvalidRouteSlug(res: ServerResponse): void {
  respondJson(res, 400, { error: "invalid route slug" });
}

export function regenApiPlugin(projectRoot: string): Plugin {
  const root = resolve(projectRoot);
  return {
    name: "website-generator:regen-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (req.method === "POST" && url === "/__regen") {
          void readBody(req).then(async (body) => {
            try {
              const { section, instruction } = body as { section: string; instruction: string };
              if (!isValidRouteSlug(routeSlugOfSection(section))) {
                respondInvalidRouteSlug(res);
                return;
              }
              snapshotSection(root, section);
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockRegen(root, section, instruction)
                  : await realRegen(root, section, instruction, usageEnvFor(req));
              // the editor reloads the frame immediately on response; the
              // watcher's async invalidation would race it and serve stale
              // transforms from the module cache
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ...result, canRevert: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/__regen-page") {
          void readBody(req).then(async (body) => {
            try {
              const { route, instruction } = body as { route: string; instruction: string };
              if (!isValidRouteSlug(route)) {
                respondInvalidRouteSlug(res);
                return;
              }
              // once, before any section runs — see the header comment
              snapshotRoute(root, route);
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockRegenPage(root, route, instruction)
                  : await realRegenPage(root, route, instruction, usageEnvFor(req));
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ...result, canRevert: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        if (req.method === "GET" && url === "/__archetypes") {
          void archetypeCatalog(root)
            .then((archetypes) => respondJson(res, 200, { archetypes }))
            .catch((error) => respondJson(res, 500, { error: String(error) }));
          return;
        }
        if (req.method === "POST" && url === "/__add-section") {
          void readBody(req).then(async (body) => {
            try {
              const { route, archetype, instruction } = body as {
                route: string;
                archetype: string;
                instruction: string;
              };
              if (!isValidRouteSlug(route)) {
                respondInvalidRouteSlug(res);
                return;
              }
              // Same route-wide snapshot as a regen, so an added section is
              // revertable by the same one step — adding one is as much a
              // change to the page as regenerating it (PRD 4.4).
              snapshotRoute(root, route);
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockAddSection(root, route, archetype, instruction)
                  : await realAddSection(root, route, archetype, instruction, usageEnvFor(req));
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ...result, canRevert: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/__edit-prompt") {
          void readBody(req).then(async (body) => {
            try {
              const { route, instruction, selection } = body as {
                route: string;
                instruction: string;
                selection?: string;
              };
              if (!isValidRouteSlug(route)) {
                respondInvalidRouteSlug(res);
                return;
              }
              // No snapshot here, unlike regen: this endpoint changes nothing on
              // disk. It returns operations; the editor applies them as ordinary
              // overrides, which the existing undo stack already covers.
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? mockEditOperations(instruction, route)
                  : await realEditPrompt(root, route, instruction, selection, usageEnvFor(req));
              respondJson(res, 200, result);
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/__regen-revert") {
          void readBody(req).then((body) => {
            try {
              const { section } = body as { section: string };
              if (!isValidRouteSlug(routeSlugOfSection(section))) {
                respondInvalidRouteSlug(res);
                return;
              }
              restoreSnapshot(root, section);
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ok: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        next();
      });
    },
  };
}

/* ---------- snapshot / revert ---------- */

function snapshotDir(root: string): string {
  return join(root, ".regen-backup");
}

function snapshotSection(root: string, section: string): void {
  snapshotRoute(root, section.split(".")[0]!);
}

function snapshotRoute(root: string, routeSlug: string): void {
  const backup = snapshotDir(root);
  rmSync(backup, { recursive: true, force: true });
  cpSync(join(root, "src", "pages", routeSlug), join(backup, "page"), { recursive: true });
  cpSync(join(root, "manifest.json"), join(backup, "manifest.json"));
}

/** Accepts a section id or a bare route slug: the snapshot is route-wide
 *  either way, so `home.hero` and `home` restore exactly the same thing. */
function restoreSnapshot(root: string, sectionOrRoute: string): void {
  const routeSlug = sectionOrRoute.split(".")[0]!;
  const backup = snapshotDir(root);
  if (!existsSync(backup)) throw new Error("no regeneration to revert");
  rmSync(join(root, "src", "pages", routeSlug), { recursive: true, force: true });
  cpSync(join(backup, "page"), join(root, "src", "pages", routeSlug), { recursive: true });
  cpSync(join(backup, "manifest.json"), join(root, "manifest.json"));
  rmSync(backup, { recursive: true, force: true });
}

/* ---------- real mode: orchestrator CLI (Kitaru replay fork) ---------- */

interface RegenOutcome {
  passed: boolean;
  orphanedOverrides: string[];
  tombstoned: string[];
  failureReport: string;
}

/** A page regen reports the same shape plus which sections it covered, so the
 *  editor can name a partial failure instead of just saying the page failed. */
interface PageRegenOutcome extends RegenOutcome {
  sections: string[];
  perSection: Record<string, boolean>;
}

function realRegen(
  root: string,
  section: string,
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<RegenOutcome> {
  return runRegenCli(root, ["--section", section], instruction, env);
}

function realRegenPage(
  root: string,
  route: string,
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<PageRegenOutcome> {
  return runRegenCli(root, ["--route", route], instruction, env) as Promise<PageRegenOutcome>;
}

function runRegenCli(
  root: string,
  scopeArgs: string[],
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<RegenOutcome> {
  return runCli<RegenOutcome>(
    root,
    ["orchestrator.regenerate", ...scopeArgs],
    instruction,
    "REGEN_RESULT ",
    env,
  );
}

/**
 * Spawns a child process and buffers its output. One place, because every
 * endpoint here spawns the same way.
 *
 * Deliberately WITHOUT `shell: true`. A shell means Node hands the OS one
 * command STRING, built by concatenating argv with spaces and no quoting
 * (Node's own DEP0190 warns about exactly this), so an argument containing a
 * space arrives as several arguments and one containing a quote arrives
 * mangled. Every argument list here ends in `--instruction <free-form user
 * text>`, so with a shell argparse saw five arguments for "make the headline
 * shorter", exited 2, and no endpoint could ever produce a result line. It was
 * also a shell-injection surface fed straight from a text box.
 *
 * Shell-free spawning resolves `uv` on Windows too: libuv searches PATH and
 * PATHEXT, so the bare name finds `uv.exe` (verified on this platform — and
 * the argv-preservation test below is the standing proof).
 */
export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Merged over the inherited environment rather than replacing it: the
    // orchestrator needs PATH, and under the hosted server it needs the
    // ANTHROPIC_API_KEY the preview pool put in this process's environment
    // for its owner. Only the caller's additions are new.
    const env = extraEnv === undefined ? undefined : { ...process.env, ...extraEnv };
    const child = spawn(command, args, env === undefined ? { cwd } : { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // Without this the promise never settles when the executable is missing:
    // "close" does not fire if the process never started.
    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

/**
 * The env addition for a request that may spend money. Absent header → no
 * addition, so the local unauthenticated preview behaves exactly as before
 * and keeps writing to the orchestrator's own shared runlog.
 *
 * Exported (though not part of the plugin's public surface) so it can be
 * tested directly rather than only through a live orchestrator spawn — the
 * header-to-env translation is the actual new logic here; `runProcess`'s
 * merge behavior is already covered on its own.
 */
export function usageEnvFor(req: IncomingMessage): NodeJS.ProcessEnv | undefined {
  const raw = req.headers[USAGE_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!isValidUsageId(value)) return undefined;
  const path = usageLogPathFor(value);
  mkdirSync(dirname(path), { recursive: true });
  return { WEBGEN_USAGE_LOG: path };
}

/** Spawns an orchestrator CLI and reads its single machine-readable result
 *  line. `moduleAndArgs` starts with the module name; --run-id (the project
 *  directory's own name) and --instruction are added here. */
async function runCli<T>(
  root: string,
  moduleAndArgs: string[],
  instruction: string,
  marker: string,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const orchestratorDir = resolve(root, "..", "..", "orchestrator");
  const runId = basename(root);
  const [moduleName, ...args] = moduleAndArgs;
  const { stdout, stderr } = await runProcess(
    "uv",
    ["run", "python", "-m", moduleName!, "--run-id", runId, ...args, "--instruction", instruction],
    orchestratorDir,
    env,
  );
  const resultLine = stdout.split("\n").find((line) => line.startsWith(marker));
  if (resultLine === undefined) {
    throw new Error(`${moduleName!} produced no result:\n${stderr.slice(-2000)}`);
  }
  return JSON.parse(resultLine.slice(marker.length)) as T;
}

interface AddSectionOutcome {
  passed: boolean;
  sectionId: string;
  failureReport: string;
}

function realAddSection(
  root: string,
  route: string,
  archetype: string,
  instruction: string,
  env?: NodeJS.ProcessEnv,
): Promise<AddSectionOutcome> {
  return runCli<AddSectionOutcome>(
    root,
    ["orchestrator.add_section", "--route", route, "--archetype", archetype],
    instruction,
    "ADD_SECTION_RESULT ",
    env,
  );
}

function realEditPrompt(
  root: string,
  route: string,
  instruction: string,
  selection: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<EditAgentResult> {
  const scope = ["orchestrator.edit_agent", "--route", route];
  if (selection !== undefined) scope.push("--selection", selection);
  return runCli<EditAgentResult>(root, scope, instruction, "EDIT_RESULT ", env);
}

/**
 * The archetype catalog for the "+" picker (PRD 4.1), read from the
 * orchestrator's own `ARCHETYPE_CATALOG`.
 *
 * Deliberately NOT duplicated in TypeScript. The catalog decides which
 * archetypes actually have prompt templates, so a copy here would drift the
 * moment one is added and would offer the user a section the generator cannot
 * build. Cached after the first read — it cannot change while the server runs.
 */
let catalogCache: Array<{ name: string; description: string }> | undefined;

async function archetypeCatalog(root: string): Promise<Array<{ name: string; description: string }>> {
  if (catalogCache !== undefined) return catalogCache;
  const raw = await runPython(root, ["-m", "orchestrator.catalog"]);
  const parsed = JSON.parse(raw) as Record<string, string>;
  catalogCache = Object.entries(parsed).map(([name, description]) => ({ name, description }));
  return catalogCache;
}

async function runPython(root: string, args: string[]): Promise<string> {
  const orchestratorDir = resolve(root, "..", "..", "orchestrator");
  const { stdout, stderr } = await runProcess("uv", ["run", "python", ...args], orchestratorDir);
  // Kitaru prints a Windows daemon notice on import, so the payload is the
  // last non-empty line rather than the whole of stdout.
  const line = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!line.startsWith("{")) throw new Error(`python produced no JSON:\n${stderr.slice(-2000)}`);
  return line;
}

/* ---------- mock mode: deterministic transformations for UX e2e ---------- */

async function mockRegen(root: string, section: string, instruction: string): Promise<RegenOutcome> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, MOCK_DELAY_MS));

  if (instruction.includes("FAIL")) {
    return {
      passed: false,
      orphanedOverrides: [],
      tombstoned: [],
      failureReport:
        'gate 3 (tokens-only): Raw hex color "#ff0000" at src/pages/home/sections/Hero.tsx:12. Components must reference semantic tokens. (mock failure)',
    };
  }

  const routeSlug = section.split(".")[0]!;
  // Which files this section owns comes from the MANIFEST, not from a guess:
  // it is the node registry (contract section 2), and the real path reads it
  // too. This was hardcoded to Hero while only home.hero was ever regenerated
  // in mock mode; a page regen loops every section, and rewriting Hero six
  // times would have made the mock look like it worked while touching one file.
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    nodes: Record<string, { component?: string }>;
  };
  const component = manifest.nodes[section]?.component;
  if (component === undefined) throw new Error(`mock regen: "${section}" is not a manifest node`);
  const sectionFile = join(root, "src", "pages", routeSlug, "sections", `${component}.tsx`);
  const mockFile = join(root, "src", "pages", routeSlug, "mock", `${component}.data.ts`);

  // Headline rewrite — stands in for "the model produced new copy". Not every
  // archetype has a `headline`, so a section without one is left alone rather
  // than reported as changed; the transformation is illustrative, and the
  // contract being tested is the response shape and the revert path.
  const shortInstruction = instruction.slice(0, 48).replace(/"/g, "'");
  if (existsSync(mockFile)) {
    writeFileSync(
      mockFile,
      readFileSync(mockFile, "utf8").replace(
        /headline: "[^"]*"/,
        `headline: "Regenerated: ${shortInstruction}"`,
      ),
    );
  }

  const orphaned: string[] = [];
  const tombstoned: string[] = [];
  if (instruction.includes("remove the subheadline")) {
    const subheadlineId = `${section}.subheadline`;
    writeFileSync(
      sectionFile,
      readFileSync(sectionFile, "utf8").replace(
        /^\s*<Text nodeId="[a-z.-]+\.subheadline"[\s\S]*?<\/Text>\r?\n/m,
        "",
      ),
    );
    // mock-only direct manifest edit (product path goes through the service)
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.nodes[subheadlineId] !== undefined) {
      manifest.nodes[subheadlineId].status = "tombstoned";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      tombstoned.push(subheadlineId);
    }
    const overridesPath = join(root, "overrides", `${routeSlug}.overrides.json`);
    if (existsSync(overridesPath)) {
      const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as {
        overrides: Array<{ nodeId: string }>;
      };
      if (overrides.overrides.some((entry) => entry.nodeId === subheadlineId)) {
        orphaned.push(subheadlineId);
      }
    }
  }

  return { passed: true, orphanedOverrides: orphaned, tombstoned, failureReport: "" };
}

/**
 * Mock page regen: loops the route's ACTIVE section roots exactly as the real
 * page path loops them, and aggregates the same way, so the editor's page-scope
 * UX is e2e-testable without model spend. Sections are read from the manifest
 * rather than the filesystem — the manifest is the node registry (contract
 * section 2), and it is what the real path reads too.
 */
async function mockRegenPage(
  root: string,
  route: string,
  instruction: string,
): Promise<PageRegenOutcome> {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    nodes: Record<string, { status: string }>;
  };
  const sections = Object.entries(manifest.nodes)
    .filter(
      ([nodeId, node]) =>
        nodeId.startsWith(`${route}.`) &&
        nodeId.split(".").length === 2 &&
        node.status === "active",
    )
    .map(([nodeId]) => nodeId);
  if (sections.length === 0) throw new Error(`no active sections on route "${route}"`);

  const perSection: Record<string, boolean> = {};
  const orphaned = new Set<string>();
  const tombstoned = new Set<string>();
  const failures: string[] = [];
  for (const section of sections) {
    const result = await mockRegen(root, section, instruction);
    perSection[section] = result.passed;
    for (const id of result.orphanedOverrides) orphaned.add(id);
    for (const id of result.tombstoned) tombstoned.add(id);
    if (!result.passed) failures.push(`${section}: ${result.failureReport}`);
  }
  return {
    passed: failures.length === 0,
    sections,
    perSection,
    orphanedOverrides: [...orphaned].sort(),
    tombstoned: [...tombstoned].sort(),
    failureReport: failures.join("\n"),
  };
}

/**
 * Mock add-a-section: writes a real (if plain) section component, its mock
 * data, its manifest entries and its render line, so the editor's "+" flow is
 * e2e-testable without model spend.
 *
 * It deliberately produces a section that is genuinely selectable and
 * editable — a stub that rendered nothing would let the UX test pass while
 * proving nothing about what the user ends up with. The component is written
 * to satisfy the same contract rules the real templates do: primitives are
 * default imports (contract 4.1), the root carries `data-node-id={nodeId}`,
 * and nodeId comes from a separate NodeProps intersection (contract 5.6).
 */
async function mockAddSection(
  root: string,
  route: string,
  archetype: string,
  instruction: string,
): Promise<AddSectionOutcome> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, MOCK_DELAY_MS));

  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    nodes: Record<string, unknown>;
  };
  const taken = new Set(
    Object.keys(manifest.nodes)
      .filter((nodeId) => nodeId.startsWith(`${route}.`) && nodeId.split(".").length === 2)
      .map((nodeId) => nodeId.split(".")[1]!),
  );
  let slug = archetype;
  for (let n = 2; taken.has(slug); n += 1) slug = `${archetype}-${n}`;

  const component = slug
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
  const sectionId = `${route}.${slug}`;
  const pageDir = join(root, "src", "pages", route);
  const file = `src/pages/${route}/sections/${component}.tsx`;

  writeFileSync(
    join(pageDir, "sections", `${component}.tsx`),
    `import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

export interface ${component}Props {
  heading: string;
  body: string;
}

export default function ${component}({ nodeId, heading, body }: ${component}Props & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-surface) py-(--space-16)">
      <Container>
        <Heading nodeId="${sectionId}.heading" level={2} variant="section">
          {heading}
        </Heading>
        <Text nodeId="${sectionId}.body" variant="body">
          {body}
        </Text>
      </Container>
    </section>
  );
}
`,
  );
  const dataVar = component[0]!.toLowerCase() + component.slice(1) + "Data";
  writeFileSync(
    join(pageDir, "mock", `${component}.data.ts`),
    `import type { ${component}Props } from "../sections/${component}";

export const ${dataVar}: ${component}Props = {
  heading: "Added: ${archetype}",
  body: ${JSON.stringify(instruction.slice(0, 160))},
};
`,
  );

  // mock-only direct manifest edit (the product path goes through the service)
  const entry = (element: string, editable: string[]) => ({
    route: route === "home" ? "/" : `/${route}`,
    file,
    component,
    element,
    editable,
    status: "active",
  });
  manifest.nodes[sectionId] = entry("section", ["style", "layout", "visibility"]);
  manifest.nodes[`${sectionId}.heading`] = entry("Heading", ["text", "style", "layout", "visibility"]);
  manifest.nodes[`${sectionId}.body`] = entry("Text", ["text", "style", "layout", "visibility"]);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const indexPath = join(pageDir, "index.tsx");
  const source = readFileSync(indexPath, "utf8");
  const importLines = source.split("\n").filter((line) => line.startsWith("import "));
  const withImports = source.replace(
    importLines.at(-1)!,
    `${importLines.at(-1)!}\nimport { ${dataVar} } from "./mock/${component}.data";\nimport ${component} from "./sections/${component}";`,
  );
  writeFileSync(
    indexPath,
    withImports.replace(
      "\n    </>",
      `\n      <${component} nodeId="${sectionId}" {...${dataVar}} />\n    </>`,
    ),
  );

  return { passed: true, sectionId, failureReport: "" };
}

/* ---------- plumbing ---------- */

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolveBody({});
      }
    });
  });
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}
