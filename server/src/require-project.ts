// server/src/require-project.ts
/**
 * The ownership rule, in exactly one place (spec, "Deny by default": every
 * project-scoped endpoint resolves projectId, loads one row, and compares
 * ownerId to the session user).
 *
 * Composed OVER requireSession rather than repeating it, so authentication and
 * authorization stay one decision each rather than two decisions per handler.
 *
 * A foreign project and a nonexistent one get the same response on purpose.
 * Distinguishing them (403 vs 404) turns every project endpoint into an
 * enumeration oracle for other people's project ids.
 */
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "./users.ts";
import type { Project } from "./projects.ts";
import { findProjectById } from "./projects.ts";
import { type Handler, sendJson } from "./router.ts";
import { requireSession } from "./require-session.ts";

export type ProjectIdSource =
  | { from: "param"; name: string }
  | { from: "query"; name: string };

export type ProjectHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { url: URL; params: Record<string, string>; user: User; project: Project },
) => Promise<void> | void;

/**
 * One message for both failure modes, so the pair is indistinguishable.
 * Exported so job-routes.ts's `GET /api/jobs/:id` — which is owner-checked on
 * the job's own `user_id` rather than through this wrapper, since a job may
 * outlive its project (`project_id` is `ON DELETE SET NULL`) — can answer a
 * foreign or absent job id with the exact same shape. A job id must not be an
 * enumeration oracle either, and reusing this literal object (not a second,
 * differently-worded copy) is what keeps the two responses byte-identical
 * without relying on two authors remembering to agree.
 */
export const NOT_FOUND = { error: "project not found" };

export function requireProject(
  db: DatabaseSync,
  source: ProjectIdSource,
  handler: ProjectHandler,
): Handler {
  return requireSession(db, async (req, res, ctx) => {
    const id = source.from === "param"
      ? ctx.params[source.name]
      : ctx.url.searchParams.get(source.name) ?? undefined;

    if (id === undefined || id === "") {
      sendJson(res, 400, { error: `a ${source.name} is required` });
      return;
    }

    const project = findProjectById(db, id);
    // One comparison, and the only one. Note the ordering: a missing row and a
    // foreign row collapse into the same branch, so no caller can accidentally
    // report them differently.
    if (project === null || project.ownerId !== ctx.user.id) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }

    await handler(req, res, { ...ctx, project });
  });
}
