# Spark — concrete build plan

A phased plan to grow the working prototype into a cross-platform, full-analog
circuit simulator in the spirit of EveryCircuit. It is written to be executed in
order: each phase produces something runnable and verified before the next
begins. **Phase 1 is already done** — the transistor described below is
implemented, verified, and in the app today.

## Guiding principles (don't break these)

The prototype earns its extensibility from three rules, and the plan depends on
keeping them. First, **the engine is a pure module** with no knowledge of the
DOM — it takes a netlist and returns voltages and currents, nothing else. Every
new device is added here and only here. Second, **every device is verified in
isolation** in Node against a known answer before it is wired into the UI; that
is how the diode (0.69V) and the transistor (β=100, Vc=4.09V) were validated,
and it is non-negotiable for each new part. Third, **nonlinear parts converge
through Newton-Raphson with junction limiting** (`pnjlim`) — the machinery is
already in place, so new semiconductors reuse it rather than reinventing it.

## Phase table

| Phase | Goal | Key work | Verification | Status |
|---|---|---|---|---|
| 0 | Foundation | MNA engine (R, V, I, C, L, D), schematic editor, animation, node detection | 6 solver tests + browser smoke | ✅ done |
| 1 | First transistor | NPN/PNP BJT (Ebers-Moll) + 3-terminal support + `pnjlim` | 6 BJT tests + UI amp example (Vc=4.09V) | ✅ done |
| 2 | Core semiconductors | MOSFET (square-law), ideal op-amp — controlled sources still TODO | Bias-point + gain tests per device | ✅ done |
| 3 | Instrumentation | Oscilloscope (probe nodes, live multi-trace) + sine source to drive it | Frequency-response test + UI capture | ✅ done |
| 4 | Analyses | AC small-signal sweep + Bode plot (magnitude & phase) | RC/RLC transfer-function checks | ✅ done |
| 5 | Persistence & sharing | Save/load circuits as JSON, shareable URLs, named example gallery | Round-trip serialize tests | ✅ done |
| 6 | Cross-platform packaging | TypeScript port, Capacitor (iOS/Android), Tauri (desktop), PWA offline | Per-platform launch + touch tests | ✅ launched on web, macOS, Android hardware, iOS simulator |
| 7 | Differentiators | "Show the math" learning mode, MCU co-sim, AI circuit assistant | Feature-specific | |

## Phase 1 — what was just delivered (reference implementation)

The NPN transistor is the template every future device follows. It shows the
full pattern end to end: an **Ebers-Moll transport model** computes collector and
base currents from the two junction voltages; its **3×3 Jacobian** is stamped
into the matrix each Newton iteration; **`pnjlim` voltage limiting** keeps the
exponential from diverging (without it, Vbe ran away to 2.4V — the first attempt
failed exactly this way, which is the canonical SPICE convergence trap); and the
editor gained **generic 3-terminal support** (pin geometry, rotation, netlist
mapping, symbol drawing, per-terminal current animation). PNP is included as a
sign-mirror of the same equations. Verified operating point: β=100, Vbe=0.71V,
Vc=4.09V in active region, and correct saturation (Vce=0.12V) when driven hard.
Use this as the reference when adding the MOSFET.

## Phase 2 — the rest of the active devices ✅ (delivered)

**Done:** the MOSFET and the ideal op-amp are both implemented, verified, and in
the app, each with its own worked example in the Load-example cycle.

The **MOSFET** uses the square-law model (cutoff / triode / saturation, with
`Id = ½·k·(Vgs−Vth)²` in saturation), stamped through the same Newton-Raphson
path as the BJT — simpler, in fact, because the gate draws no DC current, so no
`pnjlim` is needed. It reuses the transistor's 3-terminal machinery entirely;
only the model equations and the symbol differ. NMOS and PMOS share one code
path via a polarity sign. Verified against a common-source bias point (Vg=2V,
Vd=3V, Id=1mA exactly) plus direct region checks (cutoff/triode/saturation) and
a PMOS mirror — 9 checks.

The **ideal op-amp** is a high-gain voltage-controlled voltage source with its
own MNA branch current (a pure linear stamp, no iteration). It "just works" for
the standard configs: verified at non-inverting gain 2 and 5, inverting gain −1,
with the virtual-short and virtual-ground behaviors confirmed — 5 checks. This
is the part that unlocks active filters, comparators, and oscillators.

**Still TODO in this phase if you want it:** the four **controlled sources**
(VCVS, VCCS, CCVS, CCCS). They're pure linear stamps — cheap to add — and unlock
a lot of textbook circuits, but they're lower priority than moving on to
instrumentation, so they're deferred rather than done.

## Phase 3 — instrumentation ✅ (delivered)

**Done:** the oscilloscope and a sine source to drive it are both in the app,
with a worked example that pre-places two probes on an RC low-pass.

The scope reused the fact that the engine already computes the full solution
every frame. A **probe tool** lets you click any node or wire to scope it; each
probe keeps a ring buffer of `(t, v)`; the panel autoscales vertically, shows a
zero line and a time-window readout, and prints each probe's live value in the
legend. Multiple traces overlay in distinct colors. This is what turns "the dots
move" into "I can see the waveform" — the single most-requested capability in
every competitor review.

Driving it required a **time-varying source**, so the engine gained a notion of
absolute simulation time (`step()` now accumulates `t`) and a **sine source**
(`offset + amp·sin(2πf·t)`). Verified the whole path against theory: an RC
low-pass driven across frequency gives 0.994 of input at low frequency, exactly
0.704 (−3dB) at its cutoff, and 0.099 a decade above — the textbook response, and
visibly a lagging, shrunken output on the scope.

**Deferred from this phase:** a numeric multimeter panel and a DC sweep. Both
ride on the same plumbing and are small, but they're lower value than the AC
analysis in Phase 4, so they're not done yet.

## Phase 4 — real analyses ✅ (delivered)

**Done:** AC small-signal analysis with a **Bode plot** (magnitude and phase),
driven by a **Bode** button in the header and plotted for whichever nodes you've
probed.

AC was the one genuinely new solver in the roadmap. It computes the DC operating
point, linearizes every nonlinear device around it (the diode, BJT, and MOSFET
contribute their small-signal conductances; the op-amp is already linear), then
builds and solves the **complex** system `(G + jωC)·v = i` at each point of a
log-spaced frequency sweep. That required a complete complex-number layer — a
`{re, im}` arithmetic set and a complex Gauss-Jordan solver (`csolve`) — living
alongside the real solver. The stimulus source is driven with a unit phasor, so
each node's phasor *is* the transfer function to it; the UI converts that to dB
and degrees and draws magnitude (solid) over phase (dashed) with decade
gridlines.

Verified against closed-form theory: an RC low-pass reads −2.91 dB and −44.3° at
its cutoff (theory −3.01 dB, −45°) and rolls off at −20 dB/decade; a series RLC
peaks at unity gain (−0.05 dB) at 1596 Hz against a theoretical resonance of
1592 Hz. A pre-probed RLC bandpass example ships in the Load-example cycle — press
**Bode** to see the resonant peak.

**Deferred:** a numeric multimeter and an explicit DC-sweep plot. Both are small
and ride on existing plumbing, but they're lower value than persistence.

## Phase 5 — persistence and sharing ✅ (delivered)

**Done:** save, open, share, and a named example gallery are all in the header.

As predicted, this was the cheapest phase — the entire document really is just
the `comps`, `wires`, and probe arrays, so serialization is a one-liner.
**Save** downloads a `spark-circuit.json`; **Open** reads one back (with a
`uid`-reconciliation step so newly-placed parts never collide with loaded ids);
**Share** encodes the circuit into the URL hash as UTF-8-safe base64 and copies
the link to the clipboard; and on boot the app restores a shared circuit from the
hash if one is present, otherwise loads the default example. The old cycling
"Load example" button became a proper **gallery dropdown** listing all six
circuits by name. Verified by round-trip: build → serialize → clear → restore
preserves every part, wire, and probe exactly, the URL encode/decode is bit-exact,
and a restored circuit still runs both the scope and the Bode plot.

This is also where cloud sync would attach if you later want the EveryCircuit-style
community gallery.

## Phase 6 — cross-platform packaging

This is where "cross-platform" gets real, and the plan deliberately puts it
*after* the engine matures so you're packaging something worth shipping. The
recommended stack, lowest-friction first:

Port the codebase to **TypeScript** (the engine is self-contained math, so this
is mechanical and buys you type safety on the physics). Keep the web app as the
single source of truth, rendering to canvas. Then wrap the *same* app: **Capacitor**
produces native iOS and Android apps from the web build with touch input, and
**Tauri** (lighter than Electron) produces Windows/macOS/Linux desktop builds.
Make the web version a **PWA** so it works offline — directly answering the "web
needs a connection" complaint that dogs EveryCircuit and Falstad. One codebase,
one engine, every platform. If native-grade touch performance ever becomes the
bottleneck, **Flutter** is the fallback — the engine ports to Dart cleanly
because it's pure computation — but don't start there; the web-first path ships
far sooner.

**Status.** The restructure is in the repo and verified to run: `npm install`,
`npm test` (8 checks green), `npm run typecheck` (clean under `strict`), and
`npm run build` (emits `dist/` with a generated service worker and web manifest —
the PWA piece is done). `engine.ts` is now genuinely typed, not JavaScript
wearing a `.ts` extension: the netlist is a discriminated `Component` union, the
MNA layout fields are declared on the class, and the complex-arithmetic layer is
typed through `csolve`. No math changed — the same 8 checks pass before and after.

**Test coverage restored.** The port had arrived with only 8 checks against the
prototype's 46. The suite is now **52 checks across one file per device**, which
is the discipline this plan asks for: 6 solver, 4 diode, 7 BJT, 10 MOSFET, 5
op-amp, 4 sine/transient, 6 AC/Bode, 10 formatter. The transient
frequency-response checks measure gain by *running the simulation* and reading
the output peak, so they exercise the whole time-stepping path end to end rather
than re-deriving it. Restoring them required extracting `fmt`/`parseVal` out of
the UI file into `src/format.ts` — DOM-free and typed, like the engine.

**A real bug the restored coverage caught.** `parseVal` lower-cased its SI
prefix, so `"1M"` parsed as milli, not mega. Because the inspector fills its
input with `fmt(value)` and saves `parseVal(input)`, opening and re-saving a
1 MΩ resistor silently rewrote it as 1 mΩ — nine orders of magnitude, no
warning. Prefix parsing is now case-sensitive where it must be (`M` mega vs `m`
milli) and case-forgiving where there's no ambiguity, with a round-trip test
over every prefix `fmt` can emit.

**The UI is typed too.** `main.ts` no longer carries `// @ts-nocheck`; the whole
project compiles under `strict`. The part that mattered was the boundary between
the editor's model and the engine's: a placed part (`Comp` — loose, with
optional value and rotation because ground has neither) is now converted by a
single `toDevice()` switch into the engine's discriminated `Component`. Each
case builds exactly the fields that device model reads, so an absent value can
no longer reach the solver as `undefined`. Two latent problems fell out of the
pass: `TYPES` had no entries for PNP or PMOS even though the renderer draws them
and a loaded circuit can contain them (an inspector click would have thrown),
and `index.html` never linked its own icon, so every page load 404'd on
`/favicon.ico`.

**The browser smoke tests are back.** Nine Playwright specs in `e2e/` run
against the *production build*, so what they exercise is what ships. They assert
the same operating points the engine suites do, but read off the live inspector
panel: the BJT amp's 4.09 V collector, the NMOS bias at Vg=2/Vd=3, op-amp gain
2. They also check the canvas actually has ink on it (rather than merely
existing), that Bode paints its panel, that placing a part updates the node
count, and that Share round-trips a circuit through the URL and still solves to
4.09 V after a reload. They drive the system Chrome via `channel: 'chrome'`
rather than a Playwright-managed download.

**Touch works, and the phone layout exists.** The editor listened only for mouse
events, which is fatal on a phone: touch never synthesizes the `mousemove`
stream a drag needs, so parts could be placed but never moved. Input now runs
through **pointer events**, one path for mouse, touch and pen, with pointer
capture so a drag survives leaving the canvas, `touch-action:none` so the
browser can't claim the gesture for scrolling, and `overscroll-behavior:none` so
a drag past the edge doesn't trigger pull-to-refresh. Tapping a wire run's own
start point now ends it, because the desktop gesture for that is a double-click
and a double-tap is the browser's zoom.

Writing those tests exposed something larger: the three-column desktop layout
has a fixed 64px rail and 280px inspector, which on a 412px phone left the
schematic **68 pixels wide** — the app was unusable on the exact platforms this
phase exists to reach. Below 760px the columns now unstack into rows (rail as a
scrolling strip, inspector along the bottom, canvas full-width), the header
orders Run and Bode first so the primary action is never the thing scrolled
off-screen, and `100dvh` keeps mobile browser chrome from cropping the canvas.

**Desktop (Tauri) — built and launched.** The desktop target had never been
compiled, and it could not have been: `tauri.conf.json` pointed its bundle icon
at `icons/icon.png` while `src-tauri/icons/` did not exist, so the build failed
before touching Rust. The icon set is now generated from the app's own
`public/icon.svg`. On macOS, cargo builds the release binary, Tauri bundles
`Zuri.app`, and the app launches: registered as `com.zuri.livecircuit`, resident
at ~88 MB, with a WebKit content process — the webview really loaded the
simulator rather than opening an empty shell.

**Android (Capacitor) — packaged.** Capacitor was pinned at core 6 with no
platform packages at all, so `cap add` failed outright on a peer conflict. The
stack is now on **Capacitor 7**: v8 requires Node ≥ 22 (this toolchain is on
20), and v6 predates the target-SDK level Google Play now requires. Doing that
upgrade before any native project existed cost no migration at all. The Android
project scaffolds, `cap sync` embeds the production web build, and Gradle
produces a 3.9 MB `app-debug.apk` whose manifest reads `com.zuri.livecircuit`
at **targetSdk 35** with the real JS bundle inside. Building needs a JDK 21
specifically — the Android Gradle plugin rejects newer JDKs.

**Android — running on hardware.** Installed and launched on a physical Pixel
Fold (Android 16): the schematic renders, tools respond to touch, tapping a part
opens the inspector and its value field takes keyboard input. Running on real
hardware immediately exposed a defect nothing else caught — the header rendered
*underneath* the system status bar, because targetSdk 35 forces edge-to-edge on
Android 15+. See the safe-area note below.

**iOS — running in the simulator.** Xcode 26.6, CocoaPods 1.17, and the iOS 26.5
platform (8.5 GB) are installed; `cap add ios` scaffolds and `pod install`
succeeds; the app compiles for both simulator and device, and runs correctly on
an iPhone 17 simulator with the full UI and the phone layout applied.

**Safe areas are not portable — this cost two rounds to get right.**
`env(safe-area-inset-*)` is the entire fix on iOS, where the insets describe the
notch and status bar. On **Android** the same CSS silently does nothing: WebView
reports display *cutouts* only, so the status-bar height is absent and env()
resolves to `0px` on a screen without a notch. Android needs the insets applied
natively, via the edge-to-edge support plugin declared in `capacitor.config.ts`
(so it survives `android/` being regenerated). Both halves now ship.

**Remaining in this phase.** (1) Installing to the physical iPhone is blocked on
one interactive step: `codesign` fails with `errSecInternalComponent` when
driven from a non-GUI shell, because the keychain won't release the signing key
without a prompt. Pressing ▶ once in Xcode and choosing "Always Allow" clears
it permanently. (2) On iOS the header still crowds the Dynamic Island slightly —
`env(safe-area-inset-top)` is not taking full effect inside Capacitor's
WKWebView. Cosmetic, but unfinished.

## Editor affordances added after Phase 6

Three gaps surfaced from actually using the app, all now closed.

**The scope was invisible unless you placed a probe.** `drawScope` returned
early on an empty probe list, so pressing Run on any example animated the
current dots but drew no waveform at all — you had to know the Probe tool
existed first. Selecting a component now plots its **voltage across and current
through** on separate autoscaled axes, which is the EveryCircuit behaviour and
the reason the app exists. Manual probes still work and share the voltage plot.

**There was no way to restart a run.** The only reset was Clear, which deletes
the circuit. **Reset** now drops the solver state, waveforms and Bode sweep and
returns to t=0 while leaving the schematic alone.

**Undo/redo.** History is a stack of whole-document snapshots — the same JSON
Save and Share already produce. The document is only parts, wires and probes, so
snapshotting per edit is far simpler than inverse operations, and any future
edit becomes undoable with no extra bookkeeping. ⌘Z / ⇧⌘Z, 100 levels.

**A square/pulse source** joins the sine, with an adjustable duty cycle. It maps
onto the engine's existing `VS` device, so the solver gained one wave shape
rather than a new device. Verified in both physical regimes: it averages to its
DC level through an RC whose time constant dwarfs the period, and follows the
edges to both rails when it doesn't.

## Phase 7 — where you actually differentiate

With the fundamentals solid, invest in the things the incumbents don't have. A
**"show the math" learning mode** — exposing the live nodal equations, the MNA
matrix, and the step-by-step solve as the circuit runs — turns the engine's
internals into the product's teaching advantage, and the annotated code already
exists to build it. **Microcontroller co-simulation** (run real Arduino/MCU code
against the live analog sim) fills a hole EveryCircuit leaves entirely open. And
an **AI circuit assistant** that builds, explains, and debugs circuits from plain
language is something none of them ship — and something you're unusually well
positioned to add.

## Testing strategy (applies to every phase)

Keep the two-layer discipline that's already working: a **Node test file per
device** that checks its numbers against a known answer (hand calculation or
textbook), and a **headless-browser smoke test** that loads the app, runs a
representative circuit, and confirms the on-screen values match. Every new device
adds one of each before it's considered done. This is why the current engine is
trustworthy — **52 automated checks pass in the repo today** (6 solver, 4 diode,
7 BJT, 10 MOSFET, 5 op-amp, 4 sine/transient, 6 AC/Bode, 10 formatter), run with
`npm test` — and it's the cheapest insurance you have as complexity grows. The
second layer is back too: **14 headless-browser specs** (`npm run test:e2e`) load
the production build and confirm the on-screen numbers match the engine's — 9 on
a desktop viewport, 5 more in a touch-capable phone context covering tap-to-place,
touch-drag, tap-to-tap wiring, and the canvas actually getting the screen.

## Suggested immediate next step

Phases 0–5 are done: a verified analog engine (diode, BJT, MOSFET, op-amp), DC,
transient with a live oscilloscope, AC with a Bode plot, and full
save/open/share persistence. The app is now a genuinely usable single-file tool.

The next move is the big one toward shipping to real users: **Phase 6 —
cross-platform packaging**. Port the single HTML file to a **TypeScript** project
(the engine is self-contained math, so this is mechanical and buys type safety),
keep the web app as the source of truth, then wrap the same build with
**Capacitor** for native iOS/Android and **Tauri** for desktop, and make the web
version an installable **offline PWA**. One engine, one UI, every platform —
directly delivering the cross-platform goal you set at the start. Note that this
phase is a build-tooling and project-restructure step rather than an in-app
feature, so it's better done in a real repository than in the single-file
prototype; the prototype is the reference the port copies from.
