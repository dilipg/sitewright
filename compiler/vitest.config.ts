import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/*.spec.ts belongs to Playwright (npm run test:e2e), not vitest
    include: ["src/**/*.test.ts"],
    // Well above the 5s default, because a large share of this suite is not
    // unit-testing pure functions: exporter and gate tests copy the fixture
    // project and shell out to the project's own `tsc --noEmit` (gate 1). Alone
    // the slowest of those runs ~1.6s, but vitest runs test FILES in parallel,
    // so several `tsc` processes can be in flight at once — the zip-determinism
    // test was measured at 66s under that contention while passing in 1.6s on a
    // quiet machine. A CI runner is the loaded case, so the default would flake
    // there and nowhere else. Long enough to absorb that, still short enough
    // that a genuinely hung test fails rather than hanging the run.
    testTimeout: 120_000,
  },
});
