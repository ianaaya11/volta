import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// Base is './' so the built app works from any subpath — GitHub Pages, a file://
// open, or inside the Capacitor/Tauri app shells, all without reconfiguration.
export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Zuri — Live Circuit Simulator',
        short_name: 'Zuri',
        description: 'Design and simulate analog circuits with real-time animation, a scope, and Bode analysis.',
        theme_color: '#0c111a',
        background_color: '#0c111a',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // The whole app is static and offline-first once cached.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
    }),
  ],
  build: { target: 'es2020', outDir: 'dist' },
  // Vitest owns tests/ (the engine suites); Playwright owns e2e/ and must not
  // be picked up here — the two runners share a file extension, not a runtime.
  test: { include: ['tests/**/*.test.ts'] },
});
