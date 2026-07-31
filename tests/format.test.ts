// SI formatting / parsing — 10 checks.
// These guard the values the user actually sees and types: schematic labels,
// the inspector fields, the scope axes and the Bode gridlines all go through
// fmt(), and every edit the user makes comes back through parseVal().
import { describe, it, expect } from 'vitest';
import { fmt, parseVal } from '../src/format';

describe('fmt — engineering notation', () => {
  it('zero is special-cased (no prefix, and no space)', () => {
    expect(fmt(0, 'V')).toBe('0V');
  });

  it('picks the prefix that keeps the mantissa in [1, 1000)', () => {
    expect(fmt(1000, 'Ω')).toBe('1 kΩ');
    expect(fmt(4700, 'Ω')).toBe('4.7 kΩ');
    expect(fmt(1e6, 'Ω')).toBe('1 MΩ');
    expect(fmt(1e9, 'Ω')).toBe('1 GΩ');
  });

  it('handles sub-unit prefixes down to pico', () => {
    expect(fmt(1e-3, 'F')).toBe('1 mF');
    expect(fmt(1e-6, 'F')).toBe('1 µF');
    expect(fmt(2.2e-9, 'F')).toBe('2.2 nF');
    expect(fmt(1e-12, 'F')).toBe('1 pF');
  });

  it('shows three significant figures', () => {
    expect(fmt(4.09, 'V')).toBe('4.09 V');
    expect(fmt(0.0012345, 'A')).toBe('1.23 mA');
  });

  it('trims trailing zeros only after a decimal point, so 690 stays 690', () => {
    expect(fmt(690, 'Ω')).toBe('690 Ω');
    expect(fmt(1.5, 'V')).toBe('1.5 V');   // not "1.50 V"
  });

  it('rounds up into the next prefix instead of overflowing (the 0.9995 rule)', () => {
    // Without the threshold this reads "1.00e+3 mV" — a mantissa outside its prefix.
    expect(fmt(0.999998, 'V')).toBe('1 V');
  });

  it('keeps the sign of negative values', () => {
    expect(fmt(-2.5, 'V')).toBe('-2.5 V');
    expect(fmt(-4700, 'Ω')).toBe('-4.7 kΩ');
  });

  it('falls back to exponential below the smallest prefix', () => {
    expect(fmt(1e-15, 'A')).toBe('1.00e-15A');
  });
});

describe('parseVal — reading what the user types', () => {
  it('accepts prefixes, optional units, and stray spaces', () => {
    expect(parseVal('4.7k')).toBe(4700);
    expect(parseVal('470kΩ')).toBe(470000);
    expect(parseVal('2.2 k')).toBe(2200);
    expect(parseVal('1µ')).toBeCloseTo(1e-6, 12);
    expect(parseVal('5')).toBe(5);
    expect(parseVal('-3.3')).toBe(-3.3);
    expect(parseVal('nonsense')).toBeNaN();
  });

  it('round-trips every prefix fmt can emit — M is mega, m is milli', () => {
    // The inspector shows fmt(value) in its input and saves parseVal(input), so
    // any prefix fmt emits must parse back to the same number. Case-folding 'M'
    // to 'm' here silently turned 1 MΩ into 1 mΩ on every open-and-save.
    for (const v of [1e9, 1e6, 4700, 5, 1.5e-3, 2.2e-6, 47e-9, 1e-12]) {
      const round = parseVal(fmt(v, 'Ω'));
      expect(round).toBeCloseTo(v, Math.abs(v) < 1 ? 15 : 6);
    }
    expect(parseVal('1M')).toBe(1e6);      // mega
    expect(parseVal('1m')).toBe(1e-3);     // milli
  });
});
