/**
 * Export endpoints for the preview server (PRD section 5, build prompt 6.2):
 *
 *   POST /__export          -> { ok: true, files, handover, integrationCount,
 *                                offScaleCount, appliedOverrides, tombstoned,
 *                                zipName, zipBytes }
 *                           -> { ok: false, message, gateReport?, buildLog? }
 *   GET  /__export-download -> the zip produced by the last successful export
 *
 * Export is deliberately synchronous-per-request: it is deterministic code,
 * not a model call, so there is no progress stream to subscribe to — the
 * editor shows an in-flight state and awaits the response.
 *
 * A failure never returns 500-with-a-string: the gate report and build log
 * are the whole point of a loud failure (contract 7.4, PRD 5), so they are
 * carried in a structured body the editor can render field by field.
 *
 * Output goes beside the project (`<project>-export`, `<project>-export.zip`)
 * so the source project directory is never written into — the pre-export
 * state stays fully editable and re-exportable.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { ExportError, exportProject } from "./exporter.ts";

export function exportApiPlugin(projectRoot: string): Plugin {
  const root = resolve(projectRoot);
  const projectName = basename(root);
  const outDir = join(dirname(root), `${projectName}-export`);
  const zipPath = join(dirname(root), `${projectName}-export.zip`);

  return {
    name: "sitewright:export-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";

        if (req.method === "POST" && url === "/__export") {
          try {
            // A previous export's output is stale the moment an edit lands;
            // exportProject refuses to write into an existing directory, so
            // clearing here is what makes export repeatable from the UI.
            rmSync(outDir, { recursive: true, force: true });
            rmSync(zipPath, { force: true });

            const result = exportProject(root, {
              outDir,
              zipPath,
              skipBuild: process.env.WG_EXPORT_SKIP_BUILD === "1",
            });
            respondJson(res, 200, {
              ok: true,
              files: result.files,
              handover: result.handover,
              integrationCount: result.integrationCount,
              offScaleCount: result.offScaleCount,
              appliedOverrides: result.appliedOverrides,
              tombstoned: result.tombstoned,
              zipName: `${projectName}.zip`,
              zipBytes: existsSync(zipPath) ? statSync(zipPath).size : 0,
            });
          } catch (error) {
            if (error instanceof ExportError) {
              respondJson(res, 200, {
                ok: false,
                message: error.message,
                ...(error.gateReport === undefined ? {} : { gateReport: error.gateReport }),
                ...(error.buildLog === undefined ? {} : { buildLog: error.buildLog }),
              });
              return;
            }
            respondJson(res, 200, { ok: false, message: String(error) });
          }
          return;
        }

        if (req.method === "GET" && url === "/__export-download") {
          if (!existsSync(zipPath)) {
            res.statusCode = 404;
            res.end("no export archive; run an export first");
            return;
          }
          const body = readFileSync(zipPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/zip");
          res.setHeader("Content-Disposition", `attachment; filename="${projectName}.zip"`);
          res.setHeader("Content-Length", String(body.length));
          res.end(body);
          return;
        }

        next();
      });
    },
  };
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}
