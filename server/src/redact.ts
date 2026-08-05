// server/src/redact.ts
/**
 * Last line of defence for log output.
 *
 * The real rule is "never pass a key to a log call" (spec, BYOK requirement 2),
 * and every call site we construct ourselves follows it directly. This exists
 * for the messages we do NOT construct — output that passes through a log call
 * without this package having chosen its content, so there is no way to audit
 * in advance whether it carries a key.
 *
 * `preview-pool.ts`'s `spawnAndAwaitReady` is exactly that: it wires a preview
 * child's stdout and stderr into `console.log`/`console.error`. That child
 * runs the project's own model-generated code (its `vite.config.ts`, its
 * plugin chain), so its output is untrusted and unpredictable — including the
 * possibility of a key appearing on a spawned process's command line or in an
 * error message. Three call sites there depend on this function: the per-line
 * stdout logger, the stderr logger, and the malformed-readiness-line logger.
 * If a future call site pipes a child or subprocess's output into a log call,
 * it needs this too — the "never logged" guarantee stopped holding by
 * construction the moment the first such call site was wired in.
 */

// Anthropic keys are `sk-ant-` followed by a run of URL-safe characters. The
// prefix is what makes this specific enough not to mangle ordinary log text.
const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

export function redactSecrets(text: string): string {
  return text.replace(KEY_PATTERN, "sk-ant-[redacted]");
}
