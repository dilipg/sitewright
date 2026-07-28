/**
 * Client-side token helpers: the inspector reads tokens.json from the
 * preview server and needs resolved colors for swatches, ordered scale
 * keys for steppers, and the token-path set for off-scale detection.
 */

import { humanizeSegment } from "./labels";

export type TokensJson = Record<string, unknown>;

const REF_PREFIX = "ref:";
const TOKEN_PATH = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+$/;

export function resolveTokenValue(tokens: TokensJson, path: string): string | number | undefined {
  let value = getAtPath(tokens, path);
  const seen = new Set<string>([path]);
  while (typeof value === "string" && value.startsWith(REF_PREFIX)) {
    const target = value.slice(REF_PREFIX.length);
    if (seen.has(target)) return undefined;
    seen.add(target);
    value = getAtPath(tokens, target);
  }
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export interface SwatchOption {
  path: string;
  label: string;
  css: string;
}

export function semanticColorOptions(tokens: TokensJson): SwatchOption[] {
  const semantic = getAtPath(tokens, "color.semantic");
  if (typeof semantic !== "object" || semantic === null) return [];
  return Object.keys(semantic).map((key) => ({
    path: `color.semantic.${key}`,
    label: humanizeSegment(key.replace(/([A-Z])/g, "-$1").toLowerCase()),
    css: String(resolveTokenValue(tokens, `color.semantic.${key}`) ?? "transparent"),
  }));
}

export function scaleKeys(tokens: TokensJson, groupPath: string[]): string[] {
  const group = getAtPath(tokens, groupPath.join("."));
  if (typeof group !== "object" || group === null) return [];
  return Object.keys(group);
}

/**
 * Snaps a raw pixel delta (from a drag/resize gesture) to the nearest
 * space-scale magnitude, in px, preserving sign (PRD 3.3: "gestures snap to
 * the space scale"). The layout channel stores computed px deltas, not
 * token paths — the SNAP quantizes the gesture to the design system's
 * rhythm, it doesn't require the final value to resolve to a clean token.
 */
export function nearestSpaceStep(tokens: TokensJson, rawDeltaPx: number): number {
  const magnitudes = scaleKeys(tokens, ["space"])
    .map((key) => resolveTokenValue(tokens, `space.${key}`))
    .filter((value): value is string | number => value !== undefined)
    .map((value) => parseFloat(String(value)) * (String(value).endsWith("rem") ? 16 : 1));
  if (magnitudes.length === 0) return rawDeltaPx;
  const target = Math.abs(rawDeltaPx);
  const nearest = magnitudes.reduce((best, candidate) =>
    Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
  );
  return Math.sign(rawDeltaPx) * nearest;
}

export function tokenPathSet(tokens: TokensJson): Set<string> {
  const paths = new Set<string>();
  collectPaths(tokens, [], paths);
  return paths;
}

export function isTokenRef(value: string, tokenPaths: Set<string>): boolean {
  return TOKEN_PATH.test(value) && tokenPaths.has(value);
}

function collectPaths(node: unknown, prefix: string[], out: Set<string>): void {
  if (typeof node !== "object" || node === null) {
    if (prefix.length > 1) out.add(prefix.join("."));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    collectPaths(value, [...prefix, key], out);
  }
}

function getAtPath(root: TokensJson, dottedPath: string): unknown {
  let node: unknown = root;
  for (const segment of dottedPath.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}
