// MOSFET (square-law / SPICE level-1) — 9 checks.
// Five check the model equations directly in each region, four check that the
// device solves correctly once it is inside a circuit.
import { describe, it, expect } from 'vitest';
import { Circuit, mos1 } from '../src/engine';

const VTH = 1, K = 0.002;

describe('mos1 model equations', () => {
  it('cutoff: no channel below threshold', () => {
    expect(mos1(0.5, 2, VTH, K, 0)).toEqual({ Id: 0, gm: 0, gds: 0 });
  });

  it('triode: Id = k(Vov·Vds − ½Vds²)', () => {
    const vov = 2, vds = 0.5;
    const r = mos1(VTH + vov, vds, VTH, K, 0);
    expect(r.Id).toBeCloseTo(K * (vov * vds - 0.5 * vds * vds), 12);
    expect(r.gm).toBeCloseTo(K * vds, 12);
    expect(r.gds).toBeCloseTo(K * (vov - vds), 12);
  });

  it('saturation: Id = ½k·Vov²', () => {
    const vov = 2;
    const r = mos1(VTH + vov, 3, VTH, K, 0);
    expect(r.Id).toBeCloseTo(0.5 * K * vov * vov, 12);
    expect(r.gm).toBeCloseTo(K * vov, 12);   // gm = k·Vov
    expect(r.gds).toBe(0);                   // ideal current source without lambda
  });

  it('lambda gives finite output resistance in saturation', () => {
    const vov = 2, lam = 0.02, vds = 3;
    const r = mos1(VTH + vov, vds, VTH, K, lam);
    expect(r.Id).toBeCloseTo(0.5 * K * vov * vov * (1 + lam * vds), 12);
    expect(r.gds).toBeCloseTo(0.5 * K * vov * vov * lam, 12);
    expect(r.gds).toBeGreaterThan(0);
  });

  it('is continuous across the triode/saturation boundary (Vds = Vov)', () => {
    const vov = 2;
    const edge = 1e-9;
    const tri = mos1(VTH + vov, vov - edge, VTH, K, 0);
    const sat = mos1(VTH + vov, vov + edge, VTH, K, 0);
    expect(tri.Id).toBeCloseTo(sat.Id, 9);
  });
});

describe('NMOS in a common-source stage', () => {
  // Vdd=5, gate divider 150k/100k -> Vg=2V, Vov=1V, Id=½·k·1²=1mA,
  // Vd = 5 − 1mA·2k = 3V exactly.
  const cs = () => new Circuit([
    { id: 'Vdd', type: 'V', nodes: [1, 0], value: 5 },
    { id: 'Rd', type: 'R', nodes: [1, 3], value: 2000 },
    { id: 'R1', type: 'R', nodes: [1, 2], value: 150000 },
    { id: 'R2', type: 'R', nodes: [2, 0], value: 100000 },
    { id: 'M1', type: 'MN', nodes: [3, 2, 0], vth: VTH, k: K },
  ]);

  it('the divider sets the gate to 2 V', () => {
    expect(cs().dc().nodeVoltage[2]).toBeCloseTo(2, 3);
  });

  it('the drain lands on the hand calculation, 3 V', () => {
    expect(cs().dc().nodeVoltage[3]).toBeCloseTo(3, 3);
  });

  it('drain current is 1 mA and the device is in saturation', () => {
    const r = cs().dc();
    expect(r.current['M1']).toBeCloseTo(1e-3, 6);
    const vds = r.nodeVoltage[3] - 0, vov = r.nodeVoltage[2] - VTH;
    expect(vds).toBeGreaterThan(vov); // saturation condition
  });

  it('cuts off with the gate grounded and the drain pulls up to Vdd', () => {
    const c = new Circuit([
      { id: 'Vdd', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'Rd', type: 'R', nodes: [1, 3], value: 2000 },
      { id: 'Rg', type: 'R', nodes: [2, 0], value: 100000 },
      { id: 'M1', type: 'MN', nodes: [3, 2, 0], vth: VTH, k: K },
    ]);
    const r = c.dc();
    expect(r.current['M1']).toBeCloseTo(0, 9);
    expect(r.nodeVoltage[3]).toBeCloseTo(5, 6);
  });
});

describe('PMOS', () => {
  it('mirrors the NMOS bias point about the supply rail', () => {
    // Source at +5, gate at 3 V (Vgs = −2, |Vov| = 1), drain through 2k to 0.
    // Same 1 mA, so the drain sits 2 V above ground: the NMOS answer mirrored.
    const c = new Circuit([
      { id: 'Vdd', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'Vg', type: 'V', nodes: [2, 0], value: 3 },
      { id: 'Rd', type: 'R', nodes: [3, 0], value: 2000 },
      { id: 'M1', type: 'MP', nodes: [3, 2, 1], vth: -VTH, k: K },
    ]);
    const r = c.dc();
    expect(r.current['M1']).toBeCloseTo(-1e-3, 6);   // current mirrored in sign
    expect(r.nodeVoltage[3]).toBeCloseTo(2, 3);      // 1 mA into 2k
  });
});
