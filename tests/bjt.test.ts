// Bipolar junction transistor (Ebers-Moll) — 6 checks.
// The BJT is the reference implementation every other 3-terminal device copies:
// transport-model currents, a 3x3 Jacobian stamped per Newton iteration, and
// pnjlim voltage limiting. Without the limiting Vbe runs away to ~2.4 V, which
// is the canonical SPICE convergence trap — so "active region" here is also a
// convergence test.
import { describe, it, expect } from 'vitest';
import { Circuit, pnjlim } from '../src/engine';

// Vcc=5, Rb=470k, Rc=1k, beta=100. Hand calculation:
//   Ib = (5 - 0.7)/470k = 9.15 µA, Ic = 915 µA, Vc = 5 - 0.915 = 4.09 V
const commonEmitter = (rb: number) => new Circuit([
  { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
  { id: 'Rc', type: 'R', nodes: [1, 3], value: 1000 },
  { id: 'Rb', type: 'R', nodes: [1, 2], value: rb },
  { id: 'Q1', type: 'QN', nodes: [3, 2, 0], bf: 100 },
]);

describe('NPN', () => {
  it('current gain matches the model beta', () => {
    const t = commonEmitter(470000).dc().terminals['Q1'];
    expect(t.Ic / t.Ib).toBeCloseTo(100, 0);
  });

  it('Vbe sits at a forward junction drop', () => {
    const v = commonEmitter(470000).dc().nodeVoltage;
    expect(v[2]).toBeGreaterThan(0.6);
    expect(v[2]).toBeLessThan(0.75);
  });

  it('biases into the active region at the documented operating point', () => {
    const r = commonEmitter(470000).dc();
    expect(r.nodeVoltage[3]).toBeCloseTo(4.09, 1);            // collector
    expect(r.nodeVoltage[3]).toBeGreaterThan(r.nodeVoltage[2]); // Vc > Vb: not saturated
    expect(r.terminals['Q1'].Ic).toBeCloseTo(915e-6, 4);
  });

  it('saturates when the base is driven hard (Vce collapses)', () => {
    // Rb=47k asks for 9 mA of collector current, but Rc can only supply ~5 mA.
    const r = commonEmitter(47000).dc();
    const vce = r.nodeVoltage[3] - 0;
    expect(vce).toBeLessThan(0.4);              // hard into saturation
    expect(vce).toBeGreaterThan(0);
    expect(r.terminals['Q1'].Ic / r.terminals['Q1'].Ib).toBeLessThan(100); // gain collapsed
  });

  it('cuts off with the base grounded: no collector current', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'Rc', type: 'R', nodes: [1, 3], value: 1000 },
      { id: 'Rb', type: 'R', nodes: [2, 0], value: 10000 }, // base pulled to ground
      { id: 'Q1', type: 'QN', nodes: [3, 2, 0], bf: 100 },
    ]);
    const r = c.dc();
    expect(Math.abs(r.terminals['Q1'].Ic)).toBeLessThan(1e-9);
    expect(r.nodeVoltage[3]).toBeCloseTo(5, 3); // collector pulled up to Vcc
  });
});

describe('PNP', () => {
  it('is a sign-mirror of the NPN at the same operating point', () => {
    // Emitter at +5, base and collector pulled down — the mirror of the NPN
    // circuit above, so it should land on the same 4.09 V across the device.
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'Rb', type: 'R', nodes: [2, 0], value: 470000 },
      { id: 'Rc', type: 'R', nodes: [3, 0], value: 1000 },
      { id: 'Q1', type: 'QP', nodes: [3, 2, 1], bf: 100 },
    ]);
    const r = c.dc();
    const t = r.terminals['Q1'];
    expect(r.nodeVoltage[1] - r.nodeVoltage[2]).toBeCloseTo(0.7, 1); // Veb forward
    expect(t.Ic / t.Ib).toBeCloseTo(100, 0);                          // same beta
    expect(t.Ic).toBeLessThan(0);                                     // currents mirrored
    expect(r.nodeVoltage[1] - r.nodeVoltage[3]).toBeCloseTo(4.09, 1); // Vec
  });
});

describe('pnjlim', () => {
  it('caps a junction-voltage jump that would diverge the exponential', () => {
    const vt = 0.025852;
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * 1e-15));
    // A Newton step that tries to leap far past vcrit gets pulled back...
    expect(pnjlim(5, 0.7, vt, vcrit)).toBeLessThan(1.0);
    // ...while a small, safe step is passed through untouched.
    expect(pnjlim(0.71, 0.7, vt, vcrit)).toBeCloseTo(0.71, 12);
  });
});
