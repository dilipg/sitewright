// server/src/redact.ts
/**
 * Last line of defence for log output.
 *
 * The real rule is "never pass a key to a log call" (spec, BYOK requirement 2),
 * and every call site in this package follows it. This exists for the messages
 * we do not construct: a spawn error that stringifies its options, a
 * subprocess's stderr, an exception from a library.
 *
 * As of this writing, this function is deliberately inert: nothing in
 * `server/` calls it except its own test. That is not an oversight to fix by
 * inventing a call site — `console.*` is the only log sink in this package
 * today, and none of its call sites receives a key-derived value, so the
 * never-logged guarantee currently holds BY CONSTRUCTION, not by redaction.
 * The risk this note exists to head off is misplaced confidence: once slice 4
 * spawns the orchestrator and the generated project's build and wires their
 * subprocess stderr/stdout into a log call, that output can carry anything —
 * including a key, if one ever ends up on a spawned process's command line or
 * in an error message. Slice 4 MUST call `redactSecrets` on any such output
 * before it reaches a log call; do not assume this module is already wired in
 * just because it exists and is tested.
 */

// Anthropic keys are `sk-ant-` followed by a run of URL-safe characters. The
// prefix is what makes this specific enough not to mangle ordinary log text.
const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

export function redactSecrets(text: string): string {
  return text.replace(KEY_PATTERN, "sk-ant-[redacted]");
}
