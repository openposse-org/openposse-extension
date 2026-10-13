// The browser tests in test/e2e/. Run with `npm run test:e2e`, which builds `dist-e2e/` first.
//
// One test at a time: each starts its own browser with the extension in a fresh profile, and
// running them side by side buys little for four tests while making their timings harder to
// read. No retries, so a test that only sometimes passes shows up as failing.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.mjs',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
