// KiCad netlist export.
//
// The whole point of this exporter being a pure function is that its output can
// be read and checked, rather than looked at on a screen. So these tests read
// it. They cover the three things that would quietly produce a wrong board:
// connectivity that does not match what was drawn, a part silently dropped, and
// a behavioural part exported as though it were a real chip.
import { describe, it, expect } from 'vitest';
import { toKicad, specOf, type ExportPart } from '../src/netlist';
import { fmt } from '../src/format';

const K = (parts: ExportPart[]) => toKicad(parts, fmt, '2026-01-01');

/** Every (ref, pin) on a given net name. */
function netOf(text: string, name: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l.includes(`(name "${name}")`));
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < lines.length && !lines[i].startsWith('    )'); i++) {
    const m = /\(ref "([^"]+)"\) \(pin "([^"]+)"\)/.exec(lines[i]);
    if (m) out.push(`${m[1]}.${m[2]}`);
  }
  return out;
}

// A divider: 5 V source -> R1 -> R2 -> ground, tapped in the middle.
const DIVIDER: ExportPart[] = [
  { id: 'V1', type: 'V', value: 5, nodes: [1, 0] },
  { id: 'R1', type: 'R', value: 4700, nodes: [1, 2] },
  { id: 'R2', type: 'R', value: 10000, nodes: [2, 0] },
  { id: 'GND1', type: 'GND', nodes: [0] },
];

describe('connectivity survives the trip', () => {
  it('puts the right pins on the right nets', () => {
    const { text } = K(DIVIDER);
    // The tap: R1's second pin meets R2's first, and nothing else.
    expect(netOf(text, 'N$2').sort()).toEqual(['R1.2', 'R2.1']);
    // Ground carries the supply's negative and R2's bottom.
    expect(netOf(text, 'GND').sort()).toEqual(['J1.-', 'R2.2']);
  });

  it('names node 0 GND, because every PCB tool knows that one', () => {
    expect(K(DIVIDER).text).toContain('(name "GND")');
  });

  it('carries values a BOM can read', () => {
    const { text } = K(DIVIDER);
    expect(text).toContain('(value "4.7 k")');
    expect(text).toContain('(value "10 k")');
  });

  it('keeps the Volta id, so a part can be found again on the schematic', () => {
    expect(K(DIVIDER).text).toContain('(field (name "Volta_Id") "R1")');
  });

  it('is deterministic — same circuit, same bytes', () => {
    expect(K(DIVIDER).text).toBe(K(DIVIDER).text);
  });
});

describe('the three tiers', () => {
  it('drops instruments and ground symbols, and says it did', () => {
    const { text, report } = K([
      ...DIVIDER,
      { id: 'VM1', type: 'VM', value: 1e8, nodes: [2, 0] },
    ]);
    expect(text).not.toContain('VM');
    expect(report.counts.dropped).toBe(2);        // the voltmeter and the GND symbol
    expect(report.warnings.join(' ')).toMatch(/instruments? or ground symbols? dropped/);
  });

  it('turns a bench supply into a 2-pin header, not a component', () => {
    const { text, report } = K(DIVIDER);
    expect(text).toContain('(ref "J1")');
    expect(text).toContain('PinHeader_1x02');
    expect(report.warnings.join(' ')).toMatch(/A supply is not a component/);
  });

  it('refuses to dress a behavioural part up as a chip', () => {
    const { text, report } = K([
      { id: 'AND1', type: 'AND', nodes: [1, 2, 3] },
      { id: 'GND1', type: 'GND', nodes: [0] },
    ]);
    // No footprint: a 74HC08 holds four gates and Volta was never told which.
    const comp = text.slice(text.indexOf('(ref "U1")'), text.indexOf('(nets'));
    expect(comp).not.toContain('footprint');
    expect(report.lines.find(l => l.ref === 'U1')?.note).toMatch(/74HC08/);
    // And the part of the board this cannot describe is stated, not implied.
    expect(report.warnings.join(' ')).toMatch(/no VCC or GND pin/);
    expect(report.warnings.join(' ')).toMatch(/decoupling/);
  });

  it('always warns that the footprints are guesses', () => {
    expect(K(DIVIDER).report.warnings.join(' ')).toMatch(/Check every one in KiCad/);
  });
});

describe('what the report catches', () => {
  it('flags a pin wired to nothing', () => {
    const { report } = K([
      { id: 'R1', type: 'R', value: 100, nodes: [1, 2] },
      { id: 'R2', type: 'R', value: 100, nodes: [1, 0] },
      { id: 'GND1', type: 'GND', nodes: [0] },
    ]);
    // R1's second pin goes nowhere. Cheaper to hear now than on a board.
    expect(report.warnings.join(' ')).toMatch(/only one pin \(R1\.2\)/);
  });

  it('says nothing about dangling pins when everything is connected', () => {
    expect(K(DIVIDER).report.warnings.join(' ')).not.toMatch(/only one pin/);
  });

  it('writes what belongs on a source header, not the word V', () => {
    expect(K(DIVIDER).text).toContain('(value "5 V")');
    const { text } = K([{ id: 'VS1', type: 'VS', amp: 5, freq: 1000, nodes: [1, 0] }]);
    expect(text).toContain('(value "5 V 1 kHz sine")');
  });
});

describe('reference designators', () => {
  it('uses the conventional prefix, not Volta\'s internal id', () => {
    // An LED is a diode: D, not LED. Volta calls it LED8.
    const { text } = K([{ id: 'LED8', type: 'LED', color: 'green', nodes: [1, 0] }]);
    expect(text).toContain('(ref "D1")');
    expect(text).toContain('(value "GREEN")');
  });

  it('numbers each prefix independently and in placement order', () => {
    const { text } = K([
      { id: 'R5', type: 'R', value: 100, nodes: [1, 2] },
      { id: 'C2', type: 'C', value: 1e-6, nodes: [2, 0] },
      { id: 'R9', type: 'R', value: 220, nodes: [2, 3] },
    ]);
    expect(text).toContain('(field (name "Volta_Id") "R5")');
    expect(/\(ref "R1"\)[\s\S]*\(ref "C1"\)[\s\S]*\(ref "R2"\)/.test(text)).toBe(true);
  });

  it('names transistor and polarised pins rather than numbering them', () => {
    const { text } = K([
      { id: 'QN1', type: 'QN', nodes: [1, 2, 0] },
      { id: 'CP1', type: 'CP', value: 1e-4, nodes: [1, 0] },
    ]);
    expect(netOf(text, 'GND').sort()).toEqual(['C1.-', 'Q1.E']);
  });
});

describe('specOf covers the whole palette', () => {
  it('has a real-part spec for the things that are real parts', () => {
    for (const t of ['R', 'C', 'L', 'D', 'LED', 'QN', 'POT', 'RLY', 'NE555']) {
      expect(specOf(t).tier, t).toBe('real');
    }
  });

  it('treats every digital function as behavioural', () => {
    for (const t of ['AND', 'NOT', 'DFF', 'CNT4', 'SEG7', 'ADC4', 'OA', 'MCU']) {
      expect(specOf(t).tier, t).toBe('behavioural');
      expect(specOf(t).fp, t).toBe('');
    }
  });

  it('exports an unknown part rather than losing it', () => {
    const s = specOf('WHAT');
    expect(s.tier).toBe('behavioural');
    expect(s.note).toMatch(/Unrecognised/);
  });
});
