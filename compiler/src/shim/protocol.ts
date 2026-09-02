/**
 * Bridge-shim postMessage protocol (PRD 2.2). Shared by the shim runtime
 * (inside preview frames) and the editor (parent document). The protocol is
 * versioned: the editor must refuse to attach to an older shim (PRD risk 4).
 */

export const PROTOCOL_VERSION = 1;

export type ShimMode = "edit" | "interact";

export interface BoxEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  color: string;
  textAlign: string;
}

export interface NodeGeometry {
  nodeId: string;
  /**
   * Iframe-viewport coordinates (what getBoundingClientRect returns). The
   * editor is cross-origin to the preview and cannot read the frame's
   * scroll position, so the shim re-reports on scroll and the overlay maps
   * these rects 1:1 onto the frame's box in the parent document.
   */
  rect: { x: number; y: number; width: number; height: number };
  /** Computed padding/margin in px — drives the inspector's spacing overlay. */
  spacing: { padding: BoxEdges; margin: BoxEdges };
  /** Computed text style — lets the text-channel edit overlay render "styled exactly as rendered" (PRD 3.1) from the cross-origin parent document. */
  textStyle: TextStyle;
}

export interface ShimOverride {
  nodeId: string;
  channel: "text" | "style" | "layout" | "visibility" | "sectionOrder";
  /** Text-channel only: which prop to rewrite. Absent means the node's
   * text content; "src" is image replace (PRD 3.5), which is this channel
   * rather than a new one because a source swap is content, not style. */
  key?: string;
  value: unknown;
}

/* ---------- shim -> parent ---------- */

export interface FrameReadyMessage {
  type: "frame:ready";
  protocolVersion: number;
}

export interface NodesGeometryMessage {
  type: "nodes:geometry";
  protocolVersion: number;
  nodes: NodeGeometry[];
}

export interface NodeHitMessage {
  type: "node:hit";
  protocolVersion: number;
  nodeId: string;
  kind: "click" | "hover" | "dblclick";
  /**
   * Current rendered text content — sent only for "dblclick" (PRD 3.1: text
   * channel activation). The editor is cross-origin and cannot read the
   * frame's DOM directly, so the shim carries the value the inline
   * contentEditable overlay should pre-fill, reflecting any already-applied
   * text override.
   */
  text?: string;
}

/**
 * A wheel gesture that happened INSIDE a preview frame, forwarded so the canvas
 * can pan or zoom from it.
 *
 * REPORTED BY A TESTER: "when mouse pointer is hovering over any part of the
 * page inside the canvas scroll doesn't work." Exactly right, and it is
 * structural rather than a missed case — the editor's pan/zoom lives in a
 * `wheel` handler on the stage element, and a wheel over an iframe is delivered
 * to the IFRAME's document, which never bubbles into the parent. So the canvas
 * was inert over the very thing that fills it, and worked only over the
 * background gaps between frames.
 *
 * `clientX`/`clientY` are in the FRAME's own viewport coordinates, which is all
 * the shim can know. The parent converts them using the iframe element's
 * position and the current zoom — the same 1:1 mapping `NodeGeometry.rect`
 * already relies on.
 *
 * NO PROTOCOL VERSION BUMP, deliberately. The version exists so the editor can
 * refuse to attach to an OLDER shim missing behaviour it depends on (PRD risk
 * 4). This direction is purely additive: an editor that does not know this
 * message ignores it, and a shim that does not send it simply leaves the canvas
 * as it is today. Both halves are also served from `compiler/` — the shim at
 * `/@sitewright/bridge-shim.js`, never copied into a project — so they
 * ship together and cannot disagree in practice. Bumping would manufacture a
 * `version-mismatch` warning for a cached shim while changing nothing real.
 */
export interface FrameWheelMessage {
  type: "frame:wheel";
  protocolVersion: number;
  deltaX: number;
  deltaY: number;
  /** Frame-viewport coordinates of the pointer. */
  clientX: number;
  clientY: number;
  /** Zoom-intent modifiers, forwarded so the parent applies ONE rule for both
   *  a wheel over the background and a wheel over a frame. */
  ctrlKey: boolean;
  metaKey: boolean;
}

export type ShimToParentMessage =
  | FrameReadyMessage
  | NodesGeometryMessage
  | NodeHitMessage
  | FrameWheelMessage;

/* ---------- parent -> shim ---------- */

export interface OverridesApplyMessage {
  type: "overrides:apply";
  protocolVersion: number;
  /** Full replacement list — not a delta. The shim resets effects for nodes no longer listed. */
  overrides: ShimOverride[];
}

export interface ModeSetMessage {
  type: "mode:set";
  protocolVersion: number;
  mode: ShimMode;
}

export type ParentToShimMessage = OverridesApplyMessage | ModeSetMessage;
