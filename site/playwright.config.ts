import { defineConfig, devices } from '@playwright/test';

// The site is exercised the way it ships: built, then served with the real marketing
// API from one origin by e2e/fixtures/test-api.ts (temporary SQLite DB).

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'npm run build && node --import tsx e2e/fixtures/test-api.ts',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
