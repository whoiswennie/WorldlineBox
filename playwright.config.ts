import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  outputDir: '.tools/test-output/playwright',
  preserveOutput: 'failures-only',
  use: {
    trace: 'retain-on-failure',
  },
});
