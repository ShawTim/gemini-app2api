import { defineConfig } from "@playwright/test";
import path from "node:path";
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "**/*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  outputDir: process.env.PI_SCRATCH_DIR
    ? path.join(process.env.PI_SCRATCH_DIR, "gateway-browser-results")
    : path.resolve(import.meta.dirname, "../../test-results"),
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
