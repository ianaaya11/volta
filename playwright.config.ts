import { defineConfig, devices } from '@playwright/test';

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
  projects: [
    { name: 'desktop', testIgnore: /touch\.spec\.ts/ },
    // The mobile shells (Capacitor iOS/Android) render this same build with a
    // finger as the only input device, so the touch suite runs under a real
    // touch-capable, mobile-viewport context.
    {
      name: 'mobile',
      testMatch: /touch\.spec\.ts/,
      use: { ...devices['Pixel 7'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
