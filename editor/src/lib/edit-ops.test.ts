/**
 * The layer between an agent's answer and the override store. Every test here
 * is a way the agent can be wrong; the product requirement is that being wrong
 * changes nothing at all.
 */
import { describe, expect, it } from "vitest";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import { applyEditOperations, validateEditOperations } from "./edit-ops";

const MANIFEST = {
  version: 1,
  nodes: {
    "home.hero": { route: "/", file: "f", component: "Hero", element: "section", editable: ["style", "layout", "visibility"], status: "active" },
    "home.hero.headline": { route: "/", file: "f", component: "Hero", element: "Heading", editable: ["text", "style"], status: "active" },
    "home.faq": { route: "/", file: "f", component: "Faq", element: "section", editable: ["style"], status: "active" },
    "home.hero.gone": { route: "/", file: "f", component: "Hero", element: "Text", editable: ["text"], status: "tombstoned" },
    "shop.grid": { route: "/shop", file: "f", component: "Grid", element: "section", editable: ["style"], status: "active" },
  },
} as unknown as Manifest;

const TOKENS = new Set(["color.semantic.accent", "space.4"]);
const SECTIONS = ["home.hero", "home.faq"];

describe("validateEditOperations", () => {
  it("accepts an operation on a channel the node declares", () => {
    expect(
      validateEditOperations([{ op: "text", nodeId: "home.hero.headline", value: "Hi" }], MANIFEST, TOKENS, "home"),
    ).toEqual([]);
  });

  it("rejects an unknown node id", () => {
    // The most likely agent error, and the one that must never reach disk.
    const errors = validateEditOperations(
      [{ op: "text", nodeId: "home.hero.invented", value: "Hi" }], MANIFEST, TOKENS, "home",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/home\.hero\.invented/);
  });

  it("rejects a tombstoned node", () => {
    expect(
      validateEditOperations([{ op: "text", nodeId: "home.hero.gone", value: "Hi" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("rejects a channel the node does not declare editable", () => {
    // home.hero.headline has no layout channel.
    expect(
      validateEditOperations(
        [{ op: "layout", nodeId: "home.hero.headline", property: "marginTop", value: "16px" }], MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(1);
  });

  it("rejects a style token that does not exist in this project", () => {
    // The fidelity guarantee, enforced a second time on our side of the wire.
    expect(
      validateEditOperations(
        [{ op: "style", nodeId: "home.hero", property: "background", token: "color.semantic.nope" }], MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(1);
  });

  it("rejects a node on another route", () => {
    expect(
      validateEditOperations([{ op: "style", nodeId: "shop.grid", property: "background", token: "color.semantic.accent" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("rejects a sectionOrder that omits a section", () => {
    // Same rule the exporter enforces (7.5): a partial order silently drops a
    // section, and the omission looks like a reorder rather than a deletion.
    expect(
      validateEditOperations([{ op: "sectionOrder", route: "home", order: ["home.hero"] }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("accepts a complete sectionOrder", () => {
    expect(
      validateEditOperations([{ op: "sectionOrder", route: "home", order: ["home.faq", "home.hero"] }], MANIFEST, TOKENS, "home"),
    ).toEqual([]);
  });

  it("reports every problem in one pass, not just the first", () => {
    // The user should see everything wrong at once rather than one per retry.
    expect(
      validateEditOperations(
        [
          { op: "text", nodeId: "home.hero.invented", value: "Hi" },
          { op: "style", nodeId: "home.hero", property: "background", token: "color.semantic.nope" },
        ],
        MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(2);
  });
});

describe("applyEditOperations", () => {
  it("applies every operation to one map", () => {
    const map = applyEditOperations({}, [
      { op: "text", nodeId: "home.hero.headline", value: "Hi" },
      { op: "style", nodeId: "home.hero", property: "background", token: "color.semantic.accent" },
      { op: "visibility", nodeId: "home.hero", hidden: true },
    ], SECTIONS);

    expect(map["home.hero.headline"]!.text).toBe("Hi");
    expect(map["home.hero"]!.style).toEqual({ background: "color.semantic.accent" });
    expect(map["home.hero"]!.visibility).toBe(true);
  });

  it("keys a sectionOrder operation by the route, as the store does", () => {
    const map = applyEditOperations({}, [{ op: "sectionOrder", route: "home", order: ["home.faq", "home.hero"] }], SECTIONS);
    expect(map.home!.sectionOrder).toEqual(["home.faq", "home.hero"]);
  });

  it("routes an image replace through the text channel with its key", () => {
    const map = applyEditOperations({}, [{ op: "text", nodeId: "home.hero.headline", value: "/img.png", key: "src" }], SECTIONS);
    expect(map["home.hero.headline"]!.text).toEqual({ key: "src", value: "/img.png" });
  });

  it("does not mutate the map it is given", () => {
    const before = {};
    applyEditOperations(before, [{ op: "text", nodeId: "home.hero.headline", value: "Hi" }], SECTIONS);
    expect(before).toEqual({});
  });
});
