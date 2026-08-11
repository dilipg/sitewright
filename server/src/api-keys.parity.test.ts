/**
 * The editor's provider list must equal this package's, and nothing else
 * enforces that.
 *
 * `editor/src/components/KeySettings.tsx` re-declares `API_KEY_PROVIDERS` with a
 * comment saying it mirrors `server/src/api-keys.ts`. A comment is not a
 * constraint: if the server gains a provider the editor silently stops offering
 * it, and if the server drops one the editor offers a choice that 400s at
 * `PUT /api/key` — after the user has already typed a key.
 *
 * Follows the convention `compiler/src/max-body-bytes.ts` set for the same
 * problem (docs/decisions.md, `fix/proxy-residuals`): the value is defined
 * INDEPENDENTLY in each package, because neither `editor/` nor `compiler/` has a
 * dependency on `server/` and adding one to share a constant is the worse trade
 * — and the definitions are pinned equal by a test instead.
 *
 * WHY IT LIVES IN `server/` RATHER THAN `editor/`: the first version of this pin
 * was an `editor/` test, and it broke `tsc --noEmit -p editor` — `editor/` has no
 * `@types/node`, so `node:fs` and `import.meta.dirname` do not typecheck there.
 * The fix is NOT to add node types to a browser application: that would weaken
 * the very browser/Node distinction the editor's tsconfig exists to enforce.
 * `server/` already has them, so the pin lives here and reads BOTH files as
 * text. Nothing is imported across a package boundary in either direction.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { API_KEY_PROVIDERS, DEFAULT_API_KEY_PROVIDER } from "./api-keys.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const EDITOR_KEY_SETTINGS = resolve(REPO_ROOT, "editor", "src", "components", "KeySettings.tsx");

/** Pulls the literal out of `export const API_KEY_PROVIDERS = [...] as const;`. */
function declaredProviders(source: string, file: string): string[] {
  const match = /export const API_KEY_PROVIDERS = \[([^\]]*)\] as const;/.exec(source);
  if (match === null) {
    throw new Error(
      `could not find \`export const API_KEY_PROVIDERS = [...] as const;\` in ${file} — ` +
        "if that declaration was renamed or reshaped, update this pin rather than deleting it",
    );
  }
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("provider list parity between server and editor", () => {
  const editorSource = readFileSync(EDITOR_KEY_SETTINGS, "utf8");

  it("finds the editor declaration, so a rename cannot make this vacuously green", () => {
    // A pin that passes because it compared nothing is the same inert-coverage
    // class as a test file the runner never loads. Assert the parse found
    // something real before comparing.
    expect(declaredProviders(editorSource, "KeySettings.tsx").length).toBeGreaterThan(0);
  });

  it("the editor offers exactly the providers this package accepts, in the same order", () => {
    expect(declaredProviders(editorSource, "KeySettings.tsx")).toEqual([...API_KEY_PROVIDERS]);
  });

  it("the editor's default is a provider this package actually accepts", () => {
    // `PUT /api/key` treats an absent provider as this value, so a default the
    // server does not know would 400 every submit that relied on it.
    const editorDefault = /export const DEFAULT_API_KEY_PROVIDER[^=]*=\s*"([^"]+)"/.exec(editorSource);
    const value = editorDefault?.[1] ?? DEFAULT_API_KEY_PROVIDER;
    expect([...API_KEY_PROVIDERS]).toContain(value);
  });
});
