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
    headless: process.env.CI ? true : false,
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
