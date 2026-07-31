// MNA solver + passive elements — 6 checks.
// Everything else in the engine rides on these: if the matrix build, the
// pivoting, or the backward-Euler companion models are wrong, every device
// model above them is wrong too.
import { describe, it, expect } from 'vitest';
import { Circuit } from '../src/engine';

describe('DC operating point', () => {
  it('voltage divider splits by resistance ratio', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 10 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'R2', type: 'R', nodes: [2, 0], value: 2000 },
    ]);
    const r = c.dc();
    expect(r.nodeVoltage[2]).toBeCloseTo(6.6667, 3);
    // and the loop current is consistent with Ohm's law across the pair
    expect(Math.abs(r.current['R1'])).toBeCloseTo(10 / 3000, 9);
  });

  it('resolves a series/parallel network (two 2k in parallel = 1k)', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 12 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'R2', type: 'R', nodes: [2, 0], value: 2000 },
      { id: 'R3', type: 'R', nodes: [2, 0], value: 2000 },
    ]);
    expect(c.dc().nodeVoltage[2]).toBeCloseTo(6, 6);
  });

  it('an independent current source develops I·R across a resistor', () => {
    const c = new Circuit([
      { id: 'I1', type: 'I', nodes: [0, 1], value: 1e-3 },
      { id: 'R1', type: 'R', nodes: [1, 0], value: 1000 },
    ]);
    expect(Math.abs(c.dc().nodeVoltage[1])).toBeCloseTo(1, 9);
  });

  it('at DC a capacitor is an open circuit and an inductor is a short', () => {
    const cap = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'C1', type: 'C', nodes: [2, 0], value: 1e-6 },
    ]);
    expect(cap.dc().nodeVoltage[2]).toBeCloseTo(5, 6); // no drop across R

    const ind = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'L1', type: 'L', nodes: [2, 0], value: 0.1 },
    ]);
    expect(ind.dc().nodeVoltage[2]).toBeCloseTo(0, 6); // shorted to ground
  });
});

describe('transient (backward Euler)', () => {
  it('RC reaches 63.2% of its final value after one time constant', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'C1', type: 'C', nodes: [2, 0], value: 1e-6 },
    ]);
    const tau = 1000 * 1e-6;            // 1 ms
    const h = tau / 1000;
    let v = 0;
    for (let i = 0; i < 1000; i++) v = c.step(h).nodeVoltage[2];
    expect(v).toBeCloseTo(5 * (1 - Math.exp(-1)), 2); // 3.161 V
    expect(c.t).toBeCloseTo(tau, 12);                 // time really advanced
  });

  it('RL decays the inductor voltage to 1/e after one time constant', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'L1', type: 'L', nodes: [2, 0], value: 0.1 },
    ]);
    const tau = 0.1 / 1000;             // L/R = 100 µs
    const h = tau / 1000;
    let v = 0;
    for (let i = 0; i < 1000; i++) v = c.step(h).nodeVoltage[2];
    expect(v).toBeCloseTo(5 * Math.exp(-1), 1);            // 1.84 V left
    // ...and the current has risen to (V/R)(1 - 1/e)
    expect(Math.abs((5 - v) / 1000)).toBeCloseTo(5e-3 * (1 - Math.exp(-1)), 4);
  });
});
