/**
 * The style/layout properties an override may carry — ONE list, for three
 * consumers that must agree:
 *
 *   - the exporter, which compiles each property to a Tailwind utility and
 *     throws on anything it has no mapping for;
 *   - the editor's operation validation, which must refuse an operation the
 *     export could not compile;
 *   - the edit agent's tool schema (`orchestrator/src/orchestrator/edit_agent.py`
 *     reads the JSON directly), so an unrepresentable property is not merely
 *     rejected afterwards but unaskable in the first place.
 *
 * They disagreed before: `property` was an open string on the wire, validated
 * nowhere, and closed only inside the exporter. So `fontFamily` validated,
 * rendered in the preview (the shim applies any property), persisted — and then
 * killed the export. A preview the handover cannot reproduce is the one failure
 * this project exists to prevent, so the list lives in data both languages
 * read rather than in either one's source.
 */
import table from "./style-properties.json" with { type: "json" };

/** How one property compiles: utility prefix, plus how the value is written. */
export interface UtilitySpec {
  prefix: string;
  /** Tailwind value-type hint, e.g. `text-(length:--x)` for fontSize. */
  hint?: string;
  /** Bare keyword value (`text-center`) rather than a token reference. */
  keyword?: boolean;
}

export const PROPERTY_UTILITIES: Record<string, UtilitySpec> = table;

/** Every property an override may name, in declaration order. */
export const STYLE_PROPERTIES: readonly string[] = Object.keys(table);

/** Cheap membership test for the validators. */
export function isSupportedStyleProperty(property: string): boolean {
  return Object.hasOwn(PROPERTY_UTILITIES, property);
}
