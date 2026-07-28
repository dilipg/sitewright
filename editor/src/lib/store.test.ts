import { describe, expect, it } from "vitest";
import {
  applyLayoutProperty,
  applyStyleProperty,
  applyTextValue,
  applyVisibility,
  currentSnapshot,
  fromOverrideFile,
  initHistory,
  pushHistory,
  redo,
  removeNodeOverrides,
  toOverrideFile,
  undo,
} from "./store";

describe("override store: style merge", () => {
  it("merges properties into one style value per node (contract 6.1: one entry per node+channel)", () => {
    let map = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    map = applyStyleProperty(map, "home.hero", "padding", "space.8");
    expect(map["home.hero"]?.style).toEqual({
      background: "color.semantic.accent",
      padding: "space.8",
    });
  });

  it("later edits replace earlier values for the same property", () => {
    let map = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    map = applyStyleProperty(map, "home.hero", "background", "color.semantic.surface");
    expect(map["home.hero"]?.style).toEqual({ background: "color.semantic.surface" });
  });

  it("does not mutate the previous map", () => {
    const before = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    applyStyleProperty(before, "home.hero", "background", "color.semantic.surface");
    expect(before["home.hero"]?.style).toEqual({ background: "color.semantic.accent" });
  });
});

describe("override store: text channel", () => {
  it("sets the node's text value", () => {
    const map = applyTextValue({}, "home.hero.headline", "New headline");
    expect(map["home.hero.headline"]?.text).toBe("New headline");
  });

  it("a later edit replaces the earlier value", () => {
    let map = applyTextValue({}, "home.hero.headline", "First");
    map = applyTextValue(map, "home.hero.headline", "Second");
    expect(map["home.hero.headline"]?.text).toBe("Second");
  });

  it("does not mutate the previous map, and coexists with a style edit on the same node", () => {
    const withStyle = applyStyleProperty({}, "home.hero.headline", "color", "color.semantic.accent");
    const withText = applyTextValue(withStyle, "home.hero.headline", "New headline");
    expect(withText["home.hero.headline"]).toEqual({
      style: { color: "color.semantic.accent" },
      text: "New headline",
    });
    expect(withStyle["home.hero.headline"]?.text).toBeUndefined(); // input untouched
  });
});

describe("override store: layout channel (contract 6.1: size/position deltas from drag/resize)", () => {
  it("merges properties into one layout value per node, distinct from style", () => {
    let map = applyLayoutProperty({}, "home.hero", "marginLeft", "space.4");
    map = applyLayoutProperty(map, "home.hero", "marginTop", "space.2");
    expect(map["home.hero"]?.layout).toEqual({ marginLeft: "space.4", marginTop: "space.2" });
    expect(map["home.hero"]?.style).toBeUndefined();
  });

  it("later edits replace earlier values for the same property", () => {
    let map = applyLayoutProperty({}, "home.hero", "width", "space.24");
    map = applyLayoutProperty(map, "home.hero", "width", "space.16");
    expect(map["home.hero"]?.layout).toEqual({ width: "space.16" });
  });

  it("does not mutate the previous map, and coexists with a style edit on the same node", () => {
    const withStyle = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    const withLayout = applyLayoutProperty(withStyle, "home.hero", "marginTop", "space.4");
    expect(withLayout["home.hero"]).toEqual({
      style: { background: "color.semantic.accent" },
      layout: { marginTop: "space.4" },
    });
    expect(withStyle["home.hero"]?.layout).toBeUndefined(); // input untouched
  });
});

describe("override store: visibility channel", () => {
  it("sets the node hidden", () => {
    const map = applyVisibility({}, "home.hero.subheadline", true);
    expect(map["home.hero.subheadline"]?.visibility).toBe(true);
  });

  it("toggling back off replaces the value (still one entry per node+channel)", () => {
    let map = applyVisibility({}, "home.hero.subheadline", true);
    map = applyVisibility(map, "home.hero.subheadline", false);
    expect(map["home.hero.subheadline"]?.visibility).toBe(false);
  });

  it("does not mutate the previous map", () => {
    const before = applyVisibility({}, "home.hero.subheadline", true);
    applyVisibility(before, "home.hero.subheadline", false);
    expect(before["home.hero.subheadline"]?.visibility).toBe(true);
  });
});

describe("override store: contract 6.1 serialization", () => {
  it("serializes to one entry per node+channel with the route", () => {
    let map = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    map = applyStyleProperty(map, "home.hero.headline", "marginTop", "space.8");
    const file = toOverrideFile(map, "/");
    expect(file.version).toBe(1);
    expect(file.route).toBe("/");
    expect(file.overrides).toHaveLength(2);
    const hero = file.overrides.find((entry) => entry.nodeId === "home.hero");
    expect(hero?.channel).toBe("style");
    expect(hero?.value).toEqual({ background: "color.semantic.accent" });
    expect(typeof hero?.updatedAt).toBe("string");
  });

  it("round-trips through fromOverrideFile", () => {
    let map = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    const file = toOverrideFile(map, "/");
    expect(fromOverrideFile(file)).toEqual(map);
  });
});

describe("override store: orphan discard", () => {
  it("removeNodeOverrides drops every channel for the node, immutably", () => {
    let map = applyStyleProperty({}, "home.hero.subheadline", "color", "color.semantic.accent");
    map = applyStyleProperty(map, "home.hero.headline", "background", "color.semantic.surface");
    const next = removeNodeOverrides(map, "home.hero.subheadline");
    expect(next["home.hero.subheadline"]).toBeUndefined();
    expect(next["home.hero.headline"]).toBeDefined();
    expect(map["home.hero.subheadline"]).toBeDefined(); // input untouched
  });
});

describe("override store: undo/redo history", () => {
  it("undo restores the previous snapshot; redo reapplies", () => {
    const first = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    const second = applyStyleProperty(first, "home.hero", "padding", "space.8");
    let history = initHistory({});
    history = pushHistory(history, first);
    history = pushHistory(history, second);

    expect(currentSnapshot(history)).toEqual(second);
    history = undo(history);
    expect(currentSnapshot(history)).toEqual(first);
    history = undo(history);
    expect(currentSnapshot(history)).toEqual({});
    history = redo(history);
    expect(currentSnapshot(history)).toEqual(first);
  });

  it("undo at the bottom and redo at the top are no-ops", () => {
    let history = initHistory({});
    expect(currentSnapshot(undo(history))).toEqual({});
    history = pushHistory(history, applyStyleProperty({}, "a.b", "padding", "space.4"));
    expect(redo(history)).toEqual(history);
  });

  it("a new edit after undo discards the redo branch", () => {
    const first = applyStyleProperty({}, "home.hero", "background", "color.semantic.accent");
    const fork = applyStyleProperty({}, "home.hero", "background", "color.semantic.surface");
    let history = pushHistory(initHistory({}), first);
    history = undo(history);
    history = pushHistory(history, fork);
    expect(currentSnapshot(history)).toEqual(fork);
    expect(currentSnapshot(redo(history))).toEqual(fork);
  });
});
