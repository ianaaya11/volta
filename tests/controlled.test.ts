// The four dependent sources — 10 checks.
//
// These are the building blocks every behavioural model is made of (an op-amp
// is already a VCVS internally), so what matters is that each one's gain has
// the right units, the right sign, and — for the current-controlled pair —
// that the internal ammeter really does sense the branch it is wired into
// without disturbing it.
//
// Sign convention throughout, matching SPICE and this engine's independent
// current source: positive output current flows INTO out+, through the source,
// and OUT of out−. A current-output source therefore SINKS at out+, so a
// resistor from out+ to ground is driven negative.
import { describe, it, expect } from 'vitest';
import { Circuit } from '../src/engine';

describe('VCVS (E) — voltage-controlled voltage source', () => {
  it('multiplies its controlling voltage by the gain', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 2 },
      { id: 'E1', type: 'E', nodes: [2, 0, 1, 0], value: 5 },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]);
    const r = c.dc();
    expect(r.nodeVoltage[2]).toBeCloseTo(10, 9);
    // 10 V across 1 kΩ, and the source supplies all of it.
    expect(Math.abs(r.current['E1'])).toBeCloseTo(10e-3, 9);
  });

  it('holds its output stiff regardless of the load', () => {
    const build = (load: number) => new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 1 },
      { id: 'E1', type: 'E', nodes: [2, 0, 1, 0], value: 3 },
      { id: 'RL', type: 'R', nodes: [2, 0], value: load },
    ]).dc().nodeVoltage[2];
    expect(build(10)).toBeCloseTo(3, 9);
    expect(build(1e6)).toBeCloseTo(3, 9);
  });

  it('draws no current through its controlling port', () => {
    // A 1 MΩ in series with the control input would drop volts if the port
    // loaded it at all. The control node must still read the full 2 V.
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 2 },
      { id: 'Rin', type: 'R', nodes: [1, 3], value: 1e6 },
      { id: 'E1', type: 'E', nodes: [2, 0, 3, 0], value: 4 },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]);
    const r = c.dc();
    expect(r.nodeVoltage[3]).toBeCloseTo(2, 6);
    expect(r.nodeVoltage[2]).toBeCloseTo(8, 6);
  });

  it('a differential control port responds to the difference, not either node', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 7 },
      { id: 'V2', type: 'V', nodes: [3, 0], value: 5 },
      { id: 'E1', type: 'E', nodes: [2, 0, 1, 3], value: 10 },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]);
    expect(c.dc().nodeVoltage[2]).toBeCloseTo(20, 6);   // 10 × (7 − 5)
  });
});

describe('VCCS (G) — voltage-controlled current source', () => {
  it('turns a control voltage into a current, in amps per volt', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 2 },
      { id: 'G1', type: 'G', nodes: [2, 0, 1, 0], value: 1e-3 },   // 1 mA/V
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]);
    const r = c.dc();
    // 2 mA is pulled out of node 2 through the source, so 1 kΩ to ground sits
    // at −2 V. The magnitude is what the transconductance predicts.
    expect(r.nodeVoltage[2]).toBeCloseTo(-2, 9);
    expect(r.current['G1']).toBeCloseTo(2e-3, 12);
  });

  it('its output current is independent of the load it drives', () => {
    for (const load of [100, 4700]) {
      const c = new Circuit([
        { id: 'V1', type: 'V', nodes: [1, 0], value: 3 },
        { id: 'G1', type: 'G', nodes: [2, 0, 1, 0], value: 2e-3 },
        { id: 'RL', type: 'R', nodes: [2, 0], value: load },
      ]);
      expect(Math.abs(c.dc().nodeVoltage[2])).toBeCloseTo(6e-3 * load, 9);
    }
  });
});

describe('CCCS (F) — current-controlled current source', () => {
  it('multiplies the current through its own sensing port', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 1 },
      { id: 'Rs', type: 'R', nodes: [1, 3], value: 1000 },          // 1 mA into the sense pin
      { id: 'F1', type: 'F', nodes: [2, 0, 3, 0], value: 10 },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 100 },
    ]);
    const r = c.dc();
    // The sense port is a 0 V short, so it doesn't disturb the branch it
    // measures: the full 1 V lands across Rs.
    expect(r.nodeVoltage[3]).toBeCloseTo(0, 12);
    expect(r.current['F1:sense']).toBeCloseTo(1e-3, 12);
    // 10 × 1 mA = 10 mA sunk through 100 Ω.
    expect(r.nodeVoltage[2]).toBeCloseTo(-1, 9);
  });

  it('follows the sensed current when it changes', () => {
    const at = (rs: number) => new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 1 },
      { id: 'Rs', type: 'R', nodes: [1, 3], value: rs },
      { id: 'F1', type: 'F', nodes: [2, 0, 3, 0], value: 5 },
      { id: 'RL', type: 'R', nodes: [2, 0], value: 100 },
    ]).dc();
    expect(at(1000).nodeVoltage[2]).toBeCloseTo(-0.5, 9);   // 5 × 1 mA × 100 Ω
    expect(at(500).nodeVoltage[2]).toBeCloseTo(-1, 9);      // 5 × 2 mA × 100 Ω
  });
});

describe('CCVS (H) — current-controlled voltage source', () => {
  it('turns the sensed current into a voltage, in volts per amp', () => {
    const c = new Circuit([
      { id: 'V1', type: 'V', nodes: [1, 0], value: 1 },
      { id: 'Rs', type: 'R', nodes: [1, 3], value: 1000 },          // 1 mA sensed
      { id: 'H1', type: 'H', nodes: [2, 0, 3, 0], value: 2000 },    // 2 kΩ transresistance
      { id: 'RL', type: 'R', nodes: [2, 0], value: 1000 },
    ]);
    const r = c.dc();
    expect(r.current['H1:sense']).toBeCloseTo(1e-3, 12);
    expect(r.nodeVoltage[2]).toBeCloseTo(2, 9);                     // 2 kΩ × 1 mA
    // As a voltage source it holds that output whatever the load draws.
    expect(Math.abs(r.current['H1'])).toBeCloseTo(2e-3, 9);
  });
});
