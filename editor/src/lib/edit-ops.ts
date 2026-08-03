/**
 * Between the edit agent's answer and the override store.
 *
 * Everything here exists because the agent can be wrong: it can name a node
 * that does not exist, reach for a channel an archetype never opened, or invent
 * a token. The requirement is that any of those changes NOTHING — validation is
 * all-or-nothing per prompt, so a compound instruction never half-lands.
 */
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import type { EditOperation } from "@website-generator/compiler/src/edit-protocol.ts";
import type { OverridesMap } from "./store";
import {
  applyLayoutProperty,
  applyStyleProperty,
  applyTextValue,
  applyVisibility,
} from "./store";

const CHANNEL_OF: Record<EditOperation["op"], string> = {
  text: "text",
  style: "style",
  styleExact: "style",
  layout: "layout",
  visibility: "visibility",
  sectionOrder: "sectionOrder",
};

/** Rejection reasons; empty means the batch may be applied. */
export function validateEditOperations(
  ops: EditOperation[],
  manifest: Manifest,
  tokenPaths: Set<string>,
  route: string,
): string[] {
  const errors: string[] = [];
  const activeSections = Object.entries(manifest.nodes)
    .filter(([id, node]) => node.status === "active" && id.split(".").length === 2 && id.startsWith(`${route}.`))
    .map(([id]) => id);

  for (const op of ops) {
    if (op.op === "sectionOrder") {
      const order = op.order ?? [];
      const missing = activeSections.filter((id) => !order.includes(id));
      if (op.route !== route) errors.push(`reorder names route "${op.route}" but this page is "${route}"`);
      else if (missing.length > 0) errors.push(`reorder omits ${missing.join(", ")}`);
      continue;
    }

    const nodeId = op.nodeId ?? "";
    const node = manifest.nodes[nodeId];
    if (node === undefined || node.status !== "active") {
      errors.push(`"${nodeId}" is not an editable node on this page`);
      continue;
    }
    if (!nodeId.startsWith(`${route}.`) && nodeId !== route) {
      errors.push(`"${nodeId}" is not on route "${route}"`);
      continue;
    }
    const channel = CHANNEL_OF[op.op];
    if (!(node.editable as string[]).includes(channel)) {
      errors.push(`"${nodeId}" cannot be edited through ${channel}`);
      continue;
    }
    if (op.op === "style" && !tokenPaths.has(op.token ?? "")) {
      errors.push(`"${op.token}" is not a token in this project`);
    }
  }
  return errors;
}

/** Applies a VALIDATED batch. Returns a new map; never mutates the input. */
export function applyEditOperations(
  map: OverridesMap,
  ops: EditOperation[],
  sections: string[],
): OverridesMap {
  let next = { ...map };
  for (const op of ops) {
    switch (op.op) {
      case "text":
        next = applyTextValue(next, op.nodeId!, op.value!, op.key);
        break;
      case "style":
        next = applyStyleProperty(next, op.nodeId!, op.property!, op.token!);
        break;
      case "styleExact":
        next = applyStyleProperty(next, op.nodeId!, op.property!, op.value!);
        break;
      case "layout":
        next = applyLayoutProperty(next, op.nodeId!, op.property!, op.value!);
        break;
      case "visibility":
        next = applyVisibility(next, op.nodeId!, op.hidden === true);
        break;
      case "sectionOrder": {
        // Keyed by the route slug, exactly as moveSection writes it (PRD 3.3).
        const order = (op.order ?? []).filter((id) => sections.includes(id));
        next = { ...next, [op.route!]: { ...next[op.route!], sectionOrder: order } };
        break;
      }
    }
  }
  return next;
}
