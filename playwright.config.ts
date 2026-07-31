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
    // Start every test as a RETURNING visitor. About is the landing page on a
    // first visit, and it covers the editor — which is not what these tests are
    // about. e2e/landing.spec.ts uses a fresh context to cover that path
    // deliberately, so the behaviour is tested once rather than fought
    // everywhere.
    storageState: 'e2e/state.json',
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
    // Blank the community credentials for the whole suite. Vite gives an
    // already-set env var priority over .env files, so this pins the build to
    // the unconfigured baseline — the state e2e/community.spec.ts documents —
    // rather than letting a developer's .env.local decide what is tested.
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
