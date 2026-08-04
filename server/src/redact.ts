// server/src/redact.ts
/**
 * Last line of defence for log output.
 *
 * The real rule is "never pass a key to a log call" (spec, BYOK requirement 2),
 * and every call site in this package follows it. This exists for the messages
 * we do not construct: a spawn error that stringifies its options, a
 * subprocess's stderr, an exception from a library.
 */

// Anthropic keys are `sk-ant-` followed by a run of URL-safe characters. The
// prefix is what makes this specific enough not to mangle ordinary log text.
const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

export function redactSecrets(text: string): string {
  return text.replace(KEY_PATTERN, "sk-ant-[redacted]");
}
