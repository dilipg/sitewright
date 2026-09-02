/**
 * Where the fixture project lives, resolved from this module's own location.
 *
 * RELATIVE TO `import.meta.url`, never from `process.cwd()` and never from a
 * configured absolute path. The callers run with wildly different working
 * directories — the CLI from the repo root, `npm run serve -w server` from
 * `server/`, a preview child from a generated project — and this same fixture
 * is the one every generated project borrows its `node_modules` from.
 *
 * It also has to survive the repository root being RENAMED, which is what
 * `node-modules-link.ts` exists to repair; a fixture path that itself broke on a
 * rename would make the repair impossible exactly when it is needed.
 */
import { fileURLToPath } from "node:url";

/** `<repo>/fixtures/acme-landing` — the permanent test bed (build-plan §0). */
export function fixtureDir(): string {
  return fileURLToPath(new URL("../../fixtures/acme-landing", import.meta.url));
}

/** The `node_modules` every generated project links to rather than copying. */
export function fixtureNodeModules(): string {
  return fileURLToPath(new URL("../../fixtures/acme-landing/node_modules", import.meta.url));
}
