// Diode (Shockley) — 4 checks.
// The first nonlinear device in the engine, and the one that proves the
// Newton-Raphson loop works at all: i = Is(exp(v/nVt) − 1), linearized each
// iteration into a conductance plus an equivalent current source.
import { describe, it, expect } from 'vitest';
import { Circuit } from '../src/engine';

const VT = 0.025852;

// 5 V through a series resistor into a diode to ground.
const series = (r: number) => new Circuit([
  { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
  { id: 'R', type: 'R', nodes: [1, 2], value: r },
  { id: 'D1', type: 'D', nodes: [2, 0] },
]);

describe('forward bias', () => {
  it('sits at the documented ~0.69 V drop', () => {
    const r = series(1000).dc();
    expect(r.nodeVoltage[2]).toBeCloseTo(0.69, 2);
    expect(r.current['D1']).toBeCloseTo((5 - 0.69) / 1000, 4); // KCL with the resistor
  });

  it('is exponential: a decade more current costs Vt·ln(10) more volts', () => {
    // 1k -> ~4.3 mA, 100R -> ~43 mA. The drop should rise by only ~59.5 mV.
    const low = series(1000).dc().nodeVoltage[2];
    const high = series(100).dc().nodeVoltage[2];
    expect(high - low).toBeCloseTo(VT * Math.log(10), 2);
  });
});

describe('reverse bias', () => {
  it('blocks: no current, and the full supply stands across the junction', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'D1', type: 'D', nodes: [0, 2] }, // cathode toward the supply
    ]);
    const r = c.dc();
    expect(Math.abs(r.current['D1'])).toBeLessThan(1e-12);
    expect(r.nodeVoltage[2]).toBeCloseTo(5, 6); // no drop across R
  });
});

describe('half-wave rectifier', () => {
  it('passes the positive half-cycle and clips the negative one', () => {
    const c = new Circuit([
      { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SIN', amp: 5, freq: 1000, off: 0 },
      { id: 'D1', type: 'D', nodes: [1, 2] },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]);
    const h = 1 / 1000 / 400;
    let peak = -Infinity, trough = Infinity;
    for (let i = 0; i < 800; i++) {          // two full cycles
      const v = c.step(h).nodeVoltage[2];
      peak = Math.max(peak, v); trough = Math.min(trough, v);
    }
    expect(peak).toBeCloseTo(5 - 0.7, 1);    // input peak minus a diode drop
    expect(trough).toBeGreaterThan(-0.01);   // negative half-cycle blocked
  });
});
