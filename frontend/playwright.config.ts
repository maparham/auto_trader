import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    headless: true,
  },
  webServer: {
    command: "echo 'server already running'",
    url: baseURL,
    reuseExistingServer: true,
  },
});
