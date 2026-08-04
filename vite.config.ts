import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// Base is './' so the built app works from any subpath — GitHub Pages, a file://
// open, or inside the Capacitor/Tauri app shells, all without reconfiguration.
export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'about-photo.webp'],
      manifest: {
        name: 'Volta — Live Circuit Simulator',
        short_name: 'Volta',
        description: 'Design and simulate analog circuits with real-time animation, a scope, and Bode analysis.',
        // A manifest gets one colour, and the app's default theme is light.
        // These paint the splash screen an installed app shows before any of
        // its own CSS has loaded; the old navy flashed dark and then went white.
        theme_color: '#f7f9fc',
        background_color: '#f7f9fc',
        display: 'standalone',
        orientation: 'any',
        // The SVG first — it stays crisp at any size on Android — with PNGs
        // behind it, because installability checks and older launchers want a
        // raster of a known size and quietly refuse the install without one.
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The whole app is static and offline-first once cached. jpg is here
        // for the About page's portrait: About is the landing page, so leaving
        // it out means an offline first visit lands on a broken avatar.
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,webp,ico}'],
      },
    }),
  ],
  build: { target: 'es2020', outDir: 'dist' },
  // Vitest owns tests/ (the engine suites); Playwright owns e2e/ and must not
  // be picked up here — the two runners share a file extension, not a runtime.
  // The unit suite runs against the *unconfigured* build — that is the state
  // the tests assert, and it is the one real users get from a plain clone.
  // Without this, a developer's own .env.local leaks in and community.test.ts
  // starts testing their Supabase project instead of the offline default.
  test: { include: ['tests/**/*.test.ts'],
          env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' } },
});
