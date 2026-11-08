import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Mobile-first browser walkthrough (T1301/T1304). Runs against a throwaway
 * database served by `tests/e2e/start-server.ts`; reduces motion so the E1
 * timeline settles immediately (the reduced-motion path is the one we ship).
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    {
      name: 'mobile-chromium',
      // Reuse the locally installed Chrome: no 150MB browser download needed.
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        channel: process.env.WTM_E2E_BROWSER_CHANNEL ?? 'chrome',
      },
    },
  ],
  webServer: {
    command: 'npx tsx tests/e2e/start-server.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { WTM_E2E_PORT: String(PORT) },
  },
});
