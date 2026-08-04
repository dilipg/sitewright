/**
 * Deterministic operations for mock mode (WG_REGEN_MOCK=1), so the editor's
 * prompt UX is e2e-testable without model spend.
 *
 * Keyword-matched on purpose: it is not a second implementation of the agent,
 * it is a fixed set of responses covering each branch the editor must handle —
 * edits, a clarify, a structural verdict, and an invalid batch. Anything it
 * cannot match returns an empty result, which the editor reports as
 * "could not resolve" exactly as a failed real call would.
 */
import type { EditAgentResult } from "./edit-protocol.ts";

/**
 * The mock's actual return shape — `EditAgentResult` widened to require
 * `clarify`/`structural` explicitly, as `null` rather than absent.
 *
 * `edit-protocol.ts`'s `EditAgentResult` predates this convention (it types
 * both fields as merely optional) and is a known, deliberately deferred stale
 * spot — left alone here. But the REAL agent, `orchestrator/.../edit_agent.py`'s
 * `_normalize` and its other two return sites, always emits an explicit
 * `None`/JSON `null` for an absent field, never omits the key. The mock used
 * to omit the same keys instead, which is a different wire shape — and since
 * every automated test only ever ran in mock mode, that shape difference hid
 * a Critical bug: a `!== undefined` check downstream passed every mock
 * response and failed 100% of real ones, while CI stayed green throughout.
 * Matching the real shape here is what makes the editor's test suite
 * actually exercise the shape production sends.
 */
type MockEditResult = Omit<EditAgentResult, "clarify" | "structural"> & {
  clarify: string | null;
  structural: NonNullable<EditAgentResult["structural"]> | null;
};

export function mockEditOperations(instruction: string, route: string): MockEditResult {
  const text = instruction.toLowerCase();

  if (instruction.includes("INVALID")) {
    return {
      operations: [{ op: "visibility", nodeId: `${route}.does-not-exist`, hidden: true }],
      clarify: null,
      structural: null,
      notes: "mock: an operation naming an unknown node",
    };
  }
  if (text.includes("add ") && text.includes("section")) {
    return {
      operations: [],
      clarify: null,
      structural: { kind: "add-section", route, archetype: "social-proof", reason: "adding a section requires generation" },
      notes: "mock: structural request",
    };
  }
  if (text.includes("button")) {
    return {
      operations: [],
      clarify: "Which button — the primary or the secondary one?",
      structural: null,
      notes: "mock: ambiguous",
    };
  }
  // A specific colour instruction targeting the cta-band heading, checked
  // before the general accent/colour/color branch below (which shares its
  // keywords) so it cannot be shadowed by it — this is the invariant
  // suite's proof that an agent-authored style override survives export
  // exactly as a canvas-authored one does, on a node the general branch
  // does not touch.
  //
  // Token is accentContrast, not accent: the invariant suite's earlier
  // cta-band cases already set the SECTION's own background to the accent
  // token, and this heading has no background of its own, so recolouring
  // its TEXT to that same accent token would make it blend invisibly into
  // its own background by the time every case's edits have accumulated
  // (found by a real invariant-suite failure — the pixel diff still passed,
  // because both sides rendered the identical invisible block, but the
  // heading's own typography stopped being compared by anything). accentContrast
  // is the token the design system already pairs with accent for exactly
  // this reason (see Button's "primary" variant), so the heading stays
  // legible and the override is still visibly distinguishable from the
  // Heading primitive's own default text colour.
  if (text.includes("accent colour change")) {
    return {
      operations: [
        { op: "style", nodeId: `${route}.cta-band.heading`, property: "color", token: "color.semantic.accentContrast" },
      ],
      clarify: null,
      structural: null,
      notes: "mock: recoloured the cta-band heading",
    };
  }
  if (text.includes("accent") || text.includes("colour") || text.includes("color")) {
    return {
      operations: [
        { op: "style", nodeId: `${route}.hero.headline`, property: "color", token: "color.semantic.accent" },
      ],
      clarify: null,
      structural: null,
      notes: "mock: recoloured the headline",
    };
  }
  if (text.includes("shorter") || text.includes("headline")) {
    return {
      operations: [{ op: "text", nodeId: `${route}.hero.headline`, value: "A shorter headline" }],
      clarify: null,
      structural: null,
      notes: "mock: shortened the headline",
    };
  }
  // A compound instruction touching two distinct nodes in one batch — every
  // other branch above returns at most one operation, which cannot tell
  // "pushHistory once per prompt" apart from "pushHistory once per
  // operation" (1 op either way = 1 push either way). This is the only
  // branch that can prove the editor treats a whole prompt as one entry.
  if (text.includes("eyebrow") && text.includes("subhead")) {
    return {
      operations: [
        { op: "text", nodeId: `${route}.hero.eyebrow`, value: "New eyebrow copy" },
        { op: "text", nodeId: `${route}.hero.subheadline`, value: "New subheadline copy" },
      ],
      clarify: null,
      structural: null,
      notes: "mock: a compound edit touching two nodes",
    };
  }
  return { operations: [], clarify: null, structural: null, notes: "mock: no match" };
}
