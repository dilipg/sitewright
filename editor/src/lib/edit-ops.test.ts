/**
 * The layer between an agent's answer and the override store. Every test here
 * is a way the agent can be wrong; the product requirement is that being wrong
 * changes nothing at all.
 */
import { describe, expect, it } from "vitest";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import type { EditOperation } from "@website-generator/compiler/src/edit-protocol.ts";
import { STYLE_PROPERTIES } from "@website-generator/compiler/src/style-properties.ts";
import type { OverridesMap } from "./store";
import { applyEditOperations, interpretEditResult, validateEditOperations } from "./edit-ops";

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

describe("interpretEditResult", () => {
  /**
   * These payloads are the REAL agent's output shape, not the mock's.
   * `orchestrator.edit_agent._normalize` returns
   *   {"operations": [...], "clarify": None, "structural": None, "notes": ...}
   * so every absent field crosses the wire as an explicit JSON `null`, while
   * `mockEditOperations` omits the same keys (they arrive `undefined`). Every
   * automated test ran in mock mode, so a check of `!== undefined` passed
   * everything in CI and failed every real prompt.
   */
  const REAL_OPERATIONS_PAYLOAD = JSON.parse(
    '{"operations": [{"op": "text", "nodeId": "home.hero.headline", "value": "Shorter"}],' +
      ' "clarify": null, "structural": null, "notes": "shortened the headline", "model": "stub"}',
  ) as Parameters<typeof interpretEditResult>[0];

  it("reads a real agent payload whose absent fields are explicit nulls", () => {
    const outcome = interpretEditResult(REAL_OPERATIONS_PAYLOAD);
    expect(outcome.kind).toBe("operations");
    expect(outcome.kind === "operations" && outcome.operations).toHaveLength(1);
    expect(outcome.kind === "operations" && outcome.notes).toBe("shortened the headline");
  });

  it("reads a real clarify payload, whose structural field is null", () => {
    const outcome = interpretEditResult(
      JSON.parse('{"operations": [], "clarify": "which button?", "structural": null, "notes": "ambiguous"}'),
    );
    expect(outcome).toEqual({ kind: "clarify", question: "which button?" });
  });

  it("reads a real structural payload, whose clarify field is null", () => {
    const outcome = interpretEditResult(
      JSON.parse(
        '{"operations": [], "clarify": null, "notes": "structural",' +
          ' "structural": {"kind": "add-section", "route": "home", "reason": "needs generation"}}',
      ),
    );
    expect(outcome).toEqual({ kind: "structural", structuralKind: "add-section", reason: "needs generation" });
  });

  it("reads the mock's shape too, where the same fields are simply absent", () => {
    expect(
      interpretEditResult({ operations: [{ op: "text", nodeId: "home.hero.headline", value: "Hi" }], notes: "mock" }).kind,
    ).toBe("operations");
    expect(interpretEditResult({ operations: [], clarify: "which button?", notes: "mock" }).kind).toBe("clarify");
  });

  it("surfaces a server error ahead of everything else", () => {
    expect(interpretEditResult({ error: "boom", operations: [] })).toEqual({ kind: "error", message: "boom" });
  });
});

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

  it("rejects a sectionOrder naming an id that is not an active section", () => {
    // Mirrors the exporter's validateSectionOrder (compiler/src/exporter.ts),
    // which hard-fails an export on the same case: a hallucinated or
    // tombstoned id in the order used to pass validation here and only ever
    // surface at export time, far from the override that caused it.
    // home.hero.gone is tombstoned in this manifest, so it can never be a
    // valid member of an order.
    const errors = validateEditOperations(
      [{ op: "sectionOrder", route: "home", order: ["home.hero", "home.faq", "home.hero.gone"] }],
      MANIFEST, TOKENS, "home",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/home\.hero\.gone/);
  });

  it("rejects a sectionOrder that lists the same section more than once", () => {
    // Same mirrored rule: the exporter also rejects a duplicate id, since a
    // duplicate implies at least one other section is silently missing.
    const errors = validateEditOperations(
      [{ op: "sectionOrder", route: "home", order: ["home.hero", "home.faq", "home.hero"] }],
      MANIFEST, TOKENS, "home",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/home\.hero/);
  });

  it("rejects a style property the exporter has no utility mapping for", () => {
    // fontFamily is the shape of the whole class: the tool schema let the agent
    // ask for it, the shim applies ANY css property so the preview showed it,
    // it persisted — and then the export hard-failed in compileUtilityClass.
    const errors = validateEditOperations(
      [{ op: "style", nodeId: "home.hero", property: "fontFamily", token: "color.semantic.accent" }],
      MANIFEST, TOKENS, "home",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/fontFamily/);
  });

  it("rejects an unsupported property on styleExact and layout as well", () => {
    // Same compileUtilityClass call at export time, so the same closed list.
    expect(
      validateEditOperations([{ op: "styleExact", nodeId: "home.hero", property: "opacity", value: "0.5" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
    expect(
      validateEditOperations([{ op: "layout", nodeId: "home.hero", property: "borderColor", value: "red" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("accepts every property the compiler declares exportable", () => {
    // The other half of the same guarantee: validation must not be STRICTER
    // than the exporter either, or a legitimate edit is refused for no reason.
    for (const property of STYLE_PROPERTIES) {
      expect(
        validateEditOperations([{ op: "layout", nodeId: "home.hero", property, value: "16px" }], MANIFEST, TOKENS, "home"),
        `${property} should be accepted`,
      ).toEqual([]);
    }
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

describe("required fields, per operation kind", () => {
  // EditOperation is one all-optional shape for six operations, so nothing in
  // the type system catches a missing field. Each of these used to be applied:
  // `applyEditOperations` asserted the field away with `!` and wrote an
  // `undefined` key or value into the override map, which failed at export
  // rather than here.
  it("rejects a style operation with no property", () => {
    const errors = validateEditOperations(
      [{ op: "style", nodeId: "home.hero", token: "color.semantic.accent" }], MANIFEST, TOKENS, "home",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/property/);
  });

  it("rejects a text operation with no value", () => {
    expect(
      validateEditOperations([{ op: "text", nodeId: "home.hero.headline" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("rejects a style operation with no token", () => {
    expect(
      validateEditOperations([{ op: "style", nodeId: "home.hero", property: "background" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("rejects a visibility operation with no hidden flag", () => {
    expect(
      validateEditOperations([{ op: "visibility", nodeId: "home.hero" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("accepts hidden: false, which is a value and not an omission", () => {
    expect(
      validateEditOperations([{ op: "visibility", nodeId: "home.hero", hidden: false }], MANIFEST, TOKENS, "home"),
    ).toEqual([]);
  });

  it("rejects a sectionOrder operation with no order", () => {
    expect(
      validateEditOperations([{ op: "sectionOrder", route: "home" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("rejects a field of the wrong type", () => {
    expect(
      validateEditOperations(
        [{ op: "sectionOrder", route: "home", order: "home.hero" as unknown as string[] }], MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(1);
  });

  it("rejects an operation kind it has never heard of", () => {
    expect(
      validateEditOperations(
        [{ op: "delete" as EditOperation["op"], nodeId: "home.hero" }], MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(1);
  });
});

describe("applyEditOperations", () => {
  it("applies every operation to one map", () => {
    const map = applyEditOperations({}, [
      { op: "text", nodeId: "home.hero.headline", value: "Hi" },
      { op: "style", nodeId: "home.hero", property: "background", token: "color.semantic.accent" },
      { op: "visibility", nodeId: "home.hero", hidden: true },
    ]);

    expect(map["home.hero.headline"]!.text).toBe("Hi");
    expect(map["home.hero"]!.style).toEqual({ background: "color.semantic.accent" });
    expect(map["home.hero"]!.visibility).toBe(true);
  });

  it("keys a sectionOrder operation by the route, as the store does", () => {
    const map = applyEditOperations({}, [{ op: "sectionOrder", route: "home", order: ["home.faq", "home.hero"] }]);
    expect(map.home!.sectionOrder).toEqual(["home.faq", "home.hero"]);
  });

  it("writes the order it was given, without filtering it against live geometry", () => {
    // The order used to be filtered against the caller's list of RENDERED
    // sections, which App sources from live shim geometry. A virtualized frame
    // reports none, so the filter dropped every id and persisted an empty
    // order — which fails the export until the user finds and clears it.
    // Completeness is already checked against the manifest by validation.
    const map = applyEditOperations({}, [
      { op: "sectionOrder", route: "home", order: ["home.faq", "home.hero"] },
    ]);
    expect(map.home!.sectionOrder).toEqual(["home.faq", "home.hero"]);
    expect(map.home!.sectionOrder).not.toEqual([]);
  });

  it("routes an image replace through the text channel with its key", () => {
    const map = applyEditOperations({}, [{ op: "text", nodeId: "home.hero.headline", value: "/img.png", key: "src" }]);
    expect(map["home.hero.headline"]!.text).toEqual({ key: "src", value: "/img.png" });
  });

  it("does not mutate the map it is given, nor anything nested inside it", () => {
    // A populated map: with `{}` there is no existing channel object or array
    // for a shallow-copy bug to reach through, so the test could not fail.
    const before: OverridesMap = {
      "home.hero": { style: { background: "color.semantic.accent" }, visibility: false },
      "home.hero.headline": { text: "Original" },
      home: { sectionOrder: ["home.hero", "home.faq"] },
    };
    const untouched = structuredClone(before);

    applyEditOperations(before, [
      { op: "text", nodeId: "home.hero.headline", value: "Changed" },
      { op: "style", nodeId: "home.hero", property: "color", token: "color.semantic.accent" },
      { op: "layout", nodeId: "home.hero", property: "marginTop", value: "16px" },
      { op: "visibility", nodeId: "home.hero", hidden: true },
      { op: "sectionOrder", route: "home", order: ["home.faq", "home.hero"] },
    ]);

    expect(before).toEqual(untouched);
  });
});

/**
 * A text op on an Image node must carry key "src".
 *
 * FROM A LIVE EDIT-AGENT CALL, made the moment Image nodes became
 * text-editable: the agent returned `{op:"text", nodeId:"…​.image",
 * value:"https://…"}` with no key. Both halves of the system then disagree in
 * the worst possible direction — the shim sets `textContent` on a void `<img>`
 * (no visible change, edit reported as applied) and the exporter throws, because
 * a self-closing element has no text-bearing child. An invisible override that
 * kills the export later is precisely the preview ≠ handover failure the
 * override layer exists to prevent.
 */
describe("a text edit on an image must replace its src", () => {
  const imageManifest = {
    nodes: {
      "home.gallery": { route: "/", file: "f.tsx", component: "G", element: "section", editable: ["style", "visibility"], status: "active" },
      "home.gallery.photo": { route: "/", file: "f.tsx", component: "G", element: "Image", editable: ["text", "style", "visibility"], status: "active" },
      "home.gallery.caption": { route: "/", file: "f.tsx", component: "G", element: "Text", editable: ["text", "style"], status: "active" },
    },
  } as unknown as Manifest;

  // (ops, manifest, tokenPaths, route) — activeSections are derived inside.
  const validate = (ops: EditOperation[]) =>
    validateEditOperations(ops, imageManifest, new Set(["color.brand"]), "home");

  it("refuses a keyless text op on an Image — the exact payload the agent produced", () => {
    const errors = validate([
      { op: "text", nodeId: "home.gallery.photo", value: "https://example.com/x.jpg" },
    ]);
    expect(errors).toHaveLength(1);
    // The message must say what to do, not just that it is wrong: this text is
    // what the user reads when their instruction does not land.
    expect(errors[0]).toContain("src");
  });

  it("accepts the same op WITH key src", () => {
    expect(
      validate([{ op: "text", nodeId: "home.gallery.photo", key: "src", value: "https://example.com/x.jpg" }]),
    ).toEqual([]);
  });

  it("refuses some other key on an Image", () => {
    // PRD 3.5 defines `src`, and the agent's own tool schema says 'only "src"'.
    const errors = validate([
      { op: "text", nodeId: "home.gallery.photo", key: "alt", value: "a mug" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("alt");
  });

  it("leaves ordinary text nodes completely alone", () => {
    // The rule is keyed to `element === "Image"`, so a keyless text edit on a
    // Text node — every ordinary copy edit — must be unaffected.
    expect(validate([{ op: "text", nodeId: "home.gallery.caption", value: "Hand-thrown" }])).toEqual([]);
  });

  it("still refuses a channel the manifest does not declare, and says so about images", () => {
    // A site generated before templates required `text` on Image nodes: the
    // refusal stands (PRD 3.6#4), and the message routes the user to the
    // inspector control that does work.
    const legacy = {
      nodes: {
        "home.gallery.photo": { route: "/", file: "f.tsx", component: "G", element: "Image", editable: ["style", "visibility"], status: "active" },
      },
    } as unknown as Manifest;
    const errors = validateEditOperations(
      [{ op: "text", nodeId: "home.gallery.photo", key: "src", value: "https://example.com/x.jpg" }],
      legacy,
      new Set(),
      "home",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Image field");
  });
});
