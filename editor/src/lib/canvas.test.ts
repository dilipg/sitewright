import { describe, expect, it } from "vitest";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import {
  clampZoom,
  FRAME_GAP,
  FRAME_WIDTH,
  frameOffsetX,
  isEditableWidth,
  isFrameNearViewport,
  MAX_ZOOM,
  MIN_ZOOM,
  PREVIEW_WIDTHS,
  routesFromManifest,
  splitOverridesByRoute,
  zoomAt,
} from "./canvas";

describe("routesFromManifest", () => {
  it("derives the unique route list (slug + path) from manifest node ids and their route field", () => {
    const manifest: Manifest = {
      version: 1,
      nodes: {
        "home.hero": { route: "/", file: "", component: "", element: "", editable: [], status: "active" },
        "home.hero.headline": { route: "/", file: "", component: "", element: "", editable: [], status: "active" },
        "shop.products": { route: "/shop", file: "", component: "", element: "", editable: [], status: "active" },
      },
    };
    expect(routesFromManifest(manifest)).toEqual([
      { slug: "home", path: "/" },
      { slug: "shop", path: "/shop" },
    ]);
  });

  it("ignores tombstoned nodes when deriving routes, unless another active node covers the same route", () => {
    const manifest: Manifest = {
      version: 1,
      nodes: {
        "home.hero": { route: "/", file: "", component: "", element: "", editable: [], status: "active" },
        "gone.old": { route: "/gone", file: "", component: "", element: "", editable: [], status: "tombstoned" },
      },
    };
    expect(routesFromManifest(manifest)).toEqual([{ slug: "home", path: "/" }]);
  });

  it("returns an empty list for an empty manifest", () => {
    expect(routesFromManifest({ version: 1, nodes: {} })).toEqual([]);
  });
});

describe("clampZoom", () => {
  it("clamps to [MIN_ZOOM, MAX_ZOOM]", () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });
});

describe("frameOffsetX", () => {
  it("lays frames out side by side with a gap, Figma-style", () => {
    expect(frameOffsetX(0)).toBe(0);
    expect(frameOffsetX(1)).toBe(FRAME_WIDTH + FRAME_GAP);
    expect(frameOffsetX(2)).toBe(2 * (FRAME_WIDTH + FRAME_GAP));
  });
});

describe("zoomAt", () => {
  it("keeps the stage point under the cursor fixed when zooming in", () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    // cursor at screen (100, 100) maps to stage (100, 100) at zoom 1, x=y=0
    const next = zoomAt(viewport, 100, 100, 1); // deltaZoom +1 -> zoom 2
    expect(next.zoom).toBe(2);
    // the same stage point (100,100) must still map to screen (100,100):
    // screenX = stageX * zoom + x  =>  100 = 100*2 + x  =>  x = -100
    expect(next.x).toBe(-100);
    expect(next.y).toBe(-100);
  });

  it("clamps the resulting zoom", () => {
    const viewport = { x: 0, y: 0, zoom: MAX_ZOOM };
    expect(zoomAt(viewport, 0, 0, 10).zoom).toBe(MAX_ZOOM);
  });
});

describe("isFrameNearViewport", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const viewportWidth = 1000;

  it("a frame overlapping the viewport is near", () => {
    expect(isFrameNearViewport(0, FRAME_WIDTH, viewport, viewportWidth)).toBe(true);
  });

  it("a frame just past the viewport, within the render-ahead margin, is still near", () => {
    expect(isFrameNearViewport(1200, FRAME_WIDTH, viewport, viewportWidth)).toBe(true);
  });

  it("a frame far outside the viewport is not near", () => {
    expect(isFrameNearViewport(10000, FRAME_WIDTH, viewport, viewportWidth)).toBe(false);
  });

  it("accounts for pan offset, not just raw frame position", () => {
    // panned so the viewport now looks at stage x=5000..6000
    const panned = { x: -5000, y: 0, zoom: 1 };
    expect(isFrameNearViewport(5200, FRAME_WIDTH, panned, viewportWidth)).toBe(true);
    expect(isFrameNearViewport(0, FRAME_WIDTH, panned, viewportWidth)).toBe(false);
  });
});

describe("splitOverridesByRoute", () => {
  const routes = [
    { slug: "home", path: "/" },
    { slug: "shop", path: "/shop" },
  ];

  it("groups override entries by the route slug prefix of their node id", () => {
    const map = {
      "home.hero": { text: "Hi" },
      "home.hero.cta": { visibility: true },
      "shop.products": { style: { color: "red" } },
    };
    expect(splitOverridesByRoute(map, routes)).toEqual({
      home: { "home.hero": { text: "Hi" }, "home.hero.cta": { visibility: true } },
      shop: { "shop.products": { style: { color: "red" } } },
    });
  });

  it("gives every known route an entry even with no overrides for it", () => {
    const result = splitOverridesByRoute({ "home.hero": { text: "Hi" } }, routes);
    expect(result).toEqual({ home: { "home.hero": { text: "Hi" } }, shop: {} });
  });

  it("drops overrides for node ids whose route slug isn't in the known route list", () => {
    const result = splitOverridesByRoute({ "gone.old": { text: "x" } }, routes);
    expect(result).toEqual({ home: {}, shop: {} });
  });
});

describe("responsive read-only preview (PRD 7 P1)", () => {
  it("offers desktop, tablet and mobile widths", () => {
    expect(PREVIEW_WIDTHS).toEqual({ desktop: 1280, tablet: 768, mobile: 390 });
  });

  it("only desktop is editable", () => {
    // An override carries no breakpoint (contract 6.1), so an edit made at
    // 390px would silently apply at every width. Narrow widths are read-only
    // rather than implying a responsive edit the override layer cannot express.
    expect(isEditableWidth("desktop")).toBe(true);
    expect(isEditableWidth("tablet")).toBe(false);
    expect(isEditableWidth("mobile")).toBe(false);
  });

  it("frames re-lay-out at the selected width so they never overlap", () => {
    expect(frameOffsetX(0, PREVIEW_WIDTHS.mobile)).toBe(0);
    expect(frameOffsetX(1, PREVIEW_WIDTHS.mobile)).toBe(390 + FRAME_GAP);
    expect(frameOffsetX(2, PREVIEW_WIDTHS.tablet)).toBe(2 * (768 + FRAME_GAP));
    // and the default stays desktop, so existing callers are unaffected
    expect(frameOffsetX(1)).toBe(FRAME_WIDTH + FRAME_GAP);
  });
});
