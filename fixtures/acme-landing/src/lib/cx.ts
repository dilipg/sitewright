/** Joins class fragments, dropping empties. User/override classes are always passed last (contract 4.1).
 * Accepts `false` so the standard conditional idiom (`cond && "class"`) typechecks —
 * the runtime already dropped falsy parts; only the annotation was narrower. */
export function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
