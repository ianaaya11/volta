import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the built web app (in dist/) as native iOS and Android apps.
// After `npm run build`, run `npx cap add ios` / `npx cap add android` once,
// then `npm run cap:sync` to push each new web build into the native shells.
const config: CapacitorConfig = {
  appId: 'com.zuri.livecircuit',
  appName: 'Zuri',
  webDir: 'dist',
  backgroundColor: '#0c111a',
};

export default config;
