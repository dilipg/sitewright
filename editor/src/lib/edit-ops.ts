/**
 * Between the edit agent's answer and the override store.
 *
 * Everything here exists because the agent can be wrong: it can name a node
 * that does not exist, reach for a channel an archetype never opened, or invent
 * a token. The requirement is that any of those changes NOTHING — validation is
 * all-or-nothing per prompt, so a compound instruction never half-lands.
 */
import type { EditableChannel, Manifest } from "@website-generator/compiler/src/manifest.ts";
import type { EditOperation } from "@website-generator/compiler/src/edit-protocol.ts";
import { isSupportedStyleProperty } from "@website-generator/compiler/src/style-properties.ts";
import type { OverridesMap } from "./store";
import {
  applyLayoutProperty,
  applyStyleProperty,
  applyTextValue,
  applyVisibility,
} from "./store";

/**
 * The response body as it arrives on the wire — NOT as any one producer
 * happens to write it. The agent is Python: its `_normalize` emits an explicit
 * `None` for an absent `clarify`/`structural`, which reaches us as JSON `null`.
 * The mock is TypeScript and omits the same keys entirely, so they arrive
 * `undefined`. Both are legal and both must mean "absent".
 */
export interface EditPromptResponse {
  operations?: EditOperation[] | null;
  clarify?: string | null;
  structural?: { kind?: string; route?: string; archetype?: string; reason?: string } | null;
  notes?: string | null;
  error?: string | null;
}

/** What the editor should do with a response: exactly one of four things. */
export type EditPromptOutcome =
  | { kind: "error"; message: string }
  | { kind: "structural"; structuralKind: string; reason: string }
  | { kind: "clarify"; question: string }
  | { kind: "operations"; operations: EditOperation[]; notes: string };

function presentString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Reads one `/__edit-prompt` response into the branch the editor must take.
 *
 * Pure, and separate from the component, because this is the seam where the
 * two producers (real agent, mock) disagree in shape: everything automated ran
 * against the mock, so a null-vs-undefined mismatch here failed 100% of real
 * prompts while every test stayed green.
 */
export function interpretEditResult(raw: EditPromptResponse): EditPromptOutcome {
  const error = presentString(raw.error);
  if (error !== undefined) return { kind: "error", message: error };

  // `!= null`, not `!== undefined`: the real agent nulls these fields and the
  // mock omits them. Both mean absent.
  if (raw.structural != null && typeof raw.structural === "object") {
    return {
      kind: "structural",
      structuralKind: presentString(raw.structural.kind) ?? "structural change",
      reason: presentString(raw.structural.reason) ?? "This needs new or rewritten content.",
    };
  }

  const clarify = presentString(raw.clarify);
  if (clarify !== undefined) return { kind: "clarify", question: clarify };

  return {
    kind: "operations",
    operations: Array.isArray(raw.operations) ? raw.operations : [],
    notes: presentString(raw.notes) ?? "",
  };
}

const CHANNEL_OF: Record<Exclude<EditOperation["op"], "sectionOrder">, EditableChannel> = {
  text: "text",
  style: "style",
  styleExact: "style",
  layout: "layout",
  visibility: "visibility",
};

/**
 * What each kind cannot do without. `EditOperation` is one all-optional shape
 * covering six operations, so "required" is something to CHECK, not something
 * the type system says: a `style` op with no `property` type-checked fine and
 * wrote `{undefined: "…"}` into the override map, which then failed at export.
 */
const REQUIRED_FIELDS: Record<EditOperation["op"], Array<keyof EditOperation>> = {
  text: ["nodeId", "value"],
  style: ["nodeId", "property", "token"],
  styleExact: ["nodeId", "property", "value"],
  layout: ["nodeId", "property", "value"],
  visibility: ["nodeId", "hidden"],
  sectionOrder: ["route", "order"],
};

const FIELD_TYPES: Record<keyof EditOperation, "string" | "boolean" | "array"> = {
  op: "string",
  nodeId: "string",
  route: "string",
  value: "string",
  property: "string",
  token: "string",
  key: "string",
  hidden: "boolean",
  order: "array",
};

/** The ops carrying a `property` the exporter must be able to compile. */
const PROPERTY_OPS = new Set<EditOperation["op"]>(["style", "styleExact", "layout"]);

function typeError(op: EditOperation, field: keyof EditOperation): string | undefined {
  const expected = FIELD_TYPES[field];
  const value = op[field];
  const ok = expected === "array" ? Array.isArray(value) : typeof value === expected;
  return ok ? undefined : `${op.op} operation's "${field}" must be ${expected === "array" ? "an array" : `a ${expected}`}`;
}

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
    // An operation kind we do not implement, before anything indexes by it.
    if (!Object.hasOwn(REQUIRED_FIELDS, op.op)) {
      errors.push(`"${String(op.op)}" is not an operation this editor can apply`);
      continue;
    }
    const missing = REQUIRED_FIELDS[op.op].filter((field) => op[field] === undefined || op[field] === null);
    if (missing.length > 0) {
      errors.push(`${op.op} operation is missing ${missing.map((field) => `"${field}"`).join(", ")}`);
      continue;
    }
    const badTypes = REQUIRED_FIELDS[op.op]
      .map((field) => typeError(op, field))
      .filter((message): message is string => message !== undefined);
    if (badTypes.length > 0) {
      errors.push(...badTypes);
      continue;
    }

    if (op.op === "sectionOrder") {
      const order = op.order!;
      // Mirrors compiler/src/exporter.ts's validateSectionOrder exactly, so a
      // hallucinated or tombstoned id, or a duplicate, fails HERE instead of
      // at export — where it used to persist as an override the user cannot
      // see, then hard-fail the export with no path back to its cause.
      const unknownSections = order.filter((id) => !activeSections.includes(id));
      const duplicateSections = [...new Set(order.filter((id, index) => order.indexOf(id) !== index))];
      const missingSections = activeSections.filter((id) => !order.includes(id));
      if (op.route !== route) {
        errors.push(`reorder names route "${op.route}" but this page is "${route}"`);
      } else if (unknownSections.length > 0) {
        errors.push(
          `reorder names ${unknownSections.map((id) => `"${id}"`).join(", ")}, which ` +
            `${unknownSections.length === 1 ? "is not an active section" : "are not active sections"} on this page`,
        );
      } else if (duplicateSections.length > 0) {
        errors.push(`reorder lists ${duplicateSections.map((id) => `"${id}"`).join(", ")} more than once`);
      } else if (missingSections.length > 0) {
        errors.push(`reorder omits ${missingSections.join(", ")}`);
      }
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
    if (!node.editable.includes(channel)) {
      // The refusal stands — PRD 3.6 requirement 4 is that a node is editable
      // only through a channel its MANIFEST declares, and weakening that here
      // would let the prompt box author overrides the exporter never agreed to
      // compile. What changes is that one common case stops being a dead end.
      //
      // REPORTED BY A TESTER: an Image whose entry declared only style and
      // visibility, so "change this image" was refused with nothing to do next
      // — while the Inspector's own Image field replaces it happily, because
      // that control gates on `node.element === "Image"` rather than on
      // `editable`. Two rules for one channel, and the user met the stricter
      // one. The templates now require `text` on every Image node (PRD 3.5:
      // image replace IS the text channel, key `src`), but a site generated
      // BEFORE that carries the old manifest and cannot be fixed by editing it
      // — generated output is regenerated, never hand-patched — so the message
      // has to name the way through that works today.
      const imageHint =
        node.element === "Image" && channel === "text"
          ? ` — this site was generated before Image nodes declared the text channel, so replace it` +
            ` with the Image field in the inspector instead (select it and paste a URL)`
          : "";
      errors.push(`"${nodeId}" cannot be edited through ${channel}${imageHint}`);
      continue;
    }
    // The property namespace is the EXPORTER's (single source of truth in
    // compiler/src/style-properties.json). The shim will happily apply any CSS
    // property in the preview, so without this an unsupported one is invisible
    // until the export dies — preview showing what the handover cannot build.
    if (PROPERTY_OPS.has(op.op) && !isSupportedStyleProperty(op.property!)) {
      errors.push(`"${op.property}" is not a style property the exporter can compile`);
      continue;
    }
    if (op.op === "style" && !tokenPaths.has(op.token!)) {
      errors.push(`"${op.token}" is not a token in this project`);
    }
  }
  return errors;
}

/** Applies a VALIDATED batch. Returns a new map; never mutates the input. */
export function applyEditOperations(map: OverridesMap, ops: EditOperation[]): OverridesMap {
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
        // Keyed by the route slug, exactly as moveSection writes it (PRD 3.3),
        // and written VERBATIM. It was filtered against the caller's list of
        // rendered sections, which comes from live shim geometry: a virtualized
        // frame, or one that has not reported yet, reports no sections at all,
        // so the filter dropped every id and persisted `sectionOrder: []` — a
        // hard export failure the user then had to find and clear by hand.
        // Completeness against the MANIFEST is validateEditOperations' job and
        // is already done by the time we get here.
        next = { ...next, [op.route!]: { ...next[op.route!], sectionOrder: [...op.order!] } };
        break;
      }
    }
  }
  return next;
}
