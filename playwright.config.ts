import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { config } from "./utils/config";

// All replacement workers in this Playwright run reuse the same authenticated
// state. The per-run file lives outside the repository and is not reused by a
// later command.
process.env.COMPONENTS_AUTH_STATE_PATH ??= path.join(
  os.tmpdir(),
  `sail-components-auth-${process.pid}.json`,
);

const headless = process.env.HEADLESS?.trim().toLowerCase() === "true";
const explicitlyTargetedSpecs = process.argv
  .filter((argument) => !argument.startsWith("-") && /\.spec\.ts$/i.test(argument))
  .map((argument) => argument.replaceAll("\\", "/").replace(/^\.\//, ""));
const cleanupSpecExplicitlyTargeted = explicitlyTargetedSpecs.length === 1
  && (explicitlyTargetedSpecs[0] === "tests/components/clean.spec.ts"
    || explicitlyTargetedSpecs[0].endsWith("/tests/components/clean.spec.ts"));
const runningHoursWorkflow = explicitlyTargetedSpecs.length > 0
  && explicitlyTargetedSpecs.every((spec) =>
    spec === "tests/running-hours" || spec.includes("tests/running-hours/"));

// Playwright evaluates this configuration before creating its workers, so an
// exact direct CLI target can authorize cleanup without making normal suite
// discovery destructive.
if (cleanupSpecExplicitlyTargeted) {
  process.env.MANUAL_COMPONENT_CLEANUP = "true";
}

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
    ...(!runningHoursWorkflow ? [[
      "html",
      {
        open: "never",
        outputFolder: "reports/validation/playwright-html",
      },
    ] as const] : []),
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
