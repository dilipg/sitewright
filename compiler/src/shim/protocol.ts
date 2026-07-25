/**
 * Bridge-shim postMessage protocol (PRD 2.2). Shared by the shim runtime
 * (inside preview frames) and the editor (parent document). The protocol is
 * versioned: the editor must refuse to attach to an older shim (PRD risk 4).
 */

export const PROTOCOL_VERSION = 1;

export type ShimMode = "edit" | "interact";

export interface NodeGeometry {
  nodeId: string;
  /** Page coordinates (document space, scroll included). */
  rect: { x: number; y: number; width: number; height: number };
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
  kind: "click" | "hover";
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
