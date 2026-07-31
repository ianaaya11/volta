// ============================================================================
//  DIGITAL CO-SIMULATION — gates, latches, flip-flops, counters, a 555, and
//  the two converters that bridge back to the analog side.
// ============================================================================
//  None of these are solved as circuits. A CMOS gate modelled transistor by
//  transistor would be a dozen devices and a nonlinear solve per gate, to
//  produce a number the whole point of digital design is to stop thinking
//  about. So each part reads the voltages on its input pins, decides what its
//  outputs should be, and drives them — the same behavioural co-simulation the
//  MCU pins already use, and the same trade-off every simulator makes here.
//
//  What that buys, beyond speed, is that the interface to the solver stays
//  trivial: an input is a high-impedance resistor to ground, an output is a
//  voltage source (or, for an open-drain pin, a resistor that switches between
//  a milliohm and a gigaohm). Only VALUES change from step to step, never the
//  set of devices, so the matrix never has to be rebuilt.
//
//  Everything in this file is pure: no DOM, no canvas, no solver. `step` takes
//  the input voltages and the part's state and returns what to drive and the
//  new state, which is what makes the whole digital library unit-testable
//  without a browser.
// ============================================================================

/** Supply rail these parts drive, and the level at which they read a 1. */
export const LOGIC_HIGH = 5;
export const LOGIC_THRESHOLD = 2.5;
/** An input pin's leak to ground. High enough not to load, low enough that the
 *  node stays defined — a truly floating node makes the matrix singular. */
export const LOGIC_INPUT_Z = 1e8;
/** An open-drain output, conducting and not. */
export const SINK_ON = 1e-3, SINK_OFF = 1e9;

export const isHigh = (v: number): boolean => v > LOGIC_THRESHOLD;
const lvl = (b: boolean): number => (b ? LOGIC_HIGH : 0);

/**
 * What a digital part remembers between steps. `q` is its output state, `prev`
 * the previous logic level of each input (edge detection needs it), and
 * `count` a small integer for the parts that hold one.
 */
export interface DigitalState { q: boolean[]; prev: boolean[]; count: number }

export const initialState = (nOut: number, nIn: number): DigitalState =>
  ({ q: new Array(nOut).fill(false), prev: new Array(nIn).fill(false), count: 0 });

/**
 * One digital part. `step` receives the analog voltage on every input pin —
 * not a pre-thresholded boolean — because some of these parts genuinely need
 * the voltage: a 555 compares against a third of its supply, and a converter
 * has an analog side by definition.
 *
 * It returns one number per output, whose meaning depends on that output's
 * kind: volts for a 'level' pin, ohms for a 'sink' (open-drain) pin.
 */
export interface DigitalSpec {
  name: string;
  in: string[];
  out: string[];
  /** Per-output pin kind; every output is 'level' unless stated. */
  kind?: ('level' | 'sink')[];
  /** True for parts drawn with a proper gate outline rather than a box. */
  gate?: boolean;
  step(v: number[], s: DigitalState): { out: number[]; s: DigitalState };
}

/** A combinational part: no state, outputs are a pure function of the inputs. */
function comb(name: string, inputs: string[], f: (b: boolean[]) => boolean, gate = true): DigitalSpec {
  return {
    name, in: inputs, out: ['Q'], gate,
    step(v, s) {
      const q = f(v.map(isHigh));
      return { out: [lvl(q)], s: { ...s, q: [q] } };
    },
  };
}

/** Rising edge on input `i`, given the previous levels. */
const rose = (v: number[], s: DigitalState, i: number): boolean => isHigh(v[i]) && !s.prev[i];
/** Snapshot the input levels for the next step's edge detection. */
const remember = (v: number[]): boolean[] => v.map(isHigh);

/** Q and its complement, the usual pair for a latch or flip-flop. */
const qPair = (q: boolean): number[] => [lvl(q), lvl(!q)];

export const DIGITAL: Record<string, DigitalSpec> = {
  // ---- Combinational gates -------------------------------------------------
  NOT: comb('NOT gate', ['A'], b => !b[0]),
  AND: comb('AND gate', ['A', 'B'], b => b[0] && b[1]),
  OR: comb('OR gate', ['A', 'B'], b => b[0] || b[1]),
  NAND: comb('NAND gate', ['A', 'B'], b => !(b[0] && b[1])),
  NOR: comb('NOR gate', ['A', 'B'], b => !(b[0] || b[1])),
  XOR: comb('XOR gate', ['A', 'B'], b => b[0] !== b[1]),
  XNOR: comb('XNOR gate', ['A', 'B'], b => b[0] === b[1]),

  // ---- Latches -------------------------------------------------------------
  // Level-sensitive: they follow their inputs for as long as those inputs hold.
  SRL: {
    name: 'SR latch', in: ['S', 'R'], out: ['Q', 'Q̄'],
    step(v, s) {
      let q = s.q[0];
      // S and R both high is the forbidden state. Real cross-coupled gates
      // drive both outputs to the same level there; resolving it as "reset
      // wins" is arbitrary but at least deterministic, which is more useful in
      // a teaching simulator than a race.
      if (isHigh(v[1])) q = false;
      else if (isHigh(v[0])) q = true;
      return { out: qPair(q), s: { ...s, q: [q, !q] } };
    },
  },
  DL: {
    name: 'D latch', in: ['D', 'EN'], out: ['Q', 'Q̄'],
    step(v, s) {
      const q = isHigh(v[1]) ? isHigh(v[0]) : s.q[0];   // transparent while enabled
      return { out: qPair(q), s: { ...s, q: [q, !q] } };
    },
  },

  // ---- Edge-triggered flip-flops -------------------------------------------
  // These sample on the rising edge of the clock and hold until the next one,
  // which is what `prev` exists for.
  DFF: {
    name: 'D flip-flop', in: ['D', 'CLK'], out: ['Q', 'Q̄'],
    step(v, s) {
      const q = rose(v, s, 1) ? isHigh(v[0]) : s.q[0];
      return { out: qPair(q), s: { q: [q, !q], prev: remember(v), count: s.count } };
    },
  },
  JKFF: {
    name: 'JK flip-flop', in: ['J', 'CLK', 'K'], out: ['Q', 'Q̄'],
    step(v, s) {
      let q = s.q[0];
      if (rose(v, s, 1)) {
        const j = isHigh(v[0]), k = isHigh(v[2]);
        // J·K̄ sets, J̄·K clears, J·K toggles — the property that makes a JK
        // able to do everything the other flip-flops can.
        if (j && k) q = !q; else if (j) q = true; else if (k) q = false;
      }
      return { out: qPair(q), s: { q: [q, !q], prev: remember(v), count: s.count } };
    },
  },
  TFF: {
    name: 'T flip-flop', in: ['T', 'CLK'], out: ['Q', 'Q̄'],
    step(v, s) {
      const q = (rose(v, s, 1) && isHigh(v[0])) ? !s.q[0] : s.q[0];
      return { out: qPair(q), s: { q: [q, !q], prev: remember(v), count: s.count } };
    },
  },

  // ---- Counter -------------------------------------------------------------
  CNT4: {
    name: '4-bit counter', in: ['CLK', 'RST'], out: ['Q0', 'Q1', 'Q2', 'Q3'],
    step(v, s) {
      let n = s.count;
      if (isHigh(v[1])) n = 0;                       // asynchronous reset
      else if (rose(v, s, 0)) n = (n + 1) & 15;      // wraps at 16, as 4 bits do
      const bits = [0, 1, 2, 3].map(i => ((n >> i) & 1) === 1);
      return { out: bits.map(lvl), s: { q: bits, prev: remember(v), count: n } };
    },
  },

  // ---- 7-segment display ---------------------------------------------------
  // Driven by a nibble rather than seven separate segment lines: the point of
  // the part is to read a number off the schematic, and wiring seven lines by
  // hand to prove you can decode BCD is a different exercise. It drives
  // nothing, so it has no output pins — the renderer reads `count`.
  SEG7: {
    name: '7-segment display', in: ['D0', 'D1', 'D2', 'D3'], out: [],
    step(v, s) {
      const n = v.reduce((acc, x, i) => acc | (isHigh(x) ? 1 << i : 0), 0);
      return { out: [], s: { ...s, count: n } };
    },
  },

  // ---- 555 timer -----------------------------------------------------------
  // The real chip is a resistive divider setting two comparator references at
  // ⅓ and ⅔ of the supply, an SR latch between them, a totem-pole output and a
  // discharge transistor. All five of those are here; what isn't is the
  // divider itself, so CTRL is read directly as the upper threshold when it is
  // driven and derived from VCC when it is left open.
  NE555: {
    name: '555 timer', in: ['VCC', 'TRIG', 'THR', 'RST', 'CTRL'], out: ['OUT', 'DIS'],
    kind: ['level', 'sink'],
    step(v, s) {
      const vcc = v[0];
      // CTRL floating sits at ⅔ VCC through the internal divider; the leak
      // resistor pulls an undriven pin to ~0, so treat anything below a tenth
      // of the supply as "not connected" rather than as a real 0 V control.
      const upper = v[4] > vcc * 0.1 ? v[4] : (2 / 3) * vcc;
      const lower = upper / 2;
      let q = s.q[0];                                 // q true = output high
      if (v[3] > 0 && !isHigh(v[3]) && vcc > 0) q = false;   // RESET, active low
      else if (v[1] < lower) q = true;                // TRIG below ⅓: set
      else if (v[2] > upper) q = false;               // THRESH above ⅔: reset
      // The output swings to its OWN supply, not to the 5 V the logic parts
      // use: a 555 is routinely run at 9 or 12 V, and driving 5 V out of a 9 V
      // part would quietly under-drive whatever it feeds.
      // The discharge pin conducts whenever the output is low — that is what
      // makes an astable oscillate, by dumping the timing capacitor.
      return { out: [q ? vcc : 0, q ? SINK_OFF : SINK_ON], s: { ...s, q: [q, !q] } };
    },
  },

  // ---- Converters ----------------------------------------------------------
  DAC4: {
    name: '4-bit DAC', in: ['VREF', 'D0', 'D1', 'D2', 'D3'], out: ['OUT'],
    step(v, s) {
      const n = [1, 2, 3, 4].reduce((acc, p, i) => acc | (isHigh(v[p]) ? 1 << i : 0), 0);
      // Full scale is VREF at code 15, so each step is VREF/15 — the endpoint
      // convention, which makes a DAC and an ADC round-trip cleanly.
      return { out: [(v[0] * n) / 15], s: { ...s, count: n } };
    },
  },
  ADC4: {
    name: '4-bit ADC', in: ['VREF', 'VIN'], out: ['D0', 'D1', 'D2', 'D3'],
    step(v, s) {
      const ref = v[0] || LOGIC_HIGH;
      const n = Math.max(0, Math.min(15, Math.round((v[1] / ref) * 15)));
      const bits = [0, 1, 2, 3].map(i => ((n >> i) & 1) === 1);
      return { out: bits.map(lvl), s: { q: bits, prev: s.prev, count: n } };
    },
  },
};

export type DigitalType = keyof typeof DIGITAL;
export const isDigital = (t: string): boolean => Object.prototype.hasOwnProperty.call(DIGITAL, t);
