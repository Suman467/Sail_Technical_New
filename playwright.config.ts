import { defineConfig } from "@playwright/test";
import { config } from "./utils/config";

const headless = process.env.HEADLESS?.trim().toLowerCase() === "true";

export default defineConfig({
  // Maximum time allowed for one test
  timeout: 60 * 1000,

  // Maximum time for Playwright expect assertions
  expect: {
    timeout: 15 * 1000,
  },

  // Location of test files
  testDir: "./tests",

  // Do not run tests in parallel
  fullyParallel: false,

  // Retry only in CI
  retries: process.env.CI ? 2 : 0,

  // One worker because all tests use the same user account
  workers: 1,

  // Reporters
  reporter: [
    [
      "html",
      {
        open: "never",
        outputFolder: "reports/validation/playwright-html",
      },
    ],
    ["./utils/SimpleReporter.ts"],
  ],

  // Common Playwright settings
  use: {
    // Use the real browser window size instead of a fixed Playwright viewport
    viewport: null,

    // Start Chrome/Chromium maximized
    launchOptions: {
      args: ["--start-maximized"],
    },

    // Timeouts
    actionTimeout: 15 * 1000,
    navigationTimeout: 30 * 1000,

    // Debugging
    trace: "retain-on-failure",
    screenshot: "only-on-failure",

    // Application URL
    baseURL: config.baseUrl,

    // Local runs remain headed by default. Set HEADLESS=true for CI or
    // environments without a graphical desktop.
    headless,
  },

  projects: [
    {
      name: "chromium",

      use: {
        // Keep null so Playwright does not force a fixed viewport
        viewport: null,
      },
    },
  ],
});
