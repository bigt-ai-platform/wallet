import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report' }],
  ],
  timeout: 60000,
  use: {
    baseURL: process.env.APP_URL || 'http://localhost:8081',
    // Fail a stuck action fast instead of hanging until the (per-test, often
    // minutes-long) test timeout — a locator that never resolves otherwise
    // looks like "the test timed out" with no clue which step stalled.
    actionTimeout: 30_000,
    headless: process.env.HEADED !== '1',
    // HEADED=1: slow each action down so the flow is watchable in the
    // browser window (default is far too fast to follow). Position the
    // window in a clear area of the (often crowded) desktop and keep it
    // on top — the e2e box runs under KasmVNC whose client windows
    // otherwise cover a freshly opened Chromium.
    slowMo: process.env.HEADED === '1' ? Number(process.env.SLOW_MO || 200) : 0,
    launchOptions: process.env.HEADED === '1'
      ? {
          args: [
            '--window-position=1300,40',
            '--window-size=1500,1000',
          ],
        }
      : {},
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
      },
      testIgnore: '**/desktop.spec.ts',
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: '**/playwright/tests/desktop.spec.ts',
    },
  ],
  outputDir: 'test-results',
});
