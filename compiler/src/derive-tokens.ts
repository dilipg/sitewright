/**
 * Design-token deriver (contract section 3): tokens.json → CSS custom
 * properties + Tailwind theme mapping. Pure and deterministic; ref: values
 * are resolved here and only here.
 *
 * CSS variable naming rule (docs/decisions.md): JSON path segments joined
 * with "-", key names verbatim — e.g. --color-semantic-textMuted.
 */

type TokenLeaf = string | number;

interface TokenGroup {
  [key: string]: TokenLeaf | boolean | null | TokenGroup;
}

export interface TailwindTheme {
  colors?: Record<string, string>;
  fontFamily?: Record<string, string>;
  fontSize?: Record<string, string>;
  fontWeight?: Record<string, string>;
  lineHeight?: Record<string, string>;
  spacing?: Record<string, string>;
  borderRadius?: Record<string, string>;
  boxShadow?: Record<string, string>;
  screens?: Record<string, string>;
}

export interface DeriveTokensResult {
  tokensCss: string;
  tailwindTheme: TailwindTheme;
}

const REF_PREFIX = "ref:";
const CSS_HEADER = "/* Derived from tokens.json — do not edit by hand. */";

/** Token sections emitted, in fixed order. version/meta are metadata, not tokens. */
const SECTION_ORDER = ["color", "typography", "space", "radius", "shadow", "breakpoint"] as const;

export function deriveTokens(tokensInput: unknown): DeriveTokensResult {
  if (typeof tokensInput !== "object" || tokensInput === null) {
    throw new Error("deriveTokens expects a parsed tokens.json object");
  }
  const root = tokensInput as Record<string, unknown>;

  const entries: Array<{ path: string[]; value: TokenLeaf }> = [];
  for (const section of SECTION_ORDER) {
    const group = root[section];
    if (group !== undefined && typeof group === "object" && group !== null) {
      flattenGroup(root, group as TokenGroup, [section], entries);
    }
  }

  const lines = entries.map(({ path, value }) => `  --${path.join("-")}: ${String(value)};`);
  const tokensCss = `${CSS_HEADER}\n:root {\n${lines.join("\n")}\n}\n`;

  return { tokensCss, tailwindTheme: buildTailwindTheme(entries) };
}

function flattenGroup(
  root: Record<string, unknown>,
  group: TokenGroup,
  prefix: string[],
  out: Array<{ path: string[]; value: TokenLeaf }>,
): void {
  for (const [key, value] of Object.entries(group)) {
    const path = [...prefix, key];
    if (typeof value === "object" && value !== null) {
      flattenGroup(root, value, path, out);
    } else {
      const sourcePath = path.join(".");
      out.push({ path, value: resolveValue(root, value, sourcePath, [sourcePath]) });
    }
  }
}

/** Resolves a leaf, following ref: chains. `seen` carries the ref path for cycle reporting. */
function resolveValue(
  root: Record<string, unknown>,
  value: unknown,
  sourcePath: string,
  seen: string[],
): TokenLeaf {
  if (typeof value === "number") return value;
  if (typeof value !== "string") {
    throw new Error(`Invalid token value at ${sourcePath}: expected string or number`);
  }
  if (!value.startsWith(REF_PREFIX)) return value;

  const target = value.slice(REF_PREFIX.length);
  if (seen.includes(target)) {
    throw new Error(`Circular token reference: ${[...seen, target].join(" → ")}`);
  }
  const targetValue = getAtPath(root, target);
  if (targetValue === undefined || (typeof targetValue === "object" && targetValue !== null)) {
    throw new Error(`Unknown token reference "${value}" at ${sourcePath}`);
  }
  return resolveValue(root, targetValue, target, [...seen, target]);
}

function getAtPath(root: Record<string, unknown>, dottedPath: string): unknown {
  let node: unknown = root;
  for (const segment of dottedPath.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Maps token sections to classic Tailwind theme buckets. Values are var()
 * references so tokens.css stays the single source of truth — except
 * screens, which must be literal because media queries cannot read vars.
 */
function buildTailwindTheme(entries: Array<{ path: string[]; value: TokenLeaf }>): TailwindTheme {
  const theme: TailwindTheme = {};
  const put = (bucket: keyof TailwindTheme, key: string, value: string): void => {
    (theme[bucket] ??= {})[key] = value;
  };

  for (const { path, value } of entries) {
    const varRef = `var(--${path.join("-")})`;
    const [section, ...rest] = path;
    if (section === "color") {
      put("colors", rest.join("-"), varRef);
    } else if (section === "typography" && rest[0] === "fontFamily") {
      put("fontFamily", rest.slice(1).join("-"), varRef);
    } else if (section === "typography" && rest[0] === "scale") {
      put("fontSize", rest.slice(1).join("-"), varRef);
    } else if (section === "typography" && rest[0] === "weight") {
      put("fontWeight", rest.slice(1).join("-"), varRef);
    } else if (section === "typography" && rest[0] === "leading") {
      put("lineHeight", rest.slice(1).join("-"), varRef);
    } else if (section === "space") {
      put("spacing", rest.join("-"), varRef);
    } else if (section === "radius") {
      put("borderRadius", rest.join("-"), varRef);
    } else if (section === "shadow") {
      put("boxShadow", rest.join("-"), varRef);
    } else if (section === "breakpoint") {
      put("screens", rest.join("-"), String(value));
    }
  }
  return theme;
}
