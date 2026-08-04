import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Headroom over vitest's 5s default, because this suite is deliberately
    // CPU- and memory-heavy: argon2id is memory-hard by design (~19 MB and
    // tens of ms per hash at @node-rs/argon2's defaults) and the suite performs
    // over fifty hashes across parallel workers. One local `npm run check` run
    // on 16 cores hit the 5s default on two tests that make no argon2 call at
    // all and merely opened a database — starvation, not logic — and a CI
    // runner has a fraction of those cores. 15s is still short enough to catch
    // a genuine hang rather than mask one. The one test that needs more asks
    // for it explicitly (db.test.ts's two-connection lock test, 8s).
    testTimeout: 15_000,
  },
});
