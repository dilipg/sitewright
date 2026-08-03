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

export function mockEditOperations(instruction: string, route: string): EditAgentResult {
  const text = instruction.toLowerCase();

  if (instruction.includes("INVALID")) {
    return {
      operations: [{ op: "visibility", nodeId: `${route}.does-not-exist`, hidden: true }],
      notes: "mock: an operation naming an unknown node",
    };
  }
  if (text.includes("add ") && text.includes("section")) {
    return {
      operations: [],
      structural: { kind: "add-section", route, archetype: "social-proof", reason: "adding a section requires generation" },
      notes: "mock: structural request",
    };
  }
  if (text.includes("button")) {
    return { operations: [], clarify: "Which button — the primary or the secondary one?", notes: "mock: ambiguous" };
  }
  if (text.includes("accent") || text.includes("colour") || text.includes("color")) {
    return {
      operations: [
        { op: "style", nodeId: `${route}.hero.headline`, property: "color", token: "color.semantic.accent" },
      ],
      notes: "mock: recoloured the headline",
    };
  }
  if (text.includes("shorter") || text.includes("headline")) {
    return {
      operations: [{ op: "text", nodeId: `${route}.hero.headline`, value: "A shorter headline" }],
      notes: "mock: shortened the headline",
    };
  }
  return { operations: [], notes: "mock: no match" };
}
