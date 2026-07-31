// ============================================================================
//  SPARK — a tiny SPICE-like circuit engine (Modified Nodal Analysis)
// ============================================================================
//  This module is the "physics" of the app. It knows nothing about drawing.
//  You hand it a netlist (a list of components and which nodes they connect),
//  and it solves for every node voltage and every branch current.
//
//  The core idea is MODIFIED NODAL ANALYSIS (MNA). Ordinary nodal analysis
//  writes Kirchhoff's Current Law (KCL) at every node: the sum of currents
//  leaving a node is zero. That gives you G * v = i, where G is built from
//  resistor conductances. But ideal voltage sources and inductors don't have
//  a "conductance" (an ideal source can push any current), so plain nodal
//  analysis can't express them. MNA fixes this by adding one EXTRA unknown
//  per voltage source / inductor: the current THROUGH it. The system becomes
//
//        [ G  B ] [ v ]   [ i ]
//        [ C  D ] [ j ] = [ e ]
//
//  v = node voltages, j = the extra branch currents, and we solve A x = z.
// ============================================================================

// ---- Netlist types ---------------------------------------------------------
// A node id is an integer; the special id 0 is GROUND (the reference node, it
// gets no equation). Every component is a member of the `Component` union
// below, discriminated on `type`, so narrowing on `c.type` gives you exactly
// the fields that device model needs and nothing else.
export type NodeId = number;

/** Two-terminal parts: nodes = [a, b]. */
export type Pair = [NodeId, NodeId];
/** Three-terminal parts: BJT [C,B,E], MOSFET [D,G,S], op-amp [out, in+, in−]. */
export type Triple = [NodeId, NodeId, NodeId];
/** Four-terminal parts: an output port and a controlling/secondary port. */
export type Quad = [NodeId, NodeId, NodeId, NodeId];

interface Part { id: string }

export interface Resistor extends Part { type: 'R'; nodes: Pair; value: number }        // ohms
export interface Capacitor extends Part { type: 'C'; nodes: Pair; value: number }       // farads
export interface Inductor extends Part { type: 'L'; nodes: Pair; value: number }        // henries
export interface CurrentSource extends Part { type: 'I'; nodes: Pair; value: number }   // amps
export interface DCSource extends Part { type: 'V'; nodes: Pair; value: number; wave?: 'DC' }
/** A time-varying source: sine, or square/pulse with an adjustable duty cycle. */
export interface WaveSource extends Part {
  type: 'VS'; nodes: Pair; wave: 'SIN' | 'SQR';
  value?: number; amp?: number; freq?: number; off?: number; phase?: number;
  /** Square wave only: fraction of each period spent high. Defaults to 0.5. */
  duty?: number;
}
export interface Diode extends Part { type: 'D'; nodes: Pair }
export interface Bjt extends Part { type: 'QN' | 'QP'; nodes: Triple; Is?: number; bf?: number; br?: number }
export interface Mosfet extends Part { type: 'MN' | 'MP'; nodes: Triple; vth?: number; k?: number; lam?: number }
export interface OpAmp extends Part { type: 'OA'; nodes: Triple; gain?: number }

/**
 * The four dependent sources, each with an output port and a controlling port:
 * nodes = [out+, out−, ctrl+, ctrl−].
 *
 * SPICE names another source to sense a controlling CURRENT. That's awkward in
 * a schematic editor, where you draw a symbol and wire to its pins, so F and H
 * instead carry their OWN ammeter: the controlling current is whatever flows
 * in at ctrl+ and out at ctrl−, across an internal 0 V short. You wire the
 * current you want to sense through those two pins.
 *
 * `value` is the gain, and its units are what distinguish the four:
 *   E — VCVS, V/V   G — VCCS, A/V   F — CCCS, A/A   H — CCVS, V/A
 */
export interface ControlledSource extends Part {
  type: 'E' | 'G' | 'F' | 'H';
  nodes: Quad;
  value: number;
}

/**
 * Two magnetically coupled windings — a transformer. `value` is the primary
 * inductance, `l2` the secondary, and `k` the coupling coefficient (1 is
 * perfect coupling, and the turns ratio is then √(L2/L1)). nodes = [p+, p−,
 * s+, s−], with the dots at p+ and s+.
 *
 * This is the one part here that genuinely needs a new stamp rather than a
 * combination of existing ones: mutual inductance couples two branch-current
 * unknowns to each other, which nothing else in the netlist does.
 */
export interface Transformer extends Part {
  type: 'XF';
  nodes: Quad;
  value: number;   // primary inductance, henries
  l2?: number;     // secondary inductance, henries (defaults to the primary)
  k?: number;      // coupling coefficient 0..1
}

/** Anything with an MNA branch-current unknown of its own. */
export type VoltageSource = DCSource | WaveSource;
export type Component =
  | Resistor | Capacitor | Inductor | CurrentSource
  | VoltageSource | Diode | Bjt | Mosfet | OpAmp
  | ControlledSource | Transformer;

/** A complex number, used by the AC (phasor) analysis. */
export interface Complex { re: number; im: number }

/** Per-terminal currents of a 3-terminal part (drain/gate/source map to Ic/Ib/Ie). */
export interface Terminals { Ic: number; Ib: number; Ie: number }

/** What one solved operating point looks like. Keyed by node id / component id. */
export interface Solution {
  nodeVoltage: Record<NodeId, number>;
  voltageAcross: Record<string, number>;
  current: Record<string, number>;
  terminals: Record<string, Terminals>;
}

/** A frequency sweep: phasors[i][nodeId] is that node's response at freqs[i]. */
export interface AcSweep {
  freqs: number[];
  phasors: Record<NodeId, Complex>[];
  stimulusId: string | undefined;
}

/** Backward-Euler history for one component: voltage across / current through. */
interface History { v: number; i: number }

// Suffixes for the extra unknowns some parts need. They are appended to the
// component id to key the branch index, the row labels and the reported
// currents, so a part with two branches stays addressable by name from
// outside — which is how the editor animates current through both of them.
const SENSE = ':sense';         // internal ammeter of a CCCS / CCVS
const SECONDARY = ':secondary'; // a transformer's second winding

/**
 * A record of one solved system, for the "show the math" mode. The solver
 * throws this away normally, so it is only captured when `captureTrace` is on.
 * `rowLabels[i]` names unknown i — `v2` for a node voltage, `i(V1)` for a
 * branch current — so the matrix can be displayed with meaningful axes.
 */
export interface SolveTrace {
  size: number;
  rowLabels: string[];
  /** The system actually solved: A·x = z, from the final Newton iteration. */
  A: number[][];
  z: number[];
  x: number[];
  /** Newton-Raphson iterations used; 1 for a linear circuit. */
  iterations: number;
  /** max |A·x − z| — how well the returned x satisfies the system. */
  residual: number;
  nonlinear: boolean;
  /** Timestep this system was built for; null for a DC solve. */
  h: number | null;
  t: number;
}

// ---- Linear solver: Gaussian elimination with partial pivoting -------------
// Solves A x = b for x. A is n-by-n (array of rows), b is length n.
// Partial pivoting (swapping in the largest pivot) keeps it numerically stable.
// ---- Junction voltage limiting (SPICE's pnjlim) ---------------------------
// Newton-Raphson on an exponential (a pn junction) overshoots wildly: one bad
// step sends v far up the exp() wall and the current explodes to nonsense.
// pnjlim caps how far a junction voltage may move in a single iteration,
// switching to a logarithmic step once past the critical voltage. This is the
// single trick that makes diodes and transistors converge reliably.
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(Math.max(vnew / vt, 1e-12));
    }
  }
  return vnew;
}

// ---- MOSFET square-law (SPICE level-1) drain current and its derivatives ---
// Given effective (on-state) gate-source / drain-source voltages, returns the
// drain current and the two small-signal conductances gm=dId/dVgs, gds=dId/dVds.
// Cutoff / triode / saturation regions; lambda gives finite output resistance.
export function mos1(vgs: number, vds: number, vth: number, k: number, lam: number): { Id: number; gm: number; gds: number } {
  const vov = vgs - vth;
  if (vov <= 0) return { Id: 0, gm: 0, gds: 0 };            // cutoff
  if (vds < vov) {                                          // triode
    return { Id: k * (vov * vds - 0.5 * vds * vds), gm: k * vds, gds: k * (vov - vds) };
  }
  return {                                                  // saturation
    Id: 0.5 * k * vov * vov * (1 + lam * vds),
    gm: k * vov * (1 + lam * vds),
    gds: 0.5 * k * vov * vov * lam,
  };
}

// Instantaneous value of an independent source at time t.
//   DC  : its constant value.
//   SIN : offset + amp·sin(2πf·t + phase).
//   SQR : offset ± amp, switching at the duty-cycle point of each period. The
//         phase is expressed in radians like the sine's, so the two sources
//         stay interchangeable; here it just shifts where in the cycle t=0
//         falls. Amplitude is peak (not peak-to-peak), so a 5 V square swings
//         between +5 and −5 and a unipolar 0/5 V pulse is off=2.5, amp=2.5.
export function srcVal(c: VoltageSource, t: number): number {
  if (c.wave === 'SIN') return (c.off || 0) + (c.amp || 0) * Math.sin(2 * Math.PI * (c.freq || 0) * (t || 0) + (c.phase || 0));
  if (c.wave === 'SQR') {
    const cycles = (c.freq || 0) * (t || 0) + (c.phase || 0) / (2 * Math.PI);
    let frac = cycles % 1;
    if (frac < 0) frac += 1;                       // keep t<0 well defined
    const duty = c.duty ?? 0.5;
    return (c.off || 0) + (c.amp || 0) * (frac < duty ? 1 : -1);
  }
  return c.value ?? 0;
}

// ---- Complex arithmetic + solver for AC (phasor) analysis ------------------
const cx = (re: number, im = 0): Complex => ({ re, im });
const cadd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const csub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
const cmul = (a: Complex, b: Complex): Complex => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cdiv = (a: Complex, b: Complex): Complex => { const d = b.re * b.re + b.im * b.im; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; };
const cmag = (a: Complex): number => Math.hypot(a.re, a.im);

// Complex Gauss-Jordan elimination with partial pivoting. A: N×N of {re,im},
// z: length-N of {re,im}. Returns the solution vector (complex).
export function csolve(A: Complex[][], z: Complex[]): Complex[] {
  const n = z.length;
  A = A.map((r) => r.slice()); z = z.slice();
  for (let col = 0; col < n; col++) {
    let piv = col, best = cmag(A[col][col]);
    for (let r = col + 1; r < n; r++) { const m = cmag(A[r][col]); if (m > best) { best = m; piv = r; } }
    if (piv !== col) { const t = A[col]; A[col] = A[piv]; A[piv] = t; const tz = z[col]; z[col] = z[piv]; z[piv] = tz; }
    const d = A[col][col];
    if (cmag(d) < 1e-20) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = cdiv(A[r][col], d);
      if (cmag(f) === 0) continue;
      for (let c = col; c < n; c++) A[r][c] = csub(A[r][c], cmul(f, A[col][c]));
      z[r] = csub(z[r], cmul(f, z[col]));
    }
  }
  const x: Complex[] = new Array(n);
  for (let i = 0; i < n; i++) { const d = A[i][i]; x[i] = cmag(d) < 1e-20 ? cx(0) : cdiv(z[i], d); }
  return x;
}

export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  // Work on copies so we don't clobber the caller's matrix.
  const M = A.map((row) => row.slice());
  const x = b.slice();

  for (let col = 0; col < n; col++) {
    // Find the row with the largest magnitude in this column (the pivot).
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) {
      // Singular / near-singular: the circuit is under-defined (e.g. a
      // floating node with no DC path to ground). Nudge to avoid divide-by-0.
      M[pivot][col] += 1e-12;
    }
    // Swap the pivot row into place.
    [M[col], M[pivot]] = [M[pivot], M[col]];
    [x[col], x[pivot]] = [x[pivot], x[col]];

    // Eliminate this column from all rows below.
    const pv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
      x[r] -= f * x[col];
    }
  }
  // Back-substitution: solve the now-triangular system bottom to top.
  for (let row = n - 1; row >= 0; row--) {
    let s = x[row];
    for (let c = row + 1; c < n; c++) s -= M[row][c] * x[c];
    x[row] = s / M[row][row];
  }
  return x;
}

// ---- The circuit ----------------------------------------------------------
// Hand it a netlist (see the `Component` union above) and it solves for every
// node voltage and every branch current. `value` carries resistance (Ω),
// voltage (V), current (A), capacitance (F) or inductance (H) depending on the
// part; semiconductors ignore it and use their model parameters instead.
export class Circuit {
  readonly components: Component[];
  /** Absolute simulation time (seconds), advanced by step(). */
  t: number;

  // Built by _index(): the MNA layout. Non-ground node -> matrix row, and one
  // extra row/column per element carrying a branch-current unknown.
  nodeIndex!: Map<NodeId, number>;
  branchIndex!: Map<string, number>;
  numNodes!: number;
  numBranches!: number;
  size!: number;
  /** Per-element transient history, keyed by component id. */
  state!: Map<string, History>;
  /** Human-readable name for each unknown, index-aligned with the matrix. */
  rowLabels!: string[];

  /** Turn on to record each solve into `lastTrace` (costs an O(n²) copy). */
  captureTrace = false;
  lastTrace: SolveTrace | null = null;

  constructor(components: Component[]) {
    this.components = components;
    this.t = 0; // absolute simulation time (seconds), advanced by step()
    this._index();
  }

  // Assign each non-ground node a matrix row. Assign each voltage source and
  // inductor an EXTRA row/column (its branch-current unknown).
  _index(): void {
    const nodeSet = new Set<NodeId>();
    for (const c of this.components) for (const nd of c.nodes) nodeSet.add(nd);
    nodeSet.delete(0); // ground is the reference; it has no equation.

    this.nodeIndex = new Map<NodeId, number>();
    let k = 0;
    for (const nd of nodeSet) this.nodeIndex.set(nd, k++);
    this.numNodes = k;

    // Branch unknowns for elements that carry a current variable.
    this.branchIndex = new Map<string, number>();
    let b = 0;
    for (const c of this.components) {
      // Elements whose branch current is itself an unknown: anything that
      // constrains a voltage rather than a current, plus the inductor.
      if (c.type === 'V' || c.type === 'VS' || c.type === 'L' || c.type === 'OA'
        || c.type === 'E' || c.type === 'H' || c.type === 'XF') this.branchIndex.set(c.id, this.numNodes + b++);
      // A second unknown for elements with two coupled branches: the internal
      // ammeter of a current-controlled source, and a transformer's secondary.
      if (c.type === 'F' || c.type === 'H') this.branchIndex.set(c.id + SENSE, this.numNodes + b++);
      if (c.type === 'XF') this.branchIndex.set(c.id + SECONDARY, this.numNodes + b++);
    }
    this.numBranches = b;
    this.size = this.numNodes + this.numBranches;

    // Per-element history for transient analysis (previous v / i). A
    // transformer integrates two currents, so it keeps two histories.
    this.state = new Map<string, History>();
    for (const c of this.components) {
      this.state.set(c.id, { v: 0, i: 0 });
      if (c.type === 'XF') this.state.set(c.id + SECONDARY, { v: 0, i: 0 });
    }

    // Name every unknown, so a displayed matrix has meaningful row/column axes.
    this.rowLabels = new Array<string>(this.size);
    for (const [nd, idx] of this.nodeIndex) this.rowLabels[idx] = `v${nd}`;
    for (const [id, idx] of this.branchIndex) this.rowLabels[idx] = `i(${id})`;
  }

  // Matrix row for a node. -1 means ground (or an unknown node): stamps skip it.
  _ni(nd: NodeId): number {
    if (nd === 0) return -1;
    const i = this.nodeIndex.get(nd);
    return i === undefined ? -1 : i;
  }

  // Stamp helpers: add a value into A or z, skipping ground (index -1).
  _stampG(A: number[][], a: number, b: number, g: number): void {
    if (a >= 0) A[a][a] += g;
    if (b >= 0) A[b][b] += g;
    if (a >= 0 && b >= 0) { A[a][b] -= g; A[b][a] -= g; }
  }
  _stampI(z: number[], a: number, b: number, cur: number): void {
    if (a >= 0) z[a] -= cur;
    if (b >= 0) z[b] += cur;
  }

  // Build and solve one operating point.
  //   opts.h    : timestep (seconds). If omitted -> pure DC (caps open, L short).
  //   opts.vguess: node-voltage guess for Newton-Raphson (nonlinear elements).
  _buildAndSolve(h: number | null, vguess: number[] | null, t: number): number[] {
    const N = this.size;
    // Newton-Raphson loop for nonlinear elements (diodes, transistors). For a
    // linear circuit this runs exactly once because nothing changes per pass.
    let x: number[] = new Array(N).fill(0);
    const nodeV = (idx: number) => (idx < 0 ? 0 : (vguess ? vguess[idx] || 0 : x[idx] || 0));
    const nonlinear = this.components.some((c) => c.type === 'D' || c.type === 'QN' || c.type === 'QP' || c.type === 'MN' || c.type === 'MP');
    // Per-transistor memory of last iteration's junction voltages, for pnjlim.
    const bjtLim = new Map<string, { vbe: number; vbc: number }>();
    for (const c of this.components) if (c.type === 'QN' || c.type === 'QP') bjtLim.set(c.id, { vbe: 0, vbc: 0 });

    let lastA: number[][] = [], lastZ: number[] = [], iterations = 0;
    for (let iter = 0; iter < 100; iter++) {
      iterations = iter + 1;
      const A: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
      const z: number[] = new Array<number>(N).fill(0);
      lastA = A; lastZ = z;

      for (const c of this.components) {
        const a = this._ni(c.nodes[0]);
        const b = this._ni(c.nodes[1]);
        const st = this.state.get(c.id)!;

        if (c.type === 'R') {
          this._stampG(A, a, b, 1 / c.value);

        } else if (c.type === 'I') {
          // Independent current source: pushes value amps from node0 -> node1.
          this._stampI(z, a, b, c.value);

        } else if (c.type === 'V' || c.type === 'VS') {
          // Voltage source (DC or sine): extra branch current unknown 'br'.
          const br = this.branchIndex.get(c.id)!;
          if (a >= 0) { A[a][br] += 1; A[br][a] += 1; }
          if (b >= 0) { A[b][br] -= 1; A[br][b] -= 1; }
          z[br] += srcVal(c, t); // v(a) - v(b) = source value at time t
        } else if (c.type === 'C') {
          // Capacitor. DC: open circuit (skip). Transient (backward Euler):
          //   i = C/h * (v - v_prev)  =>  conductance C/h + current source.
          if (h) {
            const g = c.value / h;
            this._stampG(A, a, b, g);
            // history current source injects g * v_prev
            this._stampI(z, a, b, -g * st.v);
          } else {
            this._stampG(A, a, b, 1e-12); // tiny leak keeps node defined at DC
          }
        } else if (c.type === 'L') {
          // Inductor. Uses a branch current unknown 'br'.
          const br = this.branchIndex.get(c.id)!;
          if (a >= 0) { A[a][br] += 1; A[br][a] += 1; }
          if (b >= 0) { A[b][br] -= 1; A[br][b] -= 1; }
          if (h) {
            // v = L/h (i - i_prev)  =>  v_a - v_b - (L/h) i = -(L/h) i_prev
            A[br][br] -= c.value / h;
            z[br] += -(c.value / h) * st.i;
          } else {
            A[br][br] -= 1e-9; // DC: short circuit (branch eq: v_a - v_b = 0)
          }
        } else if (c.type === 'D') {
          // Diode, Shockley model: i = Is (exp(v/(n Vt)) - 1).
          // Newton-Raphson linearization around the present guess vk:
          //   Geq = dI/dV = (Is/(nVt)) exp(vk/(nVt))
          //   Ieq = i(vk) - Geq * vk       (the equivalent current source)
          const Is = 1e-14, Vt = 0.025852, nEm = 1.0;
          let vk = nodeV(a) - nodeV(b);
          vk = Math.max(-5, Math.min(vk, 0.8)); // clamp to help convergence
          const ex = Math.exp(vk / (nEm * Vt));
          const id = Is * (ex - 1);
          const Geq = (Is / (nEm * Vt)) * ex;
          const Ieq = id - Geq * vk;
          this._stampG(A, a, b, Geq);
          this._stampI(z, a, b, Ieq);

        } else if (c.type === 'QN' || c.type === 'QP') {
          // Bipolar junction transistor, Ebers-Moll (transport) DC model.
          // Terminals order: nodes = [collector, base, emitter].
          // For a PNP we flip the sign of every junction voltage and current,
          // which is exactly a polarity mirror of the NPN equations.
          const s = (c.type === 'QN') ? 1 : -1;
          const Is = c.Is || 1e-15, Vt = 0.025852;
          const bf = c.bf || 100, br = c.br || 1;
          const nc = this._ni(c.nodes[0]), nb = this._ni(c.nodes[1]), ne = this._ni(c.nodes[2]);
          const vcrit = Vt * Math.log(Vt / (Math.SQRT2 * Is));
          // junction voltages (sign-flipped for PNP), then voltage-limited so
          // Newton-Raphson can't jump up the exponential and diverge.
          const lim = bjtLim.get(c.id)!;
          let vbe = pnjlim(s * (nodeV(nb) - nodeV(ne)), lim.vbe, Vt, vcrit);
          let vbc = pnjlim(s * (nodeV(nb) - nodeV(nc)), lim.vbc, Vt, vcrit);
          lim.vbe = vbe; lim.vbc = vbc;
          const f1 = Math.exp(vbe / Vt), f2 = Math.exp(vbc / Vt);
          // terminal currents flowing INTO collector / base (transport form)
          const Ic = Is * (f1 - f2) - (Is / br) * (f2 - 1);
          const Ib = (Is / bf) * (f1 - 1) + (Is / br) * (f2 - 1);
          // partials wrt junction voltages
          const dIc_dvbe = (Is / Vt) * f1;
          const dIc_dvbc = -(Is / Vt) * f2 * (1 + 1 / br);
          const dIb_dvbe = (Is / (bf * Vt)) * f1;
          const dIb_dvbc = (Is / (br * Vt)) * f2;
          // chain rule to node voltages (vbe=vb-ve, vbc=vb-vc), terminals [C,B,E]
          // row = terminal current, col = node it differentiates against
          const gCC = dIc_dvbc * (-1);
          const gCB = dIc_dvbe + dIc_dvbc;
          const gCE = dIc_dvbe * (-1);
          const gBC = dIb_dvbc * (-1);
          const gBB = dIb_dvbe + dIb_dvbc;
          const gBE = dIb_dvbe * (-1);
          // emitter row = -(collector + base) by KCL
          const gEC = -(gCC + gBC), gEB = -(gCB + gBB), gEE = -(gCE + gBE);
          const IcT = s * Ic, IbT = s * Ib, IeT = -(IcT + IbT); // device-frame currents
          const nodes = [nc, nb, ne];
          const J = [[gCC, gCB, gCE], [gBC, gBB, gBE], [gEC, gEB, gEE]];
          const Iterm = [IcT, IbT, IeT];
          // Reconstruct a node-voltage triple CONSISTENT with the limited
          // junction voltages (keep emitter fixed, derive base and collector).
          const veStar = nodeV(ne);
          const vbStar = veStar + s * vbe;
          const vcStar = vbStar - s * vbc;
          const vg = [vcStar, vbStar, veStar];
          // Newton companion stamp: A[p][q] += dIp/dVq ; z[p] -= (Ip - Σ J·V)
          for (let p = 0; p < 3; p++) {
            if (nodes[p] < 0) continue;
            let ieq = Iterm[p];
            for (let q = 0; q < 3; q++) {
              if (nodes[q] >= 0) A[nodes[p]][nodes[q]] += J[p][q];
              ieq -= J[p][q] * vg[q];
            }
            z[nodes[p]] -= ieq;
          }

        } else if (c.type === 'MN' || c.type === 'MP') {
          // MOSFET, square-law model. nodes = [drain, gate, source].
          // PNP-style polarity mirror via s handles PMOS with the same math.
          const s = (c.type === 'MN') ? 1 : -1;
          const vth = c.vth ?? 1, k = c.k ?? 0.002, lam = c.lam ?? 0;
          const nd = this._ni(c.nodes[0]), ng = this._ni(c.nodes[1]), ns = this._ni(c.nodes[2]);
          const Vd = nodeV(nd), Vg = nodeV(ng), Vs = nodeV(ns);
          const vgs = s * (Vg - Vs), vds = s * (Vd - Vs);
          const { Id, gm, gds } = mos1(vgs, vds, Math.abs(vth), k, lam);
          // real-frame terminal currents (gate draws no DC current)
          const IdT = s * Id, IsT = -IdT;
          // Jacobian rows [D,G,S] × cols [D,G,S]; s² cancels so same as NMOS form
          const J = [
            [gds, gm, -(gm + gds)],
            [0, 0, 0],
            [-gds, -gm, gm + gds],
          ];
          const nodes = [nd, ng, ns], Iterm = [IdT, 0, IsT], vg = [Vd, Vg, Vs];
          for (let p = 0; p < 3; p++) {
            if (nodes[p] < 0) continue;
            let ieq = Iterm[p];
            for (let q = 0; q < 3; q++) {
              if (nodes[q] >= 0) A[nodes[p]][nodes[q]] += J[p][q];
              ieq -= J[p][q] * vg[q];
            }
            z[nodes[p]] -= ieq;
          }

        } else if (c.type === 'OA') {
          // Ideal op-amp: output = gain·(V+ − V−), output referenced to ground.
          // Modeled as a VCVS with its own branch current (linear stamp).
          const gain = c.gain ?? 1e6;
          const nout = this._ni(c.nodes[0]), np = this._ni(c.nodes[1]), nm = this._ni(c.nodes[2]);
          const br = this.branchIndex.get(c.id)!;
          if (nout >= 0) { A[nout][br] += 1; A[br][nout] += 1; } // KCL + Vout term
          if (np >= 0) A[br][np] -= gain;                        // −gain·V+
          if (nm >= 0) A[br][nm] += gain;                        // +gain·V−

        } else if (c.type === 'E' || c.type === 'G' || c.type === 'F' || c.type === 'H') {
          // Dependent sources. All four are linear, so they stamp once and
          // never take part in the Newton loop.
          const op = this._ni(c.nodes[0]), on = this._ni(c.nodes[1]);
          const cp = this._ni(c.nodes[2]), cn = this._ni(c.nodes[3]);
          const k = c.value;
          // Voltage-controlled pair: the controlling port draws no current, so
          // it appears only in the output equation.
          if (c.type === 'G') {
            // Output current k·(v_cp − v_cn) leaves out+ and enters out−.
            if (op >= 0 && cp >= 0) A[op][cp] += k;
            if (op >= 0 && cn >= 0) A[op][cn] -= k;
            if (on >= 0 && cp >= 0) A[on][cp] -= k;
            if (on >= 0 && cn >= 0) A[on][cn] += k;
          } else if (c.type === 'E') {
            // v_op − v_on = k·(v_cp − v_cn), through a branch current unknown.
            const br = this.branchIndex.get(c.id)!;
            if (op >= 0) { A[op][br] += 1; A[br][op] += 1; }
            if (on >= 0) { A[on][br] -= 1; A[br][on] -= 1; }
            if (cp >= 0) A[br][cp] -= k;
            if (cn >= 0) A[br][cn] += k;
          } else {
            // Current-controlled pair. The controlling port is a 0 V short
            // whose current is the extra unknown: v_cp − v_cn = 0.
            const bs = this.branchIndex.get(c.id + SENSE)!;
            if (cp >= 0) { A[cp][bs] += 1; A[bs][cp] += 1; }
            if (cn >= 0) { A[cn][bs] -= 1; A[bs][cn] -= 1; }
            if (c.type === 'F') {
              // Output current k·i_sense leaves out+ and enters out−.
              if (op >= 0) A[op][bs] += k;
              if (on >= 0) A[on][bs] -= k;
            } else {
              // v_op − v_on = k·i_sense.
              const br = this.branchIndex.get(c.id)!;
              if (op >= 0) { A[op][br] += 1; A[br][op] += 1; }
              if (on >= 0) { A[on][br] -= 1; A[br][on] -= 1; }
              A[br][bs] -= k;
            }
          }

        } else if (c.type === 'XF') {
          // Coupled inductors. Each winding gets the ordinary inductor stamp,
          // plus an off-diagonal M/h term tying it to the OTHER winding's
          // current — which is the whole of what makes it a transformer.
          const p = this.branchIndex.get(c.id)!, s2 = this.branchIndex.get(c.id + SECONDARY)!;
          const pp = this._ni(c.nodes[0]), pn = this._ni(c.nodes[1]);
          const sp = this._ni(c.nodes[2]), sn = this._ni(c.nodes[3]);
          if (pp >= 0) { A[pp][p] += 1; A[p][pp] += 1; }
          if (pn >= 0) { A[pn][p] -= 1; A[p][pn] -= 1; }
          if (sp >= 0) { A[sp][s2] += 1; A[s2][sp] += 1; }
          if (sn >= 0) { A[sn][s2] -= 1; A[s2][sn] -= 1; }
          if (h) {
            const L1 = c.value, L2 = c.l2 ?? c.value;
            const M = (c.k ?? 0.99) * Math.sqrt(Math.max(0, L1 * L2));
            const i1p = st.i, i2p = this.state.get(c.id + SECONDARY)!.i;
            // v1 = (L1·di1 + M·di2)/h  and  v2 = (M·di1 + L2·di2)/h
            A[p][p] -= L1 / h; A[p][s2] -= M / h;
            A[s2][p] -= M / h; A[s2][s2] -= L2 / h;
            z[p] += -(L1 / h) * i1p - (M / h) * i2p;
            z[s2] += -(M / h) * i1p - (L2 / h) * i2p;
          } else {
            A[p][p] -= 1e-9; A[s2][s2] -= 1e-9;  // DC: both windings are shorts
          }
        }
      }

      const xNew = solve(A, z);

      // Convergence check for the Newton-Raphson loop.
      let maxd = 0;
      for (let i = 0; i < N; i++) maxd = Math.max(maxd, Math.abs(xNew[i] - x[i]));
      x = xNew;
      if (!nonlinear || maxd < 1e-9) break;
    }

    if (this.captureTrace) {
      // Residual of the system actually solved: how well x satisfies A·x = z.
      let residual = 0;
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let j = 0; j < N; j++) s += lastA[i][j] * x[j];
        residual = Math.max(residual, Math.abs(s - lastZ[i]));
      }
      this.lastTrace = {
        size: N,
        rowLabels: this.rowLabels.slice(),
        A: lastA.map((r) => r.slice()),
        z: lastZ.slice(),
        x: x.slice(),
        iterations,
        residual,
        nonlinear,
        h,
        t,
      };
    }
    return x;
  }

  // Public: solve the DC operating point (t -> infinity, no time stepping).
  dc(): Solution {
    const x = this._buildAndSolve(null, null, 0);
    return this._unpack(x, null);
  }

  // Public: advance the simulation by one timestep h (seconds).
  step(h: number): Solution {
    this.t += h;
    const x = this._buildAndSolve(h, null, this.t);
    const res = this._unpack(x, h);
    // Save history (v across / i through) for the next backward-Euler step.
    for (const c of this.components) {
      const st = this.state.get(c.id)!;
      st.v = res.voltageAcross[c.id];
      st.i = res.current[c.id];
      if (c.type === 'XF') {
        const s2 = this.state.get(c.id + SECONDARY)!;
        s2.v = res.voltageAcross[c.id + SECONDARY];
        s2.i = res.current[c.id + SECONDARY];
      }
    }
    return res;
  }

  // AC small-signal analysis. Sweeps a log-spaced frequency band and solves the
  // complex system (G + jωC)·v = i at each point, linearizing any nonlinear
  // device around the DC operating point. The stimulus source is driven with a
  // unit phasor (1∠0), so each node's phasor IS the transfer function to it.
  // Returns { freqs:[Hz], phasors:[ {nodeId:{re,im}} per freq ], stimulusId }.
  ac(fStart: number, fStop: number, points: number, stimulusId?: string): AcSweep {
    const Vdc = this.dc().nodeVoltage; // operating point for linearization
    if (!stimulusId) { const s = this.components.find((c) => c.type === 'V' || c.type === 'VS'); stimulusId = s && s.id; }
    const N = this.size, Vt = 0.025852;
    const stampY = (A: Complex[][], a: number, b: number, Y: Complex) => {
      if (a >= 0) A[a][a] = cadd(A[a][a], Y);
      if (b >= 0) A[b][b] = cadd(A[b][b], Y);
      if (a >= 0 && b >= 0) { A[a][b] = csub(A[a][b], Y); A[b][a] = csub(A[b][a], Y); }
    };
    const branch = (A: Complex[][], a: number, b: number, br: number) => { // voltage-source style branch coupling
      if (a >= 0) { A[a][br] = cadd(A[a][br], cx(1)); A[br][a] = cadd(A[br][a], cx(1)); }
      if (b >= 0) { A[b][br] = csub(A[b][br], cx(1)); A[br][b] = csub(A[br][b], cx(1)); }
    };
    const gReal = (A: Complex[][], p: number, q: number, g: number) => { if (p >= 0 && q >= 0) A[p][q] = cadd(A[p][q], cx(g)); };
    const freqs: number[] = [], phasors: Record<NodeId, Complex>[] = [];
    for (let i = 0; i < points; i++) {
      const f = fStart * Math.pow(fStop / fStart, points > 1 ? i / (points - 1) : 0);
      const w = 2 * Math.PI * f;
      const A: Complex[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => cx(0)));
      const z: Complex[] = Array.from({ length: N }, () => cx(0));
      for (const c of this.components) {
        const a = this._ni(c.nodes[0]), b = this._ni(c.nodes[1]);
        if (c.type === 'R') stampY(A, a, b, cx(1 / c.value));
        else if (c.type === 'C') stampY(A, a, b, cx(0, w * c.value));
        else if (c.type === 'I') { if (a >= 0) z[a] = csub(z[a], cx(c.value)); if (b >= 0) z[b] = cadd(z[b], cx(c.value)); }
        else if (c.type === 'V' || c.type === 'VS') { const br = this.branchIndex.get(c.id)!; branch(A, a, b, br); z[br] = cx(c.id === stimulusId ? 1 : 0); }
        else if (c.type === 'L') { const br = this.branchIndex.get(c.id)!; branch(A, a, b, br); A[br][br] = csub(A[br][br], cx(0, w * c.value)); }
        else if (c.type === 'OA') {
          const gain = c.gain ?? 1e6; const nout = this._ni(c.nodes[0]), np = this._ni(c.nodes[1]), nm = this._ni(c.nodes[2]);
          const br = this.branchIndex.get(c.id)!;
          if (nout >= 0) { A[nout][br] = cadd(A[nout][br], cx(1)); A[br][nout] = cadd(A[br][nout], cx(1)); }
          if (np >= 0) A[br][np] = csub(A[br][np], cx(gain));
          if (nm >= 0) A[br][nm] = cadd(A[br][nm], cx(gain));
        } else if (c.type === 'D') {
          const vd = Math.max(-5, Math.min((Vdc[c.nodes[0]] ?? 0) - (Vdc[c.nodes[1]] ?? 0), 0.8));
          stampY(A, a, b, cx((1e-14 / Vt) * Math.exp(vd / Vt) + 1e-12));
        } else if (c.type === 'QN' || c.type === 'QP') {
          const s = (c.type === 'QN') ? 1 : -1; const Is = c.Is || 1e-15, bf = c.bf || 100, br2 = c.br || 1;
          const nc = this._ni(c.nodes[0]), nb = this._ni(c.nodes[1]), ne = this._ni(c.nodes[2]);
          const vbe = Math.min(s * ((Vdc[c.nodes[1]] ?? 0) - (Vdc[c.nodes[2]] ?? 0)), 0.9);
          const vbc = Math.min(s * ((Vdc[c.nodes[1]] ?? 0) - (Vdc[c.nodes[0]] ?? 0)), 0.9);
          const f1 = Math.exp(vbe / Vt), f2 = Math.exp(vbc / Vt);
          const dIc_dvbe = (Is / Vt) * f1, dIc_dvbc = -(Is / Vt) * f2 * (1 + 1 / br2);
          const dIb_dvbe = (Is / (bf * Vt)) * f1, dIb_dvbc = (Is / (br2 * Vt)) * f2;
          const J = [[-dIc_dvbc, dIc_dvbe + dIc_dvbc, -dIc_dvbe], [-dIb_dvbc, dIb_dvbe + dIb_dvbc, -dIb_dvbe], [0, 0, 0]];
          J[2] = [-(J[0][0] + J[1][0]), -(J[0][1] + J[1][1]), -(J[0][2] + J[1][2])];
          const nodes = [nc, nb, ne];
          for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) gReal(A, nodes[p], nodes[q], J[p][q]);
        } else if (c.type === 'MN' || c.type === 'MP') {
          const s = (c.type === 'MN') ? 1 : -1; const vth = c.vth ?? 1, k = c.k ?? 0.002, lam = c.lam ?? 0;
          const nd = this._ni(c.nodes[0]), ng = this._ni(c.nodes[1]), nsrc = this._ni(c.nodes[2]);
          const { gm, gds } = mos1(s * ((Vdc[c.nodes[1]] ?? 0) - (Vdc[c.nodes[2]] ?? 0)), s * ((Vdc[c.nodes[0]] ?? 0) - (Vdc[c.nodes[2]] ?? 0)), Math.abs(vth), k, lam);
          const J = [[gds, gm, -(gm + gds)], [0, 0, 0], [-gds, -gm, gm + gds]];
          const nodes = [nd, ng, nsrc];
          for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) gReal(A, nodes[p], nodes[q], J[p][q]);
        } else if (c.type === 'E' || c.type === 'G' || c.type === 'F' || c.type === 'H') {
          // Same stamps as the transient path — these sources are linear, so
          // the small-signal model and the large-signal one are identical.
          const op = this._ni(c.nodes[0]), on = this._ni(c.nodes[1]);
          const cp = this._ni(c.nodes[2]), cn = this._ni(c.nodes[3]);
          const k = c.value;
          if (c.type === 'G') {
            gReal(A, op, cp, k); gReal(A, op, cn, -k);
            gReal(A, on, cp, -k); gReal(A, on, cn, k);
          } else if (c.type === 'E') {
            const br = this.branchIndex.get(c.id)!;
            branch(A, op, on, br);
            if (cp >= 0) A[br][cp] = csub(A[br][cp], cx(k));
            if (cn >= 0) A[br][cn] = cadd(A[br][cn], cx(k));
          } else {
            const bs = this.branchIndex.get(c.id + SENSE)!;
            branch(A, cp, cn, bs);
            if (c.type === 'F') {
              if (op >= 0) A[op][bs] = cadd(A[op][bs], cx(k));
              if (on >= 0) A[on][bs] = csub(A[on][bs], cx(k));
            } else {
              const br = this.branchIndex.get(c.id)!;
              branch(A, op, on, br);
              A[br][bs] = csub(A[br][bs], cx(k));
            }
          }
        } else if (c.type === 'XF') {
          // jωL on each winding's own branch, jωM across the pair.
          const p = this.branchIndex.get(c.id)!, s2 = this.branchIndex.get(c.id + SECONDARY)!;
          const L1 = c.value, L2 = c.l2 ?? c.value;
          const M = (c.k ?? 0.99) * Math.sqrt(Math.max(0, L1 * L2));
          branch(A, this._ni(c.nodes[0]), this._ni(c.nodes[1]), p);
          branch(A, this._ni(c.nodes[2]), this._ni(c.nodes[3]), s2);
          A[p][p] = csub(A[p][p], cx(0, w * L1));
          A[p][s2] = csub(A[p][s2], cx(0, w * M));
          A[s2][p] = csub(A[s2][p], cx(0, w * M));
          A[s2][s2] = csub(A[s2][s2], cx(0, w * L2));
        }
      }
      const x = csolve(A, z);
      const ph: Record<NodeId, Complex> = { 0: cx(0) };
      for (const [nd, idx] of this.nodeIndex) ph[nd] = x[idx];
      freqs.push(f); phasors.push(ph);
    }
    return { freqs, phasors, stimulusId };
  }

  // Turn the raw solution vector into friendly per-node / per-component values.
  _unpack(x: number[], h: number | null): Solution {
    const nodeVoltage: Record<NodeId, number> = { 0: 0 };
    for (const [nd, idx] of this.nodeIndex) nodeVoltage[nd] = x[idx];

    const voltageAcross: Record<string, number> = {};
    const current: Record<string, number> = {};
    const terminals: Record<string, Terminals> = {}; // for 3-terminal parts: {Ic, Ib, Ie}
    for (const c of this.components) {
      const va = nodeVoltage[c.nodes[0]] ?? 0;
      const vb = nodeVoltage[c.nodes[1]] ?? 0;
      const dv = va - vb;
      voltageAcross[c.id] = dv;
      const st = this.state.get(c.id)!;
      if (c.type === 'R') current[c.id] = dv / c.value;
      else if (c.type === 'I') current[c.id] = c.value;
      else if (c.type === 'V' || c.type === 'VS' || c.type === 'L') current[c.id] = x[this.branchIndex.get(c.id)!];
      else if (c.type === 'OA') {
        const iout = x[this.branchIndex.get(c.id)!];
        current[c.id] = iout; voltageAcross[c.id] = nodeVoltage[c.nodes[0]] ?? 0;
        terminals[c.id] = { Ic: iout, Ib: 0, Ie: 0 }; // only the output carries current
      }
      else if (c.type === 'C') current[c.id] = h ? (c.value / h) * (dv - st.v) : 0;
      else if (c.type === 'D') {
        const Is = 1e-14, Vt = 0.025852;
        current[c.id] = Is * (Math.exp(Math.max(-5, Math.min(dv, 0.8)) / Vt) - 1);
      } else if (c.type === 'QN' || c.type === 'QP') {
        const s = (c.type === 'QN') ? 1 : -1;
        const Is = c.Is || 1e-15, Vt = 0.025852, bf = c.bf || 100, br = c.br || 1;
        const vc = nodeVoltage[c.nodes[0]] ?? 0, vbb = nodeVoltage[c.nodes[1]] ?? 0, ve = nodeVoltage[c.nodes[2]] ?? 0;
        let vbe = Math.min(s * (vbb - ve), 0.9), vbc = Math.min(s * (vbb - vc), 0.9);
        const f1 = Math.exp(vbe / Vt), f2 = Math.exp(vbc / Vt);
        const Ic = Is * (f1 - f2) - (Is / br) * (f2 - 1);
        const Ib = (Is / bf) * (f1 - 1) + (Is / br) * (f2 - 1);
        current[c.id] = s * Ic; // report collector current as the headline
        voltageAcross[c.id] = vc - ve; // Vce
        terminals[c.id] = { Ic: s * Ic, Ib: s * Ib, Ie: -(s * Ic + s * Ib) };
      } else if (c.type === 'MN' || c.type === 'MP') {
        const s = (c.type === 'MN') ? 1 : -1;
        const vth = c.vth ?? 1, k = c.k ?? 0.002, lam = c.lam ?? 0;
        const vd = nodeVoltage[c.nodes[0]] ?? 0, vg = nodeVoltage[c.nodes[1]] ?? 0, vs = nodeVoltage[c.nodes[2]] ?? 0;
        const { Id } = mos1(s * (vg - vs), s * (vd - vs), Math.abs(vth), k, lam);
        current[c.id] = s * Id;
        voltageAcross[c.id] = vd - vs; // Vds
        terminals[c.id] = { Ic: s * Id, Ib: 0, Ie: -s * Id }; // drain/gate/source mapped to Ic/Ib/Ie
      } else if (c.type === 'E' || c.type === 'H') {
        current[c.id] = x[this.branchIndex.get(c.id)!];
      } else if (c.type === 'G') {
        // No branch unknown: the output current IS the controlling expression.
        current[c.id] = c.value * ((nodeVoltage[c.nodes[2]] ?? 0) - (nodeVoltage[c.nodes[3]] ?? 0));
      } else if (c.type === 'F') {
        current[c.id] = c.value * x[this.branchIndex.get(c.id + SENSE)!];
      } else if (c.type === 'XF') {
        current[c.id] = x[this.branchIndex.get(c.id)!];
        current[c.id + SECONDARY] = x[this.branchIndex.get(c.id + SECONDARY)!];
        voltageAcross[c.id + SECONDARY] = (nodeVoltage[c.nodes[2]] ?? 0) - (nodeVoltage[c.nodes[3]] ?? 0);
      }
      // The controlling port of a current-controlled source is a real branch
      // the editor needs to animate, so report its current too.
      if (c.type === 'F' || c.type === 'H') {
        current[c.id + SENSE] = x[this.branchIndex.get(c.id + SENSE)!];
      }
    }
    return { nodeVoltage, voltageAcross, current, terminals };
  }
}
