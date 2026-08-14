import { describe, expect, it } from "vitest";
import {
  CHANNEL_GESTURES,
  CHANNEL_LIST_NOTE,
  describeChannelGesture,
  EMPTY_SELECTION_HINT,
  HOVER_TEXT_EDIT_HINT,
  hoverHintFor,
  SPACING_CHANNEL_NOTE,
  TEXT_EDIT_HINT,
} from "./edit-affordances";
// Vite's own `?raw`, not `node:fs`: this workspace's tsconfig has no node types
// and adding `@types/node` for a test would be a new dependency. Same precedent
// as `App.test.ts`, `ProjectPicker.test.ts` and `GenerationProgress.test.ts`.
import inspectorSource from "../components/Inspector.tsx?raw";

/**
 * `.test.ts`, never `.test.tsx` — the repo precedent and a measured trap: the
 * vitest glob once matched `.test.ts` only, so a `.test.tsx` file was silently
 * skipped. Coverage that never runs is the one failure perturbation cannot
 * detect.
 *
 * DOGFOOD G4 is a WORDING fix, so wording is what these assert, exactly rather
 * than by substring: a tester could not find text editing at all, and every
 * string here is a sentence that was missing from the screen. There is no React
 * testing library in this workspace (and may not be — "no new runtime
 * dependencies"), which is why the strings live in a module of their own and the
 * component's use of them is asserted against its source text.
 */

describe("the text channel's gesture is named, because nothing named it", () => {
  it("states the double-click gesture in the inspector, exactly", () => {
    // Exact, not `/double-click/i`: a substring assertion still passes when the
    // sentence is perturbed into something unusable ("Double-click somewhere"),
    // and this sentence IS the fix.
    expect(TEXT_EDIT_HINT).toBe("Double-click this element on the canvas to edit its text.");
  });

  it("states it on hover too, on the element itself", () => {
    // The hover hint is the half that needs no reading and no scrolling: it
    // appears under the cursor while the user is already pointing at the node.
    expect(HOVER_TEXT_EDIT_HINT).toBe("double-click to edit text");
  });

  it("offers the hover hint only for a node that really has the text channel", () => {
    expect(hoverHintFor(["text", "style", "layout", "visibility"])).toBe(HOVER_TEXT_EDIT_HINT);
    expect(hoverHintFor(["text"])).toBe(HOVER_TEXT_EDIT_HINT);
    // The discriminating direction: advertising a channel a node does not have
    // would send a tester double-clicking at something that cannot respond,
    // which is the same class of impossible advice as telling them to click a
    // placeholder that carries no node id.
    expect(hoverHintFor(["style", "layout", "visibility"])).toBeUndefined();
    expect(hoverHintFor([])).toBeUndefined();
    expect(hoverHintFor(undefined)).toBeUndefined();
  });
});

describe("the empty-selection line no longer says only how to SELECT", () => {
  it("keeps the selection instruction and adds the edit gesture", () => {
    expect(EMPTY_SELECTION_HINT).toBe(
      "Click an element in the preview to select it. Double-click text to edit it.",
    );
  });

  it("is no longer the old sentence alone", () => {
    // The absence half. This line was the ONLY thing the whole app ever said
    // about editing, and it named the one gesture that is not an edit — so the
    // test has to fail if it is ever reduced back to that, which a
    // presence-only assertion on the new half would not do.
    expect(EMPTY_SELECTION_HINT).not.toBe("Click an element in the preview to select it.");
  });
});

describe("the channel list is honest about being a status", () => {
  it("says so in as many words, and says the gesture is written beside each one", () => {
    expect(CHANNEL_LIST_NOTE).toBe(
      "What this element allows — a status, not buttons. Each one says how to make that edit.",
    );
  });

  it("has a gesture for every channel a node can declare, and for sectionOrder", () => {
    // Contract 6.1's four P0 channels, plus the page-level reorder channel (7.5)
    // that never appears in `editable` but is reached from the same panel. A
    // channel with no gesture renders as a bare pill — which is the exact state
    // this fix exists to end.
    for (const channel of ["text", "style", "layout", "visibility", "sectionOrder"]) {
      const gesture = describeChannelGesture(channel);
      expect(gesture, `no gesture for channel "${channel}"`).toBeDefined();
      expect(gesture!.trim()).not.toBe("");
    }
    expect(Object.keys(CHANNEL_GESTURES)).toHaveLength(5);
  });

  it("names the double-click for text and a canvas drag for layout — the two that are NOT in the panel", () => {
    // The two channels with no control in the inspector are the two a user
    // cannot guess. Asserted exactly, because "the controls below" for `text`
    // would be a lie that reads perfectly well.
    expect(describeChannelGesture("text")).toBe("Double-click the element on the canvas.");
    expect(describeChannelGesture("layout")).toBe(
      "Drag the element, or one of its handles, on the canvas.",
    );
    // And the two that ARE in the panel point at it, rather than at the canvas.
    expect(describeChannelGesture("style")).toMatch(/below/);
    expect(describeChannelGesture("visibility")).toMatch(/below/);
  });

  it("answers `undefined` for a channel this build does not know, rather than inventing advice", () => {
    expect(describeChannelGesture("breakpoint")).toBeUndefined();
    expect(describeChannelGesture("")).toBeUndefined();
  });
});

describe("the spacing controls admit which channel they write (G8)", () => {
  it("names both channels, so the override file cannot look like it contradicts the UI", () => {
    // A Margin Top edit persists as `{"channel":"style","value":{"marginTop":
    // "space.6"}}` while the panel also advertises `layout`. Both are correct
    // (contract 6.1: layout is size/position DELTAS, from the drag gesture);
    // only the UI was silent.
    expect(SPACING_CHANNEL_NOTE).toBe(
      "Padding and margins are saved on the style channel. The layout channel is the drag-and-resize gesture on the canvas.",
    );
  });
});

describe("Inspector.tsx: the wiring a library test structurally cannot reach", () => {
  it("renders the text-edit hint from the constant, for a text-editable node", () => {
    // The strings above are worthless if nothing renders them. Perturbation:
    // delete the callout's JSX and this fails, which is the whole point of
    // asserting source text for a component that cannot be mounted here.
    expect(inspectorSource).toContain("TEXT_EDIT_HINT");
    expect(inspectorSource).toContain('data-testid="text-edit-hint"');
    expect(inspectorSource).toContain('node.editable.includes("text")');
  });

  it("renders a gesture beside every channel badge", () => {
    expect(inspectorSource).toContain("describeChannelGesture(channel)");
    expect(inspectorSource).toContain("CHANNEL_LIST_NOTE");
  });

  it("keeps each channel badge's own text EXACTLY the channel name", () => {
    // `editor.spec.ts` asserts `toHaveText(["text","style","layout",
    // "visibility"])` across the badges, so the gesture must be a sibling
    // element and never appended inside the badge. A perturbation that moves the
    // gesture inside the badge fails this AND that Playwright assertion.
    const badge = inspectorSource.slice(
      inspectorSource.indexOf('data-testid="channel-badge"'),
      inspectorSource.indexOf("</span>", inspectorSource.indexOf('data-testid="channel-badge"')),
    );
    expect(badge).toContain("{channel}");
    expect(badge).not.toContain("describeChannelGesture");
  });

  it("states which channel the spacing steppers write", () => {
    expect(inspectorSource).toContain("SPACING_CHANNEL_NOTE");
    expect(inspectorSource).toContain('data-testid="spacing-channel-note"');
  });
});
