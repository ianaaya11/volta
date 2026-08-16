// ============================================================================
//  NETLIST EXPORT — take a proven circuit to KiCad
// ============================================================================
//  Volta simulates. It does not lay out boards, and it should not pretend to.
//  What it does have is the thing a PCB tool actually needs to start: which pin
//  is connected to which. That falls out of buildNetlist's union-find for free.
//
//  The gap between the two is footprints, and it is not a gap a simulator can
//  close. Volta's resistor is A RESISTANCE — it has no package, no tolerance,
//  no power rating. Choosing 0603 over through-hole is an engineering decision
//  made with information this app has never been told. So the defaults here are
//  through-hole, because that is what gets hand-soldered on a bench, and the
//  report says out loud that they are defaults.
//
//  Three tiers of part, and being honest about which is which is most of the
//  value of this file:
//
//    real        R, C, LED, a 555 — a real thing with a package. Exports whole.
//    bench       a supply, a voltmeter. Not board components at all. A supply
//                becomes a 2-pin header; an instrument is dropped.
//    behavioural an AND gate, a counter, an ideal op-amp. NOT chips. A CNT4 is
//                a 74HC161 or a 4017 and the designer picks which. Worse, they
//                carry no VCC or GND pin in Volta, so the board is missing
//                power distribution and every decoupling cap. These export as
//                named placeholders with no footprint, and the report says so
//                in as many words.
//
//  Everything here is pure — parts and nodes in, text out. No DOM, no canvas,
//  no globals. That is deliberate: this is exactly the kind of code that should
//  be checked by reading its output, not by looking at a screen.
// ============================================================================

/** One placed part, with its pins already resolved to node numbers.
 *  Node 0 is ground, as it is everywhere else in the app. Pin order is the
 *  order pinsOf() returns, which is the order the renderer draws them. */
export interface ExportPart {
  id: string;
  type: string;
  value?: number;
  /** Wave sources only, so a signal input header says what belongs on it. */
  amp?: number;
  freq?: number;
  color?: string;
  nodes: number[];
}

export type Tier = 'real' | 'bench' | 'behavioural' | 'dropped';

interface Spec {
  tier: Tier;
  /** Reference designator prefix, per the usual convention. */
  ref: string;
  /** KiCad footprint. Empty means "you choose" — which is the honest answer
   *  for anything whose package Volta was never told. */
  fp: string;
  /** Pin names, in pinsOf() order. Falls back to 1..n when absent. */
  pins?: string[];
  /** Shown in the report when the part needs a decision. */
  note?: string;
}

// Footprints are KiCad's standard through-hole libraries. They are a starting
// point and the report says so: reassign anything that matters in KiCad's
// footprint assignment tool rather than trusting a simulator's guess.
const THT = {
  res: 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal',
  cap: 'Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm',
  pol: 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm',
  ind: 'Inductor_THT:L_Radial_D8.0mm_P5.00mm',
  diode: 'Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal',
  led: 'LED_THT:LED_D5.0mm',
  to92: 'Package_TO_SOT_THT:TO-92_Inline',
  dip8: 'Package_DIP:DIP-8_W7.62mm',
  button: 'Button_Switch_THT:SW_PUSH_6mm',
  header2: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
};

const SPECS: Record<string, Spec> = {
  // ---- Tier 1: real parts ---------------------------------------------------
  R:    { tier: 'real', ref: 'R', fp: THT.res },
  C:    { tier: 'real', ref: 'C', fp: THT.cap },
  CP:   { tier: 'real', ref: 'C', fp: THT.pol, pins: ['+', '-'] },
  L:    { tier: 'real', ref: 'L', fp: THT.ind },
  D:    { tier: 'real', ref: 'D', fp: THT.diode, pins: ['A', 'K'] },
  LED:  { tier: 'real', ref: 'D', fp: THT.led, pins: ['A', 'K'] },
  QN:   { tier: 'real', ref: 'Q', fp: THT.to92, pins: ['C', 'B', 'E'],
          note: 'Generic NPN — pick a real transistor and check the TO-92 pinout.' },
  QP:   { tier: 'real', ref: 'Q', fp: THT.to92, pins: ['C', 'B', 'E'],
          note: 'Generic PNP — pick a real transistor and check the TO-92 pinout.' },
  MN:   { tier: 'real', ref: 'Q', fp: '', pins: ['D', 'G', 'S'],
          note: 'Generic N-channel MOSFET — package depends entirely on the part.' },
  MP:   { tier: 'real', ref: 'Q', fp: '', pins: ['D', 'G', 'S'],
          note: 'Generic P-channel MOSFET — package depends entirely on the part.' },
  POT:  { tier: 'real', ref: 'RV', fp: '', pins: ['1', 'W', '3'],
          note: 'Potentiometer — pick a body style (trimmer, panel) for the footprint.' },
  SW:   { tier: 'real', ref: 'SW', fp: THT.button, note: 'Latching switch — the default footprint is a momentary button.' },
  PB:   { tier: 'real', ref: 'SW', fp: THT.button },
  PBNC: { tier: 'real', ref: 'SW', fp: THT.button, note: 'Normally-closed button — check the part you buy actually is.' },
  RLY:  { tier: 'real', ref: 'K', fp: '', pins: ['A', 'B', 'C1', 'C2'],
          note: 'Relay — footprint depends on the can. Add a flyback diode across the coil.' },
  XF:   { tier: 'real', ref: 'T', fp: '', pins: ['P+', 'P-', 'S+', 'S-'],
          note: 'Transformer — no standard footprint; depends entirely on the part.' },
  MOT:  { tier: 'real', ref: 'M', fp: THT.header2, pins: ['+', '-'],
          note: 'Motor exports as a 2-pin header — it wires to the board, it does not sit on it.' },
  LAMP: { tier: 'real', ref: 'LA', fp: THT.header2, pins: ['1', '2'],
          note: 'Lamp exports as a 2-pin header.' },
  NE555:{ tier: 'real', ref: 'U', fp: THT.dip8,
          pins: ['VCC', 'TRIG', 'THR', 'RST', 'CTRL', 'OUT', 'DIS'],
          note: 'A real chip, but Volta models 7 pins — the DIP-8 also needs GND, and a 100n across the supply.' },

  // ---- Tier 2: bench equipment, not board components ------------------------
  V:  { tier: 'bench', ref: 'J', fp: THT.header2, pins: ['+', '-'],
        note: 'DC supply exports as a 2-pin power header.' },
  VS: { tier: 'bench', ref: 'J', fp: THT.header2, pins: ['+', '-'],
        note: 'Signal generator exports as a 2-pin input header.' },
  SQ: { tier: 'bench', ref: 'J', fp: THT.header2, pins: ['+', '-'],
        note: 'Signal generator exports as a 2-pin input header.' },
  I:  { tier: 'bench', ref: 'J', fp: THT.header2, pins: ['+', '-'],
        note: 'Current source exports as a 2-pin header.' },
  VM: { tier: 'dropped', ref: '', fp: '', note: 'Voltmeter — a test instrument, not a board component.' },
  AM: { tier: 'dropped', ref: '', fp: '', note: 'Ammeter — a test instrument, not a board component.' },
  OM: { tier: 'dropped', ref: '', fp: '', note: 'Ohmmeter — a test instrument, not a board component.' },
  WM: { tier: 'dropped', ref: '', fp: '', note: 'Wattmeter — a test instrument, not a board component.' },
  GND:{ tier: 'dropped', ref: '', fp: '', note: '' },        // a net name, not a part

  // ---- Tier 3: behavioural, needs a chip choosing ---------------------------
  OA:   { tier: 'behavioural', ref: 'U', fp: '', pins: ['OUT', 'IN+', 'IN-'],
          note: 'Ideal op-amp: no supply pins. Pick a real part and add its rails and decoupling.' },
  MCU:  { tier: 'behavioural', ref: 'U', fp: '', pins: ['PIN'],
          note: 'A single pad standing in for a microcontroller pin, not a microcontroller.' },
  LOGIC:{ tier: 'behavioural', ref: 'J', fp: '', pins: ['OUT'],
          note: 'Logic source — a clock or a switch on the bench, not a part.' },
};

// The behavioural digital family: gates, latches, flip-flops, counters and the
// converters. Every one of them is a function, not a chip.
const BEHAVIOURAL: Record<string, { pins: string[]; hint: string }> = {
  NOT:  { pins: ['A', 'Q'], hint: '74HC04' },
  AND:  { pins: ['A', 'B', 'Q'], hint: '74HC08' },
  OR:   { pins: ['A', 'B', 'Q'], hint: '74HC32' },
  NAND: { pins: ['A', 'B', 'Q'], hint: '74HC00' },
  NOR:  { pins: ['A', 'B', 'Q'], hint: '74HC02' },
  XOR:  { pins: ['A', 'B', 'Q'], hint: '74HC86' },
  XNOR: { pins: ['A', 'B', 'Q'], hint: '74HC266' },
  SRL:  { pins: ['S', 'R', 'Q', 'nQ'], hint: 'cross-coupled 74HC00' },
  DL:   { pins: ['D', 'EN', 'Q', 'nQ'], hint: '74HC75' },
  DFF:  { pins: ['D', 'CLK', 'Q', 'nQ'], hint: '74HC74' },
  JKFF: { pins: ['J', 'CLK', 'K', 'Q', 'nQ'], hint: '74HC73' },
  TFF:  { pins: ['T', 'CLK', 'Q', 'nQ'], hint: '74HC74 wired to toggle' },
  CNT4: { pins: ['CLK', 'RST', 'Q0', 'Q1', 'Q2', 'Q3'], hint: '74HC161 or CD4017' },
  SEG7: { pins: ['D0', 'D1', 'D2', 'D3'], hint: '74HC4511 plus a display' },
  DAC4: { pins: ['VREF', 'D0', 'D1', 'D2', 'D3', 'OUT'], hint: 'an R-2R ladder, or a real DAC' },
  ADC4: { pins: ['VREF', 'VIN', 'D0', 'D1', 'D2', 'D3'], hint: 'a real ADC' },
};

export function specOf(type: string): Spec {
  if (SPECS[type]) return SPECS[type];
  const b = BEHAVIOURAL[type];
  if (b) {
    return {
      tier: 'behavioural', ref: 'U', fp: '', pins: b.pins,
      note: `Behavioural ${type} — no chip and no supply pins. Try ${b.hint}, and add decoupling.`,
    };
  }
  // A part the exporter has never heard of. Emitting it with no footprint and
  // saying so beats silently dropping something the user drew.
  return { tier: 'behavioural', ref: 'U', fp: '', note: `Unrecognised part "${type}" — exported with no footprint.` };
}

export interface ReportLine { ref: string; id: string; type: string; tier: Tier; note: string }
export interface Report {
  lines: ReportLine[];
  /** Blocking-ish facts the user needs before sending a board for manufacture. */
  warnings: string[];
  counts: Record<Tier, number>;
}

/** Human-facing value string. The unit belongs in the schematic, not here —
 *  KiCad shows the value verbatim and "4.7k" is what a BOM wants. */
function valueText(p: ExportPart, fmt: (v: number, unit: string) => string): string {
  const s = specOf(p.type);
  if (p.type === 'LED') return (p.color ?? 'red').toUpperCase();
  // A bench source becomes a header, and what the header wants written next to
  // it is what you are meant to connect — not the word "V".
  if (p.type === 'V') return fmt(p.value ?? 0, 'V');
  if (p.type === 'I') return fmt(p.value ?? 0, 'A');
  if (p.type === 'VS' || p.type === 'SQ') {
    return `${fmt(p.amp ?? 0, 'V')} ${fmt(p.freq ?? 0, 'Hz')} ${p.type === 'SQ' ? 'square' : 'sine'}`;
  }
  if (p.value === undefined || s.tier !== 'real' || p.value === 0) return p.type;
  return fmt(p.value, '').trim();
}

/** Standard reference designators, numbered per prefix in placement order. */
function assignRefs(parts: ExportPart[]): Map<string, string> {
  const n = new Map<string, number>();
  const out = new Map<string, string>();
  for (const p of parts) {
    const { ref } = specOf(p.type);
    if (!ref) continue;
    const k = (n.get(ref) ?? 0) + 1;
    n.set(ref, k);
    out.set(p.id, ref + k);
  }
  return out;
}

/** Net names. Node 0 is ground everywhere in this app, and GND is the one net
 *  name every PCB tool understands without being told. */
const netName = (node: number) => node === 0 ? 'GND' : `N$${node}`;

export interface ExportResult { text: string; report: Report }

/**
 * Emit a KiCad netlist (the s-expression `.net` that Pcbnew imports).
 *
 * `date` is a parameter rather than read from the clock so the golden tests
 * compare byte for byte.
 */
export function toKicad(
  parts: ExportPart[],
  fmt: (v: number, unit: string) => string,
  date = '',
): ExportResult {
  const refs = assignRefs(parts);
  const kept = parts.filter(p => specOf(p.type).tier !== 'dropped');

  const lines: ReportLine[] = [];
  const counts: Record<Tier, number> = { real: 0, bench: 0, behavioural: 0, dropped: 0 };
  for (const p of parts) {
    const s = specOf(p.type);
    counts[s.tier]++;
    if (s.note || s.tier !== 'real') {
      lines.push({ ref: refs.get(p.id) ?? '—', id: p.id, type: p.type, tier: s.tier, note: s.note ?? '' });
    }
  }

  const warnings: string[] = [];
  if (counts.behavioural) {
    warnings.push(`${counts.behavioural} part${counts.behavioural > 1 ? 's are' : ' is'} behavioural: `
      + 'no chip chosen, and no VCC or GND pin. This netlist is missing that part of the board '
      + 'entirely — power distribution and decoupling caps included.');
  }
  if (counts.bench) {
    warnings.push(`${counts.bench} bench source${counts.bench > 1 ? 's' : ''} exported as 2-pin headers. `
      + 'A supply is not a component.');
  }
  if (counts.dropped) {
    warnings.push(`${counts.dropped} instrument${counts.dropped > 1 ? 's' : ''} or ground symbol${
      counts.dropped > 1 ? 's' : ''} dropped: meters measure, they are not fitted.`);
  }
  warnings.push('Footprints are through-hole defaults. Check every one in KiCad before ordering a board.');

  // ---- The netlist itself ---------------------------------------------------
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const out: string[] = [];
  out.push('(export (version "E")');
  out.push('  (design');
  out.push('    (source "Volta")');
  out.push(`    (date "${esc(date)}")`);
  out.push('    (tool "Volta live circuit simulator"))');

  out.push('  (components');
  for (const p of kept) {
    const s = specOf(p.type);
    const ref = refs.get(p.id)!;
    out.push(`    (comp (ref "${ref}")`);
    out.push(`      (value "${esc(valueText(p, fmt))}")`);
    if (s.fp) out.push(`      (footprint "${esc(s.fp)}")`);
    out.push(`      (fields (field (name "Volta_Type") "${esc(p.type)}")`);
    out.push(`              (field (name "Volta_Id") "${esc(p.id)}")))`);
  }
  out.push('  )');

  // Group pins by node. A node touched by fewer than two pins is a stub — it
  // is still emitted, because silently dropping it would hide a wiring mistake
  // rather than surface one.
  const byNode = new Map<number, { ref: string; pin: string }[]>();
  for (const p of kept) {
    const s = specOf(p.type);
    const ref = refs.get(p.id)!;
    p.nodes.forEach((node, i) => {
      const pin = s.pins?.[i] ?? String(i + 1);
      if (!byNode.has(node)) byNode.set(node, []);
      byNode.get(node)!.push({ ref, pin });
    });
  }

  // A net with one pin on it is a pin wired to nothing. That is almost always a
  // mistake on the schematic, and it is far cheaper to hear about it here than
  // to find it on a board. Reported, not silently fixed — the export still
  // contains it, because dropping it would hide the very thing worth seeing.
  // Ground is exempt: it is a global net that meets a plane, so one pin on it
  // is a normal circuit, not a mistake.
  const dangling = [...byNode.entries()].filter(([node, pins]) => node !== 0 && pins.length < 2);
  if (dangling.length) {
    warnings.push(`${dangling.length} net${dangling.length > 1 ? 's have' : ' has'} only one pin `
      + `(${dangling.map(([, p]) => `${p[0].ref}.${p[0].pin}`).join(', ')}) — `
      + 'connected to nothing. Check the schematic before laying this out.');
  }

  out.push('  (nets');
  let code = 1;
  for (const node of [...byNode.keys()].sort((a, b) => a - b)) {
    out.push(`    (net (code "${code++}") (name "${netName(node)}")`);
    for (const { ref, pin } of byNode.get(node)!) {
      out.push(`      (node (ref "${ref}") (pin "${pin}"))`);
    }
    out.push('    )');
  }
  out.push('  )');
  out.push(')');

  return { text: out.join('\n') + '\n', report: { lines, warnings, counts } };
}
