import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/*.spec.ts belongs to Playwright (npm run test:e2e), not vitest
    include: ["src/**/*.test.ts"],
  },
});
