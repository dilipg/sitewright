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
      command:
        "node ../editor/e2e/prepare-project.ts && node scripts/preview.ts ../generated/editor-e2e-project --port 5273",
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
