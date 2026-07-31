// AI assistant — 8 checks, all offline.
// The network call isn't tested here; what is tested is the boundary where
// model output becomes the user's schematic. Everything the assistant returns
// is untrusted input, and a malformed circuit that slips through would either
// throw deep inside the solver or silently simulate as disconnected junk.
import { describe, it, expect } from 'vitest';
import { normalizeCircuit, BUILD_CIRCUIT_TOOL, AI_PART_TYPES } from '../src/ai';

const ok = {
  parts: [
    { type: 'V', x: 4, y: 4, rot: 90, value: 5 },
    { type: 'GND', x: 4, y: 8, rot: 0, value: 0 },
    { type: 'R', x: 6, y: 4, rot: 0, value: 1000 },
  ],
  wires: [{ x1: 4, y1: 6, x2: 4, y2: 8 }],
  notes: 'A divider.',
};

describe('tool schema', () => {
  it('is strict, so arguments are guaranteed to match the shape', () => {
    expect(BUILD_CIRCUIT_TOOL.strict).toBe(true);
    expect(BUILD_CIRCUIT_TOOL.input_schema.additionalProperties).toBe(false);
    expect(BUILD_CIRCUIT_TOOL.input_schema.required).toContain('parts');
  });

  it('offers exactly the part types the editor can place', () => {
    const enumerated = BUILD_CIRCUIT_TOOL.input_schema.properties.parts.items.properties.type.enum;
    expect([...enumerated].sort()).toEqual([...AI_PART_TYPES].sort());
  });
});

describe('normalizeCircuit', () => {
  it('accepts a well-formed circuit and rounds coordinates to the grid', () => {
    const c = normalizeCircuit({ ...ok, parts: [...ok.parts, { type: 'C', x: 7.6, y: 4.2, rot: 90, value: 1e-6 }] });
    expect(c.parts).toHaveLength(4);
    expect(c.parts[3].x).toBe(8);
    expect(c.parts[3].y).toBe(4);
    expect(c.notes).toBe('A divider.');
  });

  it('rejects a circuit with no ground — it would have no 0 V reference', () => {
    const noGnd = { ...ok, parts: ok.parts.filter(p => p.type !== 'GND') };
    expect(() => normalizeCircuit(noGnd)).toThrow(/no ground/i);
  });

  it('rejects an unknown part type rather than letting it reach the solver', () => {
    const bad = { ...ok, parts: [...ok.parts, { type: 'FLUX_CAPACITOR', x: 1, y: 1, rot: 0, value: 1 }] };
    expect(() => normalizeCircuit(bad)).toThrow(/Unknown part type/);
  });

  it('rejects non-numeric coordinates', () => {
    const bad = { ...ok, parts: [...ok.parts, { type: 'R', x: NaN, y: 2, rot: 0, value: 1 }] };
    expect(() => normalizeCircuit(bad)).toThrow(/non-numeric/);
    const badWire = { ...ok, wires: [{ x1: 1, y1: 2, x2: Infinity, y2: 4 }] };
    expect(() => normalizeCircuit(badWire)).toThrow(/non-numeric/);
  });

  it('rejects empty or structurally wrong payloads', () => {
    expect(() => normalizeCircuit(null)).toThrow(/not a circuit/);
    expect(() => normalizeCircuit({ parts: [], wires: [] })).toThrow(/no parts/);
    expect(() => normalizeCircuit({ parts: 'nope', wires: [] })).toThrow(/not a circuit/);
  });

  it('tolerates a missing notes field without inventing content', () => {
    const { notes, ...noNotes } = ok;
    expect(normalizeCircuit(noNotes).notes).toBe('');
  });
});
