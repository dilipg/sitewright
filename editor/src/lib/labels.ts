/**
 * Human-readable names and ancestry for node IDs (PRD 2.3): hover labels,
 * the breadcrumb (page › section › element), and Esc's walk-up target.
 */

import type { Manifest } from "@sitewright/compiler/src/manifest.ts";

const ACRONYMS = new Set(["cta", "faq", "url", "seo", "api"]);

export interface Crumb {
  label: string;
  /** undefined marks the page crumb (page scope = nothing selected). */
  nodeId: string | undefined;
}

export function humanizeSegment(segment: string): string {
  return segment
    .split("-")
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/** Nearest strict ancestor that exists as an active manifest node; undefined = page scope. */
export function parentNodeId(nodeId: string, manifest: Manifest): string | undefined {
  let id = nodeId;
  while (id.includes(".")) {
    id = id.slice(0, id.lastIndexOf("."));
    if (manifest.nodes[id]?.status === "active") return id;
  }
  return undefined;
}

export function breadcrumbFor(nodeId: string | undefined, manifest: Manifest): Crumb[] {
  const routeSlug = nodeId?.split(".")[0] ?? firstRouteSlug(manifest);
  const crumbs: Crumb[] = [{ label: humanizeSegment(routeSlug), nodeId: undefined }];
  if (nodeId === undefined) return crumbs;

  const segments = nodeId.split(".");
  for (let index = 2; index <= segments.length; index += 1) {
    crumbs.push({
      label: humanizeSegment(segments[index - 1]!),
      nodeId: segments.slice(0, index).join("."),
    });
  }
  return crumbs;
}

function firstRouteSlug(manifest: Manifest): string {
  const first = Object.keys(manifest.nodes)[0];
  return first?.split(".")[0] ?? "page";
}
