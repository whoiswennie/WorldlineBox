import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: process.env.WORLDLINEBOX_E2E_OUTPUT_DIR ?? '.tools/test-output/playwright',
  maxFailures: process.env.WORLDLINEBOX_E2E_FAIL_FAST === '1' ? 1 : undefined,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  preserveOutput: 'failures-only',
  use: {
    trace: 'retain-on-failure',
  },
});
