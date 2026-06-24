import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:5173",
    ...devices["Desktop Chrome"],
    headless: true,
  },
  webServer: {
    command: "echo 'server already running'",
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
});
