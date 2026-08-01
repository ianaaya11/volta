# Volta — Live Circuit Simulator

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
- **Zoom & pan** — wheel or pinch to zoom, drag empty grid to pan, **Fit** (or
  `0`) to frame the circuit; `+` / `-` zoom, space-drag pans over anything.
- **Show the math** — press **∑ Math** to watch the solver work: the KCL
  equation at each node, the MNA matrix it actually inverts, the solution
  vector, and how Newton-Raphson converged — live, as the circuit runs.
- **AI circuit assistant** — press **✨ Ask** to build, explain, or debug
  circuits in plain language. Bring your own Anthropic API key (see below).
- **MCU co-simulation** — press **🔌 Code** and write an Arduino-style sketch
  that drives **MCU pin** parts on the schematic, running in simulated time
  against the analog solver.
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

## MCU co-simulation

Place **MCU pin** parts (one pad per digital pin, numbered in the inspector),
then press **🔌 Code** and write a sketch. Try the *MCU: blinking LED* example.

```c
int led = 13;
void setup() { pinMode(led, OUTPUT); }
void loop() {
  digitalWrite(led, HIGH); delay(500);
  digitalWrite(led, LOW);  delay(500);
}
```

Supported: `setup`/`loop`, `int`/`float`, `if`/`else`, `while`, `for`,
arithmetic and comparison, and `pinMode`, `digitalWrite`, `digitalRead`,
`delay`, `delayMicroseconds`, `millis`, `micros`, `abs`, `min`, `max`,
`constrain`. An output pin is an ideal 0–5 V source; an input is
high-impedance and reads HIGH above 2.5 V.

The sketch runs on the **simulated** clock, so `delay(500)` is 500 ms of circuit
time. It's saved and shared with the circuit. `BUILD-PLAN.md` lists what's
deliberately not implemented yet (ADC/PWM, serial, interrupts, real AVR
binaries) and roughly what each would take.

## AI assistant

Press **✨ Ask** and paste an [Anthropic API key](https://console.anthropic.com/).
The app calls the Claude API directly from the browser, so it stays a static
PWA with no backend and nothing to deploy or pay for per user.

> **The key lives in this browser's `localStorage`,** which means any script
> running on the page could read it. That's an acceptable trade for a personal
> or self-hosted tool; it is *not* appropriate for a public deployment. If you
> host this for other people, move the call behind a small server-side proxy
> holding one key, and drop `dangerouslyAllowBrowser` from `src/ai.ts`.

Asking for a circuit replaces the canvas, and lands in the undo stack — ⌘Z
reverts it like any other edit. Asking a question about the circuit on screen
("why is this transistor saturated?") just answers in text. The SDK is
code-split, so the offline app doesn't download it unless you open the panel.

## Reading the numbers while it runs
The readouts show **settled figures, not the instantaneous solution**. A value
that is oscillating reads as its bounds — `±3 V` when the swing is symmetric,
`0 … 2.7 mW` when it is not — with RMS underneath for a voltage or a current,
and the average for a power. A value that is genuinely steady collapses to a
single figure, so DC circuits read exactly as they always did. The meters on the
schematic show RMS, which is what a true-RMS multimeter shows.

A **Steady / Live** switch sits on the Node voltages heading. Live puts the
instantaneous value back, updated every frame — which is the right mode when
what you want to see is a number *changing*: a capacitor charging, a motor's
stall current falling away, a flip-flop toggling.

The window is sized in cycles of the slowest source, not in frames or seconds,
because how much simulated time a frame covers depends on which constraint set
the timestep and those differ by more than an order of magnitude. Bounds use
about one and a quarter cycles so they react quickly; averages use eight, over
completed whole-cycle windows, which is what makes a 3 V sine read 2.12 V rms
rather than 2.23.

## How wires connect
Wires join where their **ends** meet — a shared endpoint, or a wire ending
part-way along another one. That second case is the T-junction everyone uses to
tap a rail, and it is made real when you draw it: the rail is split in two at
that point, so what you get is an ordinary three-ended junction with a dot on
it, indistinguishable from one drawn pin to pin.

Splitting at draw time rather than reinterpreting the geometry afterwards is
deliberate. A netlist rule that treats any point inside a segment as connected
would change what circuits *already drawn* mean — the built-in 555 runs its
discharge rail through the point where the LED's cathode wire begins, and such a
rule shorts the LED and stops it oscillating. A saved design could have the same
overlap anywhere in it.

Two wires **crossing** do not connect, as in any schematic. Nor does a component
pin that merely happens to lie under a passing wire: to attach a part, end a
wire on its pin.

## Getting around, and reshaping a wire
Select a wire and it grows a handle at each end; drag one to extend the wire,
shorten it, or swing it somewhere else. The result is routed the same way the
Wire tool routes, so an end dragged off the wire's own axis becomes a
right-angled pair rather than a diagonal, and dragging one end onto the other
removes the wire. Nothing else on the schematic moves.

Picking a part from the rail places **one**, then hands you back the Select
tool. Hold **shift** while clicking to keep the tool armed, or **double-tap the
rail tile** to lock it — the tile shows a dot while it is locked, and Escape
lets go. The double-tap exists because a phone has no shift key and going back
to the rail between every part is a poor way to lay out a row of eight gates.

There is a **Pan** tool next to Select. Dragging empty grid has always panned,
and so do the middle button and space-drag, but a schematic that fills the
screen leaves no empty grid to grab and a phone has neither a middle button nor
a spacebar.

## Blocks
Select part of a circuit and press **Make a block** to wrap it up and reuse it
as a single symbol. The terminals are worked out rather than asked for: a node
that carries a pin of a selected part *and* a pin of an unselected one is, by
definition, how that piece of circuit talks to the rest of it, so those nodes
become the block's pins.

Making a block is non-destructive — it defines the block and leaves your circuit
exactly as it was. Replacing the selection in place would have to decide what
becomes of every wire that crossed the boundary, and getting that wrong quietly
rearranges someone's work.

A block is not a new kind of thing to the solver. An instance is expanded at
netlist time into exactly the devices its definition holds, with its internal
nodes drawn from the same pool a relay's coil junction already uses. So a block
cannot behave differently from the circuit it was made of, because it *is* that
circuit; a block can contain anything the editor can draw, including another
block; and the nodes inside it stay out of the node readout, which is meant to
describe the schematic you drew. Definitions travel inside the saved document
and the share link, so a circuit that uses a block is a circuit anyone can open.

## The commons — member accounts and shared designs

Optional, and **off unless you configure it**. With no credentials in the build
the community code is dead-code-eliminated: no toolbar group, no network calls,
and the Supabase SDK is never fetched. Volta stays a static, offline-capable PWA
— that is a supported mode, not a degraded one, and `e2e/community.spec.ts`
asserts it.

Switched on, members can sign up, publish a circuit to a shared gallery, and
open anyone else's to build on. Forking records the lineage, so credit follows
the work without anyone having to remember to add it.

### Setting it up

1. Create a project at [supabase.com](https://supabase.com). On the New project
   screen, under **Security**:
   - **Enable Data API** — leave **on**. `supabase-js` talks to PostgREST;
     without it nothing here works.
   - **Automatically expose new tables** — leave **off**, as Supabase
     recommends. `schema.sql` grants access to its own tables explicitly, so
     access is something the schema states rather than something a project
     setting hands out to every table anyone adds later.
   - **Enable automatic RLS** — turn **on**. The schema already enables RLS on
     every table it creates, so this changes nothing today; it is there so a
     table added later cannot ship world-writable by accident.

   Pick the region closest to your members — it cannot be changed afterwards.
   The database password is not used by the app (the browser authenticates with
   the anon key), so generate a strong random one and put it in a password
   manager.
2. Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor
   (Dashboard → SQL → New query). It is idempotent.
3. `cp .env.example .env.local` and fill in the URL and anon key from
   Project Settings → API.
4. Restart the dev server.

The anon key belongs in the browser — it is public by design. What it can *do*
is bounded by the schema, not by keeping it secret: a `GRANT` decides whether a
role may touch a table at all, and a row-level security policy decides which
rows. Both gates have to open, which is why `schema.sql` contains explicit
grants as well as policies — perfect policies with no grant just return
"permission denied". Every "only the author may edit this" is a Postgres policy, because the
browser talks to the database directly and anything enforced only in client
code is merely a suggestion.

### Deploying it
`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main`. Three one-time steps:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions**: add `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`. With them unset the workflow still succeeds and
   deploys a working offline editor with the community layer eliminated — a
   missing secret must not be a broken deploy.
3. **Supabase → Authentication → URL Configuration**: add the Pages URL to
   **Redirect URLs**, or password-reset links bounce.

The build uses `base: './'`, so it works from a repository subpath, from a
custom domain, from `file://` and inside the native shells without
reconfiguration. Verified by serving `dist/` from a subdirectory: the app boots,
the service worker registers with the right scope, and pulling the network still
leaves a working editor.

### Email delivery — do this before inviting anyone
Supabase's built-in mailer is for development only: **two messages an hour**,
and on a free project it delivers **only to your own team members' addresses**.
Both sign-up confirmation and password reset go through it, so with the default
setup a member who is not you cannot finish signing up and cannot recover an
account. Configure custom SMTP (Resend, Postmark, SendGrid — all have free
tiers) under Authentication → Emails before the first real member arrives.

### Checking it actually works
`npm run verify:commons` walks the whole path against the live database with two
real members: publish, read as a signed-out visitor, open, fork, and the credit
counter. It spends most of its assertions on what must *not* work — B editing
A's design, deleting it, unpublishing it, publishing under A's name, reading
anyone's reports — because those are the ones that break silently when a policy
is edited. It cleans up after itself.

It needs two accounts. If email confirmation is on (the default), either supply
two confirmed ones through `VOLTA_TEST_A_EMAIL` / `_PASSWORD` and the same for
`B`, or turn confirmation off in the dashboard while it runs.

### What is public

A published design shows a **display name** and a **country**. School is a
separate, opt-in field, off by default.

That default is deliberate. This is a schools tool, so a large share of members
are minors, and a full name next to a school and a town is the combination that
says where to find a child. The `gallery` view applies the rule in the database
— it nulls `school` unless `show_school` is set — so a card cannot render what
its author did not opt into, whatever the client asks for.

There is a `reports` table and a Report button on every card. Reports are
write-only from the client: a reporter can file one and can never read any,
including their own, so the table cannot be used to enumerate what has been
reported. Read them from the Supabase dashboard.

### Moderation
Every card has a Report button. Reports are invisible to everyone except a
moderator, who gets a queue in the commons: the design, its author, the reason,
and three actions — open it in the editor to look at it properly, take it down
(or put it back), or dismiss the report.

Moderator is not self-service. There is no policy that allows an insert into
`moderators`, so the only way in is the SQL editor with the project owner's
credentials:

```sql
insert into public.moderators (id, note)
select id, 'founder' from auth.users where email = 'you@example.com';
```

A moderator can unpublish a design and nothing else. That restraint is the
point: a blanket UPDATE on `designs` would also let them rewrite the title, the
description and the circuit, which is a different and much larger power than the
job needs, so taking something down goes through a function that touches one
boolean column.

### Licensing

Every design carries **CC BY-SA 4.0**, agreed to explicitly at publish time —
anyone may use, change and republish it, with credit, under the same terms.
This is recorded per row and enforced by a `CHECK`, because without a licence
captured at publish time the author keeps copyright by default and "open to all
to use" would not be true however prominently the site said it.

### Not built yet

Subscriptions. Accounts and the commons are free, and there is no Stripe
integration — a commons needs contributors before it needs a paywall. The
schema has no billing tables; adding them later touches nothing here.

## Ship to each platform

**Web (PWA).** `npm run build` produces an installable, offline-capable PWA in
`dist/`. Deploy `dist/` to any static host (GitHub Pages, Netlify, Vercel).

**Desktop (Tauri).** Requires the Rust toolchain (`rustup`). Verified on macOS —
`Volta.app` builds and launches with the simulator running inside it.

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
(`com.anaaya.volta`, targetSdk 35) that runs on a physical Pixel, and the
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
