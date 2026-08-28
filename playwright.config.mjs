import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ["line"],
    [
      "html",
      {
        open: "never",
        outputFolder: "var/playwright/report",
      },
    ],
  ],
  outputDir: "var/playwright/test-results",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: "node tooling/run-browser-test-application.mjs",
    url: "http://127.0.0.1:5173/web-ui/",
    env: { APINTERACT_BROWSER_TEST_FRONTEND_MODE: "production" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
