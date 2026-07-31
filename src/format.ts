// ============================================================================
//  SI value formatting and parsing
// ============================================================================
//  Pure string<->number helpers, shared by the schematic labels, the inspector
//  panel, the scope axes and the Bode gridlines. Kept in its own DOM-free
//  module so it can be verified in isolation like the engine is.
// ============================================================================

/** Engineering prefixes, largest first — the order the formatter scans them. */
const PREFIXES: [number, string][] = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
  [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
];

// Prefix multipliers accepted when parsing user input. CASE MATTERS for M:
// 'M' is mega and 'm' is milli, and the two are nine orders of magnitude apart.
// (Folding case here is what used to turn a 1 MΩ resistor into a 1 mΩ one on a
// round trip through the inspector, which shows fmt() and saves parseVal().)
// The other letters have no such collision, so both cases are accepted.
const MULTIPLIERS: Record<string, number> = {
  G: 1e9, g: 1e9,
  M: 1e6,
  k: 1e3, K: 1e3,
  '': 1,
  m: 1e-3,
  'µ': 1e-6, u: 1e-6, U: 1e-6,
  n: 1e-9, N: 1e-9,
  p: 1e-12, P: 1e-12,
};

// Format a number in engineering notation with an SI prefix: 4700 -> "4.70 kΩ".
// Three significant figures, trailing zeros trimmed, prefix chosen so the
// mantissa stays in [1, 1000).
export function fmt(v: number, unit: string): string {
  if (v === 0) return '0' + unit;
  const a = Math.abs(v);
  // 0.9995·m threshold so a value like 999.998m rounds up into the next unit
  // (shows "1 V" instead of "1.00e+3 mV") rather than overflowing its prefix.
  for (const [m, p] of PREFIXES) {
    if (a >= m * 0.9995) {
      let s = (v / m).toPrecision(3);
      // strip trailing zeros ONLY after a decimal point (so 690 stays 690)
      if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return s + ' ' + p + unit;
    }
  }
  return v.toExponential(2) + unit;
}

// Parse a user-typed value back to a number: "4.7k" -> 4700, "1µ" -> 1e-6.
// Unit letters are optional and ignored, so "4.7kΩ" and "4.7k" agree.
// Returns NaN when nothing numeric can be read.
export function parseVal(s: string | number): number {
  const cleaned = String(s).trim().replace(/[ΩVAFH]/gi, '');
  const m = cleaned.match(/^(-?[0-9.]+)\s*([a-zµ]?)/i);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  const p = m[2] || '';
  return v * (MULTIPLIERS[p] ?? 1);
}
