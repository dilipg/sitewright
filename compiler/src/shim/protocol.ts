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
  channel: "text" | "style" | "layout" | "visibility";
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

export type ShimToParentMessage = FrameReadyMessage | NodesGeometryMessage | NodeHitMessage;

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
