/**
 * Primitive variant inventory — M2 STUB for the hand-written fixture set.
 * The Design System Agent emits the real primitive inventory in M5
 * (pipeline 2.3); this map and its declarations must be replaced by that
 * output (see docs/decisions.md). Declarations mirror each variant's
 * token-bound styles so the shim can preview a variant switch live; at
 * export the persisted { variant } key compiles to a prop change.
 */

export interface PrimitiveVariantInfo {
  variants: string[];
  declarations: Record<string, Record<string, string>>;
}

export const PRIMITIVE_VARIANTS: Record<string, PrimitiveVariantInfo> = {
  Button: {
    variants: ["primary", "secondary"],
    declarations: {
      primary: {
        background: "color.semantic.accent",
        color: "color.semantic.accentContrast",
      },
      secondary: {
        background: "color.semantic.surface",
        color: "color.semantic.text",
      },
    },
  },
  Heading: {
    variants: ["display", "section", "subsection"],
    declarations: {
      display: { fontSize: "typography.scale.5xl" },
      section: { fontSize: "typography.scale.3xl" },
      subsection: { fontSize: "typography.scale.2xl" },
    },
  },
  Text: {
    variants: ["body", "lead", "eyebrow"],
    declarations: {
      body: { fontSize: "typography.scale.base", color: "color.semantic.text" },
      lead: { fontSize: "typography.scale.lg", color: "color.semantic.textMuted" },
      eyebrow: { fontSize: "typography.scale.sm", color: "color.semantic.accent" },
    },
  },
};

/**
 * Prepares a persisted style value for the shim: the semantic { variant }
 * key becomes that variant's declarations; explicit properties win.
 */
export function expandStyleValue(
  style: Record<string, unknown>,
  element: string,
): Record<string, string> {
  const { variant, ...rest } = style;
  const declarations =
    typeof variant === "string"
      ? (PRIMITIVE_VARIANTS[element]?.declarations[variant] ?? {})
      : {};
  return { ...declarations, ...(rest as Record<string, string>) };
}
