// Coupled inductors — 7 checks.
//
// The transformer is the only device here whose stamp ties two branch-current
// unknowns to EACH OTHER; every other element couples branches only through
// node voltages. So these tests are really about that off-diagonal M/h term:
// that it transfers energy at all, that the turns ratio comes out as √(L2/L1),
// that the dot convention sets the polarity, and that k actually controls how
// much couples.
import { describe, it, expect } from 'vitest';
import { Circuit, type Component } from '../src/engine';

/** |v(node)| from an AC sweep at a single frequency, per unit of stimulus. */
function gainAt(parts: Component[], node: number, f: number, stimulus: string): number {
  const ph = new Circuit(parts).ac(f, f, 1, stimulus).phasors[0][node];
  return Math.hypot(ph.re, ph.im);
}

/** Primary driven by a source, secondary loaded — the usual arrangement. */
function xfmr(l1: number, l2: number, k: number, load = 1000): Component[] {
  return [
    { id: 'V1', type: 'V', nodes: [1, 0], value: 1 },
    { id: 'T1', type: 'XF', nodes: [1, 0, 2, 0], value: l1, l2, k },
    { id: 'RL', type: 'R', nodes: [2, 0], value: load },
  ];
}

// Solving the two winding equations against a load R, with the primary driven
// by an ideal source, gives the exact ratio this model should produce:
//
//     |v2/v1| = n·k / |1 + jω·L2·(1−k²)/R|,   n = √(L2/L1)
//
// The magnetizing inductance drops out (an ideal source fixes v1 however much
// current it has to supply), so the only two departures from the ideal turns
// ratio are k itself and the leakage reactance working against the load. The
// frequency and coupling below make that second term ~0.5 %, which is what
// lets these assert the textbook ratio directly.
const F = 1e3, K = 0.9999;

describe('turns ratio', () => {
  it('a 1:1 transformer passes the primary voltage through', () => {
    expect(gainAt(xfmr(1, 1, K), 2, F, 'V1')).toBeCloseTo(1, 2);
  });

  it('L2 = 4·L1 steps the voltage up by 2', () => {
    expect(gainAt(xfmr(1, 4, K), 2, F, 'V1')).toBeCloseTo(2, 2);
  });

  it('L2 = L1/4 steps the voltage down by 2', () => {
    expect(gainAt(xfmr(1, 0.25, K), 2, F, 'V1')).toBeCloseTo(0.5, 2);
  });

  it('loose coupling delivers far less than the turns ratio predicts', () => {
    // k enters twice — once directly, once through the leakage reactance —
    // so halving it costs much more than half the output.
    const tight = gainAt(xfmr(1, 1, K), 2, F, 'V1');
    const loose = gainAt(xfmr(1, 1, 0.5), 2, F, 'V1');
    expect(loose).toBeLessThan(tight * 0.9);
    expect(loose).toBeGreaterThan(0);
  });
});

describe('the coupling itself', () => {
  it('with k = 0 the windings are two unrelated inductors', () => {
    // No mutual term, so nothing reaches the secondary at all.
    expect(gainAt(xfmr(1, 1, 0), 2, F, 'V1')).toBeLessThan(1e-9);
  });

  it('the dot convention sets the polarity of the secondary', () => {
    // Swapping the secondary leads inverts it: same magnitude, opposite phase.
    const dotted = new Circuit(xfmr(1, 1, K)).ac(F, F, 1, 'V1').phasors[0][2];
    const flipped = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 1 },
      { id: 'T1', type: 'XF', nodes: [1, 0, 0, 2], value: 1, l2: 1, k: K },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]).ac(F, F, 1, 'V1').phasors[0][2];
    expect(Math.hypot(flipped.re, flipped.im)).toBeCloseTo(Math.hypot(dotted.re, dotted.im), 6);
    expect(flipped.re).toBeCloseTo(-dotted.re, 6);
    expect(flipped.im).toBeCloseTo(-dotted.im, 6);
  });
});

describe('transient behaviour', () => {
  it('a step on the primary drives the secondary, then decays away', () => {
    // A transformer passes changes, not levels: the secondary sees the leading
    // edge and then falls back as the magnetizing current takes over. This is
    // the property that distinguishes it from a pair of plain inductors.
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'Rp', type: 'R', nodes: [1, 3], value: 10 },
      { id: 'T1', type: 'XF', nodes: [3, 0, 2, 0], value: 10e-3, l2: 10e-3, k: K },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]);
    const h = 1e-6;
    const first = c.step(h).nodeVoltage[2];
    expect(Math.abs(first)).toBeGreaterThan(1);        // the edge gets through
    for (let i = 0; i < 20000; i++) c.step(h);         // 20 ms — many time constants
    expect(Math.abs(c.step(h).nodeVoltage[2])).toBeLessThan(Math.abs(first) / 10);
  });
});
