import { describe, expect, it } from "vitest";
import {
  applyStyleProperty,
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
