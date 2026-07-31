import { describe, it, expect } from 'vitest';
import { Circuit } from '../src/engine';

const mag = (p: any) => Math.hypot(p.re, p.im);
const deg = (p: any) => (Math.atan2(p.im, p.re) * 180) / Math.PI;
const dB = (m: number) => 20 * Math.log10(m);

describe('DC / linear', () => {
  it('voltage divider', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 10 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'R2', type: 'R', nodes: [2, 0], value: 2000 },
    ]);
    const r = c.dc();
    expect(r.nodeVoltage[2]).toBeCloseTo(6.6667, 3);
  });

  it('RC charges toward one time constant', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'C', type: 'C', nodes: [2, 0], value: 1e-6 },
    ]);
    const h = 1e-6; for (let i = 0; i < 1000; i++) c.step(h); // t = 1ms = 1 tau
    expect(c.dc().nodeVoltage).toBeDefined();
  });
});

describe('semiconductors', () => {
  it('diode drops ~0.6-0.75V', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'D', type: 'D', nodes: [2, 0] },
    ]);
    const v = c.dc().nodeVoltage[2];
    expect(v).toBeGreaterThan(0.6); expect(v).toBeLessThan(0.75);
  });

  it('BJT common-emitter: beta≈100, active region', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'Rc', type: 'R', nodes: [1, 3], value: 1000 },
      { id: 'Rb', type: 'R', nodes: [1, 2], value: 470000 },
      { id: 'Q1', type: 'QN', nodes: [3, 2, 0], bf: 100 },
    ]);
    const r = c.dc(); const t = r.terminals['Q1'];
    expect(t.Ic / t.Ib).toBeCloseTo(100, 0);
    expect(r.nodeVoltage[3]).toBeGreaterThan(r.nodeVoltage[2]); // not saturated
  });

  it('NMOS common-source bias lands on hand calc', () => {
    const c = new Circuit([
      { id: 'Vdd', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'Rd', type: 'R', nodes: [1, 3], value: 2000 },
      { id: 'R1', type: 'R', nodes: [1, 2], value: 150000 },
      { id: 'R2', type: 'R', nodes: [2, 0], value: 100000 },
      { id: 'M1', type: 'MN', nodes: [3, 2, 0], vth: 1, k: 0.002 },
    ]);
    const r = c.dc();
    expect(r.nodeVoltage[2]).toBeCloseTo(2, 1); // gate
    expect(r.nodeVoltage[3]).toBeCloseTo(3, 1); // drain
  });

  it('op-amp non-inverting gain = 1 + Rf/Rg', () => {
    const c = new Circuit([
      { id: 'Vin', type: 'V', nodes: [2, 0], value: 1 },
      { id: 'OA', type: 'OA', nodes: [3, 2, 4] },
      { id: 'Rf', type: 'R', nodes: [3, 4], value: 10000 },
      { id: 'Rg', type: 'R', nodes: [4, 0], value: 10000 },
    ]);
    expect(c.dc().nodeVoltage[3]).toBeCloseTo(2, 3);
  });
});

describe('AC analysis', () => {
  it('RC low-pass: -3dB and -45° at cutoff', () => {
    const c = new Circuit([
      { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SIN', amp: 1, freq: 1 },
      { id: 'R', type: 'R', nodes: [1, 2], value: 1591 },
      { id: 'C', type: 'C', nodes: [2, 0], value: 1e-7 },
    ]);
    const r = c.ac(10, 1e5, 200, 'Vs');
    let idx = 0, bd = Infinity;
    r.freqs.forEach((f: number, i: number) => { const d = Math.abs(f - 1000); if (d < bd) { bd = d; idx = i; } });
    const H = r.phasors[idx][2];
    expect(dB(mag(H))).toBeCloseTo(-3.01, 0);
    expect(deg(H)).toBeCloseTo(-45, -0.5);
  });

  it('series RLC peaks at unity near resonance', () => {
    const c = new Circuit([
      { id: 'Vs', type: 'VS', nodes: [1, 0], wave: 'SIN', amp: 1, freq: 1 },
      { id: 'L', type: 'L', nodes: [1, 2], value: 0.01 },
      { id: 'C', type: 'C', nodes: [2, 3], value: 1e-6 },
      { id: 'R', type: 'R', nodes: [3, 0], value: 50 },
    ]);
    const r = c.ac(100, 1e5, 400, 'Vs');
    let pk = 0, pf = 0;
    r.freqs.forEach((f: number, i: number) => { const m = mag(r.phasors[i][3]); if (m > pk) { pk = m; pf = f; } });
    const f0 = 1 / (2 * Math.PI * Math.sqrt(0.01 * 1e-6));
    expect(pk).toBeCloseTo(1, 1);
    expect(Math.abs(pf - f0) / f0).toBeLessThan(0.05);
  });
});
