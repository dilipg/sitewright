/**
 * Plan-approval endpoints for the preview server (pipeline 2.2: the plan is
 * shown to the user for approval before generation spend begins):
 *
 *   GET  /__plan                -> { exists, approved, brief?, siteplan? }
 *   POST /__plan/section-brief  { routeSlug, sectionSlug, brief } -> { ok }
 *   POST /__plan/approve        -> { ok }
 *
 * Files live in <project>/plan/; the orchestrator's generation CLI refuses
 * to spend until plan-status.json says approved.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

export function planApiPlugin(projectRoot: string): Plugin {
  const planDir = join(resolve(projectRoot), "plan");
  return {
    name: "website-generator:plan-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (req.method === "GET" && url === "/__plan") {
          if (!existsSync(join(planDir, "siteplan.json"))) {
            respondJson(res, 200, { exists: false, approved: false });
            return;
          }
          respondJson(res, 200, {
            exists: true,
            approved: readStatus(planDir),
            brief: readJson(join(planDir, "brief.json")),
            siteplan: readJson(join(planDir, "siteplan.json")),
          });
          return;
        }
        if (req.method === "POST" && url === "/__plan/section-brief") {
          void readBody(req).then((body) => {
            const { routeSlug, sectionSlug, brief } = body as {
              routeSlug: string;
              sectionSlug: string;
              brief: string;
            };
            const planPath = join(planDir, "siteplan.json");
            const siteplan = readJson(planPath) as {
              routes: Array<{ slug: string; sections: Array<{ slug: string; brief: string }> }>;
            };
            const section = siteplan.routes
              .find((route) => route.slug === routeSlug)
              ?.sections.find((candidate) => candidate.slug === sectionSlug);
            if (section === undefined) {
              respondJson(res, 404, { ok: false, error: "section not found" });
              return;
            }
            section.brief = brief;
            writeFileSync(planPath, `${JSON.stringify(siteplan, null, 2)}\n`);
            respondJson(res, 200, { ok: true });
          });
          return;
        }
        if (req.method === "POST" && url === "/__plan/approve") {
          writeFileSync(
            join(planDir, "plan-status.json"),
            `${JSON.stringify({ approved: true, approvedAt: new Date().toISOString() }, null, 2)}\n`,
          );
          respondJson(res, 200, { ok: true });
          return;
        }
        next();
      });
    },
  };
}

function readStatus(planDir: string): boolean {
  const statusPath = join(planDir, "plan-status.json");
  if (!existsSync(statusPath)) return false;
  return (readJson(statusPath) as { approved?: boolean }).approved === true;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

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
