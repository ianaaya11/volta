# Zuri — Live Circuit Simulator

A live, cross-platform analog circuit simulator: build a schematic on a grid,
press **Run**, and watch currents flow and voltages change in real time — in the
spirit of EveryCircuit, but open and built on a from-scratch SPICE-style engine.

- **Real-time animation** — currents animate along wires, node colors track voltage.
- **Full analog engine** — Modified Nodal Analysis with Newton-Raphson for
  nonlinear devices: resistor, capacitor, inductor, DC & sine sources, diode,
  BJT (NPN/PNP), MOSFET (NMOS/PMOS), and an ideal op-amp.
- **Oscilloscope** — probe any node and see its waveform live, multi-trace.
- **AC / Bode analysis** — complex-valued sweep with magnitude & phase plots.
- **Save / open / share** — circuits serialize to JSON and to shareable URLs.
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
  app.spec.ts # browser smoke tests against the production build (Playwright).
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

**Desktop (Tauri).** Requires the Rust toolchain.

```bash
npm run tauri dev      # develop in a native window
npm run tauri build    # produce native installers (.dmg/.msi/.deb/AppImage)
```

**Mobile (Capacitor).** Requires Xcode (iOS) and/or Android Studio.

```bash
npm run build
npm run cap:add:ios        # once
npm run cap:add:android    # once
npm run cap:sync           # after each web build
npx cap open ios           # open in Xcode
npx cap open android       # open in Android Studio
```

## Status

Ported from a verified single-file prototype. **52 automated checks pass**,
organized one file per device and covering DC, transient, and AC: voltage
divider and series/parallel networks, RC and RL time constants, diode drop and
rectification, BJT β with active/saturation/cutoff regions and the PNP mirror,
MOSFET region equations plus a common-source bias point and the PMOS mirror,
op-amp gains with the virtual short and virtual ground, RC −3dB point and
−20 dB/decade rolloff, RLC resonance, and SI formatting round-trips. On top of that, **9 Playwright specs**
load the production build in a real browser and confirm the on-screen readouts
match the engine. Roadmap and phase history live in `BUILD-PLAN.md`.

> The e2e suite drives your installed Google Chrome (`channel: 'chrome'`). If
> you'd rather use Playwright's own browser, run `npx playwright install chromium`
> and drop the `channel` line from `playwright.config.ts`.

## License

MIT
