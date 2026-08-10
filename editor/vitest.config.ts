import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/*.spec.ts belongs to Playwright (npm run test:e2e), not vitest.
    //
    // `.tsx` is included as well as `.ts` (task 2) so that a component test
    // named after its `.tsx` subject is not SILENTLY skipped: a file the glob
    // does not match is not reported as excluded, it simply never runs, which
    // is the one failure mode "every test must fail if the behaviour it names
    // is removed" cannot detect. The repo's existing precedent is to write
    // even a component's test as `.test.ts` (ExportPanel.test.ts,
    // LoginScreen.test.ts) because no React testing library exists here to
    // need JSX for — this widening is a guard, not an invitation.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
