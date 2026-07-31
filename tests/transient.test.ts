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

  it('a SQR source switches between offset±amp at the duty point', () => {
    const s = {
      id: 'VS1', type: 'VS' as const, nodes: [1, 0] as [number, number],
      wave: 'SQR' as const, amp: 5, freq: 1000, off: 0,
    };
    expect(srcVal(s, 0)).toBe(5);              // starts high
    expect(srcVal(s, 0.4 / 1000)).toBe(5);     // still high before the midpoint
    expect(srcVal(s, 0.6 / 1000)).toBe(-5);    // low after it
    expect(srcVal(s, 1 / 1000)).toBe(5);       // next period repeats
  });

  it('a SQR duty cycle moves the switching point', () => {
    const s = {
      id: 'VS1', type: 'VS' as const, nodes: [1, 0] as [number, number],
      wave: 'SQR' as const, amp: 1, freq: 1000, off: 0, duty: 0.25,
    };
    expect(srcVal(s, 0.2 / 1000)).toBe(1);     // high for the first quarter
    expect(srcVal(s, 0.3 / 1000)).toBe(-1);    // low for the remaining three
    expect(srcVal(s, 0.9 / 1000)).toBe(-1);
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

describe('square wave through an RC low-pass', () => {
  it('integrates to its DC average when the period is far below the time constant', () => {
    // A 0→5 V pulse train (off 2.5, amp 2.5) at 50% duty averages 2.5 V. With
    // tau = 10 ms against a 1 ms period, the cap can't follow the edges and the
    // output settles on that average — the textbook averaging behaviour, and a
    // real end-to-end check of the new source through the transient solver.
    const c = new Circuit([
      { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SQR', amp: 2.5, off: 2.5, freq: 1000 },
      { id: 'R', type: 'R', nodes: [1, 2], value: 10000 },
      { id: 'C', type: 'C', nodes: [2, 0], value: 1e-6 },   // tau = 10 ms
    ]);
    const h = 1 / 1000 / 200;
    for (let i = 0; i < 200 * 200; i++) c.step(h);          // 200 periods = 20 tau
    let sum = 0, n = 0;
    for (let i = 0; i < 200; i++) { sum += c.step(h).nodeVoltage[2]; n++; }
    expect(sum / n).toBeCloseTo(2.5, 1);
  });

  it('follows the edges when the period is far above the time constant', () => {
    // Same source, but tau = 10 µs against a 1 ms period: the cap now charges
    // fully each half cycle, so the output reaches both rails instead of averaging.
    const c = new Circuit([
      { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SQR', amp: 2.5, off: 2.5, freq: 1000 },
      { id: 'R', type: 'R', nodes: [1, 2], value: 10 },
      { id: 'C', type: 'C', nodes: [2, 0], value: 1e-6 },   // tau = 10 µs
    ]);
    const h = 1 / 1000 / 400;
    for (let i = 0; i < 400 * 5; i++) c.step(h);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 400; i++) { const v = c.step(h).nodeVoltage[2]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(hi).toBeCloseTo(5, 1);
    expect(lo).toBeCloseTo(0, 1);
  });
});

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
