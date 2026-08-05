// server/src/project-routes.ts
/**
 * A user's own projects.
 *
 * GET /api/projects is scoped by the SQL query rather than by filtering after
 * the fact, so there is no moment at which another user's row is in hand.
 * GET /api/projects/:id goes through requireProject, so its ownership rule is
 * the same one every other project endpoint uses.
 *
 * Note what is absent: no route CREATES a project. Project creation is
 * web-triggered generation, which is slice 5.
 */
import type { DatabaseSync } from "node:sqlite";
import { sendJson, type Route } from "./router.ts";
import { requireSession } from "./require-session.ts";
import { requireProject } from "./require-project.ts";
import { listProjectsByOwner, type Project } from "./projects.ts";

/** Explicit field list: owner_id is deliberately not shipped to the client. */
function publicView(project: Project) {
  return {
    id: project.id,
    name: project.name,
    directory: project.directory,
    createdAt: project.createdAt,
  };
}

export function projectRoutes(deps: { db: DatabaseSync }): Route[] {
  const { db } = deps;
  return [
    {
      method: "GET",
      path: "/api/projects",
      handler: requireSession(db, (_req, res, ctx) => {
        sendJson(res, 200, {
          projects: listProjectsByOwner(db, ctx.user.id).map(publicView),
        });
      }),
    },
    {
      method: "GET",
      path: "/api/projects/:id",
      handler: requireProject(db, { from: "param", name: "id" }, (_req, res, ctx) => {
        sendJson(res, 200, publicView(ctx.project));
      }),
    },
  ];
}
