/**
 * Pure math for the infinite pan/zoom canvas (PRD 2.1): route layout,
 * viewport pan/zoom, and the virtualization boundary (PRD risk 2 — only
 * frames in/near the viewport run live).
 */

import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import type { OverridesMap } from "./store";

export interface RouteInfo {
  slug: string;
  path: string;
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
