# Zuri — Live Circuit Simulator

A live, cross-platform analog circuit simulator: build a schematic on a grid,
press **Run**, and watch currents flow and voltages change in real time — in the
spirit of EveryCircuit, but open and built on a from-scratch SPICE-style engine.

- **Real-time animation** — currents animate along wires, node colors track voltage.
- **Full analog engine** — Modified Nodal Analysis with Newton-Raphson for
  nonlinear devices: resistor, capacitor, inductor, DC / sine / square sources,
  diode, BJT (NPN/PNP), MOSFET (NMOS/PMOS), and an ideal op-amp.
- **Oscilloscope** — tap any component to plot its voltage and current live, on
  separate axes. Probes can also be placed by hand to compare several nodes.
- **Undo / redo** — every edit is reversible (⌘Z / ⇧⌘Z), and **Reset** restarts
  the simulation from t=0 without touching the schematic.
- **AC / Bode analysis** — complex-valued sweep with magnitude & phase plots.
- **Save / open / share** — circuits serialize to JSON and to shareable URLs.
- **Touch-ready** — pointer-based input and a phone layout, so the same build
  works with a finger as well as a mouse.
- **One engine, every platform** — web (PWA), iOS/Android (Capacitor), desktop (Tauri).

## Architecture

The project is deliberately split so the physics is independent of the UI and of
any platform:

```
src/
  engine.ts   # pure simulation engine — no DOM. The single source of truth.
  format.ts   # SI value formatting / parsing (pure).
  main.ts     # schematic editor, rendering, scope/Bode UI, persistence.
  style.css   # app styling.
index.html    # Vite entry / markup.
tests/        # one file per device, verified against closed-form theory:
  solver  diode  bjt  mosfet  opamp  transient  ac  format
e2e/
  app.spec.ts   # browser smoke tests against the production build (Playwright).
  touch.spec.ts # the same build driven by touch, at a phone viewport.
```

`engine.ts` takes a plain netlist (`{ id, type, nodes, value, ... }[]`) and
returns node voltages and branch currents. It knows nothing about canvases,
events, or frameworks — which is exactly what lets the same engine run on the
web, in a mobile shell, and in a desktop window unchanged. Every device model is
verified in isolation against a hand calculation or a textbook transfer function
before it ships (see `tests/`).

The whole project is typed and checked under `strict`. The netlist is a
discriminated union (`Component`), so narrowing on `c.type` yields exactly the
fields that device model uses, and `main.ts` converts its looser editor model
into that union in one place (`toDevice`) — the single boundary where a
schematic becomes physics.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine suites, one file per device (Vitest)
npm run test:e2e   # browser smoke tests against the production build (Playwright)
npm run typecheck  # tsc --noEmit, strict
npm run build      # production build -> dist/
npm run preview    # serve the production build
```

## Ship to each platform

**Web (PWA).** `npm run build` produces an installable, offline-capable PWA in
`dist/`. Deploy `dist/` to any static host (GitHub Pages, Netlify, Vercel).

**Desktop (Tauri).** Requires the Rust toolchain (`rustup`). Verified on macOS —
`Zuri.app` builds and launches with the simulator running inside it.

```bash
npm run tauri dev      # develop in a native window
npm run tauri build    # produce native installers (.dmg/.msi/.deb/AppImage)
```

The bundle icons in `src-tauri/icons/` are generated from `public/icon.svg`. To
regenerate them, render that SVG to a 1024×1024 PNG and run
`npx tauri icon <file>.png`.

**Mobile (Capacitor 7).** Requires a JDK 21 and the Android SDK (Android
Studio, or the command-line tools) for Android; Xcode and CocoaPods for iOS.
Both are verified: `assembleDebug` produces a 3.9 MB APK
(`com.zuri.livecircuit`, targetSdk 35) that runs on a physical Pixel, and the
iOS build runs in the Simulator with the full UI.

```bash
npm run build
npm run cap:add:android    # once
npm run cap:add:ios        # once (needs CocoaPods)
npm run cap:sync           # after each web build
npx cap open android       # open in Android Studio
npx cap open ios           # open in Xcode
```

Building Android from the command line needs both env vars set — the Gradle
project resolves the SDK from `ANDROID_HOME`, and the Android Gradle plugin
wants a JDK 21 (a newer JDK will fail):

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21   # macOS/Homebrew
cd android && ./gradlew assembleDebug           # -> app/build/outputs/apk/debug/
```

For iOS, the **first** build must be run from Xcode (`npx cap open ios`, then
press ▶) and you must answer the keychain prompt with **Always Allow**. Until
then `codesign` fails with `errSecInternalComponent` from any non-GUI shell,
because the keychain will not release the signing key without a prompt. After
that one time, command-line builds work.

> Capacitor is pinned to 7.x deliberately: 8.x requires Node ≥ 22, and 6.x
> predates the target-SDK level Google Play now requires. The generated
> `android/` and `ios/` directories are gitignored — Capacitor recreates them
> from `capacitor.config.ts`.

## Status

Ported from a verified single-file prototype. **52 automated checks pass**,
organized one file per device and covering DC, transient, and AC: voltage
divider and series/parallel networks, RC and RL time constants, diode drop and
rectification, BJT β with active/saturation/cutoff regions and the PNP mirror,
MOSFET region equations plus a common-source bias point and the PMOS mirror,
op-amp gains with the virtual short and virtual ground, RC −3dB point and
−20 dB/decade rolloff, RLC resonance, and SI formatting round-trips. On top of that, **14 Playwright specs**
load the production build in a real browser and confirm the on-screen readouts
match the engine — 9 on a desktop viewport and 5 driving the same build by touch
at a phone viewport. Roadmap and phase history live in `BUILD-PLAN.md`.

> The e2e suite drives your installed Google Chrome (`channel: 'chrome'`). If
> you'd rather use Playwright's own browser, run `npx playwright install chromium`
> and drop the `channel` line from `playwright.config.ts`.

## License

MIT
