/**
 * Override store (contract 6.1) and the persisted undo/redo history.
 * The store is a map nodeId -> channel -> value; serialization enforces
 * one entry per node+channel with later edits replacing earlier ones.
 */

export type Channel = "text" | "style" | "layout" | "visibility";

export type OverridesMap = Record<string, Partial<Record<Channel, unknown>>>;

export interface OverrideFileEntry {
  nodeId: string;
  channel: Channel;
  value: unknown;
  updatedAt: string;
}

export interface OverrideFileJson {
  version: 1;
  route: string;
  overrides: OverrideFileEntry[];
}

export function applyStyleProperty(
  map: OverridesMap,
  nodeId: string,
  property: string,
  value: string,
): OverridesMap {
  const nodeChannels = map[nodeId] ?? {};
  const style = { ...(nodeChannels.style as Record<string, string> | undefined), [property]: value };
  return { ...map, [nodeId]: { ...nodeChannels, style } };
}

export function applyTextValue(map: OverridesMap, nodeId: string, value: string): OverridesMap {
  const nodeChannels = map[nodeId] ?? {};
  return { ...map, [nodeId]: { ...nodeChannels, text: value } };
}

/** Size/position deltas from drag/resize gestures (contract 6.1) — same shape as style, distinct channel key. */
export function applyLayoutProperty(
  map: OverridesMap,
  nodeId: string,
  property: string,
  value: string,
): OverridesMap {
  const nodeChannels = map[nodeId] ?? {};
  const layout = { ...(nodeChannels.layout as Record<string, string> | undefined), [property]: value };
  return { ...map, [nodeId]: { ...nodeChannels, layout } };
}

export function applyVisibility(map: OverridesMap, nodeId: string, hidden: boolean): OverridesMap {
  const nodeChannels = map[nodeId] ?? {};
  return { ...map, [nodeId]: { ...nodeChannels, visibility: hidden } };
}

/** Drops every channel for a node — used when the user discards an orphaned override. */
export function removeNodeOverrides(map: OverridesMap, nodeId: string): OverridesMap {
  const next = { ...map };
  delete next[nodeId];
  return next;
}


export function toOverrideFile(map: OverridesMap, route: string): OverrideFileJson {
  const updatedAt = new Date().toISOString();
  const overrides: OverrideFileEntry[] = [];
  for (const [nodeId, channels] of Object.entries(map)) {
    for (const [channel, value] of Object.entries(channels)) {
      if (value !== undefined) {
        overrides.push({ nodeId, channel: channel as Channel, value, updatedAt });
      }
    }
  }
  return { version: 1, route, overrides };
}

export function fromOverrideFile(file: OverrideFileJson): OverridesMap {
  const map: OverridesMap = {};
  for (const entry of file.overrides) {
    map[entry.nodeId] = { ...map[entry.nodeId], [entry.channel]: entry.value };
  }
  return map;
}

/* ---------- undo/redo (single stack, persisted with the project) ---------- */

export interface History {
  snapshots: OverridesMap[];
  index: number;
}

export function initHistory(initial: OverridesMap): History {
  return { snapshots: [initial], index: 0 };
}

export function currentSnapshot(history: History): OverridesMap {
  return history.snapshots[history.index]!;
}

/** A new edit after undo discards the redo branch. */
export function pushHistory(history: History, next: OverridesMap): History {
  return {
    snapshots: [...history.snapshots.slice(0, history.index + 1), next],
    index: history.index + 1,
  };
}

export function undo(history: History): History {
  return history.index > 0 ? { ...history, index: history.index - 1 } : history;
}

export function redo(history: History): History {
  return history.index < history.snapshots.length - 1
    ? { ...history, index: history.index + 1 }
    : history;
}
