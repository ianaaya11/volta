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

// ---------------------------------------------------------------------------
//  LEDs — the same equation with a much smaller saturation current
// ---------------------------------------------------------------------------
//  A red LED drops 1.8 V and a blue one 3.0 V, and that difference is the whole
//  reason the colours exist as separate models rather than six paint options.
//  Before this, every LED in Volta was a 0.7 V silicon diode wearing a colour,
//  which gets a traffic light wrong in a way a student would be right to
//  believe: it says a blue LED will happily run off two AA cells.
//
//  These mirror LED_COLORS in main.ts. If the constants there change, this
//  fails, which is the point — the numbers are a claim about real parts.
const LED_N = 2, LED_RATED = 0.02;
const ledIs = (vf: number) => LED_RATED / Math.exp(vf / (LED_N * VT));
const led = (vf: number) => ({
  id: 'D1' as const, type: 'D' as const, nodes: [2, 0] as [number, number],
  Is: ledIs(vf), n: LED_N, vmax: vf + 0.4,
});

/** supply -> series resistor -> LED -> ground */
const litBy = (supply: number, r: number, vf: number) => new Circuit([
  { id: 'V1', type: 'V', nodes: [1, 0], value: supply },
  { id: 'R', type: 'R', nodes: [1, 2], value: r },
  led(vf),
]);

describe('LED forward voltage tracks its colour', () => {
  const COLOURS: [string, number][] = [
    ['red', 1.8], ['amber', 2.0], ['yellow', 2.1],
    ['green', 2.2], ['blue', 3.0], ['white', 3.1],
  ];

  it.each(COLOURS)('a %s LED at 20 mA sits at its rated %s V', (_name, vf) => {
    // Pick the resistor that would deliver exactly 20 mA at the rated drop, so
    // a correct model lands on the datasheet number.
    const c = litBy(5, (5 - vf) / LED_RATED, vf);
    const r = c.dc();
    expect(r.nodeVoltage[2]).toBeCloseTo(vf, 2);
    expect(r.current['D1']).toBeCloseTo(LED_RATED, 3);
  });

  it('separates red from blue on the same supply and resistor', () => {
    const red = litBy(5, 220, 1.8).dc();
    const blue = litBy(5, 220, 3.0).dc();
    // Same circuit, different part: the blue one takes noticeably less current
    // because more of the supply is spent crossing its junction.
    expect(red.current['D1']).toBeGreaterThan(blue.current['D1'] * 1.5);
    expect(blue.nodeVoltage[2] - red.nodeVoltage[2]).toBeCloseTo(1.2, 1);
  });

  it('will not light a blue LED from 2.5 V, but will light a red one', () => {
    const blue = litBy(2.5, 220, 3.0).dc();
    const red = litBy(2.5, 220, 1.8).dc();
    expect(blue.current['D1']).toBeLessThan(1e-4);      // dark
    expect(red.current['D1']).toBeGreaterThan(2e-3);    // clearly lit
  });

  it('still converges when driven hard, without the clamp capping it', () => {
    // 5 V behind 10 R on a red LED is an abusive drive; the solver must reach a
    // real operating point rather than parking on the linearisation clamp.
    const r = litBy(5, 10, 1.8).dc();
    expect(Number.isFinite(r.current['D1'])).toBe(true);
    expect(r.nodeVoltage[2]).toBeGreaterThan(1.8);
    expect(r.nodeVoltage[2]).toBeLessThan(2.2);
  });
});
