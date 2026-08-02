/**
 * Regeneration endpoints for the preview server (PRD section 4):
 *
 *   POST /__regen        { section, instruction } -> { passed, orphanedOverrides,
 *                                                     tombstoned, failureReport, canRevert }
 *   POST /__regen-page   { route, instruction }   -> same, plus { sections, perSection }
 *   POST /__regen-revert { section | route }      -> { ok }
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
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import type { Plugin } from "vite";

const MOCK_DELAY_MS = 1500; // keeps the in-place progress state observable in e2e

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
              snapshotSection(root, section);
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockRegen(root, section, instruction)
                  : await realRegen(root, section, instruction);
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
              // once, before any section runs — see the header comment
              snapshotRoute(root, route);
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? await mockRegenPage(root, route, instruction)
                  : await realRegenPage(root, route, instruction);
              server.moduleGraph.invalidateAll();
              respondJson(res, 200, { ...result, canRevert: true });
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/__regen-revert") {
          void readBody(req).then((body) => {
            try {
              restoreSnapshot(root, (body as { section: string }).section);
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

function realRegen(root: string, section: string, instruction: string): Promise<RegenOutcome> {
  return runRegenCli(root, ["--section", section], instruction);
}

function realRegenPage(root: string, route: string, instruction: string): Promise<PageRegenOutcome> {
  return runRegenCli(root, ["--route", route], instruction) as Promise<PageRegenOutcome>;
}

function runRegenCli(root: string, scopeArgs: string[], instruction: string): Promise<RegenOutcome> {
  const orchestratorDir = resolve(root, "..", "..", "orchestrator");
  const runId = basename(root);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "uv",
      ["run", "python", "-m", "orchestrator.regenerate", "--run-id", runId, ...scopeArgs, "--instruction", instruction],
      { cwd: orchestratorDir, shell: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", () => {
      const marker = stdout.split("\n").find((line) => line.startsWith("REGEN_RESULT "));
      if (marker === undefined) {
        rejectPromise(new Error(`regenerate CLI produced no result:\n${stderr.slice(-2000)}`));
        return;
      }
      resolvePromise(JSON.parse(marker.slice("REGEN_RESULT ".length)) as RegenOutcome);
    });
  });
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
