/** Joins class fragments, dropping empties. User/override classes are always passed last (contract 4.1). */
export function cx(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
