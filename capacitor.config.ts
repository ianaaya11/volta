import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the built web app (in dist/) as native iOS and Android apps.
// After `npm run build`, run `npx cap add ios` / `npx cap add android` once,
// then `npm run cap:sync` to push each new web build into the native shells.
const config: CapacitorConfig = {
  appId: 'com.zuri.livecircuit',
  appName: 'Zuri',
  webDir: 'dist',
  backgroundColor: '#0c111a',
  plugins: {
    // Android 15 (targetSdk 35) forces edge-to-edge, so the webview draws under
    // the status bar and the gesture pill. CSS env(safe-area-inset-*) does NOT
    // solve this on Android — there it only reports display *cutouts*, and
    // returns 0 for the status bar — so the insets have to be applied natively.
    // This plugin pads the webview by the real system-bar insets and paints the
    // bar area with the app's background.
    EdgeToEdge: { backgroundColor: '#0c111a' },
  },
};

export default config;
