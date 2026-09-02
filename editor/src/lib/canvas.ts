/**
 * Pure math for the infinite pan/zoom canvas (PRD 2.1): route layout,
 * viewport pan/zoom, and the virtualization boundary (PRD risk 2 — only
 * frames in/near the viewport run live).
 */

import type { Manifest } from "@sitewright/compiler/src/manifest.ts";
import type { OverridesMap } from "./store";

export interface RouteInfo {
  slug: string;
  path: string;
}

/**
 * Is this parsed JSON actually a manifest? ONE definition, shared by BOTH
 * readers of `manifest.json`.
 *
 * WHOLE-BRANCH REVIEW, C2. The branch's own finding-B fix added this check to
 * `App.tsx`'s `refreshManifest` and left the OTHER reader — the canvas
 * bootstrap, four hundred lines above in the same file — reading `.json()`
 * straight into state; task 3's project picker then made that reader reachable
 * in one click. A project whose directory is still empty (`POST /api/generate`
 * creates the row and the directory ~11 minutes before the files exist, and a
 * failed generation leaves one forever) answers with the preview pool's own
 * JSON failure body, so `manifest` became `{error: "…"}`: non-null, with no
 * `nodes`. `routesFromManifest` below then threw `TypeError: Cannot convert
 * undefined or null to object` inside a `useMemo` DURING RENDER, with no error
 * boundary anywhere above it — a blank page with no route back, since the
 * picker only renders when `?project=` is absent.
 *
 * It lives here, immediately beside the one function that indexes
 * `manifest.nodes`, so the guard and the code it protects cannot drift apart.
 * A type predicate rather than a boolean helper so a caller cannot forget to
 * narrow: the value is `unknown` until this says otherwise.
 */
export function isManifestShaped(value: unknown): value is Manifest {
  if (value === null || typeof value !== "object") return false;
  const nodes = (value as { nodes?: unknown }).nodes;
  return typeof nodes === "object" && nodes !== null;
}

/** Routes are derived from the manifest, not fetched separately — every
 * active node's id is prefixed with its route slug, and carries the route's
 * real path, so the full route list is already implied by data the editor
 * loads anyway (contract: manifest.json is the node registry). */
export function routesFromManifest(manifest: Manifest): RouteInfo[] {
  const routes = new Map<string, string>();
  for (const [nodeId, node] of Object.entries(manifest.nodes)) {
    if (node.status !== "active") continue;
    const slug = nodeId.split(".")[0]!;
    if (!routes.has(slug)) routes.set(slug, node.route);
  }
  return [...routes.entries()].map(([slug, path]) => ({ slug, path }));
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Frames render at desktop width (1280px, PRD 2.1) laid out side by side,
 * Figma-page style, with a gap wide enough to read each frame's label. */
export const FRAME_WIDTH = 1280;
export const FRAME_GAP = 80;

/**
 * Responsive read-only preview (PRD 7 P1). The canvas can render every frame
 * at a narrower device width to check the generated layout holds up.
 *
 * READ-ONLY by design, not by omission: an override carries no breakpoint
 * (contract 6.1), so an edit made while previewing at 390px would silently
 * apply at every width. Rather than imply a responsive edit the override layer
 * cannot express, narrow widths disable editing entirely — the same reasoning
 * that makes layout edits no-reparenting in v1.
 */
export const PREVIEW_WIDTHS = {
  desktop: FRAME_WIDTH,
  tablet: 768,
  mobile: 390,
} as const;

export type PreviewWidth = keyof typeof PREVIEW_WIDTHS;

export function isEditableWidth(width: PreviewWidth): boolean {
  return width === "desktop";
}

export function frameOffsetX(index: number, frameWidth: number = FRAME_WIDTH): number {
  return index * (frameWidth + FRAME_GAP);
}

/** Zooms toward the cursor (screen coordinates), not the stage origin —
 * solves for the new pan offset that keeps the same stage point under the
 * cursor fixed after the zoom changes, which is what makes scroll-to-zoom
 * feel anchored instead of the canvas sliding out from under the cursor. */
export function zoomAt(viewport: Viewport, cursorX: number, cursorY: number, deltaZoom: number): Viewport {
  const nextZoom = clampZoom(viewport.zoom + deltaZoom);
  const stageX = (cursorX - viewport.x) / viewport.zoom;
  const stageY = (cursorY - viewport.y) / viewport.zoom;
  return { zoom: nextZoom, x: cursorX - stageX * nextZoom, y: cursorY - stageY * nextZoom };
}

/** Render-ahead margin (PRD risk 2 virtualization): a frame just outside the
 * viewport stays live so panning by a screen-width doesn't cause a visible
 * pop-in — only frames genuinely far away fall back to a placeholder. */
const RENDER_AHEAD_PX = 400;

/** Each route's override file is persisted separately (preview.ts's
 * per-slug endpoint); node ids are globally unique and route-prefixed, so
 * this is a pure regrouping, not a lookup against the manifest. */
export function splitOverridesByRoute(map: OverridesMap, routes: RouteInfo[]): Record<string, OverridesMap> {
  const result: Record<string, OverridesMap> = {};
  for (const route of routes) result[route.slug] = {};
  for (const [nodeId, channels] of Object.entries(map)) {
    const slug = nodeId.split(".")[0]!;
    if (slug in result) result[slug]![nodeId] = channels;
  }
  return result;
}

/**
 * A route's section roots in the order they actually appear on the page,
 * top to bottom.
 *
 * The manifest is a map, not a sequence — it records that a section exists,
 * never where on the page it sits — so the order is read from the live
 * geometry the shim already reports. That also makes it self-correcting once
 * a reorder is applied: `order` moves the rendered box, so the next report
 * comes back in the new order rather than the authored one.
 */
export function renderedSections(
  geometry: Record<string, { rect: { y: number } }>,
  manifest: Manifest,
  route: string,
): string[] {
  return Object.keys(geometry)
    .filter(
      (nodeId) =>
        nodeId.split(".").length === 2 &&
        nodeId.startsWith(`${route}.`) &&
        manifest.nodes[nodeId]?.status === "active",
    )
    .sort((a, b) => geometry[a]!.rect.y - geometry[b]!.rect.y);
}

export function isFrameNearViewport(
  frameX: number,
  frameWidth: number,
  viewport: Viewport,
  viewportWidth: number,
): boolean {
  const screenLeft = frameX * viewport.zoom + viewport.x;
  const screenRight = screenLeft + frameWidth * viewport.zoom;
  return screenRight >= -RENDER_AHEAD_PX && screenLeft <= viewportWidth + RENDER_AHEAD_PX;
}
