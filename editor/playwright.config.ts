import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:5174",
  },
  webServer: [
    {
      // WG_PROJECT_DIR (soak runs) serves an existing generated project;
      // default prepares and serves the disposable fixture copy
      command: process.env.WG_PROJECT_DIR
        ? `node scripts/preview.ts ${JSON.stringify(process.env.WG_PROJECT_DIR)} --port 5273`
        : "node ../editor/e2e/prepare-project.ts && node scripts/preview.ts ../generated/editor-e2e-project --port 5273",
      env: { WG_REGEN_MOCK: "1" },
      cwd: "../compiler",
      url: "http://localhost:5273",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run dev -- --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
