// Breadboard layout.
//
// Placement is heuristics and always will be. Verification is not, and that
// asymmetry is the design: every layout is read back off the board — following
// only the board's own wiring rules — and compared to the netlist it came from.
// A layout that disagrees is rejected before anyone sees it.
//
// So most of these tests do not check WHERE anything was put. They check that
// wherever it was put, the circuit is still the circuit. The few that do check
// placement are about whether a person could follow the result.
import { describe, it, expect } from 'vitest';
import { layout, readBack, verify, stripOf, HALF, type Layout } from '../src/breadboard';
import type { ExportPart } from '../src/netlist';

const P = (id: string, type: string, nodes: number[], x = 0, value?: number): ExportPart =>
  ({ id, type, nodes, x, value });

// 5 V -> R1 -> LED -> ground.
const LED_CIRCUIT: ExportPart[] = [
  P('V1', 'V', [1, 0], 0, 5),
  P('R1', 'R', [1, 2], 4, 220),
  P('D1', 'LED', [2, 0], 8),
  P('GND1', 'GND', [0], 12),
];

// A two-stage RC, which forces one net to be shared by three pins.
const RC2: ExportPart[] = [
  P('V1', 'V', [1, 0], 0, 5),
  P('R1', 'R', [1, 2], 4, 1000),
  P('C1', 'C', [2, 0], 6, 1e-6),
  P('R2', 'R', [2, 3], 8, 1000),
  P('C2', 'C', [3, 0], 10, 1e-6),
  P('GND1', 'GND', [0], 14),
];

describe('the board is the board', () => {
  it('ties the five holes of a bank together and nothing else', () => {
    expect(stripOf({ col: 7, row: 'A' })).toBe(stripOf({ col: 7, row: 'E' }));
    // The channel keeps the banks apart — which is what lets a DIP straddle it.
    expect(stripOf({ col: 7, row: 'A' })).not.toBe(stripOf({ col: 7, row: 'F' }));
    // Different columns are different nodes.
    expect(stripOf({ col: 7, row: 'A' })).not.toBe(stripOf({ col: 8, row: 'A' }));
    // A rail is one node the whole way along.
    expect(stripOf({ col: 1, row: '-' })).toBe(stripOf({ col: 60, row: '-' }));
    expect(stripOf({ col: 1, row: '+' })).not.toBe(stripOf({ col: 1, row: '-' }));
  });
});

describe('the round trip', () => {
  for (const [name, circuit] of [['an LED and its resistor', LED_CIRCUIT], ['a two-stage RC', RC2]] as const) {
    it(`reproduces the netlist of ${name}`, () => {
      const { layout: l, problems } = layout(circuit);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  it('catches a connection that was never made', () => {
    const { layout: l } = layout(LED_CIRCUIT);
    // Move the LED's anode to a column nothing else touches. The netlist says
    // it meets R1; the board now says it meets nothing.
    const led = l.parts.find(p => p.id === 'D1')!;
    const broken: Layout = { ...l, parts: l.parts.map(p => p === led
      ? { ...p, holes: [{ col: 28, row: 'A' }, p.holes[1]] } : p) };
    const problems = verify(LED_CIRCUIT, broken);
    expect(problems.some(s => /should be connected but are not/.test(s))).toBe(true);
  });

  it('catches two nets accidentally shorted', () => {
    const { layout: l } = layout(LED_CIRCUIT);
    // Drop R1's second leg into the ground rail. Nothing on the schematic says
    // those meet, and this is the mistake that quietly destroys an LED.
    const r = l.parts.find(p => p.id === 'R1')!;
    const shorted: Layout = { ...l, parts: l.parts.map(p => p === r
      ? { ...p, holes: [p.holes[0], { col: 5, row: '-' }] } : p) };
    const problems = verify(LED_CIRCUIT, shorted);
    expect(problems.some(s => /shorted together/.test(s))).toBe(true);
  });

  it('reads the board without consulting the netlist', () => {
    // readBack follows spring clips only, so a jumper is as good as a shared
    // column — and the grouping has to prove it.
    const l: Layout = {
      cols: HALF, offBoard: [], rails: { plus: null, minus: 0 },
      parts: [
        { id: 'X', type: 'R', label: 'X', holes: [{ col: 2, row: 'A' }, { col: 5, row: 'A' }] },
        { id: 'Y', type: 'R', label: 'Y', holes: [{ col: 9, row: 'A' }, { col: 12, row: 'A' }] },
      ],
      jumpers: [{ from: { col: 5, row: 'E' }, to: { col: 9, row: 'E' } }],
    };
    const groups = [...readBack(l).values()].map(g => g.sort().join(',')).sort();
    expect(groups).toEqual(['X.0', 'X.1,Y.0', 'Y.1']);
  });
});

describe('what goes on the board and what does not', () => {
  it('puts ground on a rail rather than making it a part', () => {
    const { layout: l } = layout(LED_CIRCUIT);
    expect(l.rails.minus).toBe(0);
    expect(l.parts.some(p => p.type === 'GND')).toBe(false);
    // And it is not listed as a problem, because a rail is where it belongs.
    expect(l.offBoard.some(o => o.type === 'GND')).toBe(false);
  });

  it('sends the supply to the bench, with a reason', () => {
    const { layout: l } = layout(LED_CIRCUIT);
    const v = l.offBoard.find(o => o.id === 'V1');
    expect(v?.why).toMatch(/bench supply|rails/i);
    expect(l.parts.some(p => p.id === 'V1')).toBe(false);
  });

  it('refuses to breadboard a part Volta only models behaviourally', () => {
    const { layout: l } = layout([
      P('AND1', 'AND', [1, 2, 3]), P('GND1', 'GND', [0]),
    ]);
    const g = l.offBoard.find(o => o.id === 'AND1');
    expect(g?.why).toMatch(/not as a chip|real part chosen/i);
  });

  it('keeps a meter off the board and says where it goes instead', () => {
    const { layout: l } = layout([...LED_CIRCUIT, P('VM1', 'VM', [2, 0], 16)]);
    expect(l.offBoard.find(o => o.id === 'VM1')?.why).toMatch(/clip it on/i);
  });
});

describe('a layout a person can follow', () => {
  it('lays parts out in the order they were drawn', () => {
    const { layout: l } = layout(RC2);
    const firstCol = (id: string) =>
      Math.min(...l.parts.find(p => p.id === id)!.holes
        .filter(h => h.row !== '+' && h.row !== '-').map(h => h.col));
    expect(firstCol('R1')).toBeLessThanOrEqual(firstCol('R2'));
  });

  it('gives every leg its own hole', () => {
    // Three parts meeting at one node is normal, and all three legs going into
    // hole 3A is not. The verifier is blind to this by design: the five holes
    // of a strip ARE one node, so the netlist round trip is perfectly happy.
    const { layout: l } = layout([
      P('V1', 'V', [1, 0], 0, 5), P('R1', 'R', [1, 2], 2, 1000),
      P('C1', 'C', [2, 0], 4, 1e-6), P('R2', 'R', [2, 0], 6, 1000),
      P('D1', 'D', [2, 0], 8), P('GND1', 'GND', [0], 10),
    ]);
    const holes = l.parts.flatMap(p => p.holes.map(h => `${h.col}${h.row}`));
    expect(new Set(holes).size, `duplicate holes in ${JSON.stringify(holes)}`).toBe(holes.length);
  });

  it('never puts both legs of a part in the same node', () => {
    for (const circuit of [LED_CIRCUIT, RC2]) {
      const { layout: l } = layout(circuit);
      for (const p of l.parts) {
        const strips = p.holes.map(stripOf);
        expect(new Set(strips).size, `${p.id} shorts itself out`).toBe(strips.length);
      }
    }
  });

  it('keeps leads within reach', () => {
    const { layout: l } = layout(RC2);
    for (const p of l.parts) {
      const cols = p.holes.filter(h => h.row !== '+' && h.row !== '-').map(h => h.col);
      if (cols.length === 2) {
        expect(Math.abs(cols[0] - cols[1]), `${p.id} is stretched too far`).toBeLessThanOrEqual(9);
      }
    }
  });

  it('fits a small circuit on a half-size board', () => {
    expect(layout(LED_CIRCUIT).layout.cols).toBe(HALF);
  });

  it('shares a column instead of adding a jumper where it can', () => {
    // R1 and C1 meet at node 2. A good layout puts them in the same column and
    // spends no wire on it.
    const { layout: l } = layout(RC2);
    expect(l.jumpers.length).toBeLessThan(l.parts.length);
  });
});

// ---------------------------------------------------------------------------
//  Fuzzing the placer
// ---------------------------------------------------------------------------
//  Two hand-written circuits prove a placer works on two circuits. The round
//  trip is cheap enough to run on hundreds, and a placer is exactly the kind of
//  greedy code that is correct on the cases its author imagined and wrong three
//  columns later. Deterministic seed, so a failure can be reproduced.
describe('the round trip holds for circuits nobody designed', () => {
  // Small xorshift, so this suite never depends on Math.random.
  const rng = (seed: number) => () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 1000) / 1000;
  };

  const build = (r: () => number, i: number): ExportPart[] => {
    const nets = 2 + Math.floor(r() * 5);
    const kinds = ['R', 'C', 'L', 'D', 'LED'];
    const parts: ExportPart[] = [{ id: 'GND1', type: 'GND', nodes: [0], x: 0 }];
    const count = 2 + Math.floor(r() * 6);
    for (let k = 0; k < count; k++) {
      let a = Math.floor(r() * nets), b = Math.floor(r() * nets);
      if (a === b) b = (b + 1) % nets;                 // a part across one node is not a part
      parts.push({
        id: `${kinds[k % kinds.length]}${k}`, type: kinds[k % kinds.length],
        nodes: [a, b], x: k * 2, value: 1000,
      });
    }
    return parts;
  };

  // The round trip alone is nearly guaranteed by how the placer allocates
  // columns, so it is the weakest of these three. The other two are properties
  // the algorithm could genuinely violate: a part stretched further than its
  // leads reach, and a part whose own two legs land in one node.
  it('lays out 300 random circuits correctly, and physically', () => {
    const r = rng(20260816);
    const bad: string[] = [];
    let shared = 0;
    for (let i = 0; i < 300; i++) {
      const circuit = build(r, i);
      const { layout: l, problems } = layout(circuit);
      const show = JSON.stringify(circuit.filter(p => p.type !== 'GND')
        .map(p => `${p.id}[${p.nodes}]`));

      if (problems.length) bad.push(`#${i} netlist: ${problems[0]} ${show}`);

      // One leg per hole. Electrically invisible — the round trip cannot catch
      // it, because five holes in a strip really are one node — and completely
      // unbuildable, which is how it survived the first version of this suite.
      const holes = new Set<string>();
      for (const p of l.parts) for (const h of p.holes) {
        const k = `${h.col}${h.row}`;
        if (holes.has(k)) bad.push(`#${i} two legs in hole ${k} ${show}`);
        holes.add(k);
      }
      for (const p of l.parts) {
        const strips = p.holes.map(stripOf);
        if (new Set(strips).size !== strips.length) bad.push(`#${i} ${p.id} shorts itself ${show}`);
        const cols = p.holes.filter(h => h.row !== '+' && h.row !== '-').map(h => h.col);
        if (cols.length === 2 && Math.abs(cols[0] - cols[1]) > 9) {
          bad.push(`#${i} ${p.id} spans ${Math.abs(cols[0] - cols[1])} columns ${show}`);
        }
        if (l.cols > 63) bad.push(`#${i} needs ${l.cols} columns`);
      }
      // Confirm the fixtures are not all trivially disjoint, or none of this
      // would be exercising the column-sharing path at all.
      if (l.jumpers.length || l.parts.some(p =>
        p.holes.some(h => h.row === '-' || h.row === '+'))) shared++;
    }
    expect(shared, 'fixtures were too trivial to exercise sharing').toBeGreaterThan(100);
    expect(bad.slice(0, 4).join('\n'), `${bad.length} problems in 300 circuits`).toBe('');
  });
});
