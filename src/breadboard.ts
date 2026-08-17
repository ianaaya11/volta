// ============================================================================
//  BREADBOARD — the circuit you simulated, as something to build
// ============================================================================
//  A PCB is what you make when the design is finished. A breadboard is what you
//  make while you are still finding out, which is the part of the process this
//  app is actually for. It is also forgiving in the way Volta is forgiving: a
//  wrong jumper costs you a minute, not a box of scrap copper.
//
//  THE BOARD. Electrically a breadboard is almost nothing. Each column has ten
//  holes in two banks of five; the five in a bank are one node, the channel
//  down the middle keeps the banks apart — which is precisely what lets a DIP
//  chip straddle it with each leg in its own column — and two long rails run
//  the length for power and ground.
//
//      + + + + + + + + + + + + + + + +      <- rail, one node
//        A B C D E   |   F G H I J
//      1 o o o o o   |   o o o o o          <- column 1: two nodes, U1 and L1
//      2 o o o o o   |   o o o o o
//                  channel
//      - - - - - - - - - - - - - - - -      <- rail, one node
//
//  So a "layout" is just: which hole each pin goes in, plus the jumpers. And
//  because the board's own wiring rules are that simple, a layout can be READ
//  BACK — union the holes the board joins, union the holes the jumpers join,
//  and see which pins ended up sharing a node. If that partition is not exactly
//  the netlist you started from, the layout is wrong.
//
//  That round trip is the whole reason to trust this file. Placement is a pile
//  of heuristics and always will be; verification is not, and it does not care
//  how pretty the answer is. Every layout this module produces is checked
//  against the netlist it came from before it is ever drawn.
// ============================================================================
import type { ExportPart } from './netlist';
import { specOf } from './netlist';

/** Rows A–E are the upper bank, F–J the lower; '+' and '-' are the rails. */
export type Row = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | '+' | '-';
export const UPPER: Row[] = ['A', 'B', 'C', 'D', 'E'];
export const LOWER: Row[] = ['F', 'G', 'H', 'I', 'J'];

export interface Hole { col: number; row: Row }

/** Which electrical strip a hole belongs to. This function IS the breadboard —
 *  everything else in the file is placement and drawing. */
export function stripOf(h: Hole): string {
  if (h.row === '+') return 'R+';
  if (h.row === '-') return 'R-';
  return (UPPER as string[]).includes(h.row) ? `U${h.col}` : `L${h.col}`;
}

export interface PlacedPart {
  id: string;
  type: string;
  /** What to write on it: "R1  4.7k". */
  label: string;
  /** One hole per pin, in the part's own pin order. */
  holes: Hole[];
}
export interface Jumper { from: Hole; to: Hole }
/** A part that cannot go on a breadboard, and why — a motor, a meter, a chip
 *  Volta only models behaviourally. Said out loud rather than dropped. */
export interface OffBoard { id: string; type: string; why: string }

export interface Layout {
  cols: number;
  parts: PlacedPart[];
  jumpers: Jumper[];
  offBoard: OffBoard[];
  /** Which original net each rail carries, for labelling. */
  rails: { plus: number | null; minus: number };
}

// Board sizes, in columns. A half-size board is what most people own; the full
// one is reached for only when the circuit will not fit.
export const HALF = 30, FULL = 63;

// How many columns a two-terminal part may span. One would put both legs in the
// same node and short it out; too many and the leads will not reach.
const MIN_SPAN = 2, MAX_SPAN = 9, WANT_SPAN = 3;
// Legs allowed in one five-hole strip before spilling to a jumpered column.
const LEGS_PER_STRIP = 2;

/** Parts that exist on the bench, not on the board. */
function offBoardReason(type: string): string | null {
  const t = specOf(type).tier;
  if (t === 'dropped') return type === 'GND'
    ? '' // ground is a rail, not a part; silently absorbed
    : 'A meter. Clip it on where you want to measure.';
  if (t === 'bench') return 'Your bench supply or signal generator — run leads to the rails.';
  if (t === 'behavioural') {
    return 'Volta models this as behaviour, not as a chip. Breadboarding it needs '
      + 'a real part chosen first.';
  }
  if (type === 'MOT' || type === 'XF' || type === 'RLY' || type === 'LAMP') {
    return 'Too big for the board — wire it off-board with flying leads.';
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Reading a layout back off the board
// ---------------------------------------------------------------------------

/** Union-find over strips, so the board's own wiring can be followed. */
function joiner() {
  const up = new Map<string, string>();
  const find = (k: string): string => {
    if (!up.has(k)) up.set(k, k);
    while (up.get(k) !== k) { up.set(k, up.get(up.get(k)!)!); k = up.get(k)!; }
    return k;
  };
  return { find, union: (a: string, b: string) => { up.set(find(a), find(b)); } };
}

/**
 * Group every placed pin by the node the BOARD gives it.
 *
 * Deliberately ignorant of the netlist it came from: it follows copper (well,
 * spring clips) and nothing else. That independence is what makes comparing it
 * to the netlist meaningful.
 */
export function readBack(layout: Layout): Map<string, string[]> {
  const { find, union } = joiner();
  for (const j of layout.jumpers) union(stripOf(j.from), stripOf(j.to));
  const groups = new Map<string, string[]>();
  for (const p of layout.parts) {
    p.holes.forEach((h, i) => {
      const root = find(stripOf(h));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(`${p.id}.${i}`);
    });
  }
  return groups;
}

/**
 * The property this module lives or dies by: what the board joins must be
 * exactly what the netlist joined. Returns the disagreements, empty if none.
 */
export function verify(parts: ExportPart[], layout: Layout): string[] {
  const problems: string[] = [];
  const placed = new Set(layout.parts.map(p => p.id));

  // What the netlist says: pin -> node, for the pins that got placed.
  const wantOf = new Map<string, number>();
  for (const p of parts) {
    if (!placed.has(p.id)) continue;
    p.nodes.forEach((n, i) => wantOf.set(`${p.id}.${i}`, n));
  }

  // What the board says: pin -> board group.
  const gotOf = new Map<string, string>();
  for (const [root, pins] of readBack(layout)) for (const pin of pins) gotOf.set(pin, root);

  for (const pin of wantOf.keys()) {
    if (!gotOf.has(pin)) problems.push(`${pin} was never placed in a hole.`);
  }

  // Two pins share a node on the schematic if and only if they share one on the
  // board. Checking both directions catches the two ways a layout goes wrong:
  // a connection that was not made, and one that was made by accident.
  const pins = [...wantOf.keys()].filter(p => gotOf.has(p));
  for (let i = 0; i < pins.length; i++) {
    for (let k = i + 1; k < pins.length; k++) {
      const same = wantOf.get(pins[i]) === wantOf.get(pins[k]);
      const board = gotOf.get(pins[i]) === gotOf.get(pins[k]);
      if (same && !board) problems.push(`${pins[i]} and ${pins[k]} should be connected but are not.`);
      if (!same && board) problems.push(`${pins[i]} and ${pins[k]} are shorted together by the layout.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
//  Placement
// ---------------------------------------------------------------------------

/** The busiest non-ground net fed by a supply's positive pin, if there is one.
 *  Putting it on a rail is what a person would do, and it removes more jumpers
 *  than any other single decision. */
function pickPlusRail(parts: ExportPart[]): number | null {
  const supply = parts.find(p => specOf(p.type).tier === 'bench' && p.type !== 'I'
    && (p.type === 'V' || p.type === 'VS' || p.type === 'SQ'));
  const cand = supply?.nodes[0];
  return cand !== undefined && cand !== 0 ? cand : null;
}

/**
 * Lay the circuit out. Parts run left to right in the order they were drawn,
 * because that is the order the person who drew it was thinking in, and a
 * layout that reads like the schematic is one they can follow.
 *
 * The result is verified before it is returned. A layout that fails its own
 * check is a bug, and callers get told rather than shown something wrong.
 */
export function layout(parts: ExportPart[], opts: { cols?: number } = {}):
  { layout: Layout; problems: string[] } {

  const minus = 0;                                   // ground is always a rail
  const plus = pickPlusRail(parts);

  const offBoard: OffBoard[] = [];
  const board: ExportPart[] = [];
  for (const p of parts) {
    const why = offBoardReason(p.type);
    if (why === null) board.push(p);
    else if (why !== '') offBoard.push({ id: p.id, type: p.type, why });
  }

  // Schematic order: left to right, then top to bottom.
  const ordered = [...board].sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0));

  const railRow = (n: number): Row | null =>
    n === minus ? '-' : (plus !== null && n === plus) ? '+' : null;

  /** Columns already used by each net, so a second part can join the first
   *  without a jumper — which is the entire art of breadboarding. */
  const colsOfNet = new Map<number, number[]>();
  const placedParts: PlacedPart[] = [];
  const jumpers: Jumper[] = [];
  let next = 2;                                      // leave column 1 clear
  let railCol = 2;

  // One leg per hole. The five holes of a strip are one node, so WHICH hole a
  // leg takes is electrically cosmetic — but a layout that sends three legs to
  // hole 3A is one nobody can build, and the netlist round trip cannot see it,
  // because electrically it is perfectly correct.
  const taken = new Set<string>();
  // Which net owns each column, so spilling into a neighbour can never land on
  // somebody else's node. Shorting two nets is the one mistake that must be
  // impossible rather than merely caught.
  const ownerOf = new Map<number, number>();
  const mine = (net: number, c: number) => !ownerOf.has(c) || ownerOf.get(c) === net;

  const holeFor = (net: number, col: number, bank: Row[]): Hole => {
    const rr = railRow(net);
    if (rr) {
      // Skip holes already claimed — the alignment pass below moves rail legs
      // sideways, so the cursor cannot assume the column ahead of it is free.
      while (taken.has(`${railCol}${rr}`)) railCol++;
      const c = railCol++;
      taken.add(`${c}${rr}`);
      return { col: c, row: rr };
    }
    const list = colsOfNet.get(net) ?? [];
    colsOfNet.set(net, list);
    const free = (c: number) => bank.find(r => !taken.has(`${c}${r}`));
    const legs = (c: number) => bank.filter(r => taken.has(`${c}${r}`)).length;
    const take = (c: number, r: Row): Hole => {
      ownerOf.set(c, net);
      if (!list.includes(c)) list.push(c);
      if (c >= next) next = c + 1;
      taken.add(`${c}${r}`);
      return { col: c, row: r };
    };

    // Two legs per strip keeps a column readable; spilling one place either
    // side keeps the lead within reach. Drifting further to find space is how
    // an earlier version stretched a resistor across fourteen columns.
    for (const c of [col, col + 1, col - 1]) {
      if (c < 2 || !mine(net, c) || legs(c) >= LEGS_PER_STRIP) continue;
      const r = free(c); if (r) return take(c, r);
    }
    // No room nearby. A crowded strip beats a lead that cannot reach, so fill
    // the requested column properly before giving up on it.
    for (const c of [col, ...list]) {
      if (!mine(net, c)) continue;
      const r = free(c); if (r) return take(c, r);
    }
    return take(next, bank[0]);
  };

  for (const p of ordered) {
    const n = p.nodes.length;
    const holes: Hole[] = [];

    if (n === 2) {
      // Reuse a column this net already occupies if the span still works;
      // otherwise start a fresh one. This is where jumpers get avoided.
      const [a, b] = p.nodes;
      const aRail = railRow(a), bRail = railRow(b);
      let colA = aRail ? 0 : (colsOfNet.get(a)?.find(c => c >= next - MAX_SPAN) ?? next++);
      if (!aRail && colA >= next) next = colA + 1;
      let colB = bRail ? 0 : (colsOfNet.get(b)?.find(c => Math.abs(c - colA) >= MIN_SPAN
        && Math.abs(c - colA) <= MAX_SPAN - 2) ?? Math.max(next, colA + WANT_SPAN));
      if (!bRail && colB >= next) next = colB + 1;
      holes.push(holeFor(a, colA, UPPER), holeFor(b, colB, UPPER));
    } else {
      // Three or more pins: give each its own column, side by side, which is
      // how a TO-92 transistor or a trimmer actually sits in the board.
      const base = next;
      p.nodes.forEach((net, i) => holes.push(holeFor(net, base + i, UPPER)));
      next = base + n + 1;
    }
    // A rail leg belongs directly beneath the leg it pairs with, so the part
    // stands straight rather than leaning across its neighbours. Any column of
    // a rail is the same node, so this is free — it is purely how it reads.
    if (holes.length === 2) {
      const ri = holes.findIndex(h => h.row === '+' || h.row === '-');
      const other = ri === 0 ? holes[1] : holes[0];
      if (ri >= 0 && other && other.row !== '+' && other.row !== '-') {
        const want = other.col, row = holes[ri].row;
        if (!taken.has(`${want}${row}`)) {
          taken.delete(`${holes[ri].col}${row}`);
          taken.add(`${want}${row}`);
          holes[ri] = { col: want, row };
        }
      }
    }
    placedParts.push({
      id: p.id, type: p.type,
      label: `${p.id}${p.value !== undefined && p.value !== 0 ? '' : ''}`,
      holes,
    });
  }

  // Any net that ended up on more than one column needs those columns tied.
  for (const [, cols] of colsOfNet) {
    for (let i = 1; i < cols.length; i++) {
      jumpers.push({ from: { col: cols[i - 1], row: 'E' }, to: { col: cols[i], row: 'E' } });
    }
  }

  const used = Math.max(next, railCol);
  const lay: Layout = {
    cols: opts.cols ?? (used <= HALF ? HALF : FULL),
    parts: placedParts, jumpers, offBoard,
    rails: { plus, minus },
  };
  return { layout: lay, problems: verify(board, lay) };
}
