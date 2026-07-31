// Solver trace — what "show the math" displays. 6 checks.
// These matter because the trace is the teaching surface: if the matrix shown
// to a learner isn't the matrix actually solved, the feature is worse than
// useless. So the assertions check the stamps against hand-derived MNA values,
// not merely that a trace object exists.
import { describe, it, expect } from 'vitest';
import { Circuit } from '../src/engine';

// Vs -- R1 -- node2 -- R2 -- gnd.  Unknowns: v1, v2, i(V1).
const divider = () => {
  const c = new Circuit([
    { id: 'V1', type: 'V', nodes: [1, 0], value: 10 },
    { id: 'R1', type: 'R', nodes: [1, 2], value: 1000 },
    { id: 'R2', type: 'R', nodes: [2, 0], value: 2000 },
  ]);
  c.captureTrace = true;
  return c;
};

describe('trace capture', () => {
  it('is off by default and costs nothing', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R1', type: 'R', nodes: [1, 0], value: 1000 },
    ]);
    c.dc();
    expect(c.lastTrace).toBeNull();
  });

  it('labels every unknown: node voltages and branch currents', () => {
    const c = divider();
    c.dc();
    const t = c.lastTrace!;
    expect(t.size).toBe(3);
    expect(t.rowLabels).toContain('v1');
    expect(t.rowLabels).toContain('v2');
    expect(t.rowLabels).toContain('i(V1)');
  });

  it('stamps conductances where the hand calculation puts them', () => {
    const c = divider();
    c.dc();
    const t = c.lastTrace!;
    const r1 = t.rowLabels.indexOf('v1'), r2 = t.rowLabels.indexOf('v2');
    // KCL at node 1 sees only R1 (1/1000); node 2 sees R1 + R2 (1/1000 + 1/2000).
    expect(t.A[r1][r1]).toBeCloseTo(1 / 1000, 12);
    expect(t.A[r2][r2]).toBeCloseTo(1 / 1000 + 1 / 2000, 12);
    // ...coupled by −1/R1 off the diagonal, symmetrically.
    expect(t.A[r1][r2]).toBeCloseTo(-1 / 1000, 12);
    expect(t.A[r2][r1]).toBeCloseTo(-1 / 1000, 12);
  });

  it('puts the source value in the right-hand side, not the matrix', () => {
    const c = divider();
    c.dc();
    const t = c.lastTrace!;
    const br = t.rowLabels.indexOf('i(V1)');
    expect(t.z[br]).toBeCloseTo(10, 12);          // v(1) − v(0) = 10
    expect(t.z[t.rowLabels.indexOf('v1')]).toBeCloseTo(0, 12); // no current injected
  });

  it('returns a solution that satisfies the system it shows', () => {
    const c = divider();
    const r = c.dc();
    const t = c.lastTrace!;
    expect(t.residual).toBeLessThan(1e-9);
    // and the x in the trace is the same answer the caller got
    expect(t.x[t.rowLabels.indexOf('v2')]).toBeCloseTo(r.nodeVoltage[2], 12);
    expect(t.iterations).toBe(1);                 // linear: one pass
    expect(t.nonlinear).toBe(false);
  });

  it('reports the Newton iterations a nonlinear circuit actually took', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 5 },
      { id: 'R', type: 'R', nodes: [1, 2], value: 1000 },
      { id: 'D1', type: 'D', nodes: [2, 0] },
    ]);
    c.captureTrace = true;
    c.dc();
    const t = c.lastTrace!;
    expect(t.nonlinear).toBe(true);
    expect(t.iterations).toBeGreaterThan(1);      // a diode needs several passes
    expect(t.residual).toBeLessThan(1e-6);
  });
});
