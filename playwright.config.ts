import { defineConfig } from '@playwright/test';

// The smoke suite runs against the PRODUCTION build, not the dev server, so
// what it exercises is what actually ships — bundled, minified, service worker
// and all. `channel: 'chrome'` drives the system Chrome rather than a
// Playwright-managed download.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'chrome',
    trace: 'off',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
