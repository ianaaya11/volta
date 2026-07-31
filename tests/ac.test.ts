// AC small-signal analysis / Bode — 6 checks.
// ac() computes the DC operating point, linearizes every nonlinear device
// around it, then solves the COMPLEX system (G + jωC)·v = i across a log-spaced
// sweep. The stimulus is driven with a unit phasor, so each node's phasor is
// the transfer function to that node — which is what these compare against
// closed-form theory.
import { describe, it, expect } from 'vitest';
import { Circuit } from '../src/engine';
import type { Complex } from '../src/engine';

const mag = (p: Complex) => Math.hypot(p.re, p.im);
const deg = (p: Complex) => (Math.atan2(p.im, p.re) * 180) / Math.PI;
const dB = (m: number) => 20 * Math.log10(m);

/** The sweep point nearest a target frequency. */
const at = (freqs: number[], f: number) => {
  let idx = 0, best = Infinity;
  freqs.forEach((v, i) => { const d = Math.abs(v - f); if (d < best) { best = d; idx = i; } });
  return idx;
};

describe('RC low-pass', () => {
  const rc = () => new Circuit([
    { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SIN', amp: 1, freq: 1 },
    { id: 'R', type: 'R', nodes: [1, 2], value: 1591 },
    { id: 'C', type: 'C', nodes: [2, 0], value: 1e-7 },
  ]);
  const fc = 1 / (2 * Math.PI * 1591 * 1e-7); // 1000.3 Hz
  const sweep = () => rc().ac(10, 1e5, 200, 'Vs');

  it('is −3 dB at the cutoff frequency', () => {
    const r = sweep();
    expect(dB(mag(r.phasors[at(r.freqs, fc)][2]))).toBeCloseTo(-3.01, 0);
  });

  it('lags by 45° at the cutoff frequency', () => {
    const r = sweep();
    expect(deg(r.phasors[at(r.freqs, fc)][2])).toBeCloseTo(-45, -0.5);
  });

  it('is flat at 0 dB well below cutoff', () => {
    const r = sweep();
    expect(dB(mag(r.phasors[at(r.freqs, 10)][2]))).toBeCloseTo(0, 1);
  });

  it('rolls off at −20 dB/decade above cutoff', () => {
    const r = sweep();
    const a = dB(mag(r.phasors[at(r.freqs, fc * 10)][2]));
    const b = dB(mag(r.phasors[at(r.freqs, fc * 100)][2]));
    expect(b - a).toBeCloseTo(-20, 0);
  });

  it('reports the stimulus it swept against', () => {
    expect(sweep().stimulusId).toBe('Vs');
  });
});

describe('series RLC bandpass', () => {
  it('peaks at unity gain on its resonant frequency', () => {
    // L=10mH, C=1µF -> f0 = 1/(2π√(LC)) = 1591.5 Hz. At resonance the reactances
    // cancel and the whole source voltage lands across R: |H| = 1.
    const c = new Circuit([
      { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SIN', amp: 1, freq: 1 },
      { id: 'L', type: 'L', nodes: [1, 2], value: 0.01 },
      { id: 'C', type: 'C', nodes: [2, 3], value: 1e-6 },
      { id: 'R', type: 'R', nodes: [3, 0], value: 50 },
    ]);
    const r = c.ac(100, 1e5, 400, 'Vs');
    let peak = 0, peakF = 0;
    r.freqs.forEach((f, i) => { const m = mag(r.phasors[i][3]); if (m > peak) { peak = m; peakF = f; } });
    const f0 = 1 / (2 * Math.PI * Math.sqrt(0.01 * 1e-6));
    expect(peak).toBeCloseTo(1, 1);
    expect(Math.abs(peakF - f0) / f0).toBeLessThan(0.05);
  });
});
