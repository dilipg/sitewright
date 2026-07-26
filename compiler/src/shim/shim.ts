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
}

/* ---------- overrides ---------- */

function applyOverrides(overrides: ShimOverride[]): void {
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
      rules.push(`${selector} { display: none !important; }`);
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
    if (override.channel === "text") textByNode.set(override.nodeId, String(override.value));
  }
  for (const [element, original] of originalTexts) {
    const nodeId = element.getAttribute("data-node-id");
    if (nodeId === null || !textByNode.has(nodeId)) {
      element.textContent = original;
      originalTexts.delete(element);
    }
  }
  for (const [nodeId, text] of textByNode) {
    const element = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (element === null) continue;
    if (!originalTexts.has(element)) originalTexts.set(element, element.textContent ?? "");
    element.textContent = text;
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
