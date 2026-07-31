// Ideal op-amp — 5 checks.
// A high-gain VCVS with its own MNA branch current: a pure linear stamp, so no
// Newton iteration is involved. These cover the three textbook configurations
// plus the two behaviours everything else is reasoned from — the virtual short
// and the virtual ground.
import { describe, it, expect } from 'vitest';
import { Circuit } from '../src/engine';

// nodes = [out, in+, in−]
const nonInverting = (rf: number, rg: number, vin: number) => new Circuit([
  { id: 'Vin', type: 'V', nodes: [2, 0], value: vin },
  { id: 'OA', type: 'OA', nodes: [3, 2, 4] },
  { id: 'Rf', type: 'R', nodes: [3, 4], value: rf },
  { id: 'Rg', type: 'R', nodes: [4, 0], value: rg },
]);

describe('non-inverting amplifier', () => {
  it('gain = 1 + Rf/Rg = 2', () => {
    expect(nonInverting(10000, 10000, 1).dc().nodeVoltage[3]).toBeCloseTo(2, 3);
  });

  it('gain = 1 + Rf/Rg = 5', () => {
    expect(nonInverting(40000, 10000, 1).dc().nodeVoltage[3]).toBeCloseTo(5, 3);
  });

  it('holds the virtual short: V− tracks V+', () => {
    const r = nonInverting(40000, 10000, 1).dc();
    expect(r.nodeVoltage[4]).toBeCloseTo(r.nodeVoltage[2], 4);
  });
});

describe('inverting amplifier', () => {
  // Vin -- Rin --+-- Rf -- out,  in+ grounded, in− at the summing junction.
  const inverting = (rin: number, rf: number, vin: number) => new Circuit([
    { id: 'Vin', type: 'V', nodes: [1, 0], value: vin },
    { id: 'Rin', type: 'R', nodes: [1, 4], value: rin },
    { id: 'Rf', type: 'R', nodes: [4, 3], value: rf },
    { id: 'OA', type: 'OA', nodes: [3, 0, 4] },
  ]);

  it('gain = −Rf/Rin = −1', () => {
    expect(inverting(10000, 10000, 1).dc().nodeVoltage[3]).toBeCloseTo(-1, 3);
  });

  it('holds the virtual ground at the summing junction', () => {
    const r = inverting(10000, 20000, 1).dc();
    expect(r.nodeVoltage[4]).toBeCloseTo(0, 4);  // in− pinned to 0 V
    expect(r.nodeVoltage[3]).toBeCloseTo(-2, 3); // and the gain follows, −Rf/Rin
  });
});
