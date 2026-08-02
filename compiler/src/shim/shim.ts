/**
 * Bridge-shim runtime (PRD 2.2, contract 6.2). Injected into preview frames
 * by the dev-only Vite plugin; never part of the project or its exports.
 *
 * - indexes [data-node-id] elements, reports geometry batched per animation
 *   frame (ResizeObserver + MutationObserver + window resize)
 * - applies overrides live: text via content substitution (originals kept
 *   for restore), style/layout/visibility via a <style> sheet keyed on
 *   [data-node-id] selectors, re-appended to stay last in the cascade
 * - edit mode suppresses navigation/submission and forwards node hits;
 *   interact mode restores the page's real behavior
 */

import type {
  NodeGeometry,
  ParentToShimMessage,
  ShimMode,
  ShimOverride,
  ShimToParentMessage,
} from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const TOKEN_PATH = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+$/;

let mode: ShimMode = "edit";
let geometryScheduled = false;
let lastReportedCount = 0;
let lastHoverId: string | undefined;
const originalTexts = new Map<Element, string>();
/**
 * The last overrides list received from the parent. `overrides:apply` can
 * race React's own mount inside the frame — the node a given override
 * targets may not exist in the DOM yet when the message arrives, so the
 * override is silently unappliable at that instant. Remembering it and
 * re-running applyOverrides whenever reindex() sees new [data-node-id]
 * elements (below) catches those nodes up once they do mount, instead of
 * dropping the override forever.
 */
let lastOverrides: ShimOverride[] = [];

const overrideSheet = document.createElement("style");
overrideSheet.setAttribute("data-wg-shim", "overrides");

const resizeObserver = new ResizeObserver(() => scheduleGeometryReport());

function post(message: ShimToParentMessage): void {
  window.parent.postMessage(message, "*");
}

function indexedNodes(): Element[] {
  return [...document.querySelectorAll("[data-node-id]")];
}

function scheduleGeometryReport(): void {
  if (geometryScheduled) return;
  geometryScheduled = true;
  requestAnimationFrame(() => {
    geometryScheduled = false;
    reportGeometry();
  });
}

function reportGeometry(): void {
  const nodes: NodeGeometry[] = indexedNodes().map((element) => {
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    return {
      nodeId: element.getAttribute("data-node-id")!,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      spacing: {
        padding: {
          top: parseFloat(computed.paddingTop),
          right: parseFloat(computed.paddingRight),
          bottom: parseFloat(computed.paddingBottom),
          left: parseFloat(computed.paddingLeft),
        },
        margin: {
          top: parseFloat(computed.marginTop),
          right: parseFloat(computed.marginRight),
          bottom: parseFloat(computed.marginBottom),
          left: parseFloat(computed.marginLeft),
        },
      },
      textStyle: {
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        color: computed.color,
        textAlign: computed.textAlign,
      },
    };
  });
  // Before the app mounts there is nothing to report; stay quiet so the
  // first geometry message the editor sees is a complete one.
  if (nodes.length === 0 && lastReportedCount === 0) return;
  lastReportedCount = nodes.length;
  post({ type: "nodes:geometry", protocolVersion: PROTOCOL_VERSION, nodes });
}

function reindex(): void {
  resizeObserver.disconnect();
  resizeObserver.observe(document.documentElement);
  for (const element of indexedNodes()) resizeObserver.observe(element);
  scheduleGeometryReport();
  // catches up any node that mounted after the last overrides:apply message
  // (see lastOverrides doc comment); applyOverrides' own writes are
  // idempotent, so this never fights the mutation observer that triggers it
  applyOverrides(lastOverrides);
}

/* ---------- overrides ---------- */

function applyOverrides(overrides: ShimOverride[]): void {
  lastOverrides = overrides;
  applyTextOverrides(overrides);

  const rules: string[] = [];
  for (const override of overrides) {
    const selector = `[data-node-id="${override.nodeId}"]`;
    if (override.channel === "style" || override.channel === "layout") {
      const declarations = Object.entries(override.value as Record<string, unknown>)
        .map(([property, value]) => `${toKebab(property)}: ${resolveStyleValue(String(value))} !important;`)
        .join(" ");
      rules.push(`${selector} { ${declarations} }`);
    } else if (override.channel === "visibility" && override.value !== false) {
      // PRD 3.4: hidden nodes render ghosted in edit mode (still visible and
      // selectable, so the user can find and un-hide them) and are only
      // fully removed in interact mode, matching how the export compiles
      // them out entirely (contract 6.1) — the same distinction the exported
      // build itself has no edit mode for, so it always gets the interact
      // behavior.
      rules.push(
        mode === "interact"
          ? `${selector} { display: none !important; }`
          : `${selector} { opacity: 0.35 !important; outline: 1px dashed currentColor !important; outline-offset: -1px !important; }`,
      );
    }
  }
  overrideSheet.textContent = rules.join("\n");
  // re-append so the sheet stays after any styles Vite/Tailwind add later
  document.head.appendChild(overrideSheet);
  scheduleGeometryReport();
}

function applyTextOverrides(overrides: ShimOverride[]): void {
  const textByNode = new Map<string, string>();
  for (const override of overrides) {
    if (override.channel !== "text") continue;
    if (override.key !== undefined) {
      // Keyed text override = image replace (PRD 3.5): rewrite the named
      // attribute instead of the node's text. Kept out of textByNode so the
      // restore pass below never clobbers this element's textContent.
      const target = document.querySelector(`[data-node-id="${override.nodeId}"]`);
      if (target !== null) {
        const next = String(override.value);
        if (target.getAttribute(override.key) !== next) target.setAttribute(override.key, next);
      }
      continue;
    }
    textByNode.set(override.nodeId, String(override.value));
  }
  for (const [element, original] of originalTexts) {
    const nodeId = element.getAttribute("data-node-id");
    if (nodeId === null || !textByNode.has(nodeId)) {
      // idempotent: reindex() re-runs this on every DOM mutation it observes
      // (to catch up late-mounting nodes) — an unconditional write here would
      // re-trigger that same observer every time, looping forever
      if (element.textContent !== original) element.textContent = original;
      originalTexts.delete(element);
    }
  }
  for (const [nodeId, text] of textByNode) {
    const element = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (element === null) continue;
    if (!originalTexts.has(element)) originalTexts.set(element, element.textContent ?? "");
    if (element.textContent !== text) element.textContent = text;
  }
}

/** Token paths ("space.8") become var() references; anything else passes through. */
function resolveStyleValue(value: string): string {
  return TOKEN_PATH.test(value) ? `var(--${value.replace(/\./g, "-")})` : value;
}

function toKebab(property: string): string {
  return property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/* ---------- interaction ---------- */

function nearestNodeId(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest("[data-node-id]")?.getAttribute("data-node-id") ?? undefined;
}

document.addEventListener(
  "click",
  (event) => {
    if (mode !== "edit") return;
    event.preventDefault();
    event.stopPropagation();
    const nodeId = nearestNodeId(event.target);
    if (nodeId !== undefined) {
      post({ type: "node:hit", protocolVersion: PROTOCOL_VERSION, nodeId, kind: "click" });
    }
  },
  true,
);

document.addEventListener(
  "dblclick",
  (event) => {
    if (mode !== "edit") return;
    event.preventDefault();
    event.stopPropagation();
    const nodeId = nearestNodeId(event.target);
    if (nodeId === undefined) return;
    const element = document.querySelector(`[data-node-id="${nodeId}"]`);
    post({
      type: "node:hit",
      protocolVersion: PROTOCOL_VERSION,
      nodeId,
      kind: "dblclick",
      text: element?.textContent ?? "",
    });
  },
  true,
);

document.addEventListener(
  "submit",
  (event) => {
    if (mode !== "edit") return;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);

document.addEventListener(
  "mouseover",
  (event) => {
    if (mode !== "edit") return;
    const nodeId = nearestNodeId(event.target);
    if (nodeId !== undefined && nodeId !== lastHoverId) {
      lastHoverId = nodeId;
      post({ type: "node:hit", protocolVersion: PROTOCOL_VERSION, nodeId, kind: "hover" });
    }
  },
  true,
);

/* ---------- protocol ---------- */

window.addEventListener("message", (event) => {
  const data = event.data as ParentToShimMessage | null | undefined;
  if (data === null || data === undefined || typeof data !== "object") return;
  if (data.protocolVersion !== PROTOCOL_VERSION) return;
  if (data.type === "overrides:apply") {
    applyOverrides(data.overrides);
  } else if (data.type === "mode:set") {
    mode = data.mode;
    applyOverrides(lastOverrides); // refresh visibility's mode-dependent rule
  }
});

/* ---------- boot ---------- */

new MutationObserver(() => reindex()).observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
});
window.addEventListener("resize", () => scheduleGeometryReport());
window.addEventListener("scroll", () => scheduleGeometryReport(), true);

post({ type: "frame:ready", protocolVersion: PROTOCOL_VERSION });
reindex();
