// The digital library — 29 checks.
//
// These parts never reach the solver as logic; they read voltages and drive
// voltages. So the thing worth pinning down is the behaviour itself: complete
// truth tables for the gates, and for everything sequential the property that
// distinguishes it from its neighbours — a latch is transparent while enabled,
// a flip-flop is not; a JK toggles where an SR is forbidden; a counter wraps.
import { describe, it, expect } from 'vitest';
import { DIGITAL, initialState, LOGIC_HIGH, SINK_ON, SINK_OFF, type DigitalState } from '../src/digital';

const H = LOGIC_HIGH, L = 0;
const hi = (x: number) => x > 2.5;

/** Run a part through a sequence of input vectors, collecting its outputs. */
function run(type: string, vectors: number[][]): number[][] {
  const spec = DIGITAL[type];
  let s: DigitalState = initialState(spec.out.length, spec.in.length);
  return vectors.map(v => { const r = spec.step(v, s); s = r.s; return r.out; });
}
/** The output of a combinational part for one input vector. */
const out1 = (type: string, v: number[]) => run(type, [v])[0][0];

describe('combinational gates', () => {
  const pairs: [number, number][] = [[L, L], [L, H], [H, L], [H, H]];
  const table: Record<string, boolean[]> = {
    AND: [false, false, false, true],
    OR: [false, true, true, true],
    NAND: [true, true, true, false],
    NOR: [true, false, false, false],
    XOR: [false, true, true, false],
    XNOR: [true, false, false, true],
  };
  for (const [type, expected] of Object.entries(table)) {
    it(`${type} matches its truth table`, () => {
      expect(pairs.map(v => hi(out1(type, v)))).toEqual(expected);
    });
  }
  it('NOT inverts', () => {
    expect(hi(out1('NOT', [L]))).toBe(true);
    expect(hi(out1('NOT', [H]))).toBe(false);
  });
  it('a gate drives the full rail, not just "some voltage"', () => {
    expect(out1('AND', [H, H])).toBe(LOGIC_HIGH);
    expect(out1('AND', [H, L])).toBe(0);
  });
  it('an input part-way up reads as a 0 below the threshold', () => {
    expect(hi(out1('NOT', [2.4]))).toBe(true);   // still a 0 in
    expect(hi(out1('NOT', [2.6]))).toBe(false);  // now a 1
  });
});

describe('SR latch', () => {
  it('sets, holds, and resets', () => {
    const o = run('SRL', [[L, L], [H, L], [L, L], [L, H], [L, L]]);
    expect(o.map(r => hi(r[0]))).toEqual([false, true, true, false, false]);
  });
  it('drives Q̄ as the complement of Q', () => {
    const o = run('SRL', [[H, L], [L, H]]);
    expect(o.map(r => [hi(r[0]), hi(r[1])])).toEqual([[true, false], [false, true]]);
  });
});

describe('D latch vs D flip-flop', () => {
  it('the latch is transparent while enabled', () => {
    // D changes twice with EN held high; the latch follows both times.
    const o = run('DL', [[H, H], [L, H], [H, H]]);
    expect(o.map(r => hi(r[0]))).toEqual([true, false, true]);
  });
  it('the latch holds when the enable goes away', () => {
    const o = run('DL', [[H, H], [L, L], [H, L]]);
    expect(o.map(r => hi(r[0]))).toEqual([true, true, true]);
  });
  it('the flip-flop samples only on the clock edge', () => {
    // D is high at the edge, then changes while the clock is still high. The
    // flip-flop must ignore that — this is the whole difference from a latch.
    const o = run('DFF', [[H, L], [H, H], [L, H], [L, L]]);
    expect(o.map(r => hi(r[0]))).toEqual([false, true, true, true]);
  });
  it('the flip-flop takes the new D on the next edge', () => {
    const o = run('DFF', [[H, L], [H, H], [L, H], [L, L], [L, H]]);
    expect(hi(o[4][0])).toBe(false);
  });
});

describe('JK and T flip-flops', () => {
  it('JK sets, clears and toggles on successive edges', () => {
    //            J  CLK  K
    const o = run('JKFF', [
      [H, L, L], [H, H, L],   // J=1 -> set
      [L, L, H], [L, H, H],   // K=1 -> clear
      [H, L, H], [H, H, H],   // J=K=1 -> toggle (from 0, so set)
      [H, L, H], [H, H, H],   // toggle again
    ]);
    expect([1, 3, 5, 7].map(i => hi(o[i][0]))).toEqual([true, false, true, false]);
  });
  it('T toggles only when T is high at the edge', () => {
    const o = run('TFF', [
      [H, L], [H, H],   // toggle -> 1
      [L, L], [L, H],   // T low: hold
      [H, L], [H, H],   // toggle -> 0
    ]);
    expect([1, 3, 5].map(i => hi(o[i][0]))).toEqual([true, true, false]);
  });
});

describe('4-bit counter', () => {
  /** Clock the counter n times and read back the value on its four outputs. */
  function countTo(n: number): number {
    const vec: number[][] = [];
    for (let i = 0; i < n; i++) vec.push([L, L], [H, L]);
    const o = run('CNT4', vec);
    return o[o.length - 1].reduce((acc, x, i) => acc | (hi(x) ? 1 << i : 0), 0);
  }
  it('counts up on rising edges', () => {
    expect(countTo(1)).toBe(1);
    expect(countTo(5)).toBe(5);
    expect(countTo(15)).toBe(15);
  });
  it('wraps at 16 rather than saturating', () => {
    expect(countTo(16)).toBe(0);
    expect(countTo(19)).toBe(3);
  });
  it('reset is asynchronous — it clears without a clock edge', () => {
    const o = run('CNT4', [[L, L], [H, L], [L, L], [H, L], [H, H]]);
    expect(o[4].every(x => !hi(x))).toBe(true);
  });
});

describe('7-segment display', () => {
  it('reads its four inputs as a nibble', () => {
    const spec = DIGITAL.SEG7;
    let s = initialState(0, 4);
    s = spec.step([H, L, H, L], s).s;
    expect(s.count).toBe(5);
    s = spec.step([H, H, H, H], s).s;
    expect(s.count).toBe(15);
  });
});

describe('555 timer', () => {
  const VCC = 9;
  it('triggering below a third of the supply drives the output high', () => {
    //             VCC  TRIG  THR  RST  CTRL
    const o = run('NE555', [[VCC, 2.0, 0, VCC, 0]]);
    // The output swings to the part's own supply, not to the 5 V logic rail.
    expect(o[0][0]).toBe(VCC);
    expect(o[0][1]).toBe(SINK_OFF);      // discharge released
  });
  it('the threshold crossing two thirds of the supply resets it', () => {
    const o = run('NE555', [
      [VCC, 2.0, 0, VCC, 0],     // trigger: out high
      [VCC, VCC, 0, VCC, 0],     // trigger released, still high (it latches)
      [VCC, VCC, 7.0, VCC, 0],   // threshold above 6 V: out low
    ]);
    expect(o.map(r => r[0])).toEqual([VCC, VCC, 0]);
    // Discharge conducts exactly when the output is low — the mechanism that
    // makes an astable oscillate.
    expect(o.map(r => r[1])).toEqual([SINK_OFF, SINK_OFF, SINK_ON]);
  });
  it('the thresholds scale with the supply', () => {
    // 2.0 V triggers a 9 V part (⅓ = 3 V) but not a 5 V one (⅓ = 1.67 V).
    expect(run('NE555', [[9, 2.0, 0, 9, 0]])[0][0]).toBe(9);
    expect(run('NE555', [[5, 2.0, 0, 5, 0]])[0][0]).toBe(0);
  });
  it('holding RESET low forces the output low whatever TRIG does', () => {
    const o = run('NE555', [[VCC, 2.0, 0, VCC, 0], [VCC, 2.0, 0, 0.5, 0]]);
    expect(o.map(r => r[0])).toEqual([VCC, 0]);
  });
  it('a driven CTRL pin moves both thresholds', () => {
    // CTRL at 4 V puts the upper threshold at 4 and the lower at 2, so 2.5 V
    // on TRIG no longer fires where it would with CTRL left open (lower = 3).
    expect(run('NE555', [[VCC, 2.5, 0, VCC, 0]])[0][0]).toBe(VCC);
    expect(run('NE555', [[VCC, 2.5, 0, VCC, 4]])[0][0]).toBe(0);
  });
});

describe('converters', () => {
  it('the DAC spans 0 to VREF across its 16 codes', () => {
    const at = (bits: number[]) => run('DAC4', [[5, ...bits]])[0][0];
    expect(at([L, L, L, L])).toBeCloseTo(0, 9);
    expect(at([H, H, H, H])).toBeCloseTo(5, 9);
    expect(at([L, L, L, H])).toBeCloseTo(5 * 8 / 15, 9);   // code 8
  });
  it('the ADC and the DAC round-trip', () => {
    for (const code of [0, 1, 7, 8, 15]) {
      const volts = (5 * code) / 15;
      const bits = run('ADC4', [[5, volts]])[0];
      expect(bits.reduce((a, x, i) => a | (hi(x) ? 1 << i : 0), 0)).toBe(code);
    }
  });
  it('the ADC clamps rather than wrapping past full scale', () => {
    const over = run('ADC4', [[5, 9]])[0];
    expect(over.every(x => hi(x))).toBe(true);           // pinned at 15
    const under = run('ADC4', [[5, -3]])[0];
    expect(under.every(x => !hi(x))).toBe(true);         // pinned at 0
  });
});
