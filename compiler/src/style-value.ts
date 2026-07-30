/**
 * Shared classification of an override's style/layout VALUE (contract 6.1/7.2).
 *
 * A value is either a token reference ("color.semantic.accent" — resolves to a
 * CSS custom property from tokens.css) or an off-scale free value ("#ff5500",
 * "13px" — the user's deliberate escape from the scale, compiled to a
 * Tailwind arbitrary-value class).
 *
 * Its own module so the exporter (which compiles these) and the handover
 * generator (which reports the off-scale ones for a developer to normalize)
 * classify identically without importing each other — exporter.ts imports
 * handover.ts, so the reverse direction would be a cycle.
 */

const TOKEN_PATH = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+$/;

export function isTokenReference(value: string): boolean {
  return TOKEN_PATH.test(value);
}
