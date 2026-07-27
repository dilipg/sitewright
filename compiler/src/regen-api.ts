/**
 * Regeneration endpoints for the preview server (PRD section 4):
 *
 *   POST /__regen        { section, instruction } -> { passed, orphanedOverrides,
 *                                                     tombstoned, failureReport, canRevert }
 *   POST /__regen-revert { section }              -> { ok }
 *
 * Before every regen the section's page directory + manifest are snapshotted;
 * revert restores the snapshot — the one-step "revert regeneration" (PRD 4.4).
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
  const routeSlug = section.split(".")[0]!;
  const backup = snapshotDir(root);
  rmSync(backup, { recursive: true, force: true });
  cpSync(join(root, "src", "pages", routeSlug), join(backup, "page"), { recursive: true });
  cpSync(join(root, "manifest.json"), join(backup, "manifest.json"));
}

function restoreSnapshot(root: string, section: string): void {
  const routeSlug = section.split(".")[0]!;
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

function realRegen(root: string, section: string, instruction: string): Promise<RegenOutcome> {
  const orchestratorDir = resolve(root, "..", "..", "orchestrator");
  const runId = basename(root);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "uv",
      ["run", "python", "-m", "orchestrator.regenerate", "--run-id", runId, "--section", section, "--instruction", instruction],
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
  const sectionFile = join(root, "src", "pages", routeSlug, "sections", "Hero.tsx");
  const mockFile = join(root, "src", "pages", routeSlug, "mock", "Hero.data.ts");

  // headline rewrite — stands in for "the model produced new copy"
  const shortInstruction = instruction.slice(0, 48).replace(/"/g, "'");
  writeFileSync(
    mockFile,
    readFileSync(mockFile, "utf8").replace(
      /headline: "[^"]*"/,
      `headline: "Regenerated: ${shortInstruction}"`,
    ),
  );

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
