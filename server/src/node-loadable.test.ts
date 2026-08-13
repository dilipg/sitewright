/**
 * Every `.ts` file this package ships must survive Node's own type stripping,
 * because Node is what actually loads them.
 *
 * WHY THIS EXISTS, and it is not hypothetical: task 1 of the BYOK/Docker plan
 * wrote a class with a TypeScript *parameter property*
 * (`constructor(readonly x: string) {}`). `tsc --noEmit` was clean, all 784
 * server tests passed, and the real server would have crashed at boot with
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. `npm run check` was green for code that
 * could not boot.
 *
 * The gap is structural rather than an oversight:
 *  - `tsc` type-CHECKS; it has no opinion on what Node can strip.
 *  - vitest transforms with esbuild, which implements the full TS grammar,
 *    including the parts Node refuses.
 *  - Node's type stripping only ERASES annotations. Anything that would need
 *    code GENERATED (parameter properties, `enum`, `namespace` with runtime
 *    meaning, legacy `experimentalDecorators`) is rejected outright.
 *
 * So neither of the two checks that ran could see it, and the only thing that
 * would have was starting the server. `node:module`'s `stripTypeScriptTypes` is
 * the same stripper Node uses on load, so calling it here reproduces the boot
 * failure exactly — without executing a line of the module, so no database is
 * opened and no port is bound.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

/** Every `.ts` file under `src/` and `scripts/`, excluding tests. A test file is
 *  excluded deliberately: vitest loads those through esbuild, never Node, so
 *  holding them to Node's grammar would be asserting something untrue. */
function shippedTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...shippedTypeScriptFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const files = ["src", "scripts"].flatMap((sub) => shippedTypeScriptFiles(join(PACKAGE_ROOT, sub)));

describe("every shipped .ts file survives Node's own type stripping", () => {
  it("finds files to check, so a broken glob cannot make this vacuously green", () => {
    // Without this, a path mistake would turn the whole suite below into zero
    // assertions that report success — the same class of inert coverage as a
    // test file the runner never loads.
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const label = relative(PACKAGE_ROOT, file).replace(/\\/g, "/");
    it(`strips: ${label}`, () => {
      const source = readFileSync(file, "utf8");
      // Throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX for anything Node would refuse
      // at load time — which is precisely the boot failure being guarded.
      expect(() => stripTypeScriptTypes(source)).not.toThrow();
    });
  }
});
