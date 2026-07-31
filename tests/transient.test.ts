// Time-varying sources and transient frequency response — 4 checks.
// This is the path the on-screen oscilloscope uses: the engine accumulates
// absolute time in step(), a sine source is evaluated at that time, and the
// waveform that comes out has to match the textbook RC response. Measuring the
// response by actually running the simulation (rather than by AC analysis)
// is what makes this an end-to-end check of the transient solver.
import { describe, it, expect } from 'vitest';
import { Circuit, srcVal } from '../src/engine';

describe('sine source', () => {
  it('a DC source is constant in time', () => {
    const v = { id: 'V1', type: 'V' as const, nodes: [1, 0] as [number, number], value: 5 };
    expect(srcVal(v, 0)).toBe(5);
    expect(srcVal(v, 1.234)).toBe(5);
  });

  it('a SIN source is offset + amp·sin(2πft)', () => {
    const s = {
      id: 'VS1', type: 'VS' as const, nodes: [1, 0] as [number, number],
      wave: 'SIN' as const, amp: 2, freq: 1000, off: 1,
    };
    expect(srcVal(s, 0)).toBeCloseTo(1, 12);            // starts at the offset
    expect(srcVal(s, 1 / 4000)).toBeCloseTo(3, 12);     // quarter period: peak
    expect(srcVal(s, 3 / 4000)).toBeCloseTo(-1, 12);    // three quarters: trough
  });
});

// RC low-pass driven by a 1 V sine. R=1591Ω, C=100nF -> fc = 1000.3 Hz.
// Runs the real transient solver and measures the steady-state output peak,
// which for a 1 V input IS the magnitude response at that frequency.
function measureGain(freq: number): number {
  const c = new Circuit([
    { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SIN', amp: 1, freq, off: 0 },
    { id: 'R', type: 'R', nodes: [1, 2], value: 1591 },
    { id: 'C', type: 'C', nodes: [2, 0], value: 1e-7 },
  ]);
  const stepsPerCycle = 400;
  const h = 1 / freq / stepsPerCycle;
  for (let i = 0; i < stepsPerCycle * 10; i++) c.step(h); // let the transient die
  let peak = 0;
  for (let i = 0; i < stepsPerCycle; i++) peak = Math.max(peak, Math.abs(c.step(h).nodeVoltage[2]));
  return peak;
}

describe('RC low-pass, measured by running the simulation', () => {
  const fc = 1 / (2 * Math.PI * 1591 * 1e-7);

  it('passes frequencies well below cutoff almost untouched', () => {
    expect(measureGain(fc / 10)).toBeCloseTo(0.995, 2);
  });

  it('is 3 dB down at the cutoff frequency and rolls off above it', () => {
    const atCutoff = measureGain(fc);
    expect(atCutoff).toBeCloseTo(Math.SQRT1_2, 2);       // 0.707
    const decadeAbove = measureGain(fc * 10);
    expect(decadeAbove).toBeCloseTo(0.0995, 2);          // ~1/10 per decade
    expect(decadeAbove).toBeLessThan(atCutoff);
  });
});
