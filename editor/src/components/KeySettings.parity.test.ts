/**
 * The editor's provider list must equal the server's, and nothing else enforces
 * that.
 *
 * `KeySettings.tsx` re-declares `API_KEY_PROVIDERS` with a comment saying it
 * mirrors `server/src/api-keys.ts`. A comment is not a constraint: if the server
 * gains a provider the editor silently stops offering it, and if the server
 * drops one the editor offers a choice that 400s at `PUT /api/key` — after the
 * user has typed a key.
 *
 * This follows the convention `compiler/src/max-body-bytes.ts` already set for
 * the same problem (docs/decisions.md, `fix/proxy-residuals`): the value is
 * defined INDEPENDENTLY in each package, because `editor/` and `compiler/` have
 * no dependency on `server/` and adding one to share a constant would be a
 * worse trade — and the two definitions are pinned equal by a test instead.
 *
 * The server file is READ AS TEXT rather than imported, which is what keeps this
 * a pin rather than a dependency: no `server/` module is loaded, and no
 * TypeScript path mapping or build step has to know about the other package.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { API_KEY_PROVIDERS, DEFAULT_API_KEY_PROVIDER } from "./KeySettings.tsx";

const SERVER_API_KEYS = resolve(import.meta.dirname, "..", "..", "..", "server", "src", "api-keys.ts");

/** Pulls the literal out of `export const API_KEY_PROVIDERS = [...] as const;`. */
function serverProviderList(source: string): string[] {
  const match = /export const API_KEY_PROVIDERS = \[([^\]]*)\] as const;/.exec(source);
  if (match === null) {
    throw new Error(
      "could not find `export const API_KEY_PROVIDERS = [...] as const;` in server/src/api-keys.ts — " +
        "if that declaration was renamed or reshaped, update this pin rather than deleting it",
    );
  }
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("provider list parity with the server", () => {
  const source = readFileSync(SERVER_API_KEYS, "utf8");

  it("finds the server declaration, so a rename cannot make this vacuously green", () => {
    // Without this, a changed declaration would throw inside the helper and the
    // failure would read as "the pin is broken" rather than "the lists drifted"
    // — but a silent empty match would be far worse: a pin that passes because
    // it compared nothing. Assert the parse found something real first.
    expect(serverProviderList(source).length).toBeGreaterThan(0);
  });

  it("offers exactly the providers the server accepts, in the same order", () => {
    expect([...API_KEY_PROVIDERS]).toEqual(serverProviderList(source));
  });

  it("defaults to a provider the server actually accepts", () => {
    // `PUT /api/key` treats an absent provider as this value, so a default the
    // server does not know would 400 every submit that relied on it.
    expect(serverProviderList(source)).toContain(DEFAULT_API_KEY_PROVIDER);
  });
});
