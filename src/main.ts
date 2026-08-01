import { Circuit } from './engine';
import type { Component, NodeId, Pair, Quad, Solution, SolveTrace, Triple } from './engine';
import { fmt, parseVal } from './format';
// The assistant module pulls in the Anthropic SDK, which is several times the
// size of the whole app. It is imported dynamically at the point of use so the
// offline PWA doesn't pay for it on every load — only `import type` here, which
// is erased at compile time.
import type { AiCircuit } from './ai';
import { Mcu, checkSketch, type McuHost } from './mcu';
import { DIGITAL, initialState, isDigital, LOGIC_HIGH, LOGIC_INPUT_Z, SINK_OFF,
  type DigitalState, type DigitalType } from './digital';
import * as community from './community';
import './style.css';

//  PART 2 — SCHEMATIC MODEL + EDITOR
// ===========================================================================

/** Every part the editor can hold. 'GND' is a marker, not an engine device. */
export type PartType = 'R' | 'V' | 'I' | 'C' | 'L' | 'VS' | 'SQ' | 'D'
  | 'QN' | 'QP' | 'MN' | 'MP' | 'OA' | 'GND' | 'MCU'
  // Parts built out of the devices the engine already models.
  | 'LED' | 'LAMP' | 'CP' | 'SW' | 'PB' | 'PBNC' | 'POT'
  // Dependent sources and the transformer, straight through to the new stamps.
  | 'E' | 'G' | 'F' | 'H' | 'XF'
  // Electromechanical: state the editor integrates, driving ordinary devices.
  | 'RLY' | 'MOT'
  // Meters. Neither needs a new stamp: an ammeter is a 0 V source, whose
  // branch current the solver already reports, and a voltmeter is a very large
  // resistor. See toDevices.
  | 'VM' | 'AM' | 'OM' | 'WM'
  // Digital. Every one of these is behavioural — see digital.ts — with
  // high-impedance inputs and driven outputs. LOGIC is the source that feeds
  // them: a switchable level, or a clock when given a frequency.
  | 'LOGIC' | DigitalType
  // A block: a circuit the user built, wrapped up and reused as one symbol.
  // It needs no engine support at all — see toDevices, which expands an
  // instance into the devices its definition contains.
  | 'SUB';
/** Everything the tool rail can be set to: a part to place, or a mode. */
type Tool = PartType | 'select' | 'wire' | 'probe' | 'delete';
type Rot = 0 | 90 | 180 | 270;

/** A placed part. (x,y) are grid coords of pin A (the anchor). */
interface Comp {
  id: string;
  type: PartType;
  x: number;
  y: number;
  rot?: Rot;        // absent on ground, which has no orientation
  value?: number;   // absent on parts with no editable value (GND, D, transistors)
  amp?: number;     // wave sources (VS sine / SQ square) only
  freq?: number;
  off?: number;
  duty?: number;    // square source only: fraction of the period spent high
  pin?: number;     // MCU pin only: which digital pin this pad is
  on?: boolean;     // switches, push buttons, relay armature: contact closed
  pos?: number;     // potentiometer wiper, 0..1 from pin A to pin B
  l2?: number;      // transformer secondary inductance (H)
  k?: number;       // transformer coupling coefficient, 0..1
  // Mechanical state the editor integrates alongside the electrical solve —
  // the solver has no notion of either, so they live on the placed part.
  sub?: string;     // SUB only: which definition in `subDefs` this instance is
  omega?: number;   // DC motor shaft speed, rad/s
  angle?: number;   // DC motor shaft angle, radians (for the animation only)
}
interface Wire { x1: number; y1: number; x2: number; y2: number }
interface Probe {
  x: number; y: number; color: string;
  /** Node id resolved at Run. A probe carried along by a drag lands on new
   *  coordinates that the RUNNING netlist — captured once at Run — knows
   *  nothing about, so looking it up by position again returns a stranger node
   *  and the trace flatlines. Pinning the id keeps the trace on its net. */
  node?: NodeId;
}
interface Pt { x: number; y: number }
/** Maps a grid point to the colour of the node it sits on (null when idle). */
type NodeColor = ((x: number, y: number) => string | null) | null;

// ---- Canvas palette --------------------------------------------------------
// Every colour the canvas draws with lives here rather than inline, so the look
// changes in one place. The values below are only a fallback: the real source
// of truth is the `--cv-*` custom properties in style.css, which syncPalette()
// reads into this object whenever the theme changes. That way the schematic and
// the chrome around it cannot drift — there is one palette, in one file, and
// a light canvas with dark chrome is not expressible.
const T={
  gridMajor:'#c3ccd8',    // every 5th rule, drawn stronger
  gridMinor:'#dde3ec',
  wire:'#55627a',
  ink:'#2b3440',          // component bodies and leads
  body:'#ffffff',         // fill inside a body: IC blocks, NOT bubbles
  label:'#7a879b',        // value labels and axes
  accent:'#1f6feb',
  junction:'#55627a',
  current:'#e0952a',      // moving current dots
  panelBg:'rgba(252,253,255,0.96)',
  panelLine:'#ccd5e2',
  panelInk:'#2b3440',
  plotGrid:'#e6ebf3',
  zeroLine:'#aab6c8',
  selV:'#2b3440', selI:'#e0952a',
  mcuOn:'#a4670f', mcuOff:'#eef2f7', mcuOnInk:'#ffffff',
  segOn:'#d8382c', segOff:'#e9edf3',
  selBody:'#eaf1fe',     // body fill while selected, so the tint reads through
  highlight:'#ffd84d',   // the hovered net, washed under the wires
  chargePos:'#e05545', chargeNeg:'#3f6ee0',   // capacitor plate charge bubbles
  vHigh:'#d23a34', vLow:'#236ad9',
  shadow:'rgba(16,24,40,0.13)',
};
/** Which stylesheet custom property backs each palette entry. */
const T_VARS:Record<keyof typeof T,string>={
  gridMajor:'--cv-grid-major', gridMinor:'--cv-grid-minor', wire:'--cv-wire',
  ink:'--cv-ink', body:'--cv-body', label:'--cv-label', accent:'--cv-accent',
  junction:'--cv-junction', current:'--cv-current', panelBg:'--cv-panel-bg',
  panelLine:'--cv-panel-line', panelInk:'--cv-panel-ink', plotGrid:'--cv-plot-grid',
  zeroLine:'--cv-zero-line', selV:'--cv-sel-v', selI:'--cv-sel-i',
  mcuOn:'--cv-mcu-on', mcuOff:'--cv-mcu-off', mcuOnInk:'--cv-mcu-on-ink',
  segOn:'--cv-seg-on', segOff:'--cv-seg-off',
  selBody:'--cv-sel-body',
  highlight:'--cv-highlight',
  chargePos:'--cv-charge-pos', chargeNeg:'--cv-charge-neg',
  vHigh:'--cv-v-high', vLow:'--cv-v-low', shadow:'--canvas-shadow',
};

// ---- Theme -----------------------------------------------------------------
// The chosen theme is stamped on <html> as data-theme (an inline script in
// index.html does it before first paint, so there is no flash of the wrong
// theme). Everything downstream — CSS and canvas alike — follows that one
// attribute. Nothing here decides a colour; it only decides which column of
// the stylesheet's palette is live.
type Theme='light'|'dark';
const THEME_KEY='volta.theme';
/** [r,g,b] of the voltage ramp's three stops, re-parsed on each theme change. */
let ramp={neutral:[85,98,122],high:[210,58,52],low:[35,106,217]};

function hexRGB(h:string):[number,number,number]{
  const s=h.trim().replace(/^#/,'');
  const n=s.length===3?s.replace(/(.)/g,'$1$1'):s;
  const v=parseInt(n.slice(0,6),16);
  return Number.isNaN(v)?[85,98,122]:[(v>>16)&255,(v>>8)&255,v&255];
}
/** Pull every --cv-* value out of the live stylesheet and into T. */
function syncPalette(){
  const cs=getComputedStyle(document.documentElement);
  for(const key of Object.keys(T_VARS) as (keyof typeof T)[]){
    const v=cs.getPropertyValue(T_VARS[key]).trim();
    if(v) T[key]=v;
  }
  ramp={neutral:hexRGB(T.wire),high:hexRGB(T.vHigh),low:hexRGB(T.vLow)};
}
function currentTheme():Theme{
  return document.documentElement.dataset.theme==='dark'?'dark':'light';
}
/** @param persist false when adopting the OS preference or booting — only an
 *  explicit click should write a choice that outranks the system. */
function applyTheme(t:Theme,persist=true){
  document.documentElement.dataset.theme=t;
  if(persist) try{ localStorage.setItem(THEME_KEY,t); }catch{}
  // The mobile browser/status bar chrome takes its colour from this meta tag;
  // left alone it keeps painting the light header colour over a dark app.
  const meta=document.querySelector('meta[name="theme-color"]');
  syncPalette();
  if(meta) meta.setAttribute('content',getComputedStyle(document.documentElement)
    .getPropertyValue('--panel').trim()||'#ffffff');
  const btn=document.getElementById('themeBtn');
  if(btn){
    const dark=t==='dark';
    btn.innerHTML=`<svg class="ic" viewBox="0 0 24 24"><use href="#i-${dark?'sun':'moon'}"/></svg>`;
    btn.title=dark?'Switch to the light theme':'Switch to the dark theme';
    btn.setAttribute('aria-label',btn.title);
  }
}

// Meter internals. The test current is small enough not to disturb a live
// circuit much and large enough to read against numerical noise; the open
// reading is the resistance a real meter shows as "OL".
const OHM_TEST_I=1e-3;      // amps injected by the ohmmeter
const OHM_OPEN_R=1e9;       // its own shunt: an open circuit reads this
const OHM_REF_R=1e10;       // its tie to the reference, so it can float alone
const VOLT_COIL_R=1e8;      // wattmeter voltage coil, as for the voltmeter

const GRID=26;               // pixels per grid unit
/** Non-null element lookup — every id here is declared in index.html. */
const el=(id:string):HTMLElement=>{
  const e=document.getElementById(id);
  if(!e) throw new Error(`missing element #${id}`);
  return e;
};
const cv=el('cv') as HTMLCanvasElement;
// Rebindable so a thumbnail can be rendered with the SAME symbol code that
// draws the screen — see thumbnailDataURL. Duplicating the symbols into a
// second renderer would guarantee the two drift apart.
let ctx=cv.getContext('2d')!;
const stage=el('stage');

// The document: a list of components and a list of wires.
// A 2-terminal part spans 2 grid units; pinB is 2 units along `rot`.
// Ground is 1-terminal (pin at x,y ties that point to node 0).
let comps:Comp[]=[];
let wires:Wire[]=[];
let uid=1;
let tool:Tool='select';
let selected:Comp|null=null;
let running=false;
let mechanics=false;      // does the running circuit contain a relay or a motor?
let digital=false;        // ...or anything the digital evaluator must drive?
let lastResult:Solution|null=null;
let view={ox:0,oy:0,scale:1};  // pan offset (screen px) and zoom factor

const DIR:Record<Rot,[number,number]>={0:[1,0],90:[0,1],180:[-1,0],270:[0,-1]};
const rotOf=(c:Comp):Rot=>c.rot??0;
// rotate an integer grid offset by the component's rotation (screen y-down)
function rotOff(dx:number,dy:number,rot:Rot):[number,number]{
  if(rot===90) return [-dy,dx];
  if(rot===180) return [-dx,-dy];
  if(rot===270) return [dy,-dx];
  return [dx,dy];
}
// Pin geometry, as grid offsets from the part's anchor, in the SAME order the
// engine device expects its nodes. Anything absent here is a plain 2-terminal
// part spanning 2 units along its rotation, which is the common case.
const PIN_OFFSETS:Partial<Record<PartType,[number,number][]>>={
  GND:[[0,0]],
  MCU:[[0,0]],
  QN:[[2,-2],[0,0],[2,2]],   // C, B (at anchor), E
  QP:[[2,-2],[0,0],[2,2]],
  MN:[[2,-2],[0,0],[2,2]],   // D, G, S
  MP:[[2,-2],[0,0],[2,2]],
  OA:[[4,0],[0,-1],[0,1]],   // out, in+, in-
  POT:[[0,0],[1,-2],[2,0]],  // end A, wiper (tapped off the side), end B
  // Four-terminal parts share one box footprint: the port that DRIVES on the
  // right, the port that CONTROLS on the left, so signal flow reads left to
  // right the way the rest of the schematic does.
  E:[[4,-1],[4,1],[0,-1],[0,1]],   // out+, out-, ctrl+, ctrl-
  G:[[4,-1],[4,1],[0,-1],[0,1]],
  F:[[4,-1],[4,1],[0,-1],[0,1]],   // out+, out-, sense+, sense-
  H:[[4,-1],[4,1],[0,-1],[0,1]],
  XF:[[0,-1],[0,1],[4,-1],[4,1]],  // primary +/-, secondary +/-
  RLY:[[0,-1],[0,1],[4,-1],[4,1]], // coil +/-, contact A/B
  WM:[[0,-1],[0,1],[4,-1],[4,1]],  // current coil in/out, voltage sense +/-
  LOGIC:[[0,0]],                   // one pin; the return path is ground
  ...Object.fromEntries(Object.keys(DIGITAL).map(t=>[t,digitalPins(t)])),
};

/**
 * Pin layout for a digital part: inputs down the left edge, outputs down the
 * right, both centred on the anchor. Two grid units apart so a wire can be
 * routed between adjacent pins, which is the whole reason not to pack them
 * tighter.
 */
function digitalPins(t:string):[number,number][]{
  const spec=DIGITAL[t];
  const row=(i:number,n:number)=> n<=1?0:(2*i-(n-1));
  const w=digitalWidth(t);
  return [
    ...spec.in.map((_,i)=>[0,row(i,spec.in.length)] as [number,number]),
    ...spec.out.map((_,j)=>[w,row(j,spec.out.length)] as [number,number]),
  ];
}
/** Body width in grid units: gates are drawn to a fixed outline, chips need
 *  room for their pin labels. A declaration, not a `const` arrow — PIN_OFFSETS
 *  is built at module load and calls this, which a `const` wouldn't survive. */
function digitalWidth(t:string):number{ return DIGITAL[t].gate?4:6; }
function pinsOf(c:Comp):Pt[]{
  if(c.type==='SUB'){
    const d=subOf(c);
    // An instance whose definition has gone (a circuit opened without it) draws
    // as an empty block rather than throwing. It has no pins, so it contributes
    // nothing to the netlist and the rest of the schematic still runs.
    if(!d) return [];
    return subPinOffsets(d.pins.length).map(([ox,oy])=>{
      const [rx,ry]=rotOff(ox,oy,rotOf(c)); return {x:c.x+rx,y:c.y+ry}; });
  }
  const offs=PIN_OFFSETS[c.type];
  if(offs) return offs.map(([ox,oy])=>{ const [rx,ry]=rotOff(ox,oy,rotOf(c)); return {x:c.x+rx,y:c.y+ry}; });
  const [dx,dy]=DIR[rotOf(c)];
  return [{x:c.x,y:c.y},{x:c.x+dx*2,y:c.y+dy*2}];
}
// ---------------------------------------------------------------------------
//  BLOCKS (subcircuits)
// ---------------------------------------------------------------------------
//  A block is a circuit saved under a name and dropped into another circuit as
//  a single symbol. The definition keeps its parts in their own coordinate
//  space, plus the grid points that became its terminals.
//
//  Nothing about this reaches the solver. An instance is expanded in toDevices
//  into exactly the devices its definition holds, with its internal nodes
//  allocated from the same pool that a relay's coil junction already uses. That
//  means a block can contain anything the editor can draw — including another
//  block — for free, and it means a block cannot behave differently from the
//  circuit it was made of, because it *is* that circuit.
interface SubPin { name:string; x:number; y:number }   // x,y in the definition's own space
interface SubDef { name:string; pins:SubPin[]; comps:Comp[]; wires:Wire[] }
let subDefs:Record<string,SubDef>={};

const SUB_W=6;                       // block width in grid squares
/** Where an instance's terminals sit: down the left side, then the right.
 *  Deterministic, so a saved circuit's wires still land on the right pins. */
function subPinOffsets(n:number):[number,number][]{
  const left=Math.ceil(n/2), right=n-left;
  const col=(k:number,count:number)=> count<=1?0:(2*k-(count-1));
  const out:[number,number][]=[];
  for(let i=0;i<left;i++)  out.push([0,col(i,left)]);
  for(let i=0;i<right;i++) out.push([SUB_W,col(i,right)]);
  return out;
}
function subOf(c:Comp):SubDef|null{ return (c.sub&&subDefs[c.sub])||null; }
/** Half-height in grid squares. Driven by the busier side's pin count, so a
 *  two-terminal block is a small box and a ten-terminal one is a tall one. */
function subHeight(d:SubDef):number{
  const n=d.pins.length, left=Math.ceil(n/2);
  return Math.max(1,Math.max(left,n-left)-1);
}

interface TypeInfo { name:string; unit:string; def:number }
// PNP and PMOS aren't on the tool rail, but a loaded or shared circuit can
// contain them and the renderer draws them, so they need entries here too.
const TYPES:Record<PartType,TypeInfo>={
  R:{name:'Resistor',unit:'Ω',def:1000},
  SUB:{name:'Block',unit:'',def:0},
  VM:{name:'Voltmeter',unit:'Ω',def:1e8},
  AM:{name:'Ammeter',unit:'Ω',def:0},
  OM:{name:'Ohmmeter',unit:'Ω',def:0},
  WM:{name:'Wattmeter',unit:'W',def:0},
  V:{name:'Voltage',unit:'V',def:5},
  I:{name:'Current',unit:'A',def:0.01},
  C:{name:'Capacitor',unit:'F',def:1e-6},
  L:{name:'Inductor',unit:'H',def:1e-3},
  VS:{name:'Sine source',unit:'V',def:5},
  SQ:{name:'Square source',unit:'V',def:5},
  D:{name:'Diode',unit:'',def:0},
  QN:{name:'NPN transistor',unit:'',def:0},
  QP:{name:'PNP transistor',unit:'',def:0},
  MN:{name:'NMOS transistor',unit:'',def:0},
  MP:{name:'PMOS transistor',unit:'',def:0},
  OA:{name:'Op-amp (ideal)',unit:'',def:0},
  GND:{name:'Ground',unit:'',def:0},
  MCU:{name:'MCU pin',unit:'',def:0},
  LED:{name:'LED',unit:'',def:0},
  LAMP:{name:'Lamp',unit:'Ω',def:100},
  CP:{name:'Capacitor (polarized)',unit:'F',def:100e-6},
  SW:{name:'Switch (SPST)',unit:'',def:0},
  PB:{name:'Push button (NO)',unit:'',def:0},
  PBNC:{name:'Push button (NC)',unit:'',def:0},
  POT:{name:'Potentiometer',unit:'Ω',def:10000},
  E:{name:'VCVS (voltage-controlled V)',unit:'V/V',def:2},
  G:{name:'VCCS (voltage-controlled I)',unit:'A/V',def:1e-3},
  F:{name:'CCCS (current-controlled I)',unit:'A/A',def:10},
  H:{name:'CCVS (current-controlled V)',unit:'V/A',def:1000},
  XF:{name:'Transformer',unit:'H',def:1},
  RLY:{name:'Relay (SPST-NO)',unit:'Ω',def:200},
  MOT:{name:'DC motor',unit:'Ω',def:5},
  // A logic source's value is the clock frequency; 0 means it is a switch you
  // click rather than an oscillator.
  LOGIC:{name:'Logic source',unit:'Hz',def:0},
  ...Object.fromEntries(Object.entries(DIGITAL).map(([t,spec])=>
    [t,{name:spec.name,unit:'',def:0}])) as Record<DigitalType,TypeInfo>,
};

// ---- Digital co-simulation state -------------------------------------------
// Kept beside the schematic rather than on it: this is simulation state, not
// something the user drew, so it must not end up in a saved file or a shared
// URL. Both maps are cleared on Run, which is what makes a flip-flop power up
// in a known state instead of wherever the last run left it.
const digState=new Map<string,DigitalState>();   // per part: q, prev inputs, count
const digDrive=new Map<string,number[]>();       // per part: what each output drives
/** What a part's outputs drive right now — its power-on state if it hasn't run. */
function digDrivenOf(c:Comp):number[]{
  const cached=digDrive.get(c.id);
  if(cached) return cached;
  const spec=DIGITAL[c.type];
  const s=initialState(spec.out.length,spec.in.length);
  // Evaluate once with every input at 0 V. That is the honest power-on state:
  // a NAND with both inputs low really does come up with its output high.
  return spec.step(new Array<number>(spec.in.length).fill(0),s).out;
}

// ---- Electromechanical model constants ------------------------------------
// A relay coil is an inductor in series with its winding resistance, and the
// armature pulls in above a threshold current and drops out below a lower one.
// The gap between the two is real hysteresis, not a fudge: without it a coil
// sitting exactly at the threshold would chatter every timestep.
const RELAY_L=100e-3, RELAY_PULL_IN=20e-3, RELAY_DROP_OUT=12e-3;
// Permanent-magnet DC motor. Ke (V·s/rad) and Kt (N·m/A) are numerically equal
// in SI, J is rotor inertia and B viscous friction — small-hobby-motor numbers.
// Armature inductance is deliberately left out: it is two decades faster than
// anything you can see happening, so modelling it would only force a tiny
// timestep and slow the whole simulation to make a difference nobody can watch.
const MOTOR_KE=0.02, MOTOR_J=2e-6, MOTOR_B=2e-6;

// ---- Mechanical contacts ---------------------------------------------------
// A switch is modelled as a resistor that changes value rather than as a device
// that appears and disappears: an open contact is a 1 GΩ resistor and a closed
// one is a milliohm. That keeps the MNA matrix the same size and the same
// shape whichever way the contact is thrown, so flipping a switch mid-run only
// has to poke a value — no rebuild, no re-solve from scratch, and no chance of
// a floating subnet making the matrix singular.
const CONTACT_OPEN=1e9, CONTACT_CLOSED=1e-3;
/** Is this part's contact closed right now? NC buttons read inverted. */
function contactClosed(c:Comp):boolean{
  const held=c.on===true;
  return c.type==='PBNC' ? !held : held;
}
const isContact=(t:PartType)=>t==='SW'||t==='PB'||t==='PBNC';

// ---- MCU pin electrical model ---------------------------------------------
// An output pin is an ideal 0/5 V source; an input is high-impedance. A truly
// floating input node would make the MNA matrix singular, so an input gets a
// 100 MΩ leak to ground — high enough not to load the circuit, low enough to
// keep the node defined.
const MCU_HIGH_V=5, MCU_THRESHOLD=2.5, MCU_INPUT_Z=1e8;

// Node ids at or above this belong to a part's insides — the junction between
// a motor's armature resistance and its back-EMF, say. They are handed out
// from their own range so they can never collide with a node the user drew,
// and so the UI can tell the two apart and only show the ones on the grid.
const INTERNAL_NODE_BASE=1e6;
const mcuOut=new Map<number,boolean>();     // pin -> driven level
const mcuMode=new Map<number,boolean>();    // pin -> true when an output


// ===========================================================================
//  PART 3 — NETLIST: turn geometry into electrical nodes (union-find)
// ===========================================================================
interface Netlist {
  netComps: Component[];
  nodeOf: (x:number,y:number)=>NodeId;
  nodeCount: number;
  grounded: boolean;
}

// Turn one placed part into the engine devices it represents. Most parts are
// one device, but some — a potentiometer is two resistors sharing a wiper — are
// several, so this returns a list; ground returns an empty one, since it only
// marks the reference node and has no equation of its own. The switch is what
// earns the type safety: each case builds exactly the fields that device model
// reads, so a missing value can't reach the solver as `undefined`.
//
// A part that expands into several devices names them `<id>:<suffix>`. That
// keeps ids unique for the solver while staying recoverable, which is what
// `pinCurrents` below relies on to animate current through the part.
/** Expand a block instance into the devices its definition contains.
 *
 *  The definition's geometry is resolved exactly the way the top-level
 *  schematic's is — the same union-find over pins and wire endpoints — and then
 *  three kinds of internal node get three different fates:
 *
 *    a terminal      -> the node the instance is wired to on the outside
 *    a ground symbol -> node 0, because there is one reference for the whole
 *                       circuit and a block cannot have a private one
 *    anything else   -> a fresh node from `alloc`, private to this instance
 *
 *  That last line is what lets the same block appear twice without its two
 *  copies shorting together, and it is why ids are prefixed: two instances of a
 *  block containing R1 must not both emit a device called R1.
 *
 *  Recursive by construction. A block containing a block hits this function
 *  again through toDevices, with `alloc` threaded through, so nesting needs no
 *  special case — only the depth guard below, which exists because a definition
 *  that contains itself would otherwise recurse until the stack gives out. */
function expandSub(c:Comp,outer:NodeId[],alloc:()=>NodeId,depth:number):Component[]{
  const d=subOf(c);
  if(!d||depth>SUB_MAX_DEPTH) return [];

  // --- resolve the definition's own geometry ---
  const parent=new Map<string,string>();
  const key=(x:number,y:number)=>x+','+y;
  const find=(k:string):string=>{ if(!parent.has(k)) parent.set(k,k);
    while(parent.get(k)!==k){ parent.set(k,parent.get(parent.get(k)!)!); k=parent.get(k)!;} return k; };
  for(const ic of d.comps) for(const p of pinsOf(ic)) find(key(p.x,p.y));
  for(const w of d.wires){ find(key(w.x1,w.y1)); find(key(w.x2,w.y2));
    parent.set(find(key(w.x1,w.y1)),find(key(w.x2,w.y2))); }

  // --- decide what each internal node becomes on the outside ---
  const mapped=new Map<string,NodeId>();
  for(const ic of d.comps) if(ic.type==='GND') mapped.set(find(key(ic.x,ic.y)),0);
  d.pins.forEach((pin,i)=>{
    const root=find(key(pin.x,pin.y));
    // A terminal wired to the block's own ground stays ground: the outside
    // connection joins that node rather than replacing it.
    if(!mapped.has(root)) mapped.set(root,outer[i]??alloc());
  });
  const nodeOf=(x:number,y:number):NodeId=>{
    const r=find(key(x,y));
    if(!mapped.has(r)) mapped.set(r,alloc());
    return mapped.get(r)!;
  };

  const out:Component[]=[];
  for(const ic of d.comps){
    if(ic.type==='GND') continue;
    const scoped={...ic,id:`${c.id}/${ic.id}`};
    const ns=pinsOf(ic).map(p=>nodeOf(p.x,p.y));
    out.push(...(ic.type==='SUB'
      ? expandSub(scoped,ns,alloc,depth+1)
      : toDevices(scoped,ns,alloc)));
  }
  return out;
}
/** A block that contains itself is a drawing, not a circuit. Refuse to unroll
 *  it forever; the editor also refuses to create one (see makeBlock). */
const SUB_MAX_DEPTH=8;

function toDevices(c:Comp,nodes:NodeId[],alloc:()=>NodeId):Component[]{
  if(c.type==='SUB') return expandSub(c,nodes,alloc,0);
  const pair:Pair=[nodes[0],nodes[1]];
  const triple:Triple=[nodes[0],nodes[1],nodes[2]];
  const quad:Quad=[nodes[0],nodes[1],nodes[2],nodes[3]];
  const value=c.value??TYPES[c.type].def;
  // Digital parts all map the same way: every input is a high-impedance leak
  // to ground, every output a source driving whatever the behavioural model
  // last decided. Nothing here is solved as logic — see digital.ts for why.
  if(isDigital(c.type)){
    const spec=DIGITAL[c.type];
    const drive=digDrivenOf(c);
    const devs:Component[]=spec.in.map((_,i)=>
      ({id:`${c.id}:i${i}`,type:'R',nodes:[nodes[i],0],value:LOGIC_INPUT_Z}));
    spec.out.forEach((_,j)=>{
      const nd=nodes[spec.in.length+j];
      // An open-drain pin is a resistor that switches; everything else is a
      // voltage source. Both are value-only updates, so neither costs a
      // rebuild when the logic changes state.
      devs.push((spec.kind?.[j]??'level')==='sink'
        ? {id:`${c.id}:o${j}`,type:'R',nodes:[nd,0],value:drive[j]??SINK_OFF}
        : {id:`${c.id}:o${j}`,type:'V',nodes:[nd,0],value:drive[j]??0});
    });
    return devs;
  }
  switch(c.type){
    case 'GND': return [];
    case 'LOGIC':
      // With a frequency it is a clock, which the engine's square wave already
      // models exactly; without one it is a level you toggle by clicking it.
      return [value>0
        ? {id:c.id,type:'VS',nodes:[nodes[0],0],wave:'SQR',value:LOGIC_HIGH,
           amp:LOGIC_HIGH/2,freq:value,off:LOGIC_HIGH/2,duty:c.duty??0.5}
        : {id:c.id,type:'V',nodes:[nodes[0],0],value:c.on?LOGIC_HIGH:0}];
    case 'MCU': {
      // Referenced to ground, so a pin pad needs no second terminal drawn.
      const p=c.pin??13;
      return [mcuMode.get(p)
        ? {id:c.id,type:'V',nodes:[nodes[0],0],value:mcuOut.get(p)?MCU_HIGH_V:0}
        : {id:c.id,type:'R',nodes:[nodes[0],0],value:MCU_INPUT_Z}];
    }
    case 'R': return [{id:c.id,type:'R',nodes:pair,value}];
    // A real voltmeter is a big resistor, and modelling it as one keeps the
    // matrix non-singular: a true open circuit would leave whatever it is
    // measuring floating, with no path to the reference at all.
    case 'VM': return [{id:c.id,type:'R',nodes:pair,value:Math.max(1e3,value||1e8)}];
    // A real ammeter is a short. A 0 V source IS the ideal short, and the
    // solver already solves for its branch current — which is exactly the
    // reading. This is the same trick the F and H sources use internally.
    case 'AM': return [{id:c.id,type:'V',nodes:pair,value:0,wave:'DC'}];
    // An ohmmeter is not a passive part at all: a real one INJECTS a known test
    // current and divides the voltage it produces. Modelled the same way, so
    // the reading is derived the way the instrument derives it rather than
    // read off a value the solver never computes. The big shunt across it is
    // what a real meter's open-circuit reading is — without it an unconnected
    // meter would have nowhere to push its test current and the matrix would
    // be singular.
    case 'OM': return [
      {id:c.id,type:'I',nodes:[pair[1],pair[0]],value:OHM_TEST_I},
      {id:c.id+':shunt',type:'R',nodes:pair,value:OHM_OPEN_R},
      // A handheld meter is a self-contained loop: you measure a resistor lying
      // on the bench without wiring it to anything. That loop still needs a
      // reference or the matrix is singular, so the meter brings its own —
      // a tie to node 0 ten times weaker than its own shunt, which is far too
      // faint to move any reading but enough to anchor a floating island.
      {id:c.id+':ref',type:'R',nodes:[pair[1],0],value:OHM_REF_R},
    ];
    case 'C': return [{id:c.id,type:'C',nodes:pair,value}];
    case 'CP': return [{id:c.id,type:'C',nodes:pair,value}];
    case 'L': return [{id:c.id,type:'L',nodes:pair,value}];
    case 'I': return [{id:c.id,type:'I',nodes:pair,value}];
    case 'V': return [{id:c.id,type:'V',nodes:pair,value}];
    // Both wave sources map onto the engine's single 'VS' device; only the
    // wave shape differs, so the editor keeps them as separate parts (distinct
    // symbols and rail entries) while the solver sees one model.
    case 'VS': return [{id:c.id,type:'VS',nodes:pair,wave:'SIN',value,
      amp:c.amp??0,freq:c.freq??0,off:c.off??0}];
    case 'SQ': return [{id:c.id,type:'VS',nodes:pair,wave:'SQR',value,
      amp:c.amp??0,freq:c.freq??0,off:c.off??0,duty:c.duty??0.5}];
    case 'D': return [{id:c.id,type:'D',nodes:pair}];
    // An LED is a diode the renderer lights up. Electrically it is one, so it
    // shares the model rather than duplicating it.
    case 'LED': return [{id:c.id,type:'D',nodes:pair}];
    // A filament lamp is a resistor that glows with the power it dissipates.
    case 'LAMP': return [{id:c.id,type:'R',nodes:pair,value}];
    case 'SW': case 'PB': case 'PBNC':
      return [{id:c.id,type:'R',nodes:pair,value:contactClosed(c)?CONTACT_CLOSED:CONTACT_OPEN}];
    case 'POT': {
      // Two resistors in series across the track, tapped at the wiper. The
      // floor keeps either half from hitting 0 Ω at the end of travel, which
      // would short the wiper to an end and make the matrix singular.
      const pos=Math.max(0,Math.min(1,c.pos??0.5));
      return [
        {id:c.id+':a',type:'R',nodes:[nodes[0],nodes[1]],value:Math.max(1e-3,value*pos)},
        {id:c.id+':b',type:'R',nodes:[nodes[1],nodes[2]],value:Math.max(1e-3,value*(1-pos))},
      ];
    }
    // The dependent sources and the transformer pass straight through: the
    // engine models them directly, so the editor only supplies the pin order.
    case 'E': case 'G': case 'F': case 'H':
      return [{id:c.id,type:c.type,nodes:quad,value}];
    case 'XF':
      return [{id:c.id,type:'XF',nodes:quad,value,l2:c.l2??value,k:c.k??0.99}];
    // A real wattmeter has two coils: a current coil in series with the load
    // and a voltage coil across it. Both are modelled honestly — a 0 V source
    // for the current coil (its branch current IS the load current) and a large
    // resistor for the voltage coil — and the reading is their product, which
    // is what makes it read real power on an AC waveform rather than the
    // product of two averages.
    case 'WM': return [
      {id:c.id,type:'V',nodes:[nodes[0],nodes[1]],value:0,wave:'DC'},
      {id:c.id+':v',type:'R',nodes:[nodes[2],nodes[3]],value:VOLT_COIL_R},
    ];
    case 'RLY': {
      // Coil = winding resistance in series with its inductance, so the
      // armature takes time to pull in and the coil kicks back when it opens.
      // The contact is the same value-swapped resistor a switch uses, driven
      // by the coil current rather than by a click.
      const mid=alloc();
      return [
        {id:c.id+':coilR',type:'R',nodes:[nodes[0],mid],value},
        {id:c.id+':coilL',type:'L',nodes:[mid,nodes[1]],value:RELAY_L},
        {id:c.id+':contact',type:'R',nodes:[nodes[2],nodes[3]],
          value:c.on?CONTACT_CLOSED:CONTACT_OPEN},
      ];
    }
    case 'MOT': {
      // Armature resistance in series with a back-EMF source whose value the
      // mechanical integrator updates each step. Keeping the EMF as an ordinary
      // voltage source is what lets the shaft speed — which the solver knows
      // nothing about — feed back into the electrical solution.
      const n1=alloc();
      return [
        {id:c.id+':Ra',type:'R',nodes:[nodes[0],n1],value},
        {id:c.id+':emf',type:'V',nodes:[n1,nodes[1]],value:MOTOR_KE*(c.omega??0)},
      ];
    }
    case 'QN': return [{id:c.id,type:'QN',nodes:triple}];
    case 'QP': return [{id:c.id,type:'QP',nodes:triple}];
    case 'MN': return [{id:c.id,type:'MN',nodes:triple}];
    case 'MP': return [{id:c.id,type:'MP',nodes:triple}];
    case 'OA': return [{id:c.id,type:'OA',nodes:triple}];
  }
  // Unreachable: every digital type left the function above, and the switch
  // covers the rest. It exists only because `isDigital` narrows a value, not
  // the union, so the compiler can't see that the switch is exhaustive.
  return [];
}

// The single voltage and current to show for a part — what the inspector reads
// out and what the scope traces. A part that expands into several devices has
// no `current[id]` of its own, so this goes through `pinCurrents` instead of
// the solver's per-device record, and picks the pair of pins the number is
// actually meaningful across.
function partVI(c:Comp,result:Solution):{v:number;i:number}{
  const ps=pinsOf(c);
  const I=pinCurrents(c,result);
  const nodeV=(p:Pt)=>simNet?(result.nodeVoltage[simNet.nodeOf(p.x,p.y)]??0):0;
  // A relay's two ports are electrically unrelated, so report the coil — the
  // side you are actually driving. Everything else reads end to end.
  const other=c.type==='RLY'?ps[1]:ps[ps.length-1];
  const v=result.voltageAcross[c.id]??(ps.length>1?nodeV(ps[0])-nodeV(other):nodeV(ps[0]));
  return {v, i:I[0]??0};
}

// Current flowing INTO the part at each of its pins, in `pinsOf` order. This
// is the one place that knows how a part's internal devices connect to its
// pins, so the animation and the KCL wire solver don't have to special-case
// every multi-device part.
function pinCurrents(c:Comp,result:Solution):number[]{
  const cur=(id:string)=>result.current[id]||0;
  if(c.type==='GND') return [0];
  if(c.type==='MCU'||c.type==='LOGIC') return [cur(c.id)];
  if(isDigital(c.type)){
    const spec=DIGITAL[c.type];
    return [...spec.in.map((_,i)=>cur(`${c.id}:i${i}`)),
      ...spec.out.map((_,j)=>cur(`${c.id}:o${j}`))];
  }
  if(c.type==='POT'){
    const ia=cur(c.id+':a'), ib=cur(c.id+':b');   // each flows first node -> second
    return [ia, ib-ia, -ib];
  }
  if(c.type==='RLY'){
    const ic=cur(c.id+':coilR'), ik=cur(c.id+':contact');
    return [ic,-ic,ik,-ik];                       // coil and contact are separate loops
  }
  if(c.type==='MOT'){ const i=cur(c.id+':Ra'); return [i,-i]; }
  if(c.type==='XF'){
    const ip=cur(c.id), is=cur(c.id+':secondary');
    return [ip,-ip,is,-is];                       // two windings, no shared current
  }
  if(c.type==='E'||c.type==='G'){
    return [cur(c.id),-cur(c.id),0,0];            // the control port draws nothing
  }
  if(c.type==='F'||c.type==='H'){
    const io=cur(c.id), is=cur(c.id+':sense');
    return [io,-io,is,-is];
  }
  if(c.type==='WM'){
    const ii=cur(c.id), iv=cur(c.id+':v');
    return [ii,-ii,iv,-iv];        // current coil and voltage coil are separate
  }
  if(c.type==='OM'){
    // What flows through the thing under test is the injected current minus
    // whatever the meter's own shunt takes.
    const i=OHM_TEST_I-cur(c.id+':shunt');
    return [i,-i];
  }
  const t=result.terminals&&result.terminals[c.id];
  if(t) return [t.Ic,t.Ib,t.Ie];                  // 3-terminal active devices
  const i=cur(c.id);
  return [i,-i];                                  // 2-terminal: in at A, out at B
}

function buildNetlist():Netlist{
  const parent=new Map<string,string>();
  const key=(x:number,y:number)=>x+','+y;
  const find=(k:string):string=>{ if(!parent.has(k)) parent.set(k,k);
    while(parent.get(k)!==k){ parent.set(k,parent.get(parent.get(k)!)!); k=parent.get(k)!;} return k; };
  const union=(a:string,b:string)=>{ parent.set(find(a),find(b)); };
  // Register every pin and wire endpoint.
  for(const c of comps) for(const p of pinsOf(c)) find(key(p.x,p.y));
  for(const w of wires){ find(key(w.x1,w.y1)); find(key(w.x2,w.y2)); }
  // Wires merge their endpoints into one node.
  for(const w of wires) union(key(w.x1,w.y1),key(w.x2,w.y2));
  // Assign integer node ids; grounded roots become node 0.
  const grounded=new Set<string>();
  for(const c of comps) if(c.type==='GND') grounded.add(find(key(c.x,c.y)));
  const rootToNode=new Map<string,number>(); let next=1;
  const nodeOf=(x:number,y:number):NodeId=>{ const r=find(key(x,y));
    if(grounded.has(r)) return 0;
    if(!rootToNode.has(r)) rootToNode.set(r,next++); return rootToNode.get(r)!; };
  // Emit engine components (skip GND — it only defines the reference).
  const netComps:Component[]=[];
  // Some parts have nodes that exist only inside them — the junction between a
  // relay's coil resistance and its inductance, say — with no pin and no place
  // on the grid. Those come from a separate high range so they can never
  // collide with a grid node, and so they stay out of the "N nodes" readout,
  // which is meant to describe the schematic the user drew.
  let internal=INTERNAL_NODE_BASE;
  const alloc=():NodeId=>internal++;
  for(const c of comps) netComps.push(...toDevices(c,pinsOf(c).map(p=>nodeOf(p.x,p.y)),alloc));
  // Digital parts, MCU pads and logic sources all reference node 0 directly —
  // their inputs leak to it and their outputs drive against it — so a circuit
  // made of them already has a 0 V reference and shouldn't be made to carry a
  // ground symbol that connects to nothing just to satisfy the Run check.
  // An ohmmeter carries its own reference (see toDevices), so a bare resistor
  // and a meter is a complete, runnable measurement with no ground symbol.
  // Looked for inside blocks too: wrapping a counter up as a block must not
  // make the circuit stop running for want of a ground symbol it never needed.
  const bringsGround=(c:Comp):boolean=>
    isDigital(c.type)||c.type==='MCU'||c.type==='LOGIC'||c.type==='OM'
    || (c.type==='SUB' && !!subOf(c)?.comps.some(bringsGround));
  const implicitGround=comps.some(bringsGround);
  const hasGround=grounded.size>0||implicitGround;
  const nodeCount=next-1+(hasGround?1:0);
  return {netComps,nodeOf,nodeCount,grounded:hasGround};
}

// ---- Wire-current resolver (for animation) --------------------------------
// Within an equipotential node, wires still carry physical current. We solve
// the flow on the wire graph by KCL leaf-pruning (unique for tree wiring).
function solveWireCurrents(result:Solution|null):Map<number,number>{
  const wc=new Map<number,number>();  // wire index -> signed current (x1y1 -> x2y2)
  if(!result) return wc;
  const key=(x:number,y:number)=>x+','+y;
  // Injection at each grid point from attached component pins.
  const inject=new Map<string,number>();
  const add=(k:string,val:number)=>inject.set(k,(inject.get(k)||0)+val);
  for(const c of comps){
    if(c.type==='GND') continue;
    const ps=pinsOf(c);
    // Injection into a node = -(current flowing into the part at that pin).
    pinCurrents(c,result).forEach((i,k)=>{ if(ps[k]) add(key(ps[k].x,ps[k].y), -i); });
  }
  // Adjacency of wires at each point.
  interface Incident { wi:number; other:string; sign:number }
  const adj=new Map<string,Incident[]>();
  wires.forEach((w,wi)=>{
    const ka=key(w.x1,w.y1), kb=key(w.x2,w.y2);
    if(!adj.has(ka)) adj.set(ka,[]); if(!adj.has(kb)) adj.set(kb,[]);
    adj.get(ka)!.push({wi,other:kb,sign:+1}); // +current means flow ka->kb
    adj.get(kb)!.push({wi,other:ka,sign:-1});
    wc.set(wi,0);
  });
  const known=new Set<number>();
  const netAt=(k:string)=> (inject.get(k)||0);
  // Iteratively resolve points that have exactly one unknown incident wire.
  for(let pass=0; pass<wires.length+2; pass++){
    let changed=false;
    for(const [k,list] of adj){
      const unknown=list.filter(e=>!known.has(e.wi));
      if(unknown.length===1){
        // KCL: sum of currents leaving k = injection at k.
        let flowOut=netAt(k);
        for(const e of list){ if(known.has(e.wi)){ flowOut += e.sign*wc.get(e.wi)!; } }
        // remaining wire must carry -flowOut in its sign convention... define:
        const e=unknown[0];
        // currents leaving via known wires already counted with e.sign*wc.
        // Set unknown so that total leaving == 0 given injection is a source:
        // net leaving through wires = injection(k) ... we treat injection as current entering node.
        // Balance: sum(sign*wc) over all incident = inject(k)
        let sumKnown=0;
        for(const g of list){ if(known.has(g.wi)) sumKnown += g.sign*wc.get(g.wi)!; }
        const val=(netAt(k)-sumKnown)/e.sign;
        wc.set(e.wi,val); known.add(e.wi); changed=true;
      }
    }
    if(!changed) break;
  }
  return wc;
}

// ===========================================================================
//  PART 4 — RENDERING
// ===========================================================================
function resize(){
  const r=stage.getBoundingClientRect();
  cv.width=r.width*devicePixelRatio; cv.height=r.height*devicePixelRatio;
  cv.style.width=r.width+'px'; cv.style.height=r.height+'px';
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  draw();
}
window.addEventListener('resize',resize);

// Drawing happens in WORLD coordinates — 1 grid unit is always GRID pixels —
// and the canvas transform applies pan and zoom on top. That way every symbol
// dimension, lead length and font size in drawComponent scales for free,
// instead of each one needing a zoom factor threaded through it.
function gx(x:number){ return x*GRID; }
function gy(y:number){ return y*GRID; }
/** Screen pixels -> world pixels. */
const toWorld=(px:number,py:number):Pt=>({x:(px-view.ox)/view.scale, y:(py-view.oy)/view.scale});
function toGrid(px:number,py:number):Pt{
  const w=toWorld(px,py);
  return {x:Math.round(w.x/GRID), y:Math.round(w.y/GRID)};
}

const MIN_SCALE=0.25, MAX_SCALE=4;
/** Zoom by `f` about a screen point, keeping the world point under it fixed. */
function zoomAt(px:number,py:number,f:number){
  const s=Math.max(MIN_SCALE,Math.min(MAX_SCALE,view.scale*f));
  if(s===view.scale) return;
  const w=toWorld(px,py);
  view.scale=s; view.ox=px-w.x*s; view.oy=py-w.y*s;
  draw();
}
/**
 * Grid points a part's SYMBOL covers beyond its pins. Fit frames the circuit by
 * its pins, which is right for everything whose body sits between them — but a
 * display has all four pins down its left edge and a body six units wide, so
 * framing by pins alone crops it off the screen.
 */
function bodyExtent(c:Comp):Pt[]{
  if(isDigital(c.type)){
    const [dx,dy]=DIR[rotOf(c)], w=digitalWidth(c.type);
    return [{x:c.x+dx*w,y:c.y+dy*w}];
  }
  if(c.type==='SUB'){
    const d=subOf(c); const h=(d?subHeight(d):1)+1;
    const [dx,dy]=DIR[rotOf(c)];
    // Both far corners, so Fit frames the whole body however it is rotated.
    return [{x:c.x+dx*SUB_W-dy*h,y:c.y+dy*SUB_W+dx*h},
            {x:c.x+dx*SUB_W+dy*h,y:c.y+dy*SUB_W-dx*h}];
  }
  // These two draw a pad above their single pin.
  if(c.type==='MCU'||c.type==='LOGIC') return [{x:c.x,y:c.y-1}];
  return [];
}

/** Frame the whole circuit in the viewport, or recentre an empty grid. */
function fitView(){
  const W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio;
  const pts:Pt[]=[];
  for(const c of comps) pts.push(...pinsOf(c),...bodyExtent(c));
  for(const w of wires){ pts.push({x:w.x1,y:w.y1},{x:w.x2,y:w.y2}); }
  if(!pts.length){ view={ox:40,oy:40,scale:1}; draw(); return; }
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
  const minX=Math.min(...xs)-1, maxX=Math.max(...xs)+1;
  const minY=Math.min(...ys)-1, maxY=Math.max(...ys)+1;
  const wWorld=(maxX-minX)*GRID, hWorld=(maxY-minY)*GRID;
  // Reserve whatever the scope panel will actually occupy — it covers the
  // bottom of the canvas, and it appears while running even with nothing
  // probed or selected (it shows the "tap a component" prompt).
  const panelShown=scopeProbes.length>0||!!selected||running;
  const margin=40, panel=panelShown?225:60;
  // Cap Fit's magnification: filling the screen with a two-part circuit at 4x
  // looks broken rather than helpful.
  const FIT_MAX=2;
  const s=Math.max(MIN_SCALE,Math.min(FIT_MAX,
    Math.min((W-2*margin)/wWorld,(H-margin-panel)/hWorld)));
  view.scale=s;
  view.ox=W/2-((minX+maxX)/2)*GRID*s;
  view.oy=(H-panel)/2-((minY+maxY)/2)*GRID*s;
  draw();
}

// Voltage -> color (blue low, grey mid, red high) scaled to present range.
let vRange={min:-1,max:1};
// Voltage -> colour, tuned for a light canvas: cool blue at the low end,
// warm red at the high end, and a neutral slate in the middle so an unenergised
// net doesn't shout. Saturation carries the signal; lightness stays dark enough
// to read against white.
/** Node voltage as a colour: neutral wire grey at mid-rail, ramping to the
 *  theme's high and low stops at the rails. Both endpoints come from the
 *  palette, so a dark schematic ramps through colours that survive on grey. */
function voltColor(v:number):string{
  const {min,max}=vRange; const mid=(min+max)/2; const half=Math.max(1e-6,(max-min)/2);
  const t=Math.max(-1,Math.min(1,(v-mid)/half));
  const [nr,ng,nb]=ramp.neutral;
  const [er,eg,eb]=t>=0?ramp.high:ramp.low;
  const k=Math.abs(t);
  return `rgb(${Math.round(nr+(er-nr)*k)},${Math.round(ng+(eg-ng)*k)},${Math.round(nb+(eb-nb)*k)})`;
}

let animPhase=0;
function draw(){
  const W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio;
  const dpr=devicePixelRatio;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  // Everything from here to the matching restore() is drawn in world space.
  ctx.save();
  ctx.setTransform(dpr*view.scale,0,0,dpr*view.scale,dpr*view.ox,dpr*view.oy);

  // grid dots, over the visible world rectangle only. Below ~8px of on-screen
  // spacing they stop reading as a grid and just haze the canvas, so drop them.
  // Ruled lines rather than dots: they give the eye something to align parts
  // against, which is what makes a schematic grid useful rather than decorative.
  // Every 5th line is drawn stronger so distance is countable at a glance.
  if(GRID*view.scale>=7){
    const tl=toWorld(0,0), br=toWorld(W,H);
    const px=1/view.scale;                     // one screen pixel in world units
    const x0=Math.floor(tl.x/GRID), y0=Math.floor(tl.y/GRID);
    const x1=Math.ceil(br.x/GRID), y1=Math.ceil(br.y/GRID);
    for(const major of [false,true]){
      ctx.beginPath();
      ctx.strokeStyle=major?T.gridMajor:T.gridMinor;
      ctx.lineWidth=(major?1:1)*px;
      for(let i=x0;i<=x1;i++){
        if((Math.abs(i)%5===0)!==major) continue;
        const x=i*GRID; ctx.moveTo(x,tl.y); ctx.lineTo(x,br.y);
      }
      for(let j=y0;j<=y1;j++){
        if((Math.abs(j)%5===0)!==major) continue;
        const y=j*GRID; ctx.moveTo(tl.x,y); ctx.lineTo(br.x,y);
      }
      ctx.stroke();
    }
  }

  // node color lookup if running
  let net:Netlist|null=null;
  if(lastResult){ net=buildNetlist(); }
  const nodeColor:NodeColor=(x,y)=>{
    if(!net||!lastResult) return null;
    const nd=net.nodeOf(x,y); const v=lastResult.nodeVoltage[nd]??0; return voltColor(v);
  };

  // The hovered net washes in underneath, so the wires draw on top of it.
  if(hover) drawNetHighlight(net??buildNetlist());

  // wires
  const wc = running? solveWireCurrents(lastResult) : new Map<number,number>();
  wires.forEach((w,wi)=>{
    const col = lastResult? nodeColor(w.x1,w.y1) : T.wire;
    // A selected wire gets a soft accent halo under it. Same reasoning as a
    // selected part: say "this one" without drawing another boundary — and a
    // wire is a line, so a box round it would be all box and no wire.
    if(w===selectedWire){
      ctx.strokeStyle=T.accent; ctx.globalAlpha=0.28; ctx.lineWidth=11; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(gx(w.x1),gy(w.y1)); ctx.lineTo(gx(w.x2),gy(w.y2)); ctx.stroke();
      ctx.globalAlpha=1;
    }
    ctx.strokeStyle=(w===selectedWire?T.accent:col||T.wire); ctx.lineWidth=3; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(gx(w.x1),gy(w.y1)); ctx.lineTo(gx(w.x2),gy(w.y2)); ctx.stroke();
    if(running){ drawFlow(gx(w.x1),gy(w.y1),gx(w.x2),gy(w.y2), wc.get(wi)||0); }
  });

  // components
  // Selection reads as COLOUR, not as a box. A dashed rectangle round a part
  // is another boundary competing with the symbol's own outline, and on a dense
  // schematic it is one more thing to look past. Tinting the part itself says
  // "this one" without adding a line to the drawing — so the body, its label
  // and a soft wash behind it all shift to the accent, and the symbol keeps its
  // shape.
  for(const c of comps){
    const sel = c===selected || multi.includes(c);
    if(!sel){ drawComponent(c, nodeColor); continue; }
    // The wash sits under the symbol so it never washes the symbol out.
    const ps=pinsOf(c);
    const xs=ps.map(p=>gx(p.x)), ys=ps.map(p=>gy(p.y));
    ctx.save();
    ctx.fillStyle=T.accent; ctx.globalAlpha=0.13;
    roundRectPath(Math.min(...xs)-15,Math.min(...ys)-15,
      Math.max(...xs)-Math.min(...xs)+30, Math.max(...ys)-Math.min(...ys)+30, 8);
    ctx.fill(); ctx.restore();
    const ink=T.ink, label=T.label, body=T.body;
    T.ink=T.accent; T.label=T.accent; T.body=T.selBody;
    try{ drawComponent(c, nodeColor); }
    finally{ T.ink=ink; T.label=label; T.body=body; }
  }

  // scope probe markers
  if(scopeProbes.length){
    scopeProbes.forEach((p,i)=>{ const X=gx(p.x),Y=gy(p.y);
      ctx.strokeStyle=p.color; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(X,Y,6,0,7); ctx.stroke();
      ctx.fillStyle=p.color; ctx.font='9px ui-monospace,monospace'; ctx.textAlign='center';
      ctx.fillText(String(i+1),X,Y-9); });
    ctx.textAlign='left';
  }

  // pin junction dots
  ctx.fillStyle=T.junction;
  const pinCount=new Map<string,number>();
  const addPin=(x:number,y:number)=>pinCount.set(x+','+y,(pinCount.get(x+','+y)||0)+1);
  for(const c of comps) for(const p of pinsOf(c)) addPin(p.x,p.y);
  for(const w of wires){ addPin(w.x1,w.y1); addPin(w.x2,w.y2); }
  for(const [k,n] of pinCount){ if(n>=3){ const [x,y]=k.split(',').map(Number);
    ctx.beginPath(); ctx.arc(gx(x),gy(y),3.5,0,7); ctx.fill(); } }

  // Wire preview — the actual route, not a straight line to the cursor, so the
  // corner and the pin it will snap to are both visible before you commit.
  if(tool==='wire'){
    const mw=toWorld(mouse.px,mouse.py);
    const a=wireAnchor(mw.x/GRID,mw.y/GRID);
    ctx.strokeStyle=T.accent; ctx.lineWidth=2;
    if(wireStart){
      ctx.setLineDash([5,4]);
      ctx.beginPath();
      const segs=routeWire(wireStart,{x:a.x,y:a.y},wireExit,a.exit,[wireBox,a.box]);
      if(segs.length){
        ctx.moveTo(gx(segs[0].x1),gy(segs[0].y1));
        for(const s of segs) ctx.lineTo(gx(s.x2),gy(s.y2));
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // Ring the pin the next click will land on.
    if(a.exit){ ctx.beginPath(); ctx.arc(gx(a.x),gy(a.y),5,0,7); ctx.stroke(); }
  }
  // ghost for placing
  if(isPlaceType(tool)&&mouse.gx!=null&&mouse.gy!=null){ drawGhost(tool,mouse.gx,mouse.gy); }

  // (Selection is drawn as colour, with the parts themselves — see above.)

  ctx.restore();
  // Panels are screen furniture, not part of the schematic: they keep a fixed
  // size and position regardless of zoom, so they draw in screen space.
  ctx.setTransform(dpr,0,0,dpr,0,0);
  drawHoverChip();
  if(panelMode==='bode') drawBode(); else drawScope();
  // Zoom readout, as a chip rather than bare text floating on the grid.
  if(view.scale!==1){
    const txt=Math.round(view.scale*100)+'%';
    ctx.font=`10px ${MONO}`;
    const tw=ctx.measureText(txt).width, cw=tw+16, cx=W-12-cw, cy=10;
    ctx.fillStyle=T.panelBg; ctx.strokeStyle=T.panelLine; ctx.lineWidth=1;
    roundRectPath(cx,cy,cw,20,10); ctx.fill(); ctx.stroke();
    ctx.fillStyle=T.label; ctx.textAlign='center';
    ctx.fillText(txt, cx+cw/2, cy+14); ctx.textAlign='left';
  }
}

// ---- Oscilloscope panel ----------------------------------------------------
// The scope plots two kinds of trace: node voltages from manually-placed
// probes, and — the common case — the voltage across and current through
// whichever component is selected. Selecting a part is enough to see its
// waveform; you don't have to know about the probe tool first.
interface Channel { label:string; color:string; data:number[]; unit:string }
// Deliberately outside SCOPE_COLORS: the selected part's voltage shares a plot
// with the probe traces, so it must not collide with any of them.
// (read from T at draw time so a theme switch repaints them)

function scopeChannels():Channel[]{
  const chs:Channel[]=[];
  const buf=scopeBuf;
  scopeProbes.forEach((p,i)=>chs.push({
    label:`probe ${i+1}`, color:p.color, data:buf?buf.series[i]:[], unit:'V' }));
  if(selected&&selected.type!=='GND'){
    chs.push({label:`${selected.id} V`, color:T.selV, data:buf?buf.selV:[], unit:'V'});
    chs.push({label:`${selected.id} I`, color:T.selI, data:buf?buf.selI:[], unit:'A'});
  }
  return chs;
}

// ---- Panel furniture -------------------------------------------------------
// The scope and the Bode panel are the same object with different contents, so
// the frame, the title row and the empty-state message are drawn once here.
const UI_FONT='-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const MONO='ui-monospace,SFMono-Regular,Menlo,monospace';

/** Uppercase section label with letter-spacing where the browser supports it. */
function smallCaps(text:string,x:number,y:number,color=T.label){
  ctx.save();
  ctx.fillStyle=color; ctx.font=`600 9px ${UI_FONT}`; ctx.textAlign='left';
  // letterSpacing is Chrome 99+/Safari 17+; without it the label just sits
  // tighter, which is a cosmetic loss rather than a broken label.
  if('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D&{letterSpacing:string}).letterSpacing='0.09em';
  ctx.fillText(text.toUpperCase(),x,y);
  ctx.restore();
}

function roundRectPath(x:number,y:number,w:number,h:number,r:number){
  ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(x,y,w,h,r);
  else ctx.rect(x,y,w,h);          // ancient webviews: square corners, still legible
}

/** Floating panel: soft shadow, rounded edge, and a ruled title row. */
function panelFrame(x:number,y:number,w:number,h:number,title:string,right?:string){
  ctx.save();
  ctx.shadowColor=T.shadow; ctx.shadowBlur=20; ctx.shadowOffsetY=5;
  ctx.fillStyle=T.panelBg; roundRectPath(x,y,w,h,10); ctx.fill();
  ctx.restore();
  ctx.strokeStyle=T.panelLine; ctx.lineWidth=1;
  roundRectPath(x+0.5,y+0.5,w-1,h-1,10); ctx.stroke();
  smallCaps(title,x+14,y+17);
  if(right){
    ctx.save();
    ctx.fillStyle=T.label; ctx.font=`10px ${MONO}`; ctx.textAlign='right';
    ctx.fillText(right,x+w-14,y+17); ctx.restore();
  }
  // Hairline under the title, inset so it reads as a rule and not a border.
  ctx.strokeStyle=T.panelLine; ctx.globalAlpha=.7;
  ctx.beginPath(); ctx.moveTo(x+12,y+25.5); ctx.lineTo(x+w-12,y+25.5); ctx.stroke();
  ctx.globalAlpha=1;
}

/** Centred placeholder for a panel with nothing to plot yet. */
function panelMessage(msg:string,x:number,y:number,w:number,h:number){
  ctx.save();
  ctx.fillStyle=T.label; ctx.font=`12px ${UI_FONT}`; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(msg,x+w/2,y+h/2);
  ctx.restore();
  ctx.textAlign='left'; ctx.textBaseline='alphabetic';
}

// Draw one set of same-unit traces into a rectangle, autoscaled to their range.
function plotChannels(chs:Channel[], t:number[], x:number, y:number, w:number, h:number, unit:string){
  let mn=Infinity,mx=-Infinity;
  for(const c of chs) for(const v of c.data){ if(v<mn)mn=v; if(v>mx)mx=v; }
  if(!isFinite(mn)){ mn=-1; mx=1; }
  if(mn===mx){ mn-=Math.abs(mn)*0.5+1e-9; mx+=Math.abs(mx)*0.5+1e-9; }
  const pad=(mx-mn)*0.1; mn-=pad; mx+=pad;
  const t0=t[0], t1=t[t.length-1], dt=(t1-t0)||1;
  const X=(tv:number)=>x+(tv-t0)/dt*w, Y=(v:number)=>y+h-(v-mn)/(mx-mn)*h;

  // Graticule: four horizontal divisions and six vertical ones, so a waveform
  // can be read off rather than only looked at.
  ctx.strokeStyle=T.plotGrid; ctx.lineWidth=1;
  ctx.beginPath();
  for(let i=0;i<=4;i++){ const yy=Math.round(y+h*i/4)+0.5; ctx.moveTo(x,yy); ctx.lineTo(x+w,yy); }
  for(let i=1;i<6;i++){ const xx=Math.round(x+w*i/6)+0.5; ctx.moveTo(xx,y); ctx.lineTo(xx,y+h); }
  ctx.stroke();
  // Zero is the one line worth distinguishing from the rest of the graticule.
  if(mn<0&&mx>0){
    ctx.save();
    ctx.strokeStyle=T.zeroLine; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(x,Y(0)); ctx.lineTo(x+w,Y(0)); ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle=T.label; ctx.font=`9px ${MONO}`; ctx.textAlign='right';
  ctx.fillText(fmt(mx,unit), x-6, y+7);
  if(mn<0&&mx>0) ctx.fillText(fmt(0,unit), x-6, Y(0)+3);
  ctx.fillText(fmt(mn,unit), x-6, y+h+3);

  // Traces are clipped to the plot: an autoscale lags a fast transient by a
  // frame or two, and an unclipped spike would scribble over the legend.
  ctx.save();
  ctx.beginPath(); ctx.rect(x,y-1,w,h+2); ctx.clip();
  ctx.lineJoin='round'; ctx.lineCap='round';
  for(const c of chs){
    if(c.data.length<2) continue;
    // A trace can be shorter than the time axis (a newly-selected part starts
    // sampling mid-window), so align it to the most recent samples.
    const off=t.length-c.data.length;
    ctx.strokeStyle=c.color; ctx.lineWidth=1.75; ctx.beginPath();
    for(let k=0;k<c.data.length;k++){
      const xx=X(t[k+off]??t[t.length-1]), yy=Y(c.data[k]);
      k===0?ctx.moveTo(xx,yy):ctx.lineTo(xx,yy);
    }
    ctx.stroke();
    // A dot on the newest sample marks where "now" is on each trace.
    const lastX=X(t[t.length-1]), lastY=Y(c.data[c.data.length-1]);
    ctx.fillStyle=c.color; ctx.beginPath(); ctx.arc(lastX,lastY,2.2,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
  ctx.textAlign='left';
}

function drawScope(){
  const chs=scopeChannels();
  if(!chs.length&&!running) return;
  const W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio;
  const volts=chs.filter(c=>c.unit==='V'), amps=chs.filter(c=>c.unit==='A');
  const twoRow=volts.length>0&&amps.length>0;
  const pad=12, ph=twoRow?214:176; const px=pad, py=H-ph-pad, pw=W-2*pad;
  const t=scopeBuf?.t;
  const span=t&&t.length>1?fmt((t[t.length-1]-t[0])||1,'s')+' window':'';
  panelFrame(px,py,pw,ph,'Oscilloscope',span);

  // The legend column is sized to its longest entry rather than a fixed 200px,
  // so two probes don't reserve room for six.
  ctx.font=`10px ${MONO}`;
  let legendW=0;
  for(const c of chs){
    const last=c.data.length?c.data[c.data.length-1]:null;
    // Label and value stack on two lines, so the column only needs the wider
    // of the two — measuring them joined reserves space nothing occupies.
    legendW=Math.max(legendW,ctx.measureText(c.label).width);
    if(last!=null) legendW=Math.max(legendW,ctx.measureText(fmt(last,c.unit)).width);
  }
  const legendCol=chs.length?Math.min(legendW+37,Math.max(pw*0.3,110)):0;
  const plotX=px+56, plotY=py+38, plotW=pw-56-16-legendCol, plotH=ph-38-22;

  // legend, with each trace's live value
  const lx=plotX+plotW+20; let ly=plotY+9;
  for(const c of chs){
    ctx.fillStyle=c.color;
    roundRectPath(lx,ly-8,10,10,3); ctx.fill();
    ctx.fillStyle=T.panelInk; ctx.font=`10px ${MONO}`; ctx.textAlign='left';
    const last=c.data.length?c.data[c.data.length-1]:null;
    ctx.fillText(c.label,lx+17,ly+1);
    if(last!=null){
      ctx.fillStyle=T.label;
      ctx.fillText(fmt(last,c.unit),lx+17,ly+13);
    }
    ly+=last!=null?28:19;
  }
  if(!chs.length){
    panelMessage('Tap a component to scope its voltage & current',plotX,plotY,plotW,plotH);
    return;
  }
  if(!t||t.length<2){
    panelMessage(running?'Sampling…':'Press Run to capture waveforms',plotX,plotY,plotW,plotH);
    return;
  }
  if(twoRow){
    const gap=18, rowH=(plotH-gap)/2;
    plotChannels(volts, t, plotX, plotY, plotW, rowH, 'V');
    plotChannels(amps, t, plotX, plotY+rowH+gap, plotW, rowH, 'A');
  } else {
    plotChannels(chs, t, plotX, plotY, plotW, plotH, chs[0].unit);
  }
  ctx.textAlign='left';
}

// ---- Bode plot panel (AC frequency response) -------------------------------
function drawBode(){
  const W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio;
  const pad=12, ph=210; const px=pad, py=H-ph-pad, pw=W-2*pad;
  const f=bodeData?.freqs;
  panelFrame(px,py,pw,ph,'Bode · frequency response',
    f?`${fmt(f[0],'Hz')} – ${fmt(f[f.length-1],'Hz')}`:'');
  if(!bodeData||!f){
    panelMessage('Place a probe on the output, then press Bode',px,py+26,pw,ph-26);
    return;
  }
  const f0=f[0], f1=f[f.length-1], lg=Math.log10;
  // 40px of title row above, 28px of decade labels below, 16px between the two
  // stacked plots — anything left over is split 55/45 gain over phase.
  const plotX=px+54, plotW=pw-210;
  const rows=ph-40-28-16;
  const magY=py+40, magH=rows*0.55, phY=magY+magH+16, phH=rows*0.45;
  const Xf=(fr:number)=>plotX+(lg(fr)-lg(f0))/(lg(f1)-lg(f0))*plotW;
  let mn=Infinity,mx=-Infinity;
  for(const c of bodeData.curves) for(const v of c.mag){ if(isFinite(v)){ if(v<mn)mn=v; if(v>mx)mx=v; } }
  if(!isFinite(mn)){ mn=-40; mx=0; } if(mx-mn<6){ mx+=3; mn-=3; } const mp=(mx-mn)*0.08; mn-=mp; mx+=mp;
  const Ym=(db:number)=>magY+magH-(db-mn)/(mx-mn)*magH;
  let pmn=Infinity,pmx=-Infinity; for(const c of bodeData.curves) for(const v of c.phase){ if(v<pmn)pmn=v; if(v>pmx)pmx=v; }
  if(pmx-pmn<10){ pmx+=5; pmn-=5; }
  const Yp=(d:number)=>phY+phH-(d-pmn)/(pmx-pmn)*phH;
  // decade gridlines + labels
  ctx.strokeStyle=T.plotGrid; ctx.fillStyle=T.label; ctx.font='9px ui-monospace,monospace'; ctx.textAlign='center';
  for(let d=Math.ceil(lg(f0)); d<=Math.floor(lg(f1)); d++){ const fx=Xf(Math.pow(10,d));
    ctx.beginPath(); ctx.moveTo(fx,magY); ctx.lineTo(fx,phY+phH); ctx.stroke();
    ctx.fillText(fmt(Math.pow(10,d),'Hz'), fx, phY+phH+12); }
  if(mn<0&&mx>0){ ctx.strokeStyle=T.zeroLine; ctx.beginPath(); ctx.moveTo(plotX,Ym(0)); ctx.lineTo(plotX+plotW,Ym(0)); ctx.stroke(); }
  ctx.strokeStyle=T.plotGrid; ctx.beginPath(); ctx.moveTo(plotX,phY); ctx.lineTo(plotX+plotW,phY); ctx.stroke(); // phase panel top divider
  ctx.fillStyle=T.label; ctx.textAlign='right';
  ctx.fillText(mx.toFixed(0)+'dB', plotX-4, magY+8); ctx.fillText(mn.toFixed(0)+'dB', plotX-4, magY+magH);
  ctx.fillText(pmx.toFixed(0)+'°', plotX-4, phY+8); ctx.fillText(pmn.toFixed(0)+'°', plotX-4, phY+phH);
  bodeData.curves.forEach(c=>{
    ctx.strokeStyle=c.color; ctx.lineWidth=1.6;
    ctx.beginPath(); f.forEach((fr,i)=>{ const xx=Xf(fr),yy=Ym(c.mag[i]); i===0?ctx.moveTo(xx,yy):ctx.lineTo(xx,yy); }); ctx.stroke();
    ctx.setLineDash([3,3]); ctx.lineWidth=1.2;
    ctx.beginPath(); f.forEach((fr,i)=>{ const xx=Xf(fr),yy=Yp(c.phase[i]); i===0?ctx.moveTo(xx,yy):ctx.lineTo(xx,yy); }); ctx.stroke(); ctx.setLineDash([]);
  });
  const lx=plotX+plotW+18; let ly=magY+8;
  bodeData.curves.forEach(c=>{ ctx.fillStyle=c.color; roundRectPath(lx,ly-8,10,10,3); ctx.fill();
    ctx.fillStyle=T.panelInk; ctx.textAlign='left'; ctx.font=`10px ${MONO}`; ctx.fillText(c.label,lx+17,ly+1); ly+=18; });
  ctx.fillStyle=T.label; ctx.font=`9px ${MONO}`; ctx.textAlign='left';
  ctx.fillText('solid = gain (dB)', lx, ly+8); ctx.fillText('dashed = phase (°)', lx, ly+20);
}

// ---- Capacitor charge -------------------------------------------------------
// A ⊕/⊖ pair on the plates, swapping sides with the polarity and swelling with
// the stored charge. It is the one thing a static capacitor symbol can never
// say: which way it is charged and how hard, updated every frame. On an AC
// source you watch them trade places at the source frequency, which is most of
// the intuition the symbol is there to build.
function drawCharge(c:Comp,P:(a:number,b:number)=>Pt){
  if(!running||!lastResult) return;
  const {v}=partVI(c,lastResult);
  // Scale against the live voltage range so a 3 V swing and a 300 mV one both
  // read; below a threshold there is no charge worth drawing.
  const span=Math.max(1e-9,Math.max(Math.abs(vRange.min),Math.abs(vRange.max)));
  const mag=Math.min(1,Math.abs(v)/span);
  if(mag<0.04) return;
  const r=3+mag*3.4;
  // v is A-to-B: positive means plate A holds the positive charge.
  const plateA=P(-7,0), plateB=P(7,0);
  const pos=v>=0?plateA:plateB, neg=v>=0?plateB:plateA;
  ctx.save();
  ctx.lineWidth=1.4; ctx.lineCap='round';
  const bubble=(p:Pt,fill:string,plus:boolean)=>{
    ctx.fillStyle=fill; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=T.mcuOnInk; ctx.beginPath();
    ctx.moveTo(p.x-r*0.5,p.y); ctx.lineTo(p.x+r*0.5,p.y);
    if(plus){ ctx.moveTo(p.x,p.y-r*0.5); ctx.lineTo(p.x,p.y+r*0.5); }
    ctx.stroke();
  };
  bubble(pos,T.chargePos,true);
  bubble(neg,T.chargeNeg,false);
  ctx.restore();
}

// Moving dots to show current. Spacing is a fixed distance in world units, not
// a fraction of the segment: dividing each run into n dots made a short wire's
// dots crawl far apart and a long one's bunch up, so the same current read as
// two different flows depending on where you drew it. A constant pitch makes
// the whole schematic one legible stream, and lets the dots carry the magnitude
// in their size instead.
const FLOW_PITCH=15;   // world units between dots
function drawFlow(x1:number,y1:number,x2:number,y2:number,cur:number){
  const mag=Math.abs(cur);
  if(mag<1e-12) return;
  const len=Math.hypot(x2-x1,y2-y1); if(len<1) return;
  const ux=(x2-x1)/len, uy=(y2-y1)/len;
  const dir=Math.sign(cur);
  // Log scale: real circuits span microamps to amps, and a linear map would
  // leave everything below the largest current apparently motionless.
  const speed=Math.min(1, 0.15+Math.log10(1+mag*1000)/4);
  const r=1.7+Math.min(1.3,Math.log10(1+mag*1000)/4);
  // Phase in world units so a dot's position doesn't depend on segment length.
  let off=(animPhase*speed*dir*FLOW_PITCH*3)%FLOW_PITCH;
  if(off<0) off+=FLOW_PITCH;
  ctx.fillStyle=T.current;
  ctx.beginPath();
  for(let d=off; d<len; d+=FLOW_PITCH){
    ctx.moveTo(x1+ux*d+r, y1+uy*d);
    ctx.arc(x1+ux*d, y1+uy*d, r, 0, Math.PI*2);
  }
  ctx.fill();
}

// Which pins form the left-hand port and which the right, for the parts drawn
// as a body with a port on each side. A dependent source senses on the left and
// drives on the right; a transformer's primary is the left port.
const FOUR_PIN_SIDES:Partial<Record<PartType,{left:[number,number];right:[number,number]}>>={
  // The wattmeter's current coil is the in-series port, so it sits on the
  // signal path (left in, right out is wrong here — both current pins are one
  // port). Left = current coil, right = voltage sense, same as the relay.
  WM:{left:[0,1],right:[2,3]},
  E:{left:[2,3],right:[0,1]},  G:{left:[2,3],right:[0,1]},
  F:{left:[2,3],right:[0,1]},  H:{left:[2,3],right:[0,1]},
  XF:{left:[0,1],right:[2,3]}, RLY:{left:[0,1],right:[2,3]},
};
/** An ohmmeter's face: R = V/I, and "OL" once the reading runs off the top.
 *  A real meter shows over-limit rather than a number it cannot stand behind,
 *  and here the ceiling is literally the meter's own shunt — past about a tenth
 *  of it, what you are reading is mostly the instrument. */
function ohmReading(v:number):string{
  const r=Math.abs(v)/OHM_TEST_I;
  return r>=OHM_OPEN_R*0.1 ? 'OL' : fmt(r,'Ω');
}

/** Real power: the product of the two coils, instant by instant. */
function wattReading(c:Comp,result:Solution,coilI:number):number{
  const ps=pinsOf(c);
  const nv=(p:Pt)=>simNet?(result.nodeVoltage[simNet.nodeOf(p.x,p.y)]??0):0;
  return (nv(ps[2])-nv(ps[3]))*coilI;
}

function fourPinLabel(c:Comp):string{
  const v=c.value??TYPES[c.type].def;
  if(c.type==='XF') return `${fmt(v,'H')} : ${fmt(c.l2??v,'H')}`;
  if(c.type==='RLY') return `${fmt(v,'Ω')} coil · ${c.on?'closed':'open'}`;
  if(c.type==='WM'){
    if(!running||!lastResult) return 'watts';
    const I=pinCurrents(c,lastResult);
    return meterLabel(c.id+':w',wattReading(c,lastResult,I[0]),'W');
  }
  return `${fmt(v,'').trim()} ${TYPES[c.type].unit}`;
}

// ---- Digital symbols --------------------------------------------------------
// Gates are drawn with their proper outlines — a schematic reader identifies an
// AND from its shape long before reading any label — and everything else as a
// labelled box, which is how real schematics draw an IC anyway. The body is
// drawn inside a rotated canvas transform, since these outlines are all arcs
// and curves that would be painful to express as rotated point maths; the text
// is placed afterwards, upright, so a part rotated 90° still reads normally.
const SEG7_GLYPHS:number[]=[
  //  bits are segments a,b,c,d,e,f,g (clockwise from the top, then the middle)
  0b0111111,0b0000110,0b1011011,0b1001111,0b1100110,0b1101101,0b1111101,0b0000111,
  0b1111111,0b1101111,0b1110111,0b1111100,0b0111001,0b1011110,0b1111001,0b1110001,
];
function drawDigital(c:Comp,ps:Pt[],col:(x:number,y:number)=>string){
  const spec=DIGITAL[c.type];
  const nIn=spec.in.length, nOut=spec.out.length;
  const w=digitalWidth(c.type)*GRID;
  const rows=Math.max(nIn,nOut);
  const halfW=w/2-20, halfH=Math.max(20,(rows-1)*GRID+16);
  // Frame: the anchor is the input edge, so the body centre is half a width in.
  const [ux,uy]=DIR[rotOf(c)];
  const ax=gx(c.x), ay=gy(c.y);
  const cxp=ax+ux*w/2, cyp=ay+uy*w/2;
  const ang=Math.atan2(uy,ux);
  const P=(d:number,o:number):Pt=>({x:cxp+ux*d-uy*o, y:cyp+uy*d+ux*o});

  // Leads from each pin to the body edge.
  ctx.lineWidth=2.4;
  ps.forEach((p,i)=>{
    const side=i<nIn?-1:1;
    const o=(i<nIn? (nIn<=1?0:(2*i-(nIn-1))) : (nOut<=1?0:(2*(i-nIn)-(nOut-1))))*GRID;
    ctx.strokeStyle=col(p.x,p.y);
    const e=P(side*halfW,o);
    ctx.beginPath(); ctx.moveTo(gx(p.x),gy(p.y)); ctx.lineTo(e.x,e.y); ctx.stroke();
  });

  ctx.save();
  ctx.translate(cxp,cyp); ctx.rotate(ang);
  ctx.strokeStyle=T.ink; ctx.fillStyle=T.body; ctx.lineWidth=2;
  const bubble=(x:number)=>{ ctx.beginPath(); ctx.arc(x+5,0,5,0,7); ctx.fillStyle=T.body; ctx.fill(); ctx.stroke(); };
  if(spec.gate){
    const inv=c.type==='NAND'||c.type==='NOR'||c.type==='XNOR'||c.type==='NOT';
    const nose=inv?halfW-10:halfW;      // an inverting gate gives up its nose to the bubble
    if(c.type==='AND'||c.type==='NAND'){
      // An ELLIPTICAL front, not a circular one: a tall gate with a circular
      // arc of radius halfH would bulge past the body width and swallow its
      // own output lead.
      ctx.beginPath();
      ctx.moveTo(-halfW,-halfH); ctx.lineTo(0,-halfH);
      ctx.ellipse(0,0,nose,halfH,0,-Math.PI/2,Math.PI/2);
      ctx.lineTo(-halfW,halfH); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if(c.type==='NOT'){
      ctx.beginPath();
      ctx.moveTo(-halfW,-halfH*0.8); ctx.lineTo(nose,0); ctx.lineTo(-halfW,halfH*0.8);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {
      // The shield outline shared by OR, NOR, XOR and XNOR: a concave back and
      // two curves meeting at a point.
      const back=(off:number)=>{ ctx.moveTo(-halfW+off,-halfH); ctx.quadraticCurveTo(-halfW+22+off,0,-halfW+off,halfH); };
      ctx.beginPath();
      back(0);
      ctx.quadraticCurveTo(nose-18,halfH*0.85,nose,0);
      ctx.quadraticCurveTo(nose-18,-halfH*0.85,-halfW,-halfH);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      if(c.type==='XOR'||c.type==='XNOR'){   // the extra back arc that makes it exclusive
        ctx.beginPath(); back(-7); ctx.stroke();
      }
    }
    if(inv) bubble(nose);
  } else {
    ctx.beginPath(); ctx.rect(-halfW,-halfH,halfW*2,halfH*2); ctx.fill(); ctx.stroke();
    if(c.type==='SEG7'){
      // Draw the digit itself, as seven segments, so the schematic shows the
      // value rather than a label you have to decode.
      const n=(digState.get(c.id)?.count)??0;
      const g=SEG7_GLYPHS[n&15];
      // Segments are inset by `gap` from their nominal cell so the digit reads
      // as seven separate bars; butted up against each other they merge into
      // one blob and stop looking like a display at all.
      const sw=26, sh=32, t=5, gap=4;
      const hw=sw-gap, hh=sh/2-gap;                  // half-length of a bar
      const seg:[number,number,number,number][]=[
        [0,-sh,hw,t],[sw,-sh/2,t,hh],[sw,sh/2,t,hh],
        [0,sh,hw,t],[-sw,sh/2,t,hh],[-sw,-sh/2,t,hh],[0,0,hw,t]];
      seg.forEach(([sx,sy,bw,bh],i)=>{
        ctx.fillStyle=(g>>i)&1?T.segOn:T.segOff;
        ctx.fillRect(sx-bw,sy-bh,bw*2,bh*2);
      });
    }
  }
  ctx.restore();

  // Labels, upright. Pin names inside the body edge, and the part name across
  // the middle for anything that isn't a gate (a gate's shape is its name).
  ctx.font='9px ui-monospace,monospace'; ctx.fillStyle=T.label;
  if(!spec.gate){
    [...spec.in,...spec.out].forEach((label,i)=>{
      const side=i<nIn?-1:1;
      const o=(i<nIn? (nIn<=1?0:(2*i-(nIn-1))) : (nOut<=1?0:(2*(i-nIn)-(nOut-1))))*GRID;
      const q=P(side*(halfW-7),o);
      ctx.textAlign=side<0?'left':'right';
      // Horizontal parts read left-to-right; rotated ones would collide, so
      // just centre the label on the pin instead.
      if(rotOf(c)===0||rotOf(c)===180) ctx.fillText(label,q.x,q.y+3);
      else { ctx.textAlign='center'; ctx.fillText(label,q.x,q.y+3); }
    });
    if(c.type!=='SEG7'){
      ctx.textAlign='center'; ctx.font='10px ui-monospace,monospace'; ctx.fillStyle=T.ink;
      ctx.fillText(c.type,cxp,cyp+4);
    }
  }
  // Current dots from the input edge to the output edge, so a live gate shows
  // which way it is driving.
  if(running&&lastResult&&nOut>0){
    const o=P(halfW,0), i0=P(-halfW,0);
    drawFlow(i0.x,i0.y,o.x,o.y, -(lastResult.current[`${c.id}:o0`]??0));
  }
  ctx.textAlign='left';
}

/** A block: a labelled box with its terminals named on the inside edge.
 *  Deliberately plain — it is the one symbol on the schematic that does not
 *  stand for a known device, so it should look like a container rather than
 *  imitate an IC. */
function drawSub(c:Comp,ps:Pt[],col:(x:number,y:number)=>string){
  const d=subOf(c);
  // A little past the outermost pin, so the terminals sit on the body rather
  // than on its corners.
  const h=(d?subHeight(d):1)*GRID+16;
  const w=SUB_W*GRID;
  const [ux,uy]=DIR[rotOf(c)];
  const ax=gx(c.x), ay=gy(c.y);
  const cxp=ax+ux*w/2, cyp=ay+uy*w/2;
  const halfW=w/2-GRID, halfH=h;

  // Leads from each pin in to the body edge.
  ctx.lineWidth=2.4;
  const offs=d?subPinOffsets(d.pins.length):[];
  ps.forEach((p,i)=>{
    const [ox,oy]=offs[i];
    const along=(ox===0?-1:1)*halfW;
    const across=oy*GRID;
    const e={x:cxp+ux*along-uy*across, y:cyp+uy*along+ux*across};
    ctx.strokeStyle=col(p.x,p.y);
    ctx.beginPath(); ctx.moveTo(gx(p.x),gy(p.y)); ctx.lineTo(e.x,e.y); ctx.stroke();
  });

  ctx.save();
  ctx.translate(cxp,cyp); ctx.rotate(Math.atan2(uy,ux));
  ctx.strokeStyle=T.ink; ctx.fillStyle=T.body; ctx.lineWidth=2;
  ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(-halfW,-halfH,halfW*2,halfH*2,6);
  else ctx.rect(-halfW,-halfH,halfW*2,halfH*2);
  ctx.fill(); ctx.stroke();

  // Text upright whatever the rotation: a name read sideways is not read.
  ctx.rotate(-Math.atan2(uy,ux));
  ctx.fillStyle=T.ink; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.font='600 12px ui-monospace, monospace';
  ctx.fillText(d?d.name:'missing', 0, 0);
  ctx.fillStyle=T.label; ctx.font='9px ui-monospace, monospace';
  d?.pins.forEach((pin,i)=>{
    const [ox,oy]=offs[i];
    const along=(ox===0?-1:1)*halfW, across=oy*GRID;
    // Rotate the anchor into screen space, then place the label just inside.
    const px=ux*along-uy*across, py=uy*along+ux*across;
    const inward=ox===0?1:-1;
    ctx.textAlign = (ux*inward>0) ? 'left' : (ux*inward<0) ? 'right' : 'center';
    ctx.fillText(pin.name, px+ux*inward*6, py+uy*inward*6 + (uy===0?0:0));
  });
  ctx.restore();
}

function drawComponent(c:Comp,nodeColor:NodeColor){
  const ps=pinsOf(c);
  ctx.lineWidth=2.4; ctx.lineJoin='round'; ctx.lineCap='round';
  const col=(x:number,y:number):string=> ((lastResult&&nodeColor)? nodeColor(x,y):null)??T.ink;
  if(c.type==='SUB'){ drawSub(c,ps,col); return; }
  if(c.type==='GND'){
    const x=gx(c.x),y=gy(c.y);
    ctx.strokeStyle=col(c.x,c.y); ctx.beginPath();
    ctx.moveTo(x,y); ctx.lineTo(x,y+8);
    ctx.moveTo(x-10,y+8); ctx.lineTo(x+10,y+8);
    ctx.moveTo(x-6,y+13); ctx.lineTo(x+6,y+13);
    ctx.moveTo(x-2,y+18); ctx.lineTo(x+2,y+18); ctx.stroke(); return;
  }
  if(c.type==='MCU'){
    // A labelled pad: the pin number, and a fill that shows its driven state.
    const x=gx(c.x), y=gy(c.y), p=c.pin??13, out=mcuMode.get(p);
    const live=running&&out;
    ctx.strokeStyle=col(c.x,c.y);
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x,y-9); ctx.stroke();
    ctx.fillStyle=live?(mcuOut.get(p)?T.mcuOn:T.plotGrid):T.plotGrid;
    ctx.strokeStyle=T.ink; ctx.lineWidth=2;
    ctx.beginPath(); ctx.roundRect(x-17,y-27,34,18,4); ctx.fill(); ctx.stroke();
    ctx.fillStyle=live&&mcuOut.get(p)?T.mcuOnInk:T.ink;
    ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText('D'+p, x, y-14);
    ctx.textAlign='left';
    return;
  }
  if(c.type==='QN'||c.type==='QP'){
    const Cp={x:gx(ps[0].x),y:gy(ps[0].y)}, Bp={x:gx(ps[1].x),y:gy(ps[1].y)}, Ep={x:gx(ps[2].x),y:gy(ps[2].y)};
    const mid={x:(Cp.x+Ep.x)/2,y:(Cp.y+Ep.y)/2};
    let ax=mid.x-Bp.x, ay=mid.y-Bp.y; const al=Math.hypot(ax,ay)||1; ax/=al; ay/=al; // base->CE axis
    let px=Cp.x-Ep.x, py=Cp.y-Ep.y; const pl=Math.hypot(px,py)||1; px/=pl; py/=pl;     // E->C along bar
    const barC={x:Bp.x+ax*al*0.5, y:Bp.y+ay*al*0.5};
    const barTop={x:barC.x+px*10,y:barC.y+py*10}, barBot={x:barC.x-px*10,y:barC.y-py*10};
    const cJoin={x:barC.x+px*5,y:barC.y+py*5}, eJoin={x:barC.x-px*5,y:barC.y-py*5};
    ctx.strokeStyle=col(ps[1].x,ps[1].y); // base lead
    ctx.beginPath(); ctx.moveTo(Bp.x,Bp.y); ctx.lineTo(barC.x-ax*0,barC.y-ay*0); ctx.stroke();
    ctx.strokeStyle=T.ink; ctx.beginPath(); ctx.moveTo(barTop.x,barTop.y); ctx.lineTo(barBot.x,barBot.y); ctx.stroke(); // bar
    ctx.strokeStyle=col(ps[0].x,ps[0].y); ctx.beginPath(); ctx.moveTo(cJoin.x,cJoin.y); ctx.lineTo(Cp.x,Cp.y); ctx.stroke(); // collector
    ctx.strokeStyle=col(ps[2].x,ps[2].y); ctx.beginPath(); ctx.moveTo(eJoin.x,eJoin.y); ctx.lineTo(Ep.x,Ep.y); ctx.stroke(); // emitter
    // emitter arrow (NPN points toward emitter pin; PNP toward the bar)
    let ex=Ep.x-eJoin.x, ey=Ep.y-eJoin.y; const el=Math.hypot(ex,ey)||1; ex/=el; ey/=el;
    const npn=(c.type==='QN'); const tip=npn?{x:Ep.x*0.45+eJoin.x*0.55,y:Ep.y*0.45+eJoin.y*0.55}:eJoin;
    const adir=npn?1:-1; ctx.fillStyle=T.ink;
    ctx.beginPath(); ctx.moveTo(tip.x+ex*adir*4,tip.y+ey*adir*4);
    ctx.lineTo(tip.x-ex*adir*4+px*3,tip.y-ey*adir*4+py*3);
    ctx.lineTo(tip.x-ex*adir*4-px*3,tip.y-ey*adir*4-py*3); ctx.closePath(); ctx.fill();
    if(running&&lastResult&&lastResult.terminals&&lastResult.terminals[c.id]){
      const t=lastResult.terminals[c.id];
      drawFlow(Cp.x,Cp.y,barC.x,barC.y,-t.Ic);
      drawFlow(barC.x,barC.y,Ep.x,Ep.y,-t.Ie); }
    ctx.fillStyle=T.label; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText(npn?'NPN':'PNP', barC.x, barC.y-14); ctx.textAlign='left';
    return;
  }
  if(c.type==='MN'||c.type==='MP'){
    const Dp={x:gx(ps[0].x),y:gy(ps[0].y)}, Gp={x:gx(ps[1].x),y:gy(ps[1].y)}, Sp={x:gx(ps[2].x),y:gy(ps[2].y)};
    const mid={x:(Dp.x+Sp.x)/2,y:(Dp.y+Sp.y)/2};
    let ax=mid.x-Gp.x, ay=mid.y-Gp.y; const al=Math.hypot(ax,ay)||1; ax/=al; ay/=al; // gate->channel
    let px=Dp.x-Sp.x, py=Dp.y-Sp.y; const pl=Math.hypot(px,py)||1; px/=pl; py/=pl;     // S->D along bars
    const gateC={x:Gp.x+ax*al*0.45, y:Gp.y+ay*al*0.45};          // gate plate center
    const chanC={x:gateC.x+ax*4, y:gateC.y+ay*4};                 // channel bar center (past a gap)
    ctx.strokeStyle=col(ps[1].x,ps[1].y);                         // gate lead (no channel contact)
    ctx.beginPath(); ctx.moveTo(Gp.x,Gp.y); ctx.lineTo(gateC.x,gateC.y); ctx.stroke();
    ctx.strokeStyle=T.ink;
    ctx.beginPath(); ctx.moveTo(gateC.x+px*9,gateC.y+py*9); ctx.lineTo(gateC.x-px*9,gateC.y-py*9); ctx.stroke(); // gate plate
    ctx.beginPath(); ctx.moveTo(chanC.x+px*9,chanC.y+py*9); ctx.lineTo(chanC.x-px*9,chanC.y-py*9); ctx.stroke(); // channel
    ctx.strokeStyle=col(ps[0].x,ps[0].y); ctx.beginPath(); ctx.moveTo(chanC.x+px*9,chanC.y+py*9); ctx.lineTo(Dp.x,Dp.y); ctx.stroke(); // drain
    ctx.strokeStyle=col(ps[2].x,ps[2].y); ctx.beginPath(); ctx.moveTo(chanC.x-px*9,chanC.y-py*9); ctx.lineTo(Sp.x,Sp.y); ctx.stroke(); // source
    // bulk/source arrow (NMOS points toward channel, PMOS away)
    const nmos=(c.type==='MN'); const dir=nmos?1:-1; const abase={x:chanC.x-px*9,y:chanC.y-py*9};
    ctx.fillStyle=T.ink; ctx.beginPath();
    ctx.moveTo(abase.x+ax*dir*4, abase.y+ay*dir*4);
    ctx.lineTo(abase.x-ax*dir*4+px*3, abase.y-ay*dir*4+py*3);
    ctx.lineTo(abase.x-ax*dir*4-px*3, abase.y-ay*dir*4-py*3); ctx.closePath(); ctx.fill();
    if(running&&lastResult&&lastResult.terminals&&lastResult.terminals[c.id]){
      const t=lastResult.terminals[c.id]; drawFlow(Dp.x,Dp.y,chanC.x,chanC.y,-t.Ic); drawFlow(chanC.x,chanC.y,Sp.x,Sp.y,-t.Ie); }
    ctx.fillStyle=T.label; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText(nmos?'NMOS':'PMOS', chanC.x, chanC.y-14); ctx.textAlign='left';
    return;
  }
  if(c.type==='OA'){
    const Op={x:gx(ps[0].x),y:gy(ps[0].y)}, Pp={x:gx(ps[1].x),y:gy(ps[1].y)}, Mp={x:gx(ps[2].x),y:gy(ps[2].y)};
    const inMid={x:(Pp.x+Mp.x)/2,y:(Pp.y+Mp.y)/2};
    let ax=Op.x-inMid.x, ay=Op.y-inMid.y; const al=Math.hypot(ax,ay)||1; ax/=al; ay/=al; // input->output
    let px=Pp.x-Mp.x, py=Pp.y-Mp.y; const pl=Math.hypot(px,py)||1; px/=pl; py/=pl;         // in- -> in+
    const backC={x:inMid.x+ax*al*0.28, y:inMid.y+ay*al*0.28};   // triangle back edge center
    const tip={x:inMid.x+ax*al*0.82, y:inMid.y+ay*al*0.82};     // triangle tip
    const bTop={x:backC.x+px*11,y:backC.y+py*11}, bBot={x:backC.x-px*11,y:backC.y-py*11};
    ctx.strokeStyle=col(ps[1].x,ps[1].y); ctx.beginPath(); ctx.moveTo(Pp.x,Pp.y); ctx.lineTo(backC.x+px*7,backC.y+py*7); ctx.stroke();
    ctx.strokeStyle=col(ps[2].x,ps[2].y); ctx.beginPath(); ctx.moveTo(Mp.x,Mp.y); ctx.lineTo(backC.x-px*7,backC.y-py*7); ctx.stroke();
    ctx.strokeStyle=col(ps[0].x,ps[0].y); ctx.beginPath(); ctx.moveTo(tip.x,tip.y); ctx.lineTo(Op.x,Op.y); ctx.stroke();
    ctx.strokeStyle=T.ink; ctx.beginPath(); ctx.moveTo(bTop.x,bTop.y); ctx.lineTo(bBot.x,bBot.y);
    ctx.lineTo(tip.x,tip.y); ctx.closePath(); ctx.stroke(); // triangle body
    // +/- markers near the two inputs
    ctx.fillStyle=T.label; ctx.font='9px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText('+', backC.x+px*7+ax*6, backC.y+py*7+ay*6+3);
    ctx.fillText('−', backC.x-px*7+ax*6, backC.y-py*7+ay*6+3);
    if(running&&lastResult&&lastResult.terminals&&lastResult.terminals[c.id]){
      const t=lastResult.terminals[c.id]; drawFlow(tip.x,tip.y,Op.x,Op.y,-t.Ic); }
    ctx.textAlign='left';
    return;
  }
  if(c.type==='LOGIC'){
    // A single pad, like the MCU pin, showing the level it is driving. With a
    // frequency it's a clock and shows that instead of a 0/1.
    const x=gx(c.x), y=gy(c.y);
    const clk=(c.value??0)>0;
    const on=clk? (running&&lastResult ? (lastResult.nodeVoltage[simNet?simNet.nodeOf(c.x,c.y):0]??0)>LOGIC_HIGH/2 : false)
      : c.on===true;
    ctx.strokeStyle=col(c.x,c.y);
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x,y-9); ctx.stroke();
    ctx.fillStyle=on?T.mcuOn:T.mcuOff; ctx.strokeStyle=T.ink; ctx.lineWidth=2;
    ctx.beginPath(); ctx.roundRect(x-17,y-27,34,18,4); ctx.fill(); ctx.stroke();
    ctx.fillStyle=on?T.mcuOnInk:T.ink;
    ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
    ctx.fillText(clk?'CLK':(on?'1':'0'), x, y-14);
    if(clk){ ctx.fillStyle=T.label; ctx.fillText(fmt(c.value??0,'Hz'), x, y-32); }
    ctx.textAlign='left';
    return;
  }
  if(isDigital(c.type)){ drawDigital(c,ps,col); return; }
  // ---- Four-terminal parts -------------------------------------------------
  // All of them share one footprint: a body with a two-pin port on each side.
  // Which pins form which port differs (a dependent source is controlled on
  // the left and drives on the right; a transformer's primary is the left
  // port), so the sides are named per type rather than inferred from geometry.
  const sides=FOUR_PIN_SIDES[c.type];
  if(sides){
    const S=(i:number)=>({x:gx(ps[i].x),y:gy(ps[i].y)});
    const L0=S(sides.left[0]),L1=S(sides.left[1]),R0=S(sides.right[0]),R1=S(sides.right[1]);
    const lm={x:(L0.x+L1.x)/2,y:(L0.y+L1.y)/2}, rm={x:(R0.x+R1.x)/2,y:(R0.y+R1.y)/2};
    const mid={x:(lm.x+rm.x)/2,y:(lm.y+rm.y)/2};
    let ux4=rm.x-lm.x, uy4=rm.y-lm.y; const ul=Math.hypot(ux4,uy4)||1; ux4/=ul; uy4/=ul;
    const nx4=-uy4, ny4=ux4;
    const P4=(d:number,o:number):Pt=>({x:mid.x+ux4*d+nx4*o, y:mid.y+uy4*d+ny4*o});
    const line=(a:Pt,b:Pt)=>{ ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); };
    // Leads: each pin runs to the body corner nearest it.
    const pinIdx=[sides.left[0],sides.left[1],sides.right[0],sides.right[1]];
    const corners:[Pt,number,number][]=[[L0,-32,-26],[L1,-32,26],[R0,32,-26],[R1,32,26]];
    corners.forEach(([p,d,o],i)=>{
      ctx.strokeStyle=col(ps[pinIdx[i]].x,ps[pinIdx[i]].y); line(p,P4(d,o));
    });
    ctx.strokeStyle=T.ink; ctx.fillStyle=T.ink; ctx.lineWidth=2;
    ctx.beginPath();                                  // body outline
    const bc=[P4(-32,-26),P4(32,-26),P4(32,26),P4(-32,26)];
    ctx.moveTo(bc[0].x,bc[0].y); for(let i=1;i<4;i++) ctx.lineTo(bc[i].x,bc[i].y);
    ctx.closePath(); ctx.stroke();
    if(c.type==='XF'){
      // Two windings either side of a laminated core: the picture of coupling.
      const base=Math.atan2(ny4,nx4);
      for(const d of [-16,16]){
        ctx.beginPath();
        for(let i=0;i<3;i++){
          const a=P4(d,-14+i*14);
          ctx.arc(a.x,a.y,7,base-Math.PI/2,base+Math.PI/2,d<0);
        }
        ctx.stroke();
      }
      line(P4(-4,-22),P4(-4,22)); line(P4(4,-22),P4(4,22));   // the core
      // Dots mark the two ends that swing positive together.
      for(const d of [-16,16]){ const p=P4(d,-22); ctx.beginPath(); ctx.arc(p.x,p.y,2.4,0,7); ctx.fill(); }
    } else if(c.type==='RLY'){
      // Coil on the left, contact on the right, with a dashed armature link
      // between them — the standard way of drawing "this drives that".
      const cA=P4(-27,-15), cB=P4(-10,15);
      ctx.strokeRect(Math.min(cA.x,cB.x),Math.min(cA.y,cB.y),Math.abs(cB.x-cA.x),Math.abs(cB.y-cA.y));
      const piv=P4(10,17), rest=P4(28,17), tip=c.on===true?P4(28,17):P4(27,4);
      ctx.beginPath(); ctx.arc(piv.x,piv.y,2.2,0,7); ctx.fill();
      ctx.beginPath(); ctx.arc(rest.x,rest.y,2.2,0,7); ctx.fill();
      line(piv,tip);
      ctx.setLineDash([3,3]); ctx.lineWidth=1.2;
      line(P4(-16,0),P4(18,6)); ctx.setLineDash([]); ctx.lineWidth=2;
    } else {
      if(c.type==='WM'){
        // Meter face: a circle with W, plus the two coils named at their pins
        // so the in-series port cannot be confused with the across-the-load one.
        ctx.beginPath(); ctx.arc(mid.x,mid.y,15,0,7); ctx.stroke();
        ctx.fillStyle=T.ink; ctx.font='600 13px sans-serif'; ctx.textAlign='center';
        ctx.fillText('W',mid.x,mid.y+5);
        ctx.fillStyle=T.label; ctx.font='8px ui-monospace,monospace';
        ctx.fillText('I',P4(-22,0).x,P4(-22,0).y+3);
        ctx.fillText('V',P4(22,0).x,P4(22,0).y+3);
        ctx.fillStyle=T.ink; ctx.textAlign='left';
      } else {
        // Dependent source: a diamond, and the letter naming which of the four
        // it is. The current-controlled pair also shows the internal ammeter
        // shorting its two sensing pins together.
        const dia=[P4(28,0),P4(9,-19),P4(-10,0),P4(9,19)];
        ctx.beginPath(); ctx.moveTo(dia[0].x,dia[0].y);
        for(let i=1;i<4;i++) ctx.lineTo(dia[i].x,dia[i].y); ctx.closePath(); ctx.stroke();
        if(c.type==='F'||c.type==='H') line(P4(-32,-26),P4(-32,26));
        ctx.fillStyle=T.label; ctx.font='11px ui-monospace,monospace'; ctx.textAlign='center';
        ctx.font='12px ui-monospace,monospace';
        const lt=P4(9,0); ctx.fillText(c.type, lt.x, lt.y+4);
        ctx.fillStyle=T.ink;
      }
    }
    if(running&&lastResult){
      const I=pinCurrents(c,lastResult);
      drawFlow(L0.x,L0.y,R0.x,R0.y, (c.type==='XF'||c.type==='RLY')?I[0]:I[2]);
    }
    ctx.fillStyle=T.label; ctx.font='10px ui-monospace,monospace'; ctx.textAlign='center';
    const lp4=P4(0,-38);
    ctx.fillText(fourPinLabel(c), lp4.x, lp4.y);
    ctx.textAlign='left';
    return;
  }
  if(c.type==='POT'){
    // A resistor track between the two ends, with an arrow from the wiper pin
    // striking it at the tap point — the position of the arrow along the track
    // is the wiper setting, so the symbol reads the value at a glance.
    const Ap={x:gx(ps[0].x),y:gy(ps[0].y)}, Wp={x:gx(ps[1].x),y:gy(ps[1].y)}, Bp={x:gx(ps[2].x),y:gy(ps[2].y)};
    const tl=Math.hypot(Bp.x-Ap.x,Bp.y-Ap.y)||1;
    const tux=(Bp.x-Ap.x)/tl, tuy=(Bp.y-Ap.y)/tl;      // along the track
    const tnx=-tuy, tny=tux;                            // across it
    const cxp=(Ap.x+Bp.x)/2, cyp=(Ap.y+Bp.y)/2;
    const Q=(d:number,o:number):Pt=>({x:cxp+tux*d+tnx*o, y:cyp+tuy*d+tny*o});
    ctx.strokeStyle=col(ps[0].x,ps[0].y);
    ctx.beginPath(); ctx.moveTo(Ap.x,Ap.y); ctx.lineTo(Q(-13,0).x,Q(-13,0).y); ctx.stroke();
    ctx.strokeStyle=col(ps[2].x,ps[2].y);
    ctx.beginPath(); ctx.moveTo(Bp.x,Bp.y); ctx.lineTo(Q(13,0).x,Q(13,0).y); ctx.stroke();
    ctx.strokeStyle=T.ink; ctx.beginPath();
    for(let i=0;i<=6;i++){ const p=Q(-13+26*i/6,(i%2?6:-6)*(i===0||i===6?0:1));
      i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y); } ctx.stroke();
    const pos=Math.max(0,Math.min(1,c.pos??0.5));
    const tap=Q(-13+26*pos,0);
    ctx.strokeStyle=col(ps[1].x,ps[1].y);
    ctx.beginPath(); ctx.moveTo(Wp.x,Wp.y); ctx.lineTo(tap.x,tap.y); ctx.stroke();
    // Arrowhead on the track end of the wiper lead.
    let wx=tap.x-Wp.x, wy=tap.y-Wp.y; const wl=Math.hypot(wx,wy)||1; wx/=wl; wy/=wl;
    const bx0=tap.x-wx*8, by0=tap.y-wy*8;   // arrow base, back along the lead
    ctx.fillStyle=T.ink; ctx.beginPath();
    ctx.moveTo(tap.x,tap.y);
    ctx.lineTo(bx0-wy*4, by0+wx*4);
    ctx.lineTo(bx0+wy*4, by0-wx*4); ctx.closePath(); ctx.fill();
    if(running&&lastResult){ const I=pinCurrents(c,lastResult);
      drawFlow(Ap.x,Ap.y,tap.x,tap.y,I[0]); drawFlow(tap.x,tap.y,Bp.x,Bp.y,-I[2]); }
    // Label on the side away from the wiper, so it never sits on the track.
    ctx.fillStyle=T.label; ctx.font='10px ui-monospace,monospace';
    const lx=cxp-tnx*24, ly=cyp-tny*24;
    const txt=fmt(c.value??TYPES.POT.def,'Ω')+' · '+Math.round(pos*100)+'%';
    if(Math.abs(tnx)>Math.abs(tny)){ ctx.textAlign=tnx<0?'right':'left'; ctx.fillText(txt,lx,ly+3); }
    else { ctx.textAlign='center'; ctx.fillText(txt,lx,ly); }
    ctx.textAlign='left';
    return;
  }
  const A=ps[0],B=ps[1];
  const ax=gx(A.x),ay=gy(A.y),bx=gx(B.x),by=gy(B.y);
  const mx=(ax+bx)/2,my=(ay+by)/2;
  const len=Math.hypot(bx-ax,by-ay); const ux=(bx-ax)/len,uy=(by-ay)/len; // along
  const nx=-uy,ny=ux;                                                     // normal
  // leads
  ctx.strokeStyle=col(A.x,A.y);
  ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(mx-ux*13,my-uy*13); ctx.stroke();
  ctx.strokeStyle=col(B.x,B.y);
  ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(mx+ux*13,my+uy*13); ctx.stroke();
  ctx.strokeStyle=T.ink; ctx.fillStyle=T.ink;
  const P=(d:number,o:number):Pt=>({x:mx+ux*d+nx*o, y:my+uy*d+ny*o});
  if(c.type==='R'){
    ctx.beginPath(); let first=true;
    for(let i=0;i<=6;i++){ const d=-13+ (26*i/6); const o=(i%2? 6:-6)*(i===0||i===6?0:1);
      const p=P(d,o); first?(ctx.moveTo(p.x,p.y),first=false):ctx.lineTo(p.x,p.y);} ctx.stroke();
  } else if(c.type==='V'){
    // long line (+) and short line (-): plates perpendicular to axis
    const pL1=P(-4,9),pL2=P(-4,-9),pS1=P(4,5),pS2=P(4,-5);
    ctx.beginPath(); ctx.moveTo(pL1.x,pL1.y); ctx.lineTo(pL2.x,pL2.y);
    ctx.moveTo(pS1.x,pS1.y); ctx.lineTo(pS2.x,pS2.y); ctx.stroke();
    ctx.font='11px sans-serif'; const pp=P(-9,-13); ctx.fillText('+',pp.x-3,pp.y+4);
  } else if(c.type==='VM'||c.type==='AM'||c.type==='OM'){
    // The standard meter symbol: a circle around the letter. Kept upright
    // whatever the part's rotation — a rotated V or A stops reading as one.
    ctx.beginPath(); ctx.arc(mx,my,12,0,7); ctx.stroke();
    ctx.save();
    ctx.fillStyle=T.ink; ctx.font='600 13px sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(c.type==='VM'?'V':c.type==='AM'?'A':'\u03a9',mx,my+0.5);
    ctx.restore();
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  } else if(c.type==='VS'){
    ctx.beginPath(); ctx.arc(mx,my,12,0,7); ctx.stroke();
    ctx.beginPath();
    for(let i=0;i<=20;i++){ const d=-8+16*i/20; const o=5*Math.sin(i/20*Math.PI*2); const p=P(d,o);
      i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y); } ctx.stroke();
  } else if(c.type==='SQ'){
    // Same circle as the sine source, with a square pulse inside instead.
    ctx.beginPath(); ctx.arc(mx,my,12,0,7); ctx.stroke();
    const s1=P(-8,0),s2=P(-8,-5),s3=P(0,-5),s4=P(0,5),s5=P(8,5),s6=P(8,0);
    ctx.beginPath(); ctx.moveTo(s1.x,s1.y); ctx.lineTo(s2.x,s2.y); ctx.lineTo(s3.x,s3.y);
    ctx.lineTo(s4.x,s4.y); ctx.lineTo(s5.x,s5.y); ctx.lineTo(s6.x,s6.y); ctx.stroke();
  } else if(c.type==='I'){
    ctx.beginPath(); ctx.arc(mx,my,12,0,7); ctx.stroke();
    const a1=P(-6,0),a2=P(6,0); ctx.beginPath(); ctx.moveTo(a1.x,a1.y); ctx.lineTo(a2.x,a2.y);
    const h1=P(2,3),h2=P(2,-3); ctx.moveTo(h1.x,h1.y); ctx.lineTo(a2.x,a2.y); ctx.lineTo(h2.x,h2.y); ctx.stroke();
  } else if(c.type==='C'){
    const p1=P(-3,9),p2=P(-3,-9),p3=P(3,9),p4=P(3,-9);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y);
    ctx.moveTo(p3.x,p3.y); ctx.lineTo(p4.x,p4.y); ctx.stroke();
    // redraw inner leads to plates
    ctx.strokeStyle=col(A.x,A.y); ctx.beginPath(); ctx.moveTo(mx-ux*13,my-uy*13); ctx.lineTo(mx-ux*3,my-uy*3); ctx.stroke();
    ctx.strokeStyle=col(B.x,B.y); ctx.beginPath(); ctx.moveTo(mx+ux*13,my+uy*13); ctx.lineTo(mx+ux*3,my+uy*3); ctx.stroke();
    drawCharge(c,P);
  } else if(c.type==='L'){
    // Four half-circle bumps spanning exactly the gap between the leads, which
    // stop at ±13. The bumps used to step from −12 in 8s, so the coil ran to
    // +20 — seven units past the right lead, leaving that end visibly detached.
    // Deriving the step from the lead gap keeps the two ends meeting whatever
    // the bump count.
    ctx.strokeStyle=T.ink; ctx.beginPath();
    const bumps=4, w=26/bumps, r=w/2, ang=Math.atan2(uy,ux);
    for(let i=0;i<bumps;i++){
      const d=-13+i*w, c0=P(d+r,0);
      ctx.moveTo(P(d,0).x,P(d,0).y);
      ctx.arc(c0.x,c0.y,r,ang+Math.PI,ang,false);
    }
    ctx.stroke();
  } else if(c.type==='D'||c.type==='LED'){
    if(c.type==='LED'){
      // Brightness tracks forward current on a log scale — an LED is visibly
      // lit well before it reaches its rated 20 mA, and a linear scale would
      // show almost nothing over most of the useful range.
      const i=running&&lastResult?(lastResult.current[c.id]||0):0;
      const lit=Math.max(0,Math.min(1,Math.log10(1+Math.abs(i)/1e-4)/2.6));
      if(lit>0.02){
        const g=ctx.createRadialGradient(mx,my,2,mx,my,20);
        g.addColorStop(0,`rgba(255,120,60,${0.75*lit})`); g.addColorStop(1,'rgba(255,120,60,0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(mx,my,20,0,7); ctx.fill();
      }
      ctx.fillStyle=lit>0.02?`rgb(${Math.round(200+55*lit)},${Math.round(70+90*lit)},60)`:T.ink;
    }
    const t1=P(-6,7),t2=P(-6,-7),tip=P(6,0);
    ctx.beginPath(); ctx.moveTo(t1.x,t1.y); ctx.lineTo(t2.x,t2.y); ctx.lineTo(tip.x,tip.y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle=T.ink;
    const b1=P(6,7),b2=P(6,-7); ctx.beginPath(); ctx.moveTo(b1.x,b1.y); ctx.lineTo(b2.x,b2.y); ctx.stroke();
    if(c.type==='LED'){   // the two emission arrows that make it an LED
      for(const off of [-4,3]){
        const s=P(off-2,-9), e=P(off+3,-15);
        ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(e.x,e.y); ctx.stroke();
        let dx2=e.x-s.x, dy2=e.y-s.y; const dl=Math.hypot(dx2,dy2)||1; dx2/=dl; dy2/=dl;
        ctx.fillStyle=T.ink; ctx.beginPath(); ctx.moveTo(e.x,e.y);
        ctx.lineTo(e.x-dx2*5-dy2*2.5, e.y-dy2*5+dx2*2.5);
        ctx.lineTo(e.x-dx2*5+dy2*2.5, e.y-dy2*5-dx2*2.5); ctx.closePath(); ctx.fill();
      }
    }
  } else if(c.type==='LAMP'){
    // Filament lamp: a circle with a crossed filament, glowing with dissipated
    // power. Referenced to 1 W so an ordinary indicator bulb reads as fully on.
    const v=running&&lastResult?(lastResult.voltageAcross[c.id]||0):0;
    const i=running&&lastResult?(lastResult.current[c.id]||0):0;
    const lit=Math.max(0,Math.min(1,Math.abs(v*i)));
    if(lit>0.02){
      const g=ctx.createRadialGradient(mx,my,2,mx,my,22);
      g.addColorStop(0,`rgba(255,205,90,${0.85*lit})`); g.addColorStop(1,'rgba(255,205,90,0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(mx,my,22,0,7); ctx.fill();
    }
    ctx.fillStyle=lit>0.02?`rgba(255,225,140,${lit})`:'transparent';
    ctx.strokeStyle=T.ink;
    ctx.beginPath(); ctx.arc(mx,my,11,0,7); if(lit>0.02) ctx.fill(); ctx.stroke();
    const d=11/Math.SQRT2;
    ctx.beginPath();
    ctx.moveTo(P(-d,-d).x,P(-d,-d).y); ctx.lineTo(P(d,d).x,P(d,d).y);
    ctx.moveTo(P(-d,d).x,P(-d,d).y); ctx.lineTo(P(d,-d).x,P(d,-d).y); ctx.stroke();
  } else if(c.type==='MOT'){
    // A circle marked M, with a rotor line at the integrated shaft angle — the
    // only way the mechanical state is visible, since no node carries it.
    ctx.strokeStyle=T.ink;
    ctx.beginPath(); ctx.arc(mx,my,13,0,7); ctx.stroke();
    ctx.fillStyle=T.ink; ctx.font='bold 13px sans-serif'; ctx.textAlign='center';
    ctx.fillText('M', mx, my+5);
    // A marker on the rim, at the integrated shaft angle: the only place the
    // mechanical state is visible, since no node carries it.
    const th=c.angle??0;
    ctx.fillStyle=T.current;
    ctx.beginPath(); ctx.arc(mx+Math.cos(th)*13, my+Math.sin(th)*13, 3, 0, 7); ctx.fill();
    ctx.fillStyle=T.ink; ctx.textAlign='left';
  } else if(c.type==='CP'){
    // Polarized: a flat plate for the anode and a curved one for the cathode,
    // plus a + marker, so the orientation that matters is visible.
    const p1=P(-3,9),p2=P(-3,-9);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
    const arcC=P(9,0), ang=Math.atan2(uy,ux);
    ctx.beginPath(); ctx.arc(arcC.x,arcC.y,9,ang+Math.PI*0.62,ang+Math.PI*1.38); ctx.stroke();
    ctx.strokeStyle=col(A.x,A.y); ctx.beginPath(); ctx.moveTo(mx-ux*13,my-uy*13); ctx.lineTo(mx-ux*3,my-uy*3); ctx.stroke();
    ctx.strokeStyle=col(B.x,B.y); ctx.beginPath(); ctx.moveTo(mx+ux*13,my+uy*13); ctx.lineTo(mx+ux*3,my+uy*3); ctx.stroke();
    ctx.fillStyle=T.ink; ctx.font='11px sans-serif';
    const pp=P(-9,-13); ctx.fillText('+',pp.x-3,pp.y+4);
    drawCharge(c,P);
  } else if(isContact(c.type)){
    // A hinged blade pivoting off pin A. Open, it stands off the far contact;
    // closed, it lies across both — the same picture the schematic symbol uses,
    // which makes the state readable without selecting the part.
    const closed=contactClosed(c);
    const piv=P(-8,0), rest=P(8,0);
    ctx.strokeStyle=T.ink; ctx.fillStyle=T.ink;
    ctx.beginPath(); ctx.arc(piv.x,piv.y,2.6,0,7); ctx.fill();
    ctx.beginPath(); ctx.arc(rest.x,rest.y,2.6,0,7); ctx.fill();
    const tipP=closed?P(8,0):P(7,-10);
    ctx.beginPath(); ctx.moveTo(piv.x,piv.y); ctx.lineTo(tipP.x,tipP.y); ctx.stroke();
    if(c.type!=='SW'){   // push buttons get an actuator cap above the contacts
      const capA=P(-7,closed?-11:-14), capB=P(7,closed?-11:-14);
      ctx.beginPath(); ctx.moveTo(capA.x,capA.y); ctx.lineTo(capB.x,capB.y); ctx.stroke();
      const st1=P(0,closed?-11:-14), st2=P(0,closed?-17:-20);
      ctx.beginPath(); ctx.moveTo(st1.x,st1.y); ctx.lineTo(st2.x,st2.y); ctx.stroke();
    }
  }
  // moving current dots through the body
  // Current dots along the body. pinCurrents, not current[id]: a part built
  // from several devices has no single device current to look up.
  if(running&&lastResult){ drawFlow(ax,ay,bx,by, pinCurrents(c,lastResult)[0]||0); }
  // Label. The anchor sits one step along the component's normal, which points
  // up for a horizontal part and sideways for a vertical one. A centred label
  // is only right in the first case — on a vertical part it would straddle the
  // symbol — so side-anchored labels are aligned away from the body instead.
  ctx.fillStyle=T.label; ctx.font='10px ui-monospace,monospace';
  const lp=P(0,-18);
  const noLabel:PartType[]=['D','LED'];
  let valTxt = noLabel.includes(c.type)?'':fmt(c.value??TYPES[c.type].def,TYPES[c.type].unit);
  // A meter's label is its READING — the value it carries is only the internal
  // resistance that makes it solvable, and showing 100 MΩ next to a voltmeter
  // would be worse than showing nothing.
  if(c.type==='VM'||c.type==='AM'||c.type==='OM'){
    if(running&&lastResult){
      const {v,i}=partVI(c,lastResult);
      valTxt = c.type==='VM' ? meterLabel(c.id+':v',v,'V')
             : c.type==='AM' ? meterLabel(c.id+':i',i,'A')
             : ohmReading(v);
    } else valTxt = c.type==='VM'?'volts':c.type==='AM'?'amps':'ohms';
  }
  if(c.type==='VS'||c.type==='SQ') valTxt = fmt(c.amp??0,'V')+' '+fmt(c.freq??0,'Hz');
  if(isContact(c.type)) valTxt = contactClosed(c)?'closed':'open';
  // A motor's interesting number is its speed, not its winding resistance.
  if(c.type==='MOT') valTxt = running
    ? Math.round((c.omega??0)*60/(2*Math.PI))+' rpm'
    : fmt(c.value??TYPES.MOT.def,'Ω');
  const offX=lp.x-mx, offY=lp.y-my;
  if(Math.abs(offX)>Math.abs(offY)){
    ctx.textAlign = offX>0?'left':'right';
    ctx.fillText(valTxt, lp.x+(offX>0?2:-2), lp.y+3);
  } else {
    ctx.textAlign='center';
    ctx.fillText(valTxt, lp.x, lp.y);
  }
  ctx.textAlign='left';
}

function drawGhost(type:PartType,x:number,y:number){
  ctx.globalAlpha=0.4;
  drawComponent({id:'ghost',type,x,y,rot:ghostRot,value:TYPES[type].def},null);
  ctx.globalAlpha=1;
}

// ===========================================================================
//  PART 5 — INTERACTION
// ===========================================================================
const PLACE_TYPES:PartType[]=['R','POT','V','VS','SQ','I','C','CP','L','XF','D','LED','LAMP','VM','AM','OM','WM',
  'SW','PB','PBNC','RLY','MOT','QN','QP','MN','MP','OA','E','G','F','H','GND','MCU',
  'LOGIC','SUB',...(Object.keys(DIGITAL) as DigitalType[])];
const isPlaceType=(t:Tool):t is PartType=>(PLACE_TYPES as string[]).includes(t);
/** A wire picked out with the Select tool. Wires were the one thing on the
 *  schematic that could be drawn but never selected, so the ordinary
 *  click-then-Delete that works on every part did nothing to them. */
let selectedWire:Wire|null=null;
let mouse:{px:number;py:number;gx:number|null;gy:number|null}={px:0,py:0,gx:null,gy:null};
let wireStart:Pt|null=null;

// ---- Auto-routing ----------------------------------------------------------
// Clicking two parts should join them, not make you aim at their pins and then
// draw the corner yourself. A click anywhere on a part snaps to its nearest
// pin, and the run between two points is emitted as one or two AXIS-ALIGNED
// segments — a schematic wire that cuts diagonally across the grid is a wire
// nobody can follow.
//
// Which way the elbow turns is decided by the pins, not by the geometry: a lead
// should leave a part along the part's own axis (out of the end of a resistor,
// not sideways out of its body). Only when neither end expresses a preference
// does it fall back to "longest run first".
type Axis=[number,number]|null;
interface Box { x0:number; y0:number; x1:number; y1:number }
interface WireEnd { x:number; y:number; exit:Axis; box:Box|null }
let wireExit:Axis=null;
let wireBox:Box|null=null;   // footprint of the part the run started on

/** The direction a lead should leave this pin: along the part's own axis. */
function pinExit(c:Comp,i:number):Axis{
  const ps=pinsOf(c);
  if(ps.length<2) return [0,-1];        // ground and other single-pin symbols
  const cx=ps.reduce((s,p)=>s+p.x,0)/ps.length;
  const cy=ps.reduce((s,p)=>s+p.y,0)/ps.length;
  const dx=ps[i].x-cx, dy=ps[i].y-cy;
  if(dx===0&&dy===0) return null;
  return Math.abs(dx)>=Math.abs(dy)?[Math.sign(dx),0]:[0,Math.sign(dy)];
}

/** The rectangle a part's pins span — the region a wire must not corner in. */
function pinBox(c:Comp):Box{
  const ps=pinsOf(c);
  return {x0:Math.min(...ps.map(p=>p.x)), y0:Math.min(...ps.map(p=>p.y)),
          x1:Math.max(...ps.map(p=>p.x)), y1:Math.max(...ps.map(p=>p.y))};
}

/** Where a click lands: a part's nearest pin, or the bare grid cell. */
function wireAnchor(gxu:number,gyu:number):WireEnd{
  const c=hitComponent(gxu,gyu);
  if(!c) return {x:Math.round(gxu),y:Math.round(gyu),exit:null,box:null};
  const ps=pinsOf(c);
  let bi=0,bd=Infinity;
  ps.forEach((p,i)=>{ const d=Math.hypot(p.x-gxu,p.y-gyu); if(d<bd){ bd=d; bi=i; } });
  return {x:ps[bi].x,y:ps[bi].y,exit:pinExit(c,bi),box:pinBox(c)};
}

/** One or two right-angled segments from a to b. Empty if they coincide. */
function routeWire(a:Pt,b:Pt,from:Axis,to:Axis,boxes:(Box|null)[]=[]):Wire[]{
  if(a.x===b.x&&a.y===b.y) return [];
  if(a.x===b.x||a.y===b.y) return [{x1:a.x,y1:a.y,x2:b.x,y2:b.y}];
  // An elbow must not land inside a part's own footprint. This is not
  // cosmetic: on a multi-pin part a corner between two of its pins joins them
  // through that corner and shorts the part out. A wattmeter wired this way
  // read 0 W because its current coil had been bridged — and the schematic
  // looked perfectly reasonable.
  const blocked=(k:Pt)=>
    (k.x!==a.x||k.y!==a.y)&&(k.x!==b.x||k.y!==b.y)&&
    boxes.some(bx=>!!bx&&k.x>=bx.x0&&k.x<=bx.x1&&k.y>=bx.y0&&k.y<=bx.y1);
  // Leaving the start along its axis wins; otherwise arrive along the end's.
  // The exit's SIGN matters, not just its axis: a lead off the left end of a
  // resistor that turns right immediately runs back through the part it just
  // left. When the target is behind the pin, step off perpendicular first.
  const horizFirst =
    from ? (from[0]!==0 ? Math.sign(b.x-a.x)===from[0]
                        : Math.sign(b.y-a.y)!==from[1]) :
    to   ? to[0]===0 :                       // arrive vertically -> go across first
    Math.abs(b.x-a.x)>=Math.abs(b.y-a.y);
  const prefer = horizFirst ? {x:b.x,y:a.y} : {x:a.x,y:b.y};
  const other  = horizFirst ? {x:a.x,y:b.y} : {x:b.x,y:a.y};
  const k = blocked(prefer)&&!blocked(other) ? other : prefer;
  return [{x1:a.x,y1:a.y,x2:k.x,y2:k.y},{x1:k.x,y1:k.y,x2:b.x,y2:b.y}];
}
let ghostRot:Rot=0;
let dragging:{c:Comp;dx:number;dy:number;x0:number;y0:number}|null=null;

// ---- Rubber-band wiring ----------------------------------------------------
// Dragging a part used to leave its wires behind, so moving a finished circuit
// took it apart. Now every wire that touches a moved pin follows it, and stays
// orthogonal while it does — which is the property that makes a schematic
// readable in the first place.
//
// The trick is to do it without a richer wire model. A wire is two points, so
// an L needs two of them: at drag start each attached wire is split in place
// into a NEAR segment (pin → corner) and a FAR segment (corner → fixed end).
// The corner is derived from the wire's ORIGINAL direction, so a run that was
// horizontal stays horizontal at its fixed end and grows a vertical leg at the
// pin, exactly the way a person would have redrawn it. Both segments start
// zero-length and coincident, so nothing changes visually until the part moves;
// the degenerate ones are swept up on release.
interface WireLink {
  near:number;              // wire whose end 1 tracks the pin
  far:number|null;          // wire from the corner to the fixed end (null = no elbow)
  pin:number;               // which pin of the dragged part it follows
  qx:number; qy:number;     // the end that stays put
  orient:'h'|'v'|null;      // original run direction; null means route straight
}
/** Wires with BOTH ends on the dragged part: translated whole, never elbowed. */
interface WireCarry { i:number; x1:number; y1:number; x2:number; y2:number }
let dragLinks:WireLink[]=[];
let dragCarry:WireCarry[]=[];
let dragBody:Comp[]=[];
let dragOrigin=new Map<Comp,Pt>();
/** Probes sitting on the moving body — they travel with the node they measure. */
let dragProbes:{p:Probe;x0:number;y0:number}[]=[];

// ---- Multi-selection --------------------------------------------------------
// `selected` stays the single part the inspector edits; `multi` is the set the
// user has gathered with ⌘A or shift-click. They are deliberately separate:
// editing a value only makes sense for one part, while moving and deleting make
// sense for many, and conflating the two would mean the inspector had to guess.
let multi:Comp[]=[];

/** Take the whole schematic — the setup for "move it" or "delete it". */
function selectAll(){
  multi=comps.slice(); selected=null; selectedWire=null;
  renderInspector(); draw();
  if(multi.length) flashHint(`${multi.length} part${multi.length===1?'':'s'} selected — drag to move them together, `
    +'<span class="kbd">Del</span> to remove them.');
}
function clearMulti(){ if(multi.length){ multi=[]; renderInspector(); } }

// ---- Making a block -------------------------------------------------------
/** Wrap the current selection up as a reusable block.
 *
 *  Deliberately non-destructive: it defines the block and leaves the circuit
 *  exactly as it is. Replacing the selection in place would have to decide what
 *  becomes of every wire that crossed the boundary, and getting that wrong
 *  quietly rearranges somebody's circuit. Defining it and letting them place
 *  instances where they want is both simpler and safer, and it is how a person
 *  builds a library anyway: draw the thing once, then use it elsewhere.
 *
 *  The terminals are worked out rather than asked for. A node that carries a
 *  pin of a selected part AND a pin of an unselected one is, by definition, how
 *  this piece of circuit talks to the rest of it — so those nodes, and only
 *  those, become the block's pins.
 */
function makeBlock(){
  if(multi.length<1){ flashHint('Select the parts you want to wrap up first.'); return; }
  const chosen=new Set(multi.map(c=>c.id));
  const inside=comps.filter(c=>chosen.has(c.id));
  const outside=comps.filter(c=>!chosen.has(c.id));

  // Same union-find as buildNetlist: geometry decides what is one node.
  const parent=new Map<string,string>();
  const key=(x:number,y:number)=>x+','+y;
  const find=(k:string):string=>{ if(!parent.has(k)) parent.set(k,k);
    while(parent.get(k)!==k){ parent.set(k,parent.get(parent.get(k)!)!); k=parent.get(k)!;} return k; };
  for(const c of comps) for(const p of pinsOf(c)) find(key(p.x,p.y));
  for(const w of wires){ find(key(w.x1,w.y1)); find(key(w.x2,w.y2));
    parent.set(find(key(w.x1,w.y1)),find(key(w.x2,w.y2))); }

  // Every grid point each internal node covers, so the block can be rewired
  // from the node structure rather than from whichever wires happened to be
  // selected — that is what keeps two parts joined inside the block when the
  // wire between them ran outside the selection.
  const points=new Map<string,Pt[]>();
  const note=(p:Pt)=>{ const r=find(key(p.x,p.y)); (points.get(r)??points.set(r,[]).get(r)!).push(p); };
  for(const c of inside) for(const p of pinsOf(c)) note(p);

  const innerRoots=new Set([...points.keys()]);
  const outerRoots=new Set<string>();
  for(const c of outside) for(const p of pinsOf(c)) outerRoots.add(find(key(p.x,p.y)));

  const boundary=[...innerRoots].filter(r=>outerRoots.has(r));
  if(!boundary.length){
    flashHint('That selection does not touch the rest of the circuit, so the block '
      + 'would have no terminals. Include the parts where it connects.');
    return;
  }

  const name=(prompt('Name this block', 'Block')||'').trim();
  if(!name) return;

  // Normalise to the origin so an instance's internals do not carry the
  // coordinates they happened to be drawn at.
  const all=inside.flatMap(c=>[...pinsOf(c),{x:c.x,y:c.y}]);
  const minX=Math.min(...all.map(p=>p.x)), minY=Math.min(...all.map(p=>p.y));
  const sh=(p:Pt):Pt=>({x:p.x-minX,y:p.y-minY});

  const def:SubDef={
    name: name.slice(0,24),
    pins: boundary.map((r,i)=>{ const p=sh(points.get(r)![0]);
      return {name:`P${i+1}`,x:p.x,y:p.y}; }),
    comps: inside.map(c=>({...c,x:c.x-minX,y:c.y-minY})),
    // Copy the wires that live entirely on internal nodes, then join every
    // point of each node into a star. The stars are what guarantee electrical
    // connectivity; the copied wires are kept because a block may later be
    // opened for editing and its original shape is worth not throwing away.
    wires: [
      ...wires.filter(w=>innerRoots.has(find(key(w.x1,w.y1)))&&innerRoots.has(find(key(w.x2,w.y2))))
             .map(w=>({x1:w.x1-minX,y1:w.y1-minY,x2:w.x2-minX,y2:w.y2-minY})),
      ...[...points.entries()].flatMap(([,ps])=>{
        const a=sh(ps[0]);
        return ps.slice(1).map(q=>{ const b=sh(q); return {x1:a.x,y1:a.y,x2:b.x,y2:b.y}; });
      }),
    ],
  };

  // A fresh key every time, so making a block can never redefine one that
  // existing instances were drawn against.
  const k=`sub${Date.now().toString(36)}${Math.floor(Math.random()*1e4).toString(36)}`;
  subDefs[k]=def;
  renderBlockRail();
  pendingSub=k;
  commit();
  flashHint(`<b>${def.name}</b> is on the <b>Blocks</b> shelf with `
    + `${def.pins.length} terminal${def.pins.length===1?'':'s'}. Your circuit is unchanged — `
    + 'click the shelf entry to place a copy.');
}

/** Remove the multi-selection, and any wire left dangling by its removal. */
function deleteMulti(){
  if(!multi.length) return;
  const gone=new Set(multi);
  // Collect the pins that are about to disappear so their wires go too — a
  // deleted part that leaves its leads behind is just litter.
  const orphan=new Set(multi.flatMap(c=>pinsOf(c)).map(p=>p.x+','+p.y));
  comps=comps.filter(c=>!gone.has(c));
  // A pin position is only orphaned if no surviving part still holds it.
  for(const c of comps) for(const p of pinsOf(c)) orphan.delete(p.x+','+p.y);
  wires=wires.filter(w=>!orphan.has(w.x1+','+w.y1)&&!orphan.has(w.x2+','+w.y2));
  const n=multi.length;
  multi=[]; selected=null;
  refreshMeta(); commit(); renderInspector(); draw();
  flashHint(`Removed ${n} part${n===1?'':'s'}. <span class="kbd">⌘Z</span> puts them back.`);
}

/** Attach every wire touching `c`'s pins to the drag, splitting where needed.
 *
 *  The distinction that matters is whether a pin sits on a JUNCTION — a point
 *  something else also holds, another part's pin or a second wire end. A
 *  junction must not move: taking it along would silently unhook whatever else
 *  was there (dragging a capacitor off a resistor's pin used to orphan the
 *  resistor while still looking connected). So a junction stays where it is and
 *  the part grows a new lead back to it. Only a lead held by this pin alone —
 *  a wire with nothing else at that end — travels with the part. */
function beginWireDrag(cs:Comp[]){
  dragLinks=[]; dragCarry=[];
  dragBody=cs;
  // The moving set is treated as one rigid body: pin identity is a flat index
  // across all of its parts, so a multi-part drag reuses the whole mechanism.
  const pins=cs.flatMap(c=>pinsOf(c));
  const inSet=new Set<Comp>(cs);
  const at=(x:number,y:number)=>pins.findIndex(p=>p.x===x&&p.y===y);
  const n=wires.length;   // the loop appends; only pre-existing wires attach

  // Wires with both ends inside the body ride along whole and are not junctions.
  const carried=new Set<number>();
  for(let i=0;i<n;i++){
    const w=wires[i];
    if(at(w.x1,w.y1)>=0&&at(w.x2,w.y2)>=0){
      carried.add(i);
      dragCarry.push({i,x1:w.x1,y1:w.y1,x2:w.x2,y2:w.y2});
    }
  }

  // A probe measures a point on the schematic, so it has to travel with that
  // point — leaving it behind silently re-points it at empty grid, and the
  // scope trace it was driving goes flat with no visible cause.
  const held=new Set<string>();
  for(const p of pins) held.add(p.x+','+p.y);
  for(const i of carried){ const w=wires[i]; held.add(w.x1+','+w.y1); held.add(w.x2+','+w.y2); }
  dragProbes=scopeProbes.filter(pr=>held.has(pr.x+','+pr.y)).map(pr=>({p:pr,x0:pr.x,y0:pr.y}));

  pins.forEach((p,k)=>{
    // Every wire end sitting on this pin, ignoring the ones riding along.
    const ends:{i:number;end:1|2}[]=[];
    for(let i=0;i<n;i++){
      if(carried.has(i)) continue;
      const w=wires[i];
      if(w.x1===p.x&&w.y1===p.y) ends.push({i,end:1});
      if(w.x2===p.x&&w.y2===p.y) ends.push({i,end:2});
    }
    const sharedPin=comps.some(o=>!inSet.has(o)&&pinsOf(o).some(q=>q.x===p.x&&q.y===p.y));
    const junction=sharedPin||ends.length>1;

    if(junction){
      // Anchor the point and run a fresh lead out to the pin. Both segments
      // start collapsed onto the anchor, so an accidental click adds nothing.
      const far=wires.length; wires.push({x1:p.x,y1:p.y,x2:p.x,y2:p.y});
      const near=wires.length; wires.push({x1:p.x,y1:p.y,x2:p.x,y2:p.y});
      // 'h' puts the elbow at (pin.x, anchor.y): the lead leaves the pin
      // vertically and meets the anchor along the horizontal, which is how a
      // person redraws a part that has slid down and across.
      dragLinks.push({near,far,pin:k,qx:p.x,qy:p.y,orient:'h'});
      return;
    }
    if(ends.length!==1) return;          // a free pin has nothing to drag

    // A lead this pin alone holds: it follows, keeping its original direction
    // at the far end and growing an elbow at the pin.
    const {i,end}=ends[0];
    const w=wires[i];
    const qx=end===1?w.x2:w.x1, qy=end===1?w.y2:w.y1;
    const orient:'h'|'v'|null = p.y===qy?'h' : p.x===qx?'v' : null;
    if(orient===null){
      wires[i]={x1:p.x,y1:p.y,x2:qx,y2:qy};
      dragLinks.push({near:i,far:null,pin:k,qx,qy,orient:null});
      return;
    }
    wires[i]={x1:p.x,y1:p.y,x2:qx,y2:qy};          // becomes the FAR segment
    const near=wires.length; wires.push({x1:p.x,y1:p.y,x2:p.x,y2:p.y});
    dragLinks.push({near,far:i,pin:k,qx,qy,orient});
  });
}

/** Re-route the attached wires for the body's current position. */
function updateWireDrag(ddx:number,ddy:number){
  const pins=dragBody.flatMap(c=>pinsOf(c));
  for(const l of dragLinks){
    const p=pins[l.pin]; if(!p) continue;
    const cx=l.orient==='h'?p.x:l.orient==='v'?l.qx:p.x;
    const cy=l.orient==='h'?l.qy:l.orient==='v'?p.y:p.y;
    if(l.far===null){ wires[l.near]={x1:p.x,y1:p.y,x2:l.qx,y2:l.qy}; continue; }
    wires[l.near]={x1:p.x,y1:p.y,x2:cx,y2:cy};
    wires[l.far]={x1:cx,y1:cy,x2:l.qx,y2:l.qy};
  }
  for(const w of dragCarry){
    wires[w.i]={x1:w.x1+ddx,y1:w.y1+ddy,x2:w.x2+ddx,y2:w.y2+ddy};
  }
  for(const d of dragProbes){ d.p.x=d.x0+ddx; d.p.y=d.y0+ddy; }
}

/** Drop the zero-length segments a finished drag leaves behind. */
function endWireDrag(){
  dragLinks=[]; dragCarry=[]; dragBody=[]; dragProbes=[];
  wires=wires.filter(w=>!(w.x1===w.x2&&w.y1===w.y2));
}

// ---- Net highlighting ------------------------------------------------------
// Pointing at any wire or pin lights the whole electrical net it belongs to.
// On a dense schematic that answers the question the drawing can't: which of
// these crossing runs are actually the same conductor? Paired with the readout
// chip it also says what that conductor is doing — its voltage, and the current
// through the part under the cursor.
interface Hover { node:NodeId; x:number; y:number; comp:Comp|null }
let hover:Hover|null=null;

/** The net under the cursor, or null. Screen pixels in, grid semantics out. */
function updateHover(px:number,py:number){
  hover=null;
  if(tool!=='select'&&tool!=='probe') return;
  const w=toWorld(px,py);
  const gxu=w.x/GRID, gyu=w.y/GRID;
  const near=10/GRID/view.scale;      // ~10 screen px, in grid units

  // A pin wins over a wire: it is the more specific thing to point at.
  let best:{x:number;y:number;d:number}|null=null;
  for(const c of comps) for(const p of pinsOf(c)){
    const d=Math.hypot(p.x-gxu,p.y-gyu);
    if(d<near&&(!best||d<best.d)) best={x:p.x,y:p.y,d};
  }
  if(!best) for(const wr of wires){
    const d=distToSeg(gxu,gyu,wr);
    if(d<near&&(!best||d<best.d)) best={x:wr.x1,y:wr.y1,d};
  }
  if(best){
    const net=buildNetlist();
    hover={node:net.nodeOf(best.x,best.y),x:best.x,y:best.y,comp:hitComponent(gxu,gyu)};
  }
}

/** Wash the hovered net over the schematic, under the wires themselves. */
function drawNetHighlight(net:Netlist){
  if(!hover) return;
  const n=hover.node;
  ctx.save();
  ctx.strokeStyle=T.highlight; ctx.fillStyle=T.highlight;
  ctx.lineWidth=9/view.scale; ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.globalAlpha=0.9;
  for(const w of wires){
    if(net.nodeOf(w.x1,w.y1)!==n) continue;
    ctx.beginPath(); ctx.moveTo(gx(w.x1),gy(w.y1)); ctx.lineTo(gx(w.x2),gy(w.y2)); ctx.stroke();
  }
  for(const c of comps) for(const p of pinsOf(c)){
    if(net.nodeOf(p.x,p.y)!==n) continue;
    ctx.beginPath(); ctx.arc(gx(p.x),gy(p.y),6/view.scale,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

/** Readout chip beside the cursor: what this net is, and what it's doing. */
function drawHoverChip(){
  if(!hover) return;
  const lines:string[]=[`node ${hover.node}`];
  if(lastResult){
    lines[0]+=`  ${fmt(lastResult.nodeVoltage[hover.node]??0,'V')}`;
    if(hover.comp&&hover.comp.type!=='GND'){
      const {v,i}=partVI(hover.comp,lastResult);
      lines.push(`${hover.comp.id}  ${fmt(v,'V')}  ${fmt(i,'A')}`);
    }
  } else if(hover.comp&&hover.comp.type!=='GND'){
    lines.push(hover.comp.id);
  }
  ctx.save();
  ctx.font=`10px ${MONO}`;
  const w=Math.max(...lines.map(s=>ctx.measureText(s).width))+16;
  const h=lines.length*14+8;
  const sx=gx(hover.x)*view.scale+view.ox, sy=gy(hover.y)*view.scale+view.oy;
  // Flip to the other side of the cursor rather than run off the canvas.
  const W=cv.width/devicePixelRatio;
  let x=sx+14; if(x+w>W-8) x=sx-14-w;
  const y=sy-h-12;
  ctx.fillStyle=T.panelBg; ctx.strokeStyle=T.panelLine; ctx.lineWidth=1;
  roundRectPath(x,y,w,h,6); ctx.fill(); ctx.stroke();
  ctx.fillStyle=T.panelInk; ctx.textAlign='left';
  lines.forEach((s,k)=>ctx.fillText(s,x+8,y+16+k*14));
  ctx.restore();
}
let heldButton:Comp|null=null;   // push button currently held down by a pointer
// Panning the canvas, and the two-pointer pinch that zooms it. Tracking live
// pointers by id is what lets one finger pan while two fingers pinch.
let panning:{px:number;py:number;ox:number;oy:number}|null=null;
const pointers=new Map<number,Pt>();
let pinchDist=0;
const pointerPos=(e:PointerEvent):Pt=>{
  const r=cv.getBoundingClientRect();
  return {x:e.clientX-r.left, y:e.clientY-r.top};
};

// Nearest part whose FOOTPRINT the point falls in or near. The centroid of the
// pins used to serve, but a digital chip has all its inputs down one edge, so
// its pin centroid sits off the body entirely and the middle of the symbol —
// the obvious place to click — missed it.
/** The part under a click, and how far outside its actual outline that click
 *  landed.
 *
 *  Two distances, and the difference matters. `d` is measured from a footprint
 *  PADDED by 0.7 of a square, which is what makes a part easy to grab — you can
 *  aim near it rather than at it. `bare` is measured from the outline itself.
 *
 *  Anything choosing between a part and a wire has to compare `bare`. The
 *  padding reaches 1.4 squares past the pins, and every wire in the schematic
 *  starts at a pin, so judging by `d` makes the first stretch of every wire
 *  unreachable and a short link between two adjacent parts unclickable
 *  altogether. */
function hitComponentAt(gxu:number,gyu:number):{c:Comp;d:number;bare:number}|null{
  let best:Comp|null=null, bd=1e9, bc=1e9, bbare=1e9;
  for(const c of comps){
    const ps=pinsOf(c);
    const xs=ps.map(p=>p.x), ys=ps.map(p=>p.y);
    const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys);
    const cxu=(x0+x1)/2, cyu=(y0+y1)/2;
    const hw=(x1-x0)/2, hh=(y1-y0)/2;
    const dx=Math.max(0,Math.abs(gxu-cxu)-(hw+0.7));
    const dy=Math.max(0,Math.abs(gyu-cyu)-(hh+0.7));
    const d=Math.hypot(dx,dy);
    if(d>=0.7) continue;
    // Overlapping parts all score 0, so break the tie on which centre is nearer.
    const cd=Math.hypot(cxu-gxu,cyu-gyu);
    if(d<bd-1e-9||(Math.abs(d-bd)<1e-9&&cd<bc)){
      bd=d; bc=cd; best=c;
      bbare=Math.hypot(Math.max(0,Math.abs(gxu-cxu)-hw),Math.max(0,Math.abs(gyu-cyu)-hh));
    }
  }
  return best?{c:best,d:bd,bare:bbare}:null;
}
function hitComponent(gxu:number,gyu:number):Comp|null{
  return hitComponentAt(gxu,gyu)?.c??null;
}

/** The wire under a click, and how far off it the click landed. */
function hitWireAt(gxu:number,gyu:number):{w:Wire;i:number;d:number}|null{
  let bi=-1,bd=WIRE_GRAB;
  wires.forEach((w,i)=>{ const d=distToSeg(gxu,gyu,w); if(d<bd){ bd=d; bi=i; } });
  return bi>=0?{w:wires[bi],i:bi,d:bd}:null;
}
/** How near a click has to be, in grid squares, to count as on a wire. */
const WIRE_GRAB=0.55;

/** Which of the two the user meant.
 *
 *  A part wins whenever the click is ON it — inside its outline, pins included.
 *  That matters at a pin, where a wire starts and both are at distance zero:
 *  handing that to the wire would make a part undraggable by its own lead.
 *  Anywhere else the nearer of the two wins, measured from the part's real
 *  outline rather than from its generous grab padding. */
function pickTarget(gxu:number,gyu:number):{comp?:Comp;wire?:{w:Wire;i:number}}{
  const c=hitComponentAt(gxu,gyu), w=hitWireAt(gxu,gyu);
  if(c&&w) return (c.bare<1e-9||c.bare<w.d)?{comp:c.c}:{wire:w};
  if(w) return {wire:w};
  if(c) return {comp:c.c};
  return {};
}

// Input is handled through POINTER events, not mouse events, so one code path
// serves mouse, touch and pen alike — which is what makes the same build usable
// inside the iOS/Android shells. Touch never synthesizes the mousemove stream a
// drag needs, so a mouse-only editor can place parts on a phone but not move
// them. `touch-action:none` on the stage (see style.css) stops the browser from
// claiming the same gesture for scroll/zoom, and pointer capture keeps a drag
// tracking even when the finger leaves the canvas.
stage.addEventListener('pointermove',e=>{
  const p=pointerPos(e);
  if(pointers.has(e.pointerId)) pointers.set(e.pointerId,p);
  mouse.px=p.x; mouse.py=p.y;
  const g=toGrid(mouse.px,mouse.py); mouse.gx=g.x; mouse.gy=g.y;

  if(pointers.size>=2){                 // pinch to zoom
    const [a,b]=[...pointers.values()];
    const d=Math.hypot(a.x-b.x,a.y-b.y);
    if(pinchDist>0&&d>0) zoomAt((a.x+b.x)/2,(a.y+b.y)/2,d/pinchDist);
    pinchDist=d;
    return;
  }
  if(panning){ view.ox=panning.ox+(p.x-panning.px); view.oy=panning.oy+(p.y-panning.py); draw(); return; }
  if(dragging){
    const nx=g.x-dragging.dx, ny=g.y-dragging.dy;
    const ddx=nx-dragging.x0, ddy=ny-dragging.y0;
    // Every part of the body moves by the same delta, so a multi-selection
    // keeps its internal geometry — and therefore its internal wiring — exact.
    for(const b of dragBody){
      const o=dragOrigin.get(b); if(!o) continue;
      b.x=o.x+ddx; b.y=o.y+ddy;
    }
    updateWireDrag(ddx,ddy);
    hover=null;
  } else {
    updateHover(p.x,p.y);
  }
  draw();
});
stage.addEventListener('pointerleave',()=>{ if(hover){ hover=null; draw(); } });

// Wheel and trackpad pinch both zoom about the cursor; shift+wheel pans
// sideways, matching how schematic and CAD editors behave.
stage.addEventListener('wheel',e=>{
  e.preventDefault();
  const p=pointerPos(e as unknown as PointerEvent);
  if(e.shiftKey&&!e.ctrlKey){ view.ox-=e.deltaY||e.deltaX; draw(); return; }
  zoomAt(p.x,p.y,Math.exp(-e.deltaY*(e.ctrlKey?0.01:0.0022)));
},{passive:false});
stage.addEventListener('pointerdown',e=>{
  const pt=pointerPos(e); const px=pt.x, py=pt.y;
  const g=toGrid(px,py);
  // A finger reports no position until it touches down, so seed the hover state
  // here — otherwise the first tap of a placement has no ghost to place.
  mouse.px=px; mouse.py=py; mouse.gx=g.x; mouse.gy=g.y;

  pointers.set(e.pointerId,pt);
  if(pointers.size>=2){                 // second finger down: pinch, not edit
    const [a,b]=[...pointers.values()];
    pinchDist=Math.hypot(a.x-b.x,a.y-b.y);
    panning=null; dragging=null; endWireDrag(); wireStart=null; wireExit=null; wireBox=null; draw();
    return;
  }
  // Middle button, or space held, pans regardless of the active tool.
  if(e.button===1||spaceHeld){
    panning={px,py,ox:view.ox,oy:view.oy};
    try{ stage.setPointerCapture(e.pointerId); }catch{ /* best-effort */ }
    return;
  }
  if(isPlaceType(tool)){
    const nc:Comp={id:tool+(uid++),type:tool,x:g.x,y:g.y,rot:ghostRot,value:TYPES[tool].def};
    if(tool==='VS'){ nc.amp=5; nc.freq=1000; nc.off=0; }
    if(tool==='SQ'){ nc.amp=5; nc.freq=1000; nc.off=0; nc.duty=0.5; }
    if(tool==='POT') nc.pos=0.5;
    if(isContact(tool)) nc.on=false;   // NC buttons read `on` as "held", so this is closed
    if(tool==='XF'){ nc.l2=1; nc.k=0.99; }
    if(tool==='RLY') nc.on=false;
    if(tool==='MOT'){ nc.omega=0; nc.angle=0; }
    if(tool==='LOGIC') nc.on=false;
    if(tool==='SUB'){
      if(!pendingSub||!subDefs[pendingSub]){
        flashHint('Pick a block from the <b>Blocks</b> shelf first.'); return;
      }
      nc.sub=pendingSub; delete nc.value;
    }
    comps.push(nc);
    refreshMeta(); commit(); draw(); return;
  }
  if(tool==='wire'){
    const wp=toWorld(px,py);
    const a=wireAnchor(wp.x/GRID,wp.y/GRID);
    if(!wireStart){ wireStart={x:a.x,y:a.y}; wireExit=a.exit; wireBox=a.box; }
    else if(a.x===wireStart.x&&a.y===wireStart.y){
      // Tapping the run's own start point ends it. Double-click does the same
      // on desktop, but a double-tap on touch is the browser's zoom gesture,
      // so touch needs a way out that isn't a double-tap.
      wireStart=null; wireExit=null; wireBox=null;
    }
    else {
      const segs=routeWire(wireStart,{x:a.x,y:a.y},wireExit,a.exit,[wireBox,a.box]);
      if(segs.length){
        wires.push(...segs);
        wireStart={x:a.x,y:a.y};
        // Carry on from the new point along its own axis if it is a pin;
        // from a bare corner, continue perpendicular to the run just laid so a
        // hand-drawn polyline keeps turning instead of doubling back.
        const last=segs[segs.length-1];
        wireExit=a.exit??(last.y1===last.y2?[0,1]:[1,0]);
        wireBox=a.box;
        refreshMeta(); commit();
      }
    }
    draw(); return;
  }
  if(tool==='probe'){
    const ex=scopeProbes.findIndex(p=>p.x===g.x&&p.y===g.y);
    if(ex>=0) scopeProbes.splice(ex,1);
    else scopeProbes.push({x:g.x,y:g.y,color:SCOPE_COLORS[scopeProbes.length%SCOPE_COLORS.length]});
    resetScope(); commit(); draw(); return;
  }
  if(tool==='delete'){
    const t=pickTarget(g.x,g.y);
    if(t.comp){ const c=t.comp; comps=comps.filter(k=>k!==c); if(selected===c)selected=null; }
    else if(t.wire){ wires.splice(t.wire.i,1); if(selectedWire===t.wire.w) selectedWire=null; }
    refreshMeta(); commit(); renderInspector(); draw(); return;
  }
  // select tool
  const target=pickTarget(g.x,g.y);
  const c=target.comp??null;
  // A wire the user aimed at, and no part nearer. Selecting it is the whole
  // point: Delete then works on it exactly as it works on a component.
  if(!c&&target.wire&&!e.shiftKey){
    selectedWire=target.wire.w; selected=null; clearMulti();
    renderInspector(); draw();
    // Still fall through to panning so a drag from here moves the view.
    panning={px,py,ox:view.ox,oy:view.oy};
    try{ stage.setPointerCapture(e.pointerId); }catch{ /* best-effort */ }
    return;
  }
  selectedWire=null;
  // While the simulation runs, the schematic doubles as a control panel:
  // tapping a switch throws it and holding a push button presses it, which is
  // what these parts are for. Stopped, the same tap just selects the part.
  if(c&&running&&c.type==='LOGIC'&&!(c.value??0)){
    c.on=!c.on; selected=c; renderInspector(); syncValues(); draw(); return;
  }
  if(c&&running&&isContact(c.type)){
    if(c.type==='SW'){ c.on=!c.on; }
    else { c.on=true; heldButton=c; try{ stage.setPointerCapture(e.pointerId); }catch{ /* best-effort */ } }
    selected=c; renderInspector(); syncValues(); draw(); return;
  }
  if(c&&e.shiftKey){
    // Shift-click gathers parts one at a time, and toggles one back out.
    multi = multi.includes(c) ? multi.filter(m=>m!==c) : [...multi,c];
    selected=null; renderInspector(); draw(); return;
  }
  const inMulti=!!c&&multi.includes(c);
  if(!inMulti) clearMulti();
  // Grabbing a member of the selection must not collapse it to that one part —
  // otherwise the selection's own actions vanish the instant you reach for it.
  selected=inMulti?null:c;
  renderInspector();
  if(c){
    dragging={c,dx:g.x-c.x,dy:g.y-c.y,x0:c.x,y0:c.y};
    // Dragging any member of a multi-selection drags the whole selection.
    const body=multi.includes(c)?multi.slice():[c];
    dragOrigin=new Map(body.map(b=>[b,{x:b.x,y:b.y}]));
    beginWireDrag(body);
    // Keep receiving moves even if the pointer slides off the canvas mid-drag.
    try{ stage.setPointerCapture(e.pointerId); }catch{ /* capture is best-effort */ }
  } else {
    // Dragging empty grid pans the view — the natural gesture, and the only one
    // available to a single finger on a phone.
    panning={px,py,ox:view.ox,oy:view.oy};
    try{ stage.setPointerCapture(e.pointerId); }catch{ /* best-effort */ }
  }
  draw();
});
const endDrag=(e?:PointerEvent)=>{
  if(e) pointers.delete(e.pointerId);
  if(pointers.size<2) pinchDist=0;
  panning=null;
  // A push button is momentary — releasing the pointer releases the contact.
  if(heldButton){ heldButton.on=false; heldButton=null; syncValues(); renderInspector(); draw(); }
  if(!dragging) return;
  const moved=dragging.c.x!==dragging.x0||dragging.c.y!==dragging.y0;
  dragging=null; endWireDrag(); refreshMeta();
  if(moved) commit();   // a drag that ends where it began isn't an edit
  draw();
};
window.addEventListener('pointerup',endDrag);
window.addEventListener('pointercancel',endDrag);
stage.addEventListener('dblclick',()=>{ if(wireStart){ wireStart=null; wireExit=null; draw(); } });
const turn=(r:Rot):Rot=>((r+90)%360) as Rot;
let spaceHeld=false;
window.addEventListener('keyup',e=>{ if(e.code==='Space') spaceHeld=false; });
window.addEventListener('keydown',e=>{
  // Never steal keys from a field the user is typing in — the value inputs, the
  // part search, or the MCU code editor. R and Delete are destructive here.
  const tag=(e.target as HTMLElement|null)?.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
  const meta=e.metaKey||e.ctrlKey;
  if(e.code==='Space'){ spaceHeld=true; e.preventDefault(); }
  if(meta&&(e.key==='z'||e.key==='Z')){ e.preventDefault(); e.shiftKey?redo():undo(); return; }
  if(meta&&(e.key==='y'||e.key==='Y')){ e.preventDefault(); redo(); return; }
  // ⌘A selects the whole schematic; Delete then clears it. Distinct from the
  // Clear button only in that it is undoable in one step and leaves the view,
  // the probes and the sketch alone.
  if(meta&&(e.key==='a'||e.key==='A')){ e.preventDefault(); selectAll(); return; }
  // Zoom shortcuts, about the middle of the canvas.
  const cx=cv.width/devicePixelRatio/2, cy=cv.height/devicePixelRatio/2;
  if(e.key==='+'||e.key==='='){ zoomAt(cx,cy,1.2); return; }
  if(e.key==='-'||e.key==='_'){ zoomAt(cx,cy,1/1.2); return; }
  if(e.key==='0'){ fitView(); return; }
  if(e.key==='r'||e.key==='R'){ ghostRot=turn(ghostRot); if(selected){ selected.rot=turn(rotOf(selected)); refreshMeta(); commit(); } draw(); }
  if(e.key==='Escape'){ wireStart=null; wireExit=null; wireBox=null; selected=null; selectedWire=null; clearMulti(); setTool('select'); renderInspector(); draw(); }
  if((e.key==='Delete'||e.key==='Backspace')&&multi.length){ deleteMulti(); return; }
  if((e.key==='Delete'||e.key==='Backspace')&&selected){ comps=comps.filter(k=>k!==selected); selected=null; refreshMeta(); commit(); renderInspector(); draw(); return; }
  if((e.key==='Delete'||e.key==='Backspace')&&selectedWire){ deleteSelectedWire(); return; }
});
function deleteSelectedWire(){
  const i=selectedWire?wires.indexOf(selectedWire):-1;
  if(i<0){ selectedWire=null; return; }
  wires.splice(i,1); selectedWire=null;
  refreshMeta(); commit(); renderInspector(); draw();
}

function distToSeg(x:number,y:number,w:Wire){
  const x1=w.x1,y1=w.y1,x2=w.x2,y2=w.y2; const dx=x2-x1,dy=y2-y1;
  const t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(x-(x1+t*dx),y-(y1+t*dy));
}

// ===========================================================================
//  PART 6 — SIMULATION LOOP
// ===========================================================================
let circuit:Circuit|null=null, simTime=0, simH=1e-5, rafId:number|null=null;
/** Solver steps per animation frame. Named because the reading windows have to
 *  convert frames to simulated time, and a bare 8 in two places is a trap. */
const STEPS_PER_FRAME=8;
// ---- Oscilloscope state ----
// t and series[] run the full window; selV/selI restart whenever the selection
// changes, so they can be shorter and are drawn aligned to the newest samples.
interface ScopeBuf { t:number[]; series:number[][]; selV:number[]; selI:number[]; selId:string|null }
interface BodeCurve { color:string; label:string; mag:number[]; phase:number[] }
interface BodeData { freqs:number[]; curves:BodeCurve[] }
let scopeProbes:Probe[]=[];       // grid points to plot
let scopeBuf:ScopeBuf|null=null;
let simNet:Netlist|null=null;     // netlist captured at Run (for probe node lookup)
// Fixed, not theme-derived: a probe's colour is saved with the circuit, so it
// has to mean the same thing in both themes and in a file shared between them.
const SCOPE_COLORS=['#3b82f6','#eab308','#ef7d7d','#4ec97a','#c084fc','#fb923c'];
const SCOPE_MAX=1400;
function resetScope(){
  scopeBuf={t:[],series:scopeProbes.map(()=>[] as number[]),selV:[],selI:[],selId:selected?selected.id:null};
}
// ---- MCU co-simulation state ----------------------------------------------
let sketch='';                 // the user's source, saved with the circuit
let mcu:Mcu|null=null;
let mcuStatus='';
/** Bridges the interpreter to the live circuit: pin numbers <-> node voltages. */
const mcuHost:McuHost={
  nowMs:()=>simTime*1000,      // the solver's clock, not the wall clock
  setMode:(pin,out)=>{
    if(mcuMode.get(pin)!==out){ mcuMode.set(pin,out); rebuildMcuPins(); }
  },
  writePin:(pin,high)=>{ mcuOut.set(pin,high); syncMcuPins(); },
  readPin:pin=>{
    if(!simNet||!lastResult) return false;
    for(const c of comps){
      if(c.type==='MCU'&&(c.pin??13)===pin){
        const nd=simNet.nodeOf(c.x,c.y);
        return (lastResult.nodeVoltage[nd]??0)>MCU_THRESHOLD;
      }
    }
    return false;
  },
};
/** Push driven levels into the live solver without rebuilding the matrix. */
function syncMcuPins(){
  if(!circuit) return;
  for(const c of comps){
    if(c.type!=='MCU') continue;
    const dev=circuit.components.find(d=>d.id===c.id);
    if(dev&&dev.type==='V') dev.value=mcuOut.get(c.pin??13)?MCU_HIGH_V:0;
  }
}
/** A pin changing direction changes the DEVICE, so the matrix must be rebuilt. */
function rebuildMcuPins(){
  if(!running) return;
  const net=buildNetlist();
  const fresh=new Circuit(net.netComps.map(c=>({...c})));
  fresh.captureTrace=mathMode;
  circuit=fresh; liveIndex=null; simNet=net;
}
let panelMode:'scope'|'bode'='scope';   // transient panel or AC sweep panel
let bodeData:BodeData|null=null;
function refreshMeta(){
  el('nodeCount').textContent=(buildNetlist().nodeCount||0)+' nodes';
}
function mcuFault(msg:string){
  mcu=null; mcuStatus='Runtime error — '+msg;
  flashHint('Sketch stopped: '+msg);
  renderMcuStatus();
}
// ===========================================================================
//  STEADY READINGS — numbers you can actually read while it runs
// ===========================================================================
//  Every readout used to print the instantaneous solution at whatever timestep
//  the frame happened to land on. On anything oscillating that means the digits
//  churn through the whole waveform and none of them can be read — which is
//  exactly the thing a real instrument does not do. A bench multimeter shows one
//  settled number; a scope shows min, max and RMS.
//
//  So each measured quantity keeps a rolling band. Two buckets rather than a
//  ring buffer: the current one fills, and when it is full it becomes the
//  previous one and a fresh one starts. The reading is the union of the two, so
//  it covers between one and two bucket-lengths of recent history at O(1) memory
//  per quantity, and old history falls off instead of accumulating forever — a
//  switch-on surge should not sit in the bounds for the rest of the run.
//
//  The bucket is counted in FRAMES, not in seconds, and that is deliberate. The
//  solver picks its timestep from the circuit — 1/(200f) for a sine source, a
//  fiftieth of the time constant for a reactive network — so a fixed number of
//  frames is a fixed number of periods whatever the circuit is doing. A fixed
//  number of seconds would be two cycles of a 1 kHz sine and ten thousand of a
//  1 MHz one.
//  Two windows, not one, because the bounds and the averages want opposite
//  things. min/max should react quickly — you want to see a swing grow as you
//  turn a pot — and a short window costs them nothing, because a bound is
//  exact from a single sample that happens to be the peak.
//
//  RMS and mean are the opposite: they are integrals, and integrating over a
//  fractional number of cycles is where the error comes from. A window of ~1.6
//  cycles put a 3 V sine's RMS at 2.23 V when the answer is 2.12 — five per
//  cent out, on a figure this app has no business rounding. Eight cycles brings
//  that under half a per cent, and nobody minds an average taking a second
//  longer to settle than a bound does.
//  Both windows are measured in PERIODS of the slowest source, and both are
//  therefore sized when Run is pressed rather than fixed here. A frame count
//  cannot do the job: how much simulated time a frame covers depends on which
//  constraint set the timestep, and those differ by more than an order of
//  magnitude. In the sine-into-RC example the capacitor's time constant wins
//  and a frame is 1/78th of a period; if the source frequency had won it would
//  have been 1/25th. Forty frames is 1.6 cycles in one case and half a cycle in
//  the other — and half a cycle contains one peak, so the upper bound sagged
//  and crawled while the lower bound sat still.
const BAND_CYCLES=1.25;      // bounds: enough to be sure of catching both peaks
const AVG_CYCLES=8;          // averages: enough that RMS is right to ~0.5%
// Fallbacks for a circuit with no periodic source at all — DC, digital, a
// transient settling. Nothing there has a period to count, and such signals are
// flat or monotonic, so a plain frame count is the honest choice.
const BAND_FRAMES_DC=40, AVG_FRAMES_DC=200;

let bandFrames=BAND_FRAMES_DC, avgFrames=AVG_FRAMES_DC;

/** Size the reading windows for the circuit about to run. */
function sizeReadWindows(nc:Component[],h:number){
  const freqs=nc.flatMap(c=>c.type==='VS'&&(c.freq??0)>0?[c.freq!]:[]);
  if(!freqs.length){ bandFrames=BAND_FRAMES_DC; avgFrames=AVG_FRAMES_DC; return; }
  // The slowest source is the one that needs the longest window; anything
  // faster fits inside it several times over.
  const framesPerCycle=(1/Math.min(...freqs))/(STEPS_PER_FRAME*h);
  const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,Math.round(v)));
  bandFrames=clamp(framesPerCycle*BAND_CYCLES,8,400);
  // Rounded to a whole cycle FIRST, then multiplied — so the bucket is a whole
  // number of cycles rather than eight-and-a-bit, which is what makes the
  // average over a completed bucket come out right.
  avgFrames =clamp(Math.max(1,Math.round(framesPerCycle))*AVG_CYCLES,40,4000);
}

interface Band { min:number; max:number; sum:number; sum2:number; n:number }
const emptyBand=():Band=>({min:Infinity,max:-Infinity,sum:0,sum2:0,n:0});

/** A pair of buckets: one filling, one complete. Reporting their union covers
 *  between one and two window-lengths of recent history at fixed cost, and old
 *  history falls off rather than accumulating forever. */
class Window_ {
  private cur=emptyBand();
  private prev=emptyBand();
  constructor(private readonly size:number){}
  push(v:number){
    const b=this.cur;
    if(v<b.min) b.min=v;
    if(v>b.max) b.max=v;
    b.sum+=v; b.sum2+=v*v; b.n++;
    if(b.n>=this.size){ this.prev=this.cur; this.cur=emptyBand(); }
  }
  /** Union of both buckets: responsive, covers one to two windows. */
  get(){
    const a=this.prev,b=this.cur,n=a.n+b.n;
    if(!n) return null;
    return { min:Math.min(a.min,b.min), max:Math.max(a.max,b.max),
             mean:(a.sum+b.sum)/n, rms:Math.sqrt((a.sum2+b.sum2)/n) };
  }
  /** The last COMPLETED bucket only.
   *
   *  For an integral this matters more than being current. A bucket is sized to
   *  a whole number of cycles, so its average is over whole cycles; the union
   *  is however full the second bucket happens to be, which is a fractional
   *  cycle and exactly the error that put a 3 V sine's RMS at 2.14 instead of
   *  2.12. The cost is that averages step once per window instead of easing —
   *  which is what a settled instrument does anyway. */
  completed(){
    const a=this.prev;
    if(!a.n) return this.get();
    return { min:a.min, max:a.max, mean:a.sum/a.n, rms:Math.sqrt(a.sum2/a.n) };
  }
}

class Reading {
  // Sized at construction from the values Run computed, which is safe because
  // the map is thrown away and rebuilt on every Run.
  private bounds=new Window_(bandFrames);
  private avg=new Window_(avgFrames);
  push(v:number){
    if(!Number.isFinite(v)) return;
    this.bounds.push(v); this.avg.push(v);
  }
  /** Bounds from the short window, averages from the long one. */
  band():{min:number;max:number;rms:number;mean:number}|null{
    const s=this.bounds.get(), l=this.avg.completed();
    if(!s||!l) return null;
    return { min:s.min, max:s.max, rms:l.rms, mean:l.mean };
  }
}

/** Every quantity being tracked this run, keyed by what it measures. */
let readings=new Map<string,Reading>();
function track(key:string,v:number){
  let r=readings.get(key);
  if(!r) readings.set(key,r=new Reading());
  r.push(v);
}

// 'steady' shows the band, 'live' the instantaneous value. Some circuits are
// easier to understand watching the number move — a capacitor charging, say —
// so this is a toggle and not a decision made on the user's behalf.
type ReadMode='steady'|'live';
const READ_MODE_KEY='volta.readMode';
let readMode:ReadMode=(()=>{ try{ return localStorage.getItem(READ_MODE_KEY)==='live'?'live':'steady'; }
  catch{ return 'steady'; } })();
function setReadMode(m:ReadMode){
  readMode=m;
  try{ localStorage.setItem(READ_MODE_KEY,m); }catch{}
  renderReadout(); draw();
}

/** Is this quantity actually sitting still? A band whose whole swing is a
 *  rounding error on its own magnitude is a DC value, and printing
 *  "5.00 … 5.00 V" for it would be worse than printing "5 V". */
function isFlat(b:{min:number;max:number}):boolean{
  const peak=Math.max(Math.abs(b.min),Math.abs(b.max));
  return (b.max-b.min)<=Math.max(1e-12,peak*0.005);
}

/** The headline figure for a quantity: one number when steady, a range when
 *  not. `inst` is the instantaneous value, used in live mode and before the
 *  first window has filled. */
function reads(key:string,inst:number,unit:string):string{
  if(readMode==='live'||!running) return fmt(inst,unit);
  const b=readings.get(key)?.band();
  if(!b) return fmt(inst,unit);
  if(isFlat(b)) return fmt((b.min+b.max)/2,unit);
  const peak=Math.max(Math.abs(b.min),Math.abs(b.max));
  // A bound that is a billionth of the peak is the solver's rounding, not a
  // measurement. Power touches zero every half cycle and was reporting its
  // floor as 2.01e-14 W.
  const clean=(v:number)=>Math.abs(v)<peak*1e-9?0:v;
  const lo=clean(b.min), hi=clean(b.max);
  // A symmetric swing is how AC actually reads, and ±3 V says it in a third of
  // the space that "-3 … 3 V" takes.
  if(lo<0&&hi>0&&Math.abs(lo+hi)<=peak*0.02) return '±'+fmt(peak,unit);
  return `${fmt(lo,'').trim()} … ${fmt(hi,unit)}`;
}

/** The supporting line under a range, or '' when there is nothing to add.
 *
 *  RMS for a voltage or a current, because that is the figure a true-RMS meter
 *  gives and the one that decides heating. Power is different: the useful
 *  number is the AVERAGE, since that is the energy actually delivered per
 *  second. The RMS of a power waveform is a quantity with no physical job. */
function statOf(key:string,unit:string,kind:'rms'|'avg'='rms'):string{
  if(readMode==='live'||!running) return '';
  const b=readings.get(key)?.band();
  if(!b||isFlat(b)) return '';
  return kind==='avg' ? `${fmt(b.mean,unit)} avg` : `${fmt(b.rms,unit)} rms`;
}

/** One line for a canvas label, where there is no room for a range. A true-RMS
 *  meter is what this is imitating, so RMS is the number it shows. */
function meterLabel(key:string,inst:number,unit:string):string{
  if(readMode==='live'||!running) return fmt(inst,unit);
  const b=readings.get(key)?.band();
  if(!b) return fmt(inst,unit);
  if(isFlat(b)) return fmt((b.min+b.max)/2,unit);
  return fmt(b.rms,unit)+' rms';
}

function startSim(){
  // Readings are per-run: last run's bounds must not colour this one.
  readings=new Map();
  // Boot the MCU with the circuit: pin state must not leak between runs.
  mcuOut.clear(); mcuMode.clear(); mcu=null; mcuStatus='';
  // Mechanical state is part of the simulation, not the schematic — a motor
  // that was spinning when you pressed Stop must start from rest on Run.
  for(const c of comps){
    if(c.type==='MOT'){ c.omega=0; c.angle=0; }
    if(c.type==='RLY') c.on=false;
  }
  // Likewise the digital state: a flip-flop must power up in a known state
  // rather than wherever the previous run happened to leave it.
  digState.clear(); digDrive.clear();
  if(sketch.trim()){
    const err=checkSketch(sketch);
    if(err){ mcuStatus='Compile error — '+err; flashHint('Sketch error: '+err); }
    else { mcu=new Mcu(sketch); mcuStatus='Running'; }
    renderMcuStatus();
  }
  const net=buildNetlist();
  if(!net.grounded){ flashHint('Add a Ground symbol — the simulator needs a 0V reference.'); return; }
  if(net.netComps.length===0){ flashHint('Place some components first.'); return; }
  // choose timestep from smallest reactive time constant present
  simH=chooseTimestep(net.netComps);
  sizeReadWindows(net.netComps,simH);
  circuit=new Circuit(net.netComps.map(c=>({...c}))); liveIndex=null;
  mechanics=hasMechanics(); digital=hasDigital();
  circuit.captureTrace=mathMode;
  simNet=net; for(const p of scopeProbes) p.node=net.nodeOf(p.x,p.y);
  resetScope(); panelMode='scope';
  simTime=0; running=true;
  setRunButton(true);
  loop();
}
/** Swap the Run/Stop face. The label stays real text — it is what the e2e
 *  suite reads, and what a screen reader announces. */
function setRunButton(runningNow:boolean){
  const b=el('runBtn');
  b.innerHTML=`<svg class="ic fill" viewBox="0 0 24 24"><use href="#i-${runningNow?'stop':'play'}"/></svg>`
    +`<span>${runningNow?'Stop':'Run'}</span>`;
  b.classList.toggle('stop',runningNow);
  b.title=runningNow?'Stop the simulation (Space)':'Run the simulation (Space)';
}
function stopSim(){
  running=false; if(rafId) cancelAnimationFrame(rafId); rafId=null;
  setRunButton(false);
  draw();
}
// Restart from t=0 without touching the schematic: throws away the solver
// state, the captured waveforms and the Bode sweep, so the next Run starts
// from rest. (Clear, by contrast, deletes the circuit itself.)
function resetSim(){
  stopSim();
  circuit=null; liveIndex=null; simNet=null; simTime=0; lastResult=null; bodeData=null;
  for(const p of scopeProbes) delete p.node;
  panelMode='scope'; resetScope();
  vRange={min:-1,max:1};
  renderInspector(); draw();
  flashHint('Simulation reset to <b>t = 0</b>. Press <b>Run</b> to start again.');
}
function runBode(){
  const net=buildNetlist();
  if(!net.grounded){ flashHint('Add a Ground — AC analysis needs a 0V reference.'); return; }
  if(!net.netComps.some(c=>c.type==='V'||c.type==='VS')){ flashHint('Add a voltage source — it becomes the AC input for the sweep.'); return; }
  if(!scopeProbes.length){ flashHint('Place a Probe on the output node, then press Bode.'); return; }
  stopSim();
  const c2=new Circuit(net.netComps.map(c=>({...c})));
  const stim=net.netComps.find(c=>c.type==='V'||c.type==='VS')!.id;
  const res=c2.ac(1,1e6,240,stim);
  const curves:BodeCurve[]=scopeProbes.map((p,i)=>{
    const nd=net.nodeOf(p.x,p.y); const mag:number[]=[],phase:number[]=[];
    res.phasors.forEach(ph=>{ const Hc=ph[nd]||{re:0,im:0}; const m=Math.hypot(Hc.re,Hc.im);
      mag.push(20*Math.log10(Math.max(m,1e-9))); phase.push(Math.atan2(Hc.im,Hc.re)*180/Math.PI); });
    return {color:p.color,label:'probe '+(i+1),mag,phase};
  });
  bodeData={freqs:res.freqs,curves}; panelMode='bode';
  lastResult=c2.dc();
  flashHint('AC sweep 1 Hz–1 MHz. Solid = gain (dB), dashed = phase (°), per probe.');
  draw();
}
function chooseTimestep(nc:Component[]){
  let tau=1e-3;
  let reactive=false;
  // Reference resistance for an inductor's time constant. L/R is the decay it
  // actually has, so assuming a fixed 1 kΩ badly misjudges low-impedance
  // circuits — a relay coil or a motor armature is tens of ohms, and the fixed
  // guess makes the step 10–100× smaller than it needs to be, which is the
  // difference between a relay you watch pull in and one you wait out. Take the
  // largest resistance that looks like a real circuit element: switch contacts
  // and high-impedance pins sit decades outside that band and would otherwise
  // dominate the estimate.
  const rs=nc.flatMap(c=>c.type==='R'&&c.value>1e-2&&c.value<1e7?[c.value]:[]);
  const rRef=rs.length?Math.max(...rs):1000;
  for(const c of nc){ if(c.type==='C'){ reactive=true; tau=Math.min(tau, Math.max(1e-7,c.value*1000)); }
    if(c.type==='L'||c.type==='XF'){ reactive=true; tau=Math.min(tau, Math.max(1e-7,c.value/rRef)); } }
  // A purely resistive network has no state to integrate, so backward Euler is
  // exact at any step size — take big ones. This is what makes MCU sketches
  // watchable: at the reactive-circuit timestep, a delay(500) would take the
  // better part of a minute of wall time to elapse.
  let h=reactive?tau/50:1e-3;
  // ensure at least ~200 steps per sine period for smooth waveforms
  for(const c of nc){ if(c.type==='VS'&&(c.freq??0)>0) h=Math.min(h, 1/(c.freq!*200)); }
  return h;
}
function loop(){
  if(!running||!circuit) return;
  // Advance a few timesteps per frame for smooth transient evolution. The MCU
  // runs BEFORE each solver step, so a pin written this instant is already
  // driving the network when the step is solved — the same ordering as
  // hardware, where the port latch changes and then the circuit settles.
  for(let k=0;k<STEPS_PER_FRAME;k++){
    if(mcu){ mcu.run(mcuHost); if(mcu.error) mcuFault(mcu.error); }
    if(!circuit) break;
    lastResult=circuit.step(simH); simTime+=simH;
    // Mechanical state advances on the solution just computed, and what it
    // writes back takes effect on the next step — a relay contact can't close
    // in the same instant its coil reaches the pull-in current.
    if(mechanics) stepMechanics(lastResult,simH);
    if(digital) stepDigital(lastResult);
  }
  // Feed the steady readings once per frame, on the same solution the scope
  // samples. Every node, because the node table shows every node; the selected
  // part, because its live panel does; and every meter, because a meter that
  // flickers is a meter you cannot read.
  if(lastResult){
    const r=lastResult;
    // nodeVoltage is keyed by node id, and the internal range starts far above
    // the grid nodes, so the readout's own count is what to walk.
    const upTo=simNet?simNet.nodeCount:0;
    for(let n=0;n<upTo;n++) track('n'+n,r.nodeVoltage[n]??0);
    for(const c of comps){
      const isMeter=c.type==='VM'||c.type==='AM'||c.type==='OM'||c.type==='WM';
      if(!isMeter&&c!==selected) continue;
      if(c.type==='GND') continue;
      if(c.type==='WM'){
        const I=pinCurrents(c,r);
        track(c.id+':w',wattReading(c,r,I[0]));
        continue;
      }
      const {v,i}=partVI(c,r);
      track(c.id+':v',v); track(c.id+':i',i); track(c.id+':p',Math.abs(v*i));
    }
  }
  // sample the scope once per frame
  const net=simNet, buf=scopeBuf, res=lastResult;
  if(net&&buf&&res){
    buf.t.push(simTime);
    scopeProbes.forEach((p,i)=>{ const nd=p.node??net.nodeOf(p.x,p.y);
      buf.series[i].push(res.nodeVoltage[nd]??0); });
    // The selected component's own voltage and current. Changing selection
    // starts a fresh trace rather than splicing two parts' data together.
    const selId=selected&&selected.type!=='GND'?selected.id:null;
    if(selId!==buf.selId){ buf.selV.length=0; buf.selI.length=0; buf.selId=selId; }
    if(selId&&selected){
      const {v,i}=partVI(selected,res);
      buf.selV.push(v); buf.selI.push(i);
    }
    if(buf.t.length>SCOPE_MAX){
      buf.t.shift(); buf.series.forEach(s=>s.shift());
      if(buf.selV.length>SCOPE_MAX){ buf.selV.shift(); buf.selI.shift(); }
    }
  }
  updateVRange(); animPhase=(animPhase+0.02)%1;
  // The math panel rebuilds a chunk of DOM, so it updates a few times a second
  // rather than every frame — fast enough to read, cheap enough not to matter.
  // The matrix cannot show a range without becoming unreadable, so in steady
  // mode it slows to one snapshot per window instead — still a genuine instant,
  // just one that sits still long enough to be read. renderMath says which.
  if(mathMode&&(++mathTick%(readMode==='steady'?Math.max(12,bandFrames):12)===0)){
    mathAt=simTime; refreshMath();
  }
  draw(); renderReadout();
  rafId=requestAnimationFrame(loop);
}
function updateVRange(){
  if(!lastResult) return;
  let mn=Infinity,mx=-Infinity;
  for(const v of Object.values(lastResult.nodeVoltage)){ mn=Math.min(mn,v); mx=Math.max(mx,v); }
  if(mn===mx){ mn-=1; mx+=1; }
  vRange.min=vRange.min*0.8+mn*0.2; vRange.max=vRange.max*0.8+mx*0.2;
}

// ===========================================================================
//  PART 7 — INSPECTOR / UI CHROME
// ===========================================================================
function renderInspector(){
  const body=el('inspectorBody');
  // A wire selection is a reference INTO the wires array, and several paths
  // replace that array wholesale — Open, Clear, every gallery loader. Checking
  // it is still present here catches all of them at once, which is better than
  // remembering to clear it in each and missing one.
  if(selectedWire&&!wires.includes(selectedWire)) selectedWire=null;
  if(!selected&&selectedWire){
    const w=selectedWire;
    const len=Math.abs(w.x2-w.x1)+Math.abs(w.y2-w.y1);
    body.innerHTML=`<h3>Wire</h3>
      <div class="empty">A ${len===0?'joint':`${len}-square`} link from
        (${w.x1}, ${w.y1}) to (${w.x2}, ${w.y2}).
        Deleting it breaks whatever it joined — the parts stay put.</div>
      <hr><div class="inspectoract">
        <button class="btn danger" id="wireDel"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg>Delete wire</button>
        <button class="btn" id="wireNone">Deselect</button>
      </div>`;
    document.getElementById('wireDel')?.addEventListener('click',deleteSelectedWire);
    document.getElementById('wireNone')?.addEventListener('click',()=>{ selectedWire=null; renderInspector(); draw(); });
    renderReadout(); return;
  }
  if(!selected&&multi.length){
    body.innerHTML=`<h3>Selection</h3>
      <div class="empty"><b>${multi.length}</b> part${multi.length===1?'':'s'} selected.
        Drag any of them to move the whole selection — the wires follow and stay square.
        Shift-click a part to add or remove it.</div>
      <hr><div class="inspectoract">
        <button class="btn primary" id="multiBlock">Make a block</button>
        <button class="btn danger" id="multiDel"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg>Delete ${multi.length}</button>
        <button class="btn" id="multiNone">Deselect</button>
      </div>`;
    document.getElementById('multiBlock')?.addEventListener('click',makeBlock);
    document.getElementById('multiDel')?.addEventListener('click',deleteMulti);
    document.getElementById('multiNone')?.addEventListener('click',()=>{ clearMulti(); draw(); });
    renderReadout(); return;
  }
  if(!selected){
    body.innerHTML=`<h3>Inspector</h3><div class="empty">
      Select a component to edit its value, or scope its voltage and current.
      </div>
      <div class="shortcuts">
        <div><span class="kbd">R</span><span>Rotate</span></div>
        <div><span class="kbd">Del</span><span>Remove</span></div>
        <div><span class="kbd">Esc</span><span>Deselect</span></div>
        <div><span class="kbd">0</span><span>Fit to view</span></div>
      </div><hr>
      <h3>Legend</h3>
      <div class="swatch-row"><span class="swatch" style="background:${voltColor(-1e9)}"></span> low voltage</div>
      <div class="swatch-row"><span class="swatch" style="background:${voltColor(1e9)}"></span> high voltage</div>
      <div class="swatch-row"><span class="swatch" style="background:${T.current}"></span> current flow (moving dots)</div>`;
    renderReadout(); return;
  }
  const sel=selected;                       // narrowed for the closures below
  const t=TYPES[sel.type];
  let html=`<h3>${t.name}</h3>`;
  const noValue:PartType[]=['GND','D','LED','QN','QP','MN','MP','OA','VS','SQ','MCU','AM','OM','WM',
    'SW','PB','PBNC',...(Object.keys(DIGITAL) as PartType[])];
  if(!noValue.includes(sel.type)){
    html+=`<div class="field"><label>Value (${t.unit}) — e.g. 4.7k, 100n, 12</label>
      <input id="valInput" value="${fmt(sel.value??t.def,'').trim()}"/></div>`;
  }
  if(sel.type==='VS'||sel.type==='SQ'){
    html+=`<div class="field"><label>Amplitude (V)</label><input id="ampInput" value="${fmt(sel.amp??0,'').trim()}"/></div>
      <div class="field"><label>Frequency (Hz)</label><input id="freqInput" value="${fmt(sel.freq??0,'').trim()}"/></div>
      <div class="field"><label>DC offset (V)</label><input id="offInput" value="${fmt(sel.off||0,'').trim()}"/></div>`;
    if(sel.type==='SQ'){
      html+=`<div class="field"><label>Duty cycle (0–1) — 0.5 is a symmetric square</label>
        <input id="dutyInput" value="${sel.duty??0.5}"/></div>`;
    }
  }
  if(sel.type==='POT'){
    html+=`<div class="field"><label>Wiper position — ${Math.round((sel.pos??0.5)*100)}%</label>
      <input id="posInput" type="range" min="0" max="100" step="1" value="${Math.round((sel.pos??0.5)*100)}"/></div>
      <div class="field"><div class="empty">Track resistance splits between the two halves. Drag while
        the simulation runs to sweep it live.</div></div>`;
  }
  if(isContact(sel.type)){
    const closed=contactClosed(sel);
    const verb=sel.type==='SW'?(closed?'Open':'Close'):(closed?'Release':'Press');
    html+=`<div class="field"><label>Contact — currently <b>${closed?'closed':'open'}</b></label>
      <button class="btn" id="contactBtn">${verb}</button></div>
      <div class="field"><div class="empty">${sel.type==='SW'
        ? 'Click the switch on the schematic while running to throw it.'
        : 'Hold the button on the schematic while running to press it; it springs back on release.'}</div></div>`;
  }
  if(sel.type==='LOGIC'){
    const clock=(sel.value??0)>0;
    html+=`<div class="field"><label>Clock frequency (Hz) — 0 makes it a manual switch</label>
      <input id="valInput2" value="${fmt(sel.value??0,'').trim()}"/></div>`;
    if(!clock){
      html+=`<div class="field"><label>Level — currently <b>${sel.on?'1':'0'}</b></label>
        <button class="btn" id="logicBtn">Drive ${sel.on?'0':'1'}</button></div>
        <div class="field"><div class="empty">Click it on the schematic while running to toggle it.</div></div>`;
    } else {
      html+=`<div class="field"><div class="empty">A ${fmt(sel.value??0,'Hz')} square wave between 0 and
        ${LOGIC_HIGH} V. Changing between clock and switch changes the device, so it takes
        effect on the next Run.</div></div>`;
    }
  }
  if(isDigital(sel.type)){
    const spec=DIGITAL[sel.type];
    html+=`<div class="field"><label>Pins</label><div class="empty">
      In: ${spec.in.join(', ')||'—'}<br>Out: ${spec.out.join(', ')||'—'}</div></div>
      <div class="field"><div class="empty">Behavioural, not solved as transistors: inputs are
      high-impedance (${fmt(LOGIC_INPUT_Z,'Ω')}) and read a 1 above 2.5 V; outputs drive
      0 or ${LOGIC_HIGH} V. One timestep of propagation delay, which is what lets a
      flip-flop feed back into itself.</div></div>`;
  }
  if(sel.type==='E'||sel.type==='G'||sel.type==='F'||sel.type==='H'){
    const senses=(sel.type==='F'||sel.type==='H')
      ? 'The two left pins are an internal ammeter — a 0 V short. Wire the current you want to sense straight through them.'
      : 'The two left pins sense a voltage and draw no current of their own.';
    html+=`<div class="field"><div class="empty">${senses}
      Output is the right-hand pair, <b>+</b> on top.</div></div>`;
  }
  if(sel.type==='XF'){
    html+=`<div class="field"><label>Secondary inductance (H)</label>
      <input id="l2Input" value="${fmt(sel.l2??sel.value??1,'').trim()}"/></div>
      <div class="field"><label>Coupling k (0–1)</label>
      <input id="kInput" value="${sel.k??0.99}"/></div>
      <div class="field"><div class="empty">Turns ratio is √(L₂/L₁), so L₂ = 4·L₁ steps the
        voltage up by 2. Perfect coupling (k = 1) makes the two windings linearly
        dependent and the matrix singular — 0.99 is the useful default.</div></div>`;
  }
  if(sel.type==='RLY'){
    html+=`<div class="field"><div class="empty">Coil on the left (its value is the winding
      resistance), contact on the right. The armature pulls in above
      ${fmt(RELAY_PULL_IN,'A')} of coil current and drops out below
      ${fmt(RELAY_DROP_OUT,'A')}. Put a diode across the coil to catch the kickback.</div></div>`;
  }
  if(sel.type==='MOT'){
    html+=`<div class="field"><div class="empty">Permanent-magnet DC motor: its value is the
      armature resistance. It draws a big stall current at start-up and settles as
      the back-EMF builds — watch the rpm on the symbol while it runs.</div></div>`;
  }
  if(sel.type==='VM'){
    html+=`<div class="field"><div class="empty">Wire it <b>across</b> the thing you want to
      measure. Its value is the meter's own input resistance — high enough not to
      disturb the circuit, but finite, because a true open circuit would leave
      whatever it measures with no path to ground and nothing to solve against.
      Its reading appears on the symbol while the simulation runs.</div></div>`;
  }
  if(sel.type==='AM'){
    html+=`<div class="field"><div class="empty">Wire it <b>in series</b> — break the
      connection and put the meter in the gap, so all the current you want to
      measure flows through it. It is an ideal short with no resistance of its
      own, so it does not change the circuit. Its reading appears on the symbol
      while the simulation runs.</div></div>`;
  }
  if(sel.type==='OM'){
    html+=`<div class="field"><div class="empty">Reads the resistance between its
      pins by pushing a known ${fmt(OHM_TEST_I,'A')} through them and dividing the
      voltage that results — which is how a real ohmmeter does it.
      <b>Power the circuit down first</b>: with a source driving the same nodes
      you are measuring that source, not the resistance. Beyond
      ${fmt(OHM_OPEN_R*0.1,'Ω')} it reads <b>OL</b>, the same over-limit a bench
      meter shows rather than a number it can't stand behind.</div></div>`;
  }
  if(sel.type==='WM'){
    html+=`<div class="field"><label>Terminals</label><div class="empty">
      Two coils, like the real instrument. The <b>I</b> pair on the left is the
      current coil — break the circuit and wire it in series. The <b>V</b> pair
      on the right is the voltage coil — wire it across the load. It reports
      their product instant by instant, so on AC it reads <b>real</b> power,
      not the product of two averages.</div></div>`;
  }
  if(sel.type==='LED'){
    html+=`<div class="field"><div class="empty">A diode that lights with forward current. Add a series
      resistor — a bare LED across a supply is a short.</div></div>`;
  }
  if(sel.type==='CP'){
    html+=`<div class="field"><div class="empty">Polarized: the <b>+</b> plate must sit at the higher
      potential. The solver models it as an ordinary capacitor.</div></div>`;
  }
  if(sel.type==='QN'||sel.type==='QP'){
    html+=`<div class="field"><label>Terminals</label><div class="empty">Base = single-pin side; collector = upper pin, emitter = lower pin (arrow). β≈100.</div></div>`;
  }
  if(sel.type==='MN'||sel.type==='MP'){
    html+=`<div class="field"><label>Terminals</label><div class="empty">Gate = single-pin side; drain = upper pin, source = lower pin (arrow). Vth=1V, k=2mA/V².</div></div>`;
  }
  if(sel.type==='MCU'){
    html+=`<div class="field"><label>Digital pin number</label>
      <input id="pinInput" value="${sel.pin??13}"/></div>
      <div class="field"><div class="empty">Drives 0–5 V when your sketch sets this pin
        to OUTPUT; reads as HIGH above 2.5 V when set to INPUT. Write the sketch
        under <b>Code</b> in the toolbar.</div></div>`;
  }
  if(sel.type==='OA'){
    html+=`<div class="field"><label>Terminals</label><div class="empty">Two input pins on the left (+ upper, − lower); output on the right. Ideal gain. Needs feedback.</div></div>`;
  }
  html+=`<hr><div class="inspectoract">
    <button class="btn" onclick="rotateSel()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-rotate"/></svg>Rotate 90°</button>
    <button class="btn danger" onclick="deleteSel()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg>Delete</button>
  </div>`;
  body.innerHTML=html;
  const vi=document.getElementById('valInput') as HTMLInputElement|null;
  if(vi){ vi.addEventListener('change',()=>{ const v=parseVal(vi.value); if(!isNaN(v)&&v>0){ sel.value=v; commit(); if(circuit&&running){ syncValues(); } draw(); } });
    vi.addEventListener('keydown',e=>{ if(e.key==='Enter') vi.blur(); }); }
  const bindNum=(id:string,set:(v:number)=>void)=>{
    const inp=document.getElementById(id) as HTMLInputElement|null; if(!inp) return;
    inp.addEventListener('change',()=>{ const v=parseVal(inp.value); if(!isNaN(v)){ set(v); commit(); if(circuit&&running) syncSine(); draw(); } });
    inp.addEventListener('keydown',ev=>{ if(ev.key==='Enter') inp.blur(); }); };
  bindNum('ampInput',v=>sel.amp=v);
  bindNum('freqInput',v=>sel.freq=v);
  bindNum('offInput',v=>sel.off=v);
  bindNum('dutyInput',v=>sel.duty=Math.max(0.01,Math.min(0.99,v)));
  bindNum('pinInput',v=>sel.pin=Math.max(0,Math.round(v)));
  bindNum('l2Input',v=>sel.l2=Math.max(1e-12,v));
  bindNum('valInput2',v=>sel.value=Math.max(0,v));
  const lb=document.getElementById('logicBtn');
  if(lb) lb.addEventListener('click',()=>{
    sel.on=!sel.on; commit(); if(running) syncValues(); renderInspector(); draw();
  });
  bindNum('kInput',v=>sel.k=Math.max(0,Math.min(0.9999,v)));
  // The wiper streams on `input`, not `change`: sweeping a pot and watching the
  // circuit follow is most of the point of having one.
  const pos=document.getElementById('posInput') as HTMLInputElement|null;
  if(pos) pos.addEventListener('input',()=>{
    sel.pos=Number(pos.value)/100;
    const lab=pos.previousElementSibling; if(lab) lab.innerHTML=`Wiper position — ${pos.value}%`;
    if(running) syncValues(); draw();
  });
  if(pos) pos.addEventListener('change',()=>commit());
  const cb=document.getElementById('contactBtn');
  if(cb) cb.addEventListener('click',()=>{
    sel.on=!sel.on; commit(); if(running) syncValues(); renderInspector(); draw();
  });
  renderReadout();
}
// ---- Electromechanical co-simulation ---------------------------------------
// Relays and motors have state the solver knows nothing about: an armature
// position, a shaft speed. Each timestep we read the electrical solution, step
// that mechanical state forward, and write the consequence back as a device
// VALUE — a contact resistance, a back-EMF. Because only values change and
// never the set of devices, the matrix keeps its shape and none of this costs
// a rebuild. It is the same trick the MCU pins use, applied to physics.
let liveIndex:Map<string,Component>|null=null;
/** Set a live device's value in place, without rebuilding the netlist. */
function pokeLive(id:string,value:number){
  if(!circuit) return;
  if(!liveIndex) liveIndex=new Map(circuit.components.map(d=>[d.id,d]));
  const d=liveIndex.get(id);
  if(d&&'value' in d) d.value=value;
}
function stepMechanics(res:Solution,h:number){
  for(const c of comps){
    if(c.type==='RLY'){
      // Hysteresis between pull-in and drop-out: a coil sitting exactly at one
      // threshold would otherwise chatter on every timestep.
      const i=Math.abs(res.current[c.id+':coilR']??0);
      const on=c.on ? i>RELAY_DROP_OUT : i>RELAY_PULL_IN;
      if(on!==c.on){ c.on=on; pokeLive(c.id+':contact',on?CONTACT_CLOSED:CONTACT_OPEN); }
    } else if(c.type==='MOT'){
      // J·dω/dt = Kt·i − B·ω, forward Euler. The timestep is already small
      // enough for the electrical side, and the mechanical time constant is
      // orders of magnitude longer, so this is comfortably stable.
      const i=res.current[c.id+':Ra']??0;
      const w=c.omega??0;
      c.omega=w+h*(MOTOR_KE*i-MOTOR_B*w)/MOTOR_J;
      c.angle=(c.angle??0)+h*c.omega;
      pokeLive(c.id+':emf',MOTOR_KE*c.omega);
    }
  }
}
/** True when the document holds anything the mechanical integrator must run for. */
const hasMechanics=()=>comps.some(c=>c.type==='RLY'||c.type==='MOT');

// Evaluate every digital part against the solution just computed and drive its
// outputs for the next step. One step of delay is not an artefact to apologise
// for — it IS the propagation delay, and it's what lets a ring of inverters
// oscillate and a flip-flop feed back into its own input without the solver
// having to resolve a combinational loop.
function stepDigital(res:Solution){
  const net=simNet; if(!net) return;
  for(const c of comps){
    if(!isDigital(c.type)) continue;
    const spec=DIGITAL[c.type];
    const ps=pinsOf(c);
    const v=spec.in.map((_,i)=>res.nodeVoltage[net.nodeOf(ps[i].x,ps[i].y)]??0);
    const s=digState.get(c.id)??initialState(spec.out.length,spec.in.length);
    const r=spec.step(v,s);
    digState.set(c.id,r.s);
    const prev=digDrive.get(c.id);
    digDrive.set(c.id,r.out);
    r.out.forEach((val,j)=>{ if(!prev||prev[j]!==val) pokeLive(`${c.id}:o${j}`,val); });
  }
}
/** True when the document holds anything the digital evaluator must run for. */
const hasDigital=()=>comps.some(c=>isDigital(c.type));

function syncValues(){ // push edited values into live sim without restarting
  if(!circuit) return;
  const map=new Map(buildNetlist().netComps.map(c=>[c.id,c]));
  for(const live of circuit.components){
    const fresh=map.get(live.id);
    if(fresh&&'value' in live&&'value' in fresh&&fresh.value!==undefined) live.value=fresh.value;
    // A transformer's other two numbers are model parameters, not `value`, so
    // they need carrying across too — otherwise editing them mid-run does
    // nothing and the schematic silently disagrees with the simulation.
    if(fresh&&live.type==='XF'&&fresh.type==='XF'){ live.l2=fresh.l2; live.k=fresh.k; }
  }
}
function syncSine(){ // push edited sine params into the live sim
  if(!circuit) return;
  for(const c of circuit.components){
    if(c.type!=='VS') continue;
    const s=comps.find(k=>k.id===c.id);
    if(s&&(s.type==='VS'||s.type==='SQ')){ c.amp=s.amp; c.freq=s.freq; c.off=s.off; c.duty=s.duty; }
  }
}
// ===========================================================================
//  SHOW THE MATH — expose the solver's own working
// ===========================================================================
// The engine already computes an MNA system every step and throws it away.
// This surfaces it: the KCL equation at each node, the matrix actually solved,
// and how the Newton loop converged. It's the teaching advantage the annotated
// engine was written for — the internals are the product here, not plumbing.
let mathMode=false;
let mathTrace:SolveTrace|null=null;
let mathTick=0;

/** Node label, with ground written as 0 so terms read like a textbook. */
const vLabel=(nd:NodeId)=>nd===0?'0':`v${nd}`;

/** Build the "sum of currents leaving this node = 0" statement per node. */
function kclEquations(netComps:Component[]):string[]{
  const nodes=new Set<NodeId>();
  for(const c of netComps) for(const nd of c.nodes) if(nd!==0) nodes.add(nd);
  const eqs:string[]=[];
  for(const nd of [...nodes].sort((a,b)=>a-b)){
    const terms:string[]=[];
    for(const c of netComps){
      const [a,b]=[c.nodes[0],c.nodes[1]];
      const here=a===nd?1:b===nd?-1:0;
      const other=a===nd?b:a;
      if(c.type==='R'&&here){
        const num=other===0?vLabel(nd):`(${vLabel(nd)} − ${vLabel(other)})`;
        terms.push(`${num}/${fmt(c.value,'Ω')}`);
      } else if(c.type==='I'&&here){
        terms.push(`${here>0?'+':'−'}${fmt(c.value,'A')}`);
      } else if((c.type==='V'||c.type==='VS'||c.type==='L')&&here){
        terms.push(`${here>0?'+':'−'}i(${c.id})`);
      } else if(c.type==='C'&&here){
        const num=other===0?vLabel(nd):`(${vLabel(nd)} − ${vLabel(other)})`;
        terms.push(`${fmt(c.value,'F')}/h·${num} − hist`);
      } else if(c.nodes.length===3&&c.nodes.includes(nd)){
        terms.push(`i(${c.id})`);            // linearized each Newton pass
      }
    }
    if(terms.length) eqs.push(`${vLabel(nd)}:  ${terms.join('  +  ')}  =  0`);
  }
  return eqs;
}

/** Recompute the trace: from the live solver when running, else a DC solve. */
/** Simulated time the displayed matrix was captured at. */
let mathAt=0;
function refreshMath(){
  if(!mathMode){ mathTrace=null; return; }
  if(running&&circuit){ mathTrace=circuit.lastTrace; return; }
  const net=buildNetlist();
  if(!net.grounded||!net.netComps.length){ mathTrace=null; return; }
  const c=new Circuit(net.netComps.map(x=>({...x})));
  c.captureTrace=true;
  try{ c.dc(); mathTrace=c.lastTrace; }catch{ mathTrace=null; }
}

function renderMath(){
  const body=el('inspectorBody');
  let host=document.getElementById('mathHost');
  if(!mathMode){ if(host) host.remove(); return; }
  if(!host){ host=document.createElement('div'); host.id='mathHost'; body.appendChild(host); }
  const t=mathTrace;
  if(!t){
    host.innerHTML=`<hr><h3>Show the math</h3><div class="empty">
      Add a ground and at least one component — the solver needs a 0 V reference
      before there are equations to show.</div>`;
    return;
  }
  // Say which instant this is. A matrix that updates slowly and does not say
  // when it was taken is a matrix you cannot trust.
  const stamp=running
    ? `<div class="mathat">snapshot at t = ${fmt(mathAt,'s')}`
      + (readMode==='steady'?' · slowed so it can be read':'')+`</div>`
    : '';
  const eqs=kclEquations(buildNetlist().netComps);
  // Entries many orders below the largest one are numerically zero — a
  // reverse-biased junction stamps things like 7e-71. Printing them in full
  // makes the matrix unreadable and implies a precision that isn't there, so
  // they're shown as the same dot used for structural zeros.
  let scale=0;
  for(const row of t.A) for(const v of row) scale=Math.max(scale,Math.abs(v));
  const tiny=scale*1e-12;
  const num=(v:number)=>Math.abs(v)<=tiny?'·':fmt(v,'').trim();
  let m='<table class="mna"><tr><td></td>';
  for(const l of t.rowLabels) m+=`<th>${l}</th>`;
  m+='<th class="rhs">=</th></tr>';
  t.A.forEach((row,i)=>{
    m+=`<tr><th>${t.rowLabels[i]}</th>`;
    for(const v of row) m+=`<td${v===0?' class="z"':''}>${num(v)}</td>`;
    m+=`<td class="rhs">${num(t.z[i])}</td></tr>`;
  });
  m+='</table>';

  host.innerHTML=`<hr><h3>Show the math</h3>${stamp}
    <div class="mathnote">Kirchhoff's current law at each node — the sum of
      currents leaving is zero:</div>
    <div class="eqs">${eqs.map(e=>`<div>${e}</div>`).join('')}</div>
    <div class="mathnote">Written as a matrix, this is the system the solver
      actually inverts (A·x = z). Blank cells are zero — nodes that don't touch:</div>
    <div class="mnawrap">${m}</div>
    <div class="mathnote">Solution x:</div>
    <table class="probes">${t.rowLabels.map((l,i)=>
      `<tr><td>${l}</td><td>${fmt(t.x[i], l.startsWith('i')?'A':'V')}</td></tr>`).join('')}</table>
    <div class="mathnote">${t.nonlinear
      ? `Nonlinear: Newton-Raphson relinearized the diodes/transistors <b>${t.iterations}</b> ${t.iterations===1?'time':'times'} until the step fell below tolerance.`
      : `Linear: solved in a single pass (no Newton iteration needed).`}
      Residual max|A·x − z| = <b>${t.residual.toExponential(1)}</b>.
      ${t.h!=null?`Timestep h = ${fmt(t.h,'s')} at t = ${fmt(t.t,'s')}.`:'DC operating point (caps open, inductors shorted).'}</div>`;
}

/** One readout line, with an optional second line under the value. */
function row(label:string,value:string,sub:string):string{
  return `<div><span class="k">${label}</span><span class="v">${value}`
    + (sub?`<em>${sub}</em>`:'') + `</span></div>`;
}

/** Steady / Live. Only offered while running — stopped, there is one number
 *  and nothing to steady. */
function modeToggle():string{
  if(!running) return '';
  const b=(m:ReadMode,label:string,title:string)=>
    `<button type="button" class="seg${readMode===m?' on':''}" data-read="${m}" title="${title}">${label}</button>`;
  return `<div class="segs">`
    + b('steady','Steady','Bounds and RMS over the last moment of simulated time')
    + b('live','Live','The instantaneous value, updated every frame')
    + `</div>`;
}

// The readout is rewritten every animation frame, so anything the user has to
// AIM at cannot live in the rewritten part — a button replaced between mousedown
// and mouseup is a button that cannot be pressed. The panel is therefore three
// containers: two that churn, and one holding the Steady/Live switch that is
// written only when what it says changes.
function readoutParts(){
  const body=el('inspectorBody');
  let host=document.getElementById('readoutHost');
  if(!host){
    host=document.createElement('div'); host.id='readoutHost';
    host.innerHTML='<div id="roLive"></div><div id="roHead"></div><div id="roTable"></div>';
    body.appendChild(host);
    // renderInspector rebuilds the whole panel and takes this container with
    // it, so the cached signature has to go too — otherwise the switch is
    // "already up to date" on an element that no longer exists, and the heading
    // never comes back.
    headSig='';
    // Bound once, on the container that survives, so the handler outlives every
    // rebuild of what is inside it.
    host.addEventListener('click',e=>{
      const b=(e.target as HTMLElement).closest<HTMLElement>('[data-read]');
      if(b) setReadMode(b.dataset.read as ReadMode);
    });
  }
  return { host,
    live:document.getElementById('roLive')!,
    head:document.getElementById('roHead')!,
    table:document.getElementById('roTable')! };
}

/** What the switch currently says. Rewritten only when this changes. */
let headSig='';

function renderReadout(){
  const { host,live,head,table }=readoutParts();
  if(!lastResult){ live.innerHTML=''; head.innerHTML=''; table.innerHTML=''; headSig='';
    renderMath(); return; }
  const res=lastResult;      // narrowed for the closures below
  let rows='';
  // A meter's live panel should read like the instrument, not like a generic
  // two-terminal part: a wattmeter's own terminals drop nothing, so the stock
  // "voltage across / current / power" row would report 0 W for a meter that is
  // measuring 1.44 W on the canvas beside it.
  if(selected&&selected.type==='WM'){
    const I=pinCurrents(selected,lastResult);
    const ps=pinsOf(selected);
    const nv=(p:Pt)=>simNet?(res.nodeVoltage[simNet.nodeOf(p.x,p.y)]??0):0;
    const id=selected.id;
    rows+=`<hr><h3>Reading — ${id}</h3><div class="readout">
      ${row('Power',reads(id+':w',wattReading(selected,lastResult,I[0]),'W'),statOf(id+':w','W','avg'))}
      <div><span class="k">Load voltage</span><span class="v">${fmt(nv(ps[2])-nv(ps[3]),'V')}</span></div>
      <div><span class="k">Load current</span><span class="v">${fmt(I[0],'A')}</span></div></div>`;
  } else if(selected&&selected.type==='OM'){
    const {v}=partVI(selected,lastResult);
    rows+=`<hr><h3>Reading — ${selected.id}</h3><div class="readout">
      <div><span class="k">Resistance</span><span class="v">${ohmReading(v)}</span></div>
      <div><span class="k">Test current</span><span class="v">${fmt(OHM_TEST_I,'A')}</span></div></div>`;
  } else if(selected&&selected.type!=='GND'){
    const {v,i}=partVI(selected,lastResult);
    const id=selected.id;
    rows+=`<hr><h3>${running&&readMode==='steady'?'Reading':'Live'} — ${id}</h3><div class="readout">
      ${row('Voltage across',reads(id+':v',v,'V'),statOf(id+':v','V'))}
      ${row('Current',reads(id+':i',i,'A'),statOf(id+':i','A'))}
      ${row('Power',reads(id+':p',Math.abs(v*i),'W'),statOf(id+':p','W','avg'))}
      </div>`;
  }
  live.innerHTML=rows;
  rows='';

  const sig=`${running?1:0}|${readMode}`;
  if(sig!==headSig){
    headSig=sig;
    head.innerHTML=`<hr><div class="readhead"><h3>Node voltages</h3>${modeToggle()}</div>`;
  }
  rows+=`<table class="probes">`;
  for(const [k,v] of Object.entries(lastResult.nodeVoltage)){
    // Skip nodes that exist only inside a part. They are real unknowns to the
    // solver, but they correspond to nothing the user drew, so listing them
    // just makes the schematic look like it has nodes it doesn't.
    if(Number(k)>=INTERNAL_NODE_BASE) continue;
    const n=k===''?'0':k;
    rows+=`<tr><td>node ${n}</td><td>${reads('n'+n,v,'V')}</td></tr>`; }
  rows+=`</table>`;
  table.innerHTML=rows;
  void host;
  renderMath();   // the math panel sits below the live readout
}
// Exposed on window because the inspector markup wires them with inline onclick.
declare global {
  interface Window { rotateSel:()=>void; deleteSel:()=>void }
}
window.rotateSel=()=>{ if(selected){ selected.rot=turn(rotOf(selected)); refreshMeta(); commit(); draw(); } };
window.deleteSel=()=>{ if(selected){ comps=comps.filter(k=>k!==selected); selected=null; refreshMeta(); commit(); renderInspector(); draw(); } };

function flashHint(msg:string){ const h=el('hint'); h.innerHTML=msg; h.style.borderColor='var(--accent2)';
  setTimeout(()=>{h.style.borderColor='';},2500); }

// ---- Tool rail buttons ----
// Fifty-odd parts in one flat column is a scroll-and-hunt exercise, so they are
// filed by what they *are*. `label` is what fits under a 50px tile; `full` is
// the name a person would search for, and both feed the search index — typing
// "flip" or "555" or "capacitor" has to find the part either way.
interface RailItem { t:Tool; label:string; full?:string }
interface RailGroup { name:string; items:RailItem[] }
const RAIL_GROUPS:RailGroup[]=[
  // Filled at runtime from subDefs — see renderBlockRail. Declared here so it
  // keeps its place in the rail order and its collapsed state like any other.
  {name:'Blocks',items:[]},
  {name:'Tools',items:[
    {t:'select',label:'Select'},
    {t:'wire',label:'Wire',full:'Wire / connect pins'},
    {t:'probe',label:'Probe',full:'Voltage probe'},
    {t:'delete',label:'Delete',full:'Delete component or wire'},
  ]},
  {name:'Sources',items:[
    {t:'V',label:'Source',full:'DC voltage source'},
    {t:'VS',label:'Sine',full:'Sine voltage source'},
    {t:'SQ',label:'Square',full:'Square wave source'},
    {t:'I',label:'Current',full:'Current source'},
    {t:'GND',label:'Ground'},
  ]},
  {name:'Passives',items:[
    {t:'R',label:'Resistor'},
    {t:'POT',label:'Pot',full:'Potentiometer'},
    {t:'C',label:'Cap',full:'Capacitor'},
    {t:'CP',label:'Cap +',full:'Polarized capacitor'},
    {t:'L',label:'Inductor'},
    {t:'XF',label:'Transf',full:'Transformer'},
  ]},
  {name:'Semiconductors',items:[
    {t:'D',label:'Diode'},
    {t:'LED',label:'LED'},
    {t:'QN',label:'NPN',full:'NPN bipolar transistor'},
    {t:'QP',label:'PNP',full:'PNP bipolar transistor'},
    {t:'MN',label:'NMOS',full:'N-channel MOSFET'},
    {t:'MP',label:'PMOS',full:'P-channel MOSFET'},
    {t:'OA',label:'Op-amp',full:'Operational amplifier'},
  ]},
  {name:'Electromechanical',items:[
    {t:'SW',label:'Switch',full:'SPST toggle switch'},
    {t:'PB',label:'Button',full:'Push button, normally open'},
    {t:'PBNC',label:'Btn NC',full:'Push button, normally closed'},
    {t:'RLY',label:'Relay'},
    {t:'MOT',label:'Motor',full:'DC motor'},
    {t:'LAMP',label:'Lamp',full:'Incandescent lamp'},
  ]},
  {name:'Meters',items:[
    {t:'VM',label:'Volt',full:'Voltmeter — reads the voltage across it'},
    {t:'AM',label:'Amp',full:'Ammeter — wire it in series to read the current through it'},
    {t:'OM',label:'Ohm',full:'Ohmmeter — reads the resistance between its pins (power the circuit down first)'},
    {t:'WM',label:'Watt',full:'Wattmeter — current coil in series, voltage coil across the load'},
  ]},
  {name:'Dependent',items:[      // wraps to two lines as "Dependent sources"
    {t:'E',label:'VCVS',full:'Voltage-controlled voltage source'},
    {t:'G',label:'VCCS',full:'Voltage-controlled current source'},
    {t:'F',label:'CCCS',full:'Current-controlled current source'},
    {t:'H',label:'CCVS',full:'Current-controlled voltage source'},
  ]},
  {name:'Digital',items:[
    {t:'MCU',label:'MCU pin',full:'Microcontroller pin'},
    {t:'LOGIC',label:'Logic',full:'Logic input / clock'},
    {t:'NOT',label:'NOT',full:'NOT gate / inverter'},
    {t:'AND',label:'AND',full:'AND gate'},
    {t:'OR',label:'OR',full:'OR gate'},
    {t:'NAND',label:'NAND',full:'NAND gate'},
    {t:'NOR',label:'NOR',full:'NOR gate'},
    {t:'XOR',label:'XOR',full:'XOR gate'},
    {t:'XNOR',label:'XNOR',full:'XNOR gate'},
    {t:'SRL',label:'SR',full:'SR latch'},
    {t:'DL',label:'D latch',full:'D latch'},
    {t:'DFF',label:'D-FF',full:'D flip-flop'},
    {t:'JKFF',label:'JK-FF',full:'JK flip-flop'},
    {t:'TFF',label:'T-FF',full:'T flip-flop'},
    {t:'CNT4',label:'Counter',full:'4-bit counter'},
    {t:'SEG7',label:'7-seg',full:'7-segment display'},
    {t:'NE555',label:'555',full:'555 timer'},
    {t:'DAC4',label:'DAC',full:'4-bit digital-to-analog converter'},
    {t:'ADC4',label:'ADC',full:'4-bit analog-to-digital converter'},
  ]},
];

const RAIL_COLLAPSED_KEY='volta.rail.collapsed';
/** Group names the user has folded away, remembered between sessions. */
function collapsedGroups():Set<string>{
  try{ return new Set(JSON.parse(localStorage.getItem(RAIL_COLLAPSED_KEY)||'[]')); }
  catch{ return new Set(); }
}
function saveCollapsed(s:Set<string>){
  try{ localStorage.setItem(RAIL_COLLAPSED_KEY,JSON.stringify([...s])); }catch{}
}

function buildRail(){
  const host=el('railGroups');
  host.innerHTML='';
  const collapsed=collapsedGroups();
  for(const g of RAIL_GROUPS){
    const sec=document.createElement('section');
    sec.className='railgroup'+(collapsed.has(g.name)?'':' open');
    sec.dataset.g=g.name;

    const head=document.createElement('button');
    head.className='grouphead'; head.type='button';
    head.setAttribute('aria-expanded',String(!collapsed.has(g.name)));
    head.innerHTML=`<svg class="ic" viewBox="0 0 24 24"><use href="#i-chevron"/></svg>${g.name}`;
    head.onclick=()=>{
      const open=sec.classList.toggle('open');
      head.setAttribute('aria-expanded',String(open));
      const c=collapsedGroups();
      open?c.delete(g.name):c.add(g.name);
      saveCollapsed(c);
    };
    sec.appendChild(head);

    const grid=document.createElement('div'); grid.className='grid';
    for(const item of g.items){
      const b=document.createElement('button');
      b.className='tool'; b.type='button'; b.dataset.t=item.t;
      b.title=item.full??item.label;
      b.dataset.search=`${item.label} ${item.full??''} ${item.t}`.toLowerCase();
      b.innerHTML=miniSymbol(item.t)+`<span>${item.label}</span>`;
      b.onclick=()=>setTool(item.t);
      grid.appendChild(b);
    }
    sec.appendChild(grid);
    host.appendChild(sec);
  }
  renderBlockRail();
  updateRail();
}

/** Which definition the next placed block will be an instance of. The tool rail
 *  can only say "SUB"; this says which one. */
let pendingSub:string|null=null;

/** Redraw the Blocks group from the definitions currently loaded. Called on
 *  every change to subDefs — creating one, or opening a circuit that carries
 *  some. */
function renderBlockRail(){
  const sec=document.querySelector<HTMLElement>('.railgroup[data-g="Blocks"]');
  if(!sec) return;
  const grid=sec.querySelector<HTMLElement>('.grid');
  if(!grid) return;
  const keys=Object.keys(subDefs);
  // Nothing built yet: say how to build one rather than showing an empty shelf.
  sec.classList.toggle('empty',keys.length===0);
  grid.innerHTML='';
  if(!keys.length){
    const p=document.createElement('p');
    p.className='railnote';
    p.textContent='Select part of a circuit and choose "Make a block" to reuse it here.';
    grid.appendChild(p);
    return;
  }
  for(const k of keys){
    const d=subDefs[k];
    const b=document.createElement('button');
    b.className='tool'; b.type='button'; b.dataset.t='SUB'; b.dataset.sub=k;
    b.title=`${d.name} — ${d.pins.length} pin${d.pins.length===1?'':'s'}, `
      + `${d.comps.length} part${d.comps.length===1?'':'s'}`;
    b.dataset.search=`${d.name} block subcircuit`.toLowerCase();
    b.innerHTML=miniSymbol('SUB')+`<span>${d.name}</span>`;
    b.onclick=()=>{ pendingSub=k; setTool('SUB'); };
    grid.appendChild(b);
  }
  updateRail();
}

/** Filter the palette to parts matching `q`, hiding groups left with nothing. */
function filterRail(q:string){
  const needle=q.trim().toLowerCase();
  let hits=0;
  for(const sec of document.querySelectorAll<HTMLElement>('.railgroup')){
    let shown=0;
    for(const b of sec.querySelectorAll<HTMLElement>('.tool')){
      const match=!needle||(b.dataset.search??'').includes(needle);
      b.hidden=!match;
      if(match) shown++;
    }
    sec.hidden=shown===0;
    hits+=shown;
    // While searching, a collapsed group would hide its own matches — so a
    // search opens everything, and restores the user's folds when cleared.
    if(needle) sec.classList.add('open');
    else sec.classList.toggle('open',!collapsedGroups().has(sec.dataset.g??''));
  }
  (el('railEmpty') as HTMLElement).hidden=hits>0;
}
function miniSymbol(t:Tool){
  const s=(inner:string)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${inner}</svg>`;
  switch(t){
    case 'select': return s('<path d="M5 3l6 15 2-6 6-2z"/>');
    case 'wire': return s('<path d="M3 16h6a3 3 0 003-3 3 3 0 013-3h6"/>');
    case 'R': return s('<path d="M2 12h3l1.5-4 3 8 3-8 3 8 1.5-4H21"/>');
    case 'SUB': return s('<rect x="6" y="5" width="12" height="14" rx="2"/><path d="M2 9h4M2 15h4M18 9h4M18 15h4"/>');
    case 'V': return s('<circle cx="12" cy="12" r="7"/><path d="M12 8v8M9 12h6"/>');
    case 'VS': return s('<circle cx="12" cy="12" r="7"/><path d="M8 12a2 2 0 014 0 2 2 0 004 0"/>');
    case 'SQ': return s('<circle cx="12" cy="12" r="7"/><path d="M7 14v-4h4v4h4v-4"/>');
    case 'probe': return s('<path d="M3 21l7-7M9 11l4 4M11 9l6-6 3 3-6 6z"/>');
    case 'I': return s('<circle cx="12" cy="12" r="7"/><path d="M12 8v8M9 11l3-3 3 3"/>');
    case 'C': return s('<path d="M2 12h8M14 12h8M10 6v12M14 6v12"/>');
    case 'L': return s('<path d="M2 14h3a3 3 0 016 0 3 3 0 016 0h3"/>');
    case 'D': return s('<path d="M2 12h6M16 12h6M8 6l8 6-8 6zM16 6v12"/>');
    case 'LED': return s('<path d="M2 12h6M16 12h6M8 6l8 6-8 6zM16 6v12M13 5l3-3M16 2h-3M16 2v3M17 8l4-4M21 4h-3M21 4v3"/>');
    case 'LAMP': return s('<circle cx="12" cy="12" r="6"/><path d="M2 12h4M18 12h4M8 8l8 8M16 8l-8 8"/>');
    case 'POT': return s('<path d="M2 17h3l1.5-4 3 8 3-8 3 8 1.5-4H21M12 3v6M9 6l3 3 3-3"/>');
    case 'CP': return s('<path d="M2 12h8M14 12h8M10 5v14M14 6a9 9 0 010 12M4 6h4M6 4v4"/>');
    case 'SW': return s('<path d="M2 16h5M17 16h5M7 16l10-6"/><circle cx="7" cy="16" r="1.6"/><circle cx="17" cy="16" r="1.6"/>');
    case 'PB': return s('<path d="M2 17h5M17 17h5M7 17h10M4 9h16M12 9V4"/>');
    case 'PBNC': return s('<path d="M2 17h5M17 17h5M6 14h12M12 14V4M12 17v-3"/>');
    case 'XF': return s('<path d="M9 4v16M15 4v16M3 7a2.5 2.5 0 010 5a2.5 2.5 0 010 5M21 7a2.5 2.5 0 000 5a2.5 2.5 0 000 5M3 7h3M3 17h3M18 7h3M18 17h3"/>');
    case 'RLY': return s('<rect x="2" y="8" width="8" height="8"/><path d="M14 16h3M20 16h2M14 16l6-4"/><path d="M10 12h3" stroke-dasharray="2 2"/>');
    case 'MOT': return s('<circle cx="12" cy="12" r="7"/><path d="M2 12h3M19 12h3M9 9l6 6M15 9l-6 6"/>');
    case 'E': case 'G': case 'F': case 'H':
      return s(`<path d="M12 5l6 7-6 7-6-7z"/><path d="M2 8h3M2 16h3M19 12h3"/><text x="12" y="15" font-size="7" fill="currentColor" stroke="none" text-anchor="middle">${t}</text>`);
    case 'QN': return s('<path d="M3 12h6M9 5v14M9 9l9-5M9 15l9 5"/>');
    case 'QP': return s('<path d="M3 12h6M9 5v14M9 9l9-5M9 15l9 5M12 13.7l3 1.6"/>');
    case 'MN': return s('<path d="M3 12h4M7 6v12M10 6v12M10 8h8M10 16h8M18 4v6M18 14v6"/>');
    case 'MP': return s('<path d="M3 12h4M7 6v12M10 6v12M10 8h8M10 16h8M18 4v6M18 14v6M13 15l-2.5 1"/>');
    case 'OA': return s('<path d="M4 5v14l14-7zM2 9h2M2 15h2"/>');
    case 'LOGIC': return s('<path d="M3 8h5v8h5v-8h5v8h3M3 20h18"/>');
    case 'NOT': return s('<path d="M6 5v14l10-7zM17 12h1M2 12h4M19 12h3"/><circle cx="17.5" cy="12" r="1.6"/>');
    case 'AND': return s('<path d="M6 5h5a7 7 0 010 14H6zM2 8h4M2 16h4M18 12h4"/>');
    case 'OR': return s('<path d="M5 5q5 7 0 14q9 1 13-7q-4-8-13-7zM2 8h4M2 16h4M18 12h4"/>');
    case 'NAND': return s('<path d="M6 5h5a6 6 0 010 14H6zM2 8h4M2 16h4M20 12h2"/><circle cx="18.4" cy="12" r="1.6"/>');
    case 'NOR': return s('<path d="M5 5q5 7 0 14q8 1 12-7q-4-8-12-7zM2 8h4M2 16h4M20 12h2"/><circle cx="18.4" cy="12" r="1.6"/>');
    case 'XOR': return s('<path d="M7 5q5 7 0 14q9 1 13-7q-4-8-13-7zM3 5q5 7 0 14M2 8h3M2 16h3M20 12h2"/>');
    case 'XNOR': return s('<path d="M6 5q5 7 0 14q8 1 11-7q-3-8-11-7zM2 5q5 7 0 14M19 12h3"/><circle cx="18" cy="12" r="1.4"/>');
    case 'SEG7': case 'DFF': case 'DL': case 'SRL': case 'JKFF': case 'TFF':
    case 'CNT4': case 'NE555': case 'DAC4': case 'ADC4':
      return s(`<rect x="5" y="4" width="14" height="16" rx="1"/><path d="M2 8h3M2 16h3M19 8h3M19 16h3"/><text x="12" y="14.5" font-size="6" fill="currentColor" stroke="none" text-anchor="middle">${DIGITAL[t]?.out.length?'\u2b1a':'8'}</text>`);
    case 'VM': case 'AM': case 'OM':
      return s(`<circle cx="12" cy="12" r="7"/><path d="M2 12h3M19 12h3"/>`
        +`<text x="12" y="15.5" font-size="9" font-weight="600" fill="currentColor" stroke="none" text-anchor="middle">`
        +`${t==='VM'?'V':t==='AM'?'A':'\u03a9'}</text>`);
    case 'WM':
      return s(`<circle cx="12" cy="12" r="7"/><path d="M2 8h3M2 16h3M19 8h3M19 16h3"/>`
        +`<text x="12" y="15.5" font-size="9" font-weight="600" fill="currentColor" stroke="none" text-anchor="middle">W</text>`);
    case 'GND': return s('<path d="M12 4v8M6 12h12M8 16h8M10 20h4"/>');
    case 'MCU': return s('<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M12 17v4"/>');
    case 'delete': return s('<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/>');
  }
  return '';
}
function setTool(t:Tool){ tool=t; wireStart=null; wireExit=null; wireBox=null; updateRail();
  const hints:Partial<Record<Tool,string>>={select:'Click a part to select & drag, or a wire to select and delete it.',
    wire:'Click pin to pin to lay wire. Double-click to finish a run.',
    probe:'Click a node/wire to scope its voltage. Click again to remove. Then press Run.',
    delete:'Click a component or wire to remove it.'};
  el('hint').innerHTML=hints[t]??`Click the grid to place a <b>${isPlaceType(t)?TYPES[t].name:t}</b>. Press <span class="kbd">R</span> to rotate.`;
  draw();
}
function updateRail(){
  // Every block shares the SUB tool, so which one is armed decides which tile
  // lights up — otherwise picking one block highlights the whole shelf.
  document.querySelectorAll<HTMLElement>('.tool').forEach(b=>b.classList.toggle('active',
    b.dataset.t===tool && (b.dataset.t!=='SUB'||b.dataset.sub===pendingSub)));
}

// ---- Example circuits -----------------------------------------------------
const GALLERY=[
  {name:'RC low-pass (transient)', fn:loadRC},
  {name:'Sine → RC low-pass (scope)', fn:loadSine},
  {name:'Square wave → RC integrator', fn:loadSquare},
  {name:'MCU: blinking LED', fn:loadBlink},
  {name:'RLC bandpass (Bode)', fn:loadRLC},
  {name:'BJT common-emitter amp', fn:loadAmp},
  {name:'NMOS common-source amp', fn:loadMos},
  {name:'Non-inverting op-amp', fn:loadOpamp},
  {name:'Switch, pot & LED (click to play)', fn:loadPanel},
  {name:'Relay drives a DC motor', fn:loadRelay},
  {name:'Transformer steps 10 V up to 20 V', fn:loadXfmr},
  {name:'Digital: clock → counter → display', fn:loadCounter},
  {name:'Digital: gates on two switches', fn:loadGates},
  {name:'555 astable blinks an LED', fn:load555},
];
// A circuit you operate rather than watch: throw the switch to power the rail,
// hold the button for the lamp, and sweep the pot to dim the LED. Every part
// here is one the solver already knew how to model — the switch and the pot
// are resistors whose value the UI changes — so it doubles as the worked
// example for the whole electromechanical batch.
function loadPanel(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:2,y:4,rot:90,value:9});   // 9 V battery (2,4)-(2,6)
  comps.push({id:'GND'+(uid++),type:'GND',x:2,y:10});
  wires.push({x1:2,y1:6,x2:2,y2:10});
  // Master switch feeds the top rail. Closed at load so Run does something.
  comps.push({id:'SW'+(uid++),type:'SW',x:2,y:2,rot:0,on:true});  // (2,2)-(4,2)
  wires.push({x1:2,y1:4,x2:2,y2:2});
  wires.push({x1:4,y1:2,x2:6,y2:2});
  wires.push({x1:6,y1:2,x2:12,y2:2});
  // Branch 1 — pot in series with an LED: sweeping the wiper dims it.
  comps.push({id:'POT'+(uid++),type:'POT',x:6,y:2,rot:90,value:2000,pos:0.35}); // (6,2)-(6,4), wiper (8,3)
  wires.push({x1:6,y1:4,x2:6,y2:10});                             // bottom of the track to ground
  wires.push({x1:8,y1:3,x2:8,y2:5});                              // wiper down to the LED
  comps.push({id:'LED'+(uid++),type:'LED',x:8,y:5,rot:90});       // (8,5)-(8,7)
  wires.push({x1:8,y1:7,x2:8,y2:10});
  // Branch 2 — momentary button lighting a lamp.
  comps.push({id:'PB'+(uid++),type:'PB',x:12,y:2,rot:90});        // (12,2)-(12,4)
  comps.push({id:'LAMP'+(uid++),type:'LAMP',x:12,y:4,rot:90,value:150}); // (12,4)-(12,6)
  wires.push({x1:12,y1:6,x2:12,y2:10});
  // Ground rail. Split at each tap point: wires join at endpoints, so a run
  // that merely passes over a junction doesn't connect to it.
  wires.push({x1:2,y1:10,x2:6,y2:10});
  wires.push({x1:6,y1:10,x2:8,y2:10});
  wires.push({x1:8,y1:10,x2:12,y2:10});
  selected=null; refreshMeta(); renderInspector(); fitView(); draw();
  flashHint('Press <b>Run</b>, then click the <b>switch</b>, hold the <b>button</b>, and sweep the <b>pot</b> in the inspector.');
}
// A small control circuit switching a big load — the reason relays exist. The
// button carries only coil current; the motor's stall current goes through the
// contact. The flyback diode across the coil is the point of the example: an
// inductor whose current is interrupted will generate whatever voltage it
// takes to keep that current flowing, and the diode gives it somewhere to go.
function loadRelay(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:2,y:4,rot:90,value:12});   // 12 V (2,4)-(2,6)
  comps.push({id:'GND'+(uid++),type:'GND',x:2,y:12});
  wires.push({x1:2,y1:6,x2:2,y2:12});
  // Supply rail: up from the battery, along the top, down to the contact.
  wires.push({x1:2,y1:4,x2:2,y2:2});
  wires.push({x1:2,y1:2,x2:2,y2:0});
  wires.push({x1:2,y1:0,x2:10,y2:0});
  wires.push({x1:10,y1:0,x2:10,y2:2});
  // Control side: button -> coil, with the flyback diode across the coil.
  comps.push({id:'PB'+(uid++),type:'PB',x:2,y:2,rot:0});           // (2,2)-(4,2)
  comps.push({id:'RLY'+(uid++),type:'RLY',x:6,y:3,rot:0,value:200});
  // coil (6,2)-(6,4); contact (10,2)-(10,4)
  // Flyback diode across the coil, cathode uppermost so it blocks in normal
  // operation and only conducts on the reverse spike when the coil opens.
  comps.push({id:'D'+(uid++),type:'D',x:4,y:4,rot:270});           // (4,4)->(4,2)
  wires.push({x1:4,y1:2,x2:6,y2:2});
  wires.push({x1:4,y1:4,x2:6,y2:4});
  wires.push({x1:6,y1:4,x2:6,y2:12});
  // Load side: the contact feeds the motor.
  comps.push({id:'MOT'+(uid++),type:'MOT',x:10,y:6,rot:90,value:5}); // (10,6)-(10,8)
  wires.push({x1:10,y1:4,x2:10,y2:6});
  wires.push({x1:10,y1:8,x2:10,y2:12});
  wires.push({x1:2,y1:12,x2:6,y2:12});
  wires.push({x1:6,y1:12,x2:10,y2:12});
  selected=null; refreshMeta(); renderInspector(); fitView(); draw();
  flashHint('Press <b>Run</b>, then hold the <b>button</b>: the coil energises, the contact closes, and the motor spins up.');
}

// Turns ratio in action: L₂ = 4·L₁ is a 1:2 winding ratio, so a 10 V peak sine
// on the primary comes out as 20 V on the secondary.
function loadXfmr(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'VS'+(uid++),type:'VS',x:2,y:2,rot:90,value:10,amp:10,freq:1000,off:0});
  comps.push({id:'GND'+(uid++),type:'GND',x:2,y:8});
  wires.push({x1:2,y1:4,x2:2,y2:8});
  comps.push({id:'XF'+(uid++),type:'XF',x:6,y:3,rot:0,value:1,l2:4,k:0.999});
  // primary (6,2)-(6,4); secondary (10,2)-(10,4)
  wires.push({x1:2,y1:2,x2:6,y2:2});
  wires.push({x1:6,y1:4,x2:6,y2:8});
  comps.push({id:'R'+(uid++),type:'R',x:10,y:2,rot:90,value:10000});  // (10,2)-(10,4)
  wires.push({x1:10,y1:4,x2:10,y2:8});
  wires.push({x1:2,y1:8,x2:6,y2:8});
  wires.push({x1:6,y1:8,x2:10,y2:8});
  scopeProbes=[{x:2,y:2,color:SCOPE_COLORS[0]},{x:10,y:2,color:SCOPE_COLORS[1]}];
  selected=null; refreshMeta(); renderInspector(); fitView(); draw();
  flashHint('Press <b>Run</b>: the scope shows 10 V in on the primary and 20 V out on the secondary — √(L₂/L₁) = 2.');
}

// The digital library end to end: a clock drives a counter and the counter
// drives a display, so you can watch it count 0–F and wrap.
function loadCounter(){
  comps=[]; wires=[]; uid=1;
  // No ground symbol: every part here is digital, and digital parts carry
  // their own 0 V reference.
  comps.push({id:'LOGIC'+(uid++),type:'LOGIC',x:2,y:3,rot:0,value:5});   // 5 Hz clock
  comps.push({id:'CNT4'+(uid++),type:'CNT4',x:6,y:4,rot:0});
  // CLK (6,3), RST (6,5); Q0..Q3 at (12,1),(12,3),(12,5),(12,7)
  wires.push({x1:2,y1:3,x2:6,y2:3});
  comps.push({id:'SEG7'+(uid++),type:'SEG7',x:18,y:4,rot:0});
  // D0..D3 at (18,1),(18,3),(18,5),(18,7)
  for(let i=0;i<4;i++) wires.push({x1:12,y1:1+i*2,x2:18,y2:1+i*2});
  selected=null; refreshMeta(); renderInspector(); fitView(); draw();
  flashHint('Press <b>Run</b>: the clock ticks the counter and the display shows it count 0–F and wrap.');
}

// Two switchable inputs into three gates at once, so the truth tables are
// something you read off the schematic rather than take on trust. The two
// sources fan out on a pair of vertical buses, which is how you would draw it
// on paper and keeps every run orthogonal.
function loadGates(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'GND'+(uid++),type:'GND',x:0,y:20});
  comps.push({id:'LOGIC'+(uid++),type:'LOGIC',x:2,y:2,rot:0,value:0,on:true});   // A
  comps.push({id:'LOGIC'+(uid++),type:'LOGIC',x:2,y:4,rot:0,value:0,on:false});  // B
  // A runs down x=6, B down x=4; each gate taps both on its way past.
  wires.push({x1:2,y1:2,x2:6,y2:2});
  wires.push({x1:6,y1:2,x2:6,y2:8},{x1:6,y1:8,x2:6,y2:14});
  wires.push({x1:2,y1:4,x2:4,y2:4});
  wires.push({x1:4,y1:4,x2:4,y2:10},{x1:4,y1:10,x2:4,y2:16});
  const gates:PartType[]=['AND','OR','XOR'];
  gates.forEach((g,row)=>{
    const y=3+row*6;                       // inputs at (10,y-1) and (10,y+1)
    comps.push({id:g+(uid++),type:g,x:10,y,rot:0});
    wires.push({x1:6,y1:y-1,x2:10,y2:y-1});
    wires.push({x1:4,y1:y+1,x2:10,y2:y+1});
    comps.push({id:'LED'+(uid++),type:'LED',x:14,y,rot:0});            // (14,y)-(16,y)
    comps.push({id:'R'+(uid++),type:'R',x:16,y,rot:0,value:470});      // (16,y)-(18,y)
    wires.push({x1:18,y1:y,x2:18,y2:20});
  });
  wires.push({x1:0,y1:20,x2:18,y2:20});
  selected=null; refreshMeta(); renderInspector(); fitView(); draw();
  flashHint('Press <b>Run</b>, then click either <b>logic source</b> to toggle it and watch which LEDs light.');
}

// The classic astable: the capacitor charges through R1+R2 to two thirds of the
// supply, the 555 flips and dumps it through R2 back to one third, and round
// again. It exercises both comparators, the latch, and the open-drain discharge
// pin at once — the whole part in one circuit.
function load555(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:0,y:2,rot:90,value:9});    // (0,2)+ .. (0,4)-
  comps.push({id:'GND'+(uid++),type:'GND',x:0,y:18});
  wires.push({x1:0,y1:4,x2:0,y2:18});
  comps.push({id:'NE555'+(uid++),type:'NE555',x:8,y:4,rot:0});
  // VCC (8,0), TRIG (8,2), THR (8,4), RST (8,6), CTRL (8,8); OUT (14,3), DIS (14,5)
  // Supply rail across the top, with a branch down to hold RESET high.
  wires.push({x1:0,y1:2,x2:0,y2:0},{x1:0,y1:0,x2:2,y2:0});
  wires.push({x1:2,y1:0,x2:8,y2:0});
  wires.push({x1:2,y1:0,x2:2,y2:6},{x1:2,y1:6,x2:8,y2:6});
  // Timing network: R1 from the supply to DISCHARGE, R2 on down to the cap.
  comps.push({id:'R'+(uid++),type:'R',x:20,y:0,rot:0,value:10000});   // R1 (20,0)-(22,0)
  wires.push({x1:8,y1:0,x2:20,y2:0});
  wires.push({x1:22,y1:0,x2:22,y2:5});
  wires.push({x1:14,y1:5,x2:22,y2:5});                               // DISCHARGE taps the junction
  comps.push({id:'R'+(uid++),type:'R',x:22,y:5,rot:90,value:47000});  // R2 (22,5)-(22,7)
  comps.push({id:'C'+(uid++),type:'C',x:22,y:9,rot:90,value:1e-6});   // C (22,9)-(22,11)
  wires.push({x1:22,y1:7,x2:22,y2:9});
  wires.push({x1:22,y1:11,x2:22,y2:18});
  // The cap voltage is what both comparators watch, so it feeds THR and TRIG.
  // Routed under the chip at y=10, clear of the body.
  wires.push({x1:22,y1:9,x2:22,y2:10},{x1:22,y1:10,x2:6,y2:10});
  wires.push({x1:6,y1:10,x2:6,y2:4},{x1:6,y1:4,x2:8,y2:4});
  wires.push({x1:6,y1:4,x2:6,y2:2},{x1:6,y1:2,x2:8,y2:2});
  // The output drives an LED.
  comps.push({id:'R'+(uid++),type:'R',x:16,y:3,rot:0,value:470});     // (16,3)-(18,3)
  wires.push({x1:14,y1:3,x2:16,y2:3});
  comps.push({id:'LED'+(uid++),type:'LED',x:18,y:3,rot:90});          // (18,3)-(18,5)
  wires.push({x1:18,y1:5,x2:18,y2:18});
  wires.push({x1:0,y1:18,x2:18,y2:18},{x1:18,y1:18,x2:22,y2:18});
  scopeProbes=[{x:22,y:9,color:SCOPE_COLORS[0]},{x:14,y:3,color:SCOPE_COLORS[1]}];
  selected=null; refreshMeta(); renderInspector(); fitView(); draw();
  flashHint('Press <b>Run</b>: the scope shows the capacitor ramping between one third and two thirds of the supply while the output squares off.');
}

function buildGallery(){
  const sel=el('gallery') as HTMLSelectElement;
  sel.innerHTML='<option value="">Examples ▾</option>'+GALLERY.map((g,i)=>`<option value="${i}">${g.name}</option>`).join('');
  sel.onchange=()=>{ const i=sel.value; if(i!==''){ GALLERY[+i].fn(); commit(); } sel.value=''; };
}

// ===========================================================================
//  PART 8 — PERSISTENCE  (save / open / share)
// ===========================================================================
// A circuit is fully described by its parts, wires and probes — nothing else
// needs to be stored. Runtime state (the solver, animation) is rebuilt on load.
interface SavedModel { v:number; comps:Comp[]; wires:Wire[]; probes?:Probe[]; sketch?:string;
  /** Block definitions travel with the document. A circuit that uses a block
   *  and does not carry it is a circuit nobody else can open. */
  subs?:Record<string,SubDef> }
function serializeModel():SavedModel{
  return { v:1,
    comps: comps.map(c=>({...c})),
    wires: wires.map(w=>({...w})),
    probes: scopeProbes.map(p=>({x:p.x,y:p.y,color:p.color})),
    // The firmware is part of the design: save, open and share carry it too.
    ...(sketch.trim()?{sketch}:{}),
    ...(Object.keys(subDefs).length?{subs:JSON.parse(JSON.stringify(subDefs))}:{}) };
}
function applyModel(m:SavedModel){
  if(!m||!Array.isArray(m.comps)||!Array.isArray(m.wires)) throw new Error('not a Spark circuit');
  stopSim();
  comps=m.comps.map(c=>({...c}));
  wires=m.wires.map(w=>({...w}));
  scopeProbes=(m.probes||[]).map((p,i)=>({x:p.x,y:p.y,color:p.color||SCOPE_COLORS[i%SCOPE_COLORS.length]}));
  sketch=typeof m.sketch==='string'?m.sketch:'';
  // Merged, not replaced. Opening a circuit that uses a block should not throw
  // away the blocks already defined in this session — and a document that
  // carries a definition is authoritative for that name, because its instances
  // were drawn against it.
  subDefs={...subDefs,...(m.subs&&typeof m.subs==='object'?m.subs:{})};
  renderBlockRail();
  // rebuild the id counter so new parts never collide with loaded ones
  let mx=0; for(const c of comps){ const n=parseInt(String(c.id).replace(/\D/g,''),10); if(n>mx) mx=n; }
  uid=mx+1;
  lastResult=null; selected=null; bodeData=null; panelMode='scope'; resetScope();
  refreshMeta(); renderInspector(); draw();
}
// ---- Undo / redo -----------------------------------------------------------
// History is a stack of whole-document snapshots (the same JSON that Save and
// Share produce). The document is small — parts, wires and probes — so cloning
// it per edit is far simpler than tracking inverse operations, and it means any
// future edit is automatically undoable without extra bookkeeping.
const HISTORY_LIMIT=100;
const undoStack:string[]=[];
const redoStack:string[]=[];
let historyPrev=''; // the document as of the last commit
const snapshot=()=>JSON.stringify(serializeModel());

/** Call after any change to the document to make it undoable. */
function commit(){
  undoStack.push(historyPrev);
  if(undoStack.length>HISTORY_LIMIT) undoStack.shift();
  redoStack.length=0;
  historyPrev=snapshot();
  updateHistoryButtons();
}
function updateHistoryButtons(){
  (el('undoBtn') as HTMLButtonElement).disabled=undoStack.length===0;
  (el('redoBtn') as HTMLButtonElement).disabled=redoStack.length===0;
}
function undo(){
  if(!undoStack.length) return;
  redoStack.push(snapshot());
  const prev=undoStack.pop()!;
  applyModel(JSON.parse(prev));
  historyPrev=prev; updateHistoryButtons();
}
function redo(){
  if(!redoStack.length) return;
  undoStack.push(snapshot());
  const next=redoStack.pop()!;
  applyModel(JSON.parse(next));
  historyPrev=next; updateHistoryButtons();
}

function saveFile(){
  const blob=new Blob([JSON.stringify(serializeModel(),null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='spark-circuit.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  flashHint('Saved <b>spark-circuit.json</b> to your downloads.');
}
function openFile(){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange=()=>{ const f=inp.files?.[0]; if(!f) return; const r=new FileReader();
    r.onload=()=>{ try{ applyModel(JSON.parse(String(r.result))); commit(); flashHint('Loaded <b>'+f.name+'</b>.'); }
      catch(e){ flashHint('Could not open that file — '+(e instanceof Error?e.message:String(e))); } };
    r.readAsText(f); };
  inp.click();
}
// Circuit <-> URL hash: JSON, then UTF-8-safe base64. Small circuits fit easily.
function encodeModel(m:SavedModel){ return btoa(unescape(encodeURIComponent(JSON.stringify(m)))); }
function decodeModel(s:string):SavedModel{ return JSON.parse(decodeURIComponent(escape(atob(s)))); }
function shareURL(){
  const code=encodeModel(serializeModel());
  const url=location.origin+location.pathname+'#c='+code;
  try{ history.replaceState(null,'','#c='+code); }catch{ /* hash update is best-effort */ }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(()=>flashHint('Shareable link copied to your clipboard.'),
      ()=>flashHint('Link is in the address bar — copy it to share.'));
  } else flashHint('Link is in the address bar — copy it to share.');
}
function loadFromHash(){
  const h=location.hash||''; const m=h.match(/#c=(.+)$/);
  if(!m) return false;
  try{ applyModel(decodeModel(m[1])); return true; }
  catch{ return false; }
}

// Series RLC bandpass (L=10mH, C=1µF -> f0≈1.6kHz), output across R. A probe
// on the output is pre-placed — press Bode to see the resonant peak.
function loadRLC(){
  comps=[]; wires=[]; uid=1; scopeProbes=[];
  comps.push({id:'VS'+(uid++),type:'VS',x:4,y:6,rot:90,value:1,amp:1,freq:1600,off:0});
  wires.push({x1:4,y1:8,x2:4,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:10});
  wires.push({x1:4,y1:6,x2:6,y2:6});
  comps.push({id:'L'+(uid++),type:'L',x:6,y:6,rot:0,value:0.01});   // (6,6)-(8,6)
  comps.push({id:'C'+(uid++),type:'C',x:8,y:6,rot:0,value:1e-6});   // (8,6)-(10,6)
  comps.push({id:'R'+(uid++),type:'R',x:10,y:6,rot:90,value:50});   // output (10,6)-(10,8)
  wires.push({x1:10,y1:8,x2:10,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:10});
  scopeProbes.push({x:10,y:6,color:SCOPE_COLORS[0]}); // output across R
  scopeProbes.push({x:4,y:6,color:SCOPE_COLORS[1]});  // input
  resetScope();
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Series RLC bandpass. Press <b>Bode</b> for the resonant peak near 1.6kHz — or <b>Run</b> to see it in time.');
}

// Digital pin 13 driving an LED through a series resistor — the first thing
// anyone builds on a microcontroller, and the smallest circuit that proves the
// firmware and the analog solver are genuinely running against each other.
function loadBlink(){
  comps=[]; wires=[]; uid=1; scopeProbes=[];
  comps.push({id:'MCU'+(uid++),type:'MCU',x:6,y:4,pin:13});
  comps.push({id:'R'+(uid++),type:'R',x:6,y:4,rot:90,value:330});  // (6,4)-(6,6)
  comps.push({id:'D'+(uid++),type:'D',x:6,y:6,rot:90,value:0});    // (6,6)-(6,8)
  wires.push({x1:6,y1:8,x2:6,y2:10});
  comps.push({id:'GND'+(uid++),type:'GND',x:6,y:10});
  scopeProbes.push({x:6,y:4,color:SCOPE_COLORS[0]});               // the pin itself
  scopeProbes.push({x:6,y:6,color:SCOPE_COLORS[1]});               // across the LED
  sketch=BLINK_SKETCH;
  resetScope();
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('MCU blink — press <b>Run</b>. The sketch under <b>🔌 Code</b> toggles pin 13 every 500 ms.');
}

// A 0→5V square wave into an RC whose time constant is a few periods long, so
// the capacitor can't follow the edges and integrates them into the classic
// exponential ramp. Probes on the input and output show both at once.
function loadSquare(){
  comps=[]; wires=[]; uid=1; scopeProbes=[];
  comps.push({id:'SQ'+(uid++),type:'SQ',x:4,y:6,rot:90,value:5,amp:2.5,freq:500,off:2.5,duty:0.5});
  wires.push({x1:4,y1:8,x2:4,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:10});
  wires.push({x1:4,y1:6,x2:6,y2:6});
  comps.push({id:'R'+(uid++),type:'R',x:6,y:6,rot:0,value:4700});   // input(6,6)->output(8,6)
  comps.push({id:'C'+(uid++),type:'C',x:8,y:6,rot:90,value:2.2e-7});// tau ≈ 1ms vs 2ms period
  wires.push({x1:8,y1:8,x2:8,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:8,y:10});
  scopeProbes.push({x:4,y:6,color:SCOPE_COLORS[0]});  // square input
  scopeProbes.push({x:8,y:6,color:SCOPE_COLORS[1]});  // integrated output
  resetScope();
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Square wave into an RC integrator — press <b>Run</b>. Blue is the square input, yellow the exponential ramp.');
}

// Sine source into an RC low-pass (fc≈800Hz), driven at the cutoff. Two scope
// probes are pre-placed on the input and output so the roll-off is visible.
function loadSine(){
  comps=[]; wires=[]; uid=1; scopeProbes=[];
  comps.push({id:'VS'+(uid++),type:'VS',x:4,y:6,rot:90,value:3,amp:3,freq:800,off:0});
  wires.push({x1:4,y1:8,x2:4,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:10});
  wires.push({x1:4,y1:6,x2:6,y2:6});
  comps.push({id:'R'+(uid++),type:'R',x:6,y:6,rot:0,value:2000});   // input(6,6)->output(8,6)
  comps.push({id:'C'+(uid++),type:'C',x:8,y:6,rot:90,value:1e-7});  // output->(8,8)
  wires.push({x1:8,y1:8,x2:8,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:8,y:10});
  scopeProbes.push({x:4,y:6,color:SCOPE_COLORS[0]});  // input
  scopeProbes.push({x:8,y:6,color:SCOPE_COLORS[1]});  // output
  resetScope();
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Sine → RC low-pass at cutoff. Press <b>Run</b> — scope shows input (blue) vs the attenuated, lagging output (yellow).');
}

// NMOS common-source amplifier: Vdd=5, Rd=2k, gate divider 150k/100k -> Vg=2V.
// Verified: Vg=2V, Vd=3V, Id=1mA (Vth=1V, k=2mA/V²).
function loadMos(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:4,y:4,rot:90,value:5});
  wires.push({x1:4,y1:6,x2:4,y2:8}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:8});
  wires.push({x1:4,y1:4,x2:8,y2:4}); wires.push({x1:8,y1:4,x2:12,y2:4});
  comps.push({id:'R'+(uid++),type:'R',x:8,y:4,rot:90,value:150000});  // R1: Vdd->gate
  wires.push({x1:8,y1:6,x2:8,y2:8});                                  // gate node
  comps.push({id:'R'+(uid++),type:'R',x:6,y:8,rot:0,value:100000});   // R2: gate->(6,8)
  wires.push({x1:6,y1:8,x2:6,y2:10}); comps.push({id:'GND'+(uid++),type:'GND',x:6,y:10});
  comps.push({id:'R'+(uid++),type:'R',x:12,y:4,rot:90,value:2000});   // Rd: Vdd->drain
  comps.push({id:'M'+(uid++),type:'MN',x:8,y:8,rot:0});               // gate(8,8) drain(10,6) source(10,10)
  wires.push({x1:12,y1:6,x2:10,y2:6});                               // Rd -> drain
  wires.push({x1:10,y1:10,x2:10,y2:12}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:12});
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('NMOS common-source amp — press <b>Run</b>. Gate ≈ 2V, drain ≈ 3V.');
}

// Non-inverting op-amp, gain = 1 + Rf/Rg = 2, Vin=1V -> Vout=2V.
function loadOpamp(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:6,y:5,rot:90,value:1});       // Vin: (6,5)+ (6,7)-
  wires.push({x1:6,y1:7,x2:6,y2:9}); comps.push({id:'GND'+(uid++),type:'GND',x:6,y:9});
  wires.push({x1:6,y1:5,x2:10,y2:5});                                 // Vin -> in+
  comps.push({id:'OA'+(uid++),type:'OA',x:10,y:6,rot:0});             // out(14,6) in+(10,5) in-(10,7)
  wires.push({x1:10,y1:7,x2:10,y2:8});                               // in- -> feedback node
  comps.push({id:'R'+(uid++),type:'R',x:12,y:8,rot:0,value:10000});   // Rf: (12,8)-(14,8)
  wires.push({x1:10,y1:8,x2:12,y2:8});                               // fb node -> Rf
  wires.push({x1:14,y1:8,x2:14,y2:6});                               // Rf -> out
  comps.push({id:'R'+(uid++),type:'R',x:10,y:8,rot:90,value:10000});  // Rg: (10,8)-(10,10)
  wires.push({x1:10,y1:10,x2:10,y2:12}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:12});
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Non-inverting op-amp, gain 2 — press <b>Run</b>. Output ≈ 2V from a 1V input.');
}

// A common-emitter NPN amplifier bias: Vcc=5V, Rc=1k, Rb=470k, emitter grounded.
// Verified operating point: Vc ≈ 4.09V, Ic ≈ 0.91mA, β = 100.
function loadAmp(){
  comps=[]; wires=[]; uid=1;
  comps.push({id:'V'+(uid++),type:'V',x:4,y:4,rot:90,value:5});   // Vcc source
  wires.push({x1:4,y1:6,x2:4,y2:8}); comps.push({id:'GND'+(uid++),type:'GND',x:4,y:8});
  wires.push({x1:4,y1:4,x2:8,y2:4}); wires.push({x1:8,y1:4,x2:12,y2:4}); // Vcc rail
  comps.push({id:'R'+(uid++),type:'R',x:8,y:4,rot:90,value:470000}); // Rb: Vcc->base
  comps.push({id:'R'+(uid++),type:'R',x:12,y:4,rot:90,value:1000});  // Rc: Vcc->collector
  wires.push({x1:8,y1:6,x2:8,y2:8});                                 // Rb bottom -> base
  comps.push({id:'Q'+(uid++),type:'QN',x:8,y:8,rot:0});             // base(8,8) C(10,6) E(10,10)
  wires.push({x1:12,y1:6,x2:10,y2:6});                               // Rc bottom -> collector
  wires.push({x1:10,y1:10,x2:10,y2:12}); comps.push({id:'GND'+(uid++),type:'GND',x:10,y:12}); // emitter->gnd
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('NPN common-emitter amplifier — press <b>Run</b>. Collector should sit near 4.1V.');
}

// A 5V source drives R1 into node B, where a capacitor (RC low-pass), a 2k
// load resistor, and a diode-to-ground all sit. Every 2-terminal part spans
// exactly 2 grid units, so pins meet cleanly. Top rail = y4, ground rail = y8.
function loadRC(){
  comps=[]; wires=[]; uid=1;
  // Source (vertical): + at top (4,4), - at (4,6).
  comps.push({id:'V'+(uid++),type:'V',x:4,y:4,rot:90,value:5});
  wires.push({x1:4,y1:6,x2:4,y2:8});                 // source - down to ground rail
  comps.push({id:'GND'+(uid++),type:'GND',x:4,y:8}); // 0V reference
  // Top rail: source+ -> R1 -> node B
  wires.push({x1:4,y1:4,x2:6,y2:4});
  comps.push({id:'R'+(uid++),type:'R',x:6,y:4,rot:0,value:1000});  // R1 (6,4)-(8,4)
  // Node B fans out along the top rail to C, R2, D
  wires.push({x1:8,y1:4,x2:10,y2:4});
  wires.push({x1:10,y1:4,x2:12,y2:4});
  comps.push({id:'C'+(uid++),type:'C',x:8,y:4,rot:90,value:1e-6}); // C  (8,4)-(8,6)
  comps.push({id:'R'+(uid++),type:'R',x:10,y:4,rot:90,value:2000});// R2 (10,4)-(10,6)
  comps.push({id:'D'+(uid++),type:'D',x:12,y:4,rot:90,value:0});   // D  (12,4)-(12,6)
  // Bottoms down to the ground rail at y8
  wires.push({x1:8,y1:6,x2:8,y2:8});
  wires.push({x1:10,y1:6,x2:10,y2:8});
  wires.push({x1:12,y1:6,x2:12,y2:8});
  wires.push({x1:4,y1:8,x2:8,y2:8});
  wires.push({x1:8,y1:8,x2:10,y2:8});
  wires.push({x1:10,y1:8,x2:12,y2:8});
  selected=null; refreshMeta(); renderInspector(); draw();
  flashHint('Example loaded — press <b>Run</b> to watch it come alive.');
}

el('runBtn').onclick=()=>{ running?stopSim():startSim(); };
// `multi` holds references to parts, so clearing the document without clearing
// it leaves the inspector offering to delete two components that no longer
// exist — and "Make a block" offering to wrap them up.
el('clearBtn').onclick=()=>{ stopSim(); comps=[];wires=[];lastResult=null;selected=null; multi=[]; selectedWire=null; scopeProbes=[]; scopeBuf=null; bodeData=null; panelMode='scope'; refreshMeta(); commit(); renderInspector(); draw(); };
el('bodeBtn').onclick=runBode;
el('resetBtn').onclick=resetSim;
el('fitBtn').onclick=fitView;
el('mathBtn').onclick=()=>{
  mathMode=!mathMode;
  el('mathBtn').classList.toggle('active-toggle',mathMode);
  el('app').classList.toggle('mathmode',mathMode);
  if(circuit) circuit.captureTrace=mathMode;
  resize();                       // the canvas just changed width
  refreshMath(); renderInspector();
  flashHint(mathMode
    ? 'Showing the solver\'s working: the KCL equation per node, the MNA matrix it builds, and how Newton-Raphson converged.'
    : 'Math view off.');
};
el('undoBtn').onclick=undo;
el('redoBtn').onclick=redo;
el('selectAllBtn').onclick=selectAll;
el('rotateBtn').onclick=()=>{ ghostRot=turn(ghostRot); if(selected){selected.rot=turn(rotOf(selected)); refreshMeta(); commit();} draw(); };
el('saveBtn').onclick=saveFile;
el('openBtn').onclick=openFile;
el('shareBtn').onclick=shareURL;

// Palette search. Escape clears rather than closing anything, since the field
// is always on screen — and blurs, so the canvas shortcuts come back.
{
  const q=el('partSearch') as HTMLInputElement;
  q.addEventListener('input',()=>filterRail(q.value));
  q.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ q.value=''; filterRail(''); q.blur(); }
    // Enter on a single match picks it — the fast path for a known part name.
    if(e.key==='Enter'){
      const hit=document.querySelector<HTMLElement>('.railgroup:not([hidden]) .tool:not([hidden])');
      if(hit?.dataset.t){ setTool(hit.dataset.t as Tool); q.blur(); }
    }
  });
}

// Theme toggle. The OS preference is only consulted while the user has never
// chosen one — once they pick a side, following the system back would override
// a deliberate choice.
el('themeBtn').onclick=()=>{
  applyTheme(currentTheme()==='dark'?'light':'dark');
  renderInspector();     // the legend swatches are painted from the palette
  draw();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',e=>{
  let chosen=null; try{ chosen=localStorage.getItem(THEME_KEY); }catch{}
  if(chosen==='light'||chosen==='dark') return;
  applyTheme(e.matches?'dark':'light',false);
  renderInspector(); draw();
});

// ===========================================================================
//  MCU CODE EDITOR — UI wiring
// ===========================================================================
const BLINK_SKETCH=`// Blink an LED on digital pin 13.
int led = 13;

void setup() {
  pinMode(led, OUTPUT);
}

void loop() {
  digitalWrite(led, HIGH);
  delay(500);
  digitalWrite(led, LOW);
  delay(500);
}`;

function renderMcuStatus(){
  const box=document.getElementById('codeStatus');
  if(!box) return;
  box.className=mcuStatus.includes('error')?'aibad':mcuStatus?'aigood':'';
  box.textContent=mcuStatus;
}
function openCode(){
  el('codeModal').hidden=false;
  (el('codeSrc') as HTMLTextAreaElement).value=sketch;
  renderMcuStatus();
  (el('codeSrc') as HTMLTextAreaElement).focus();
}
function saveCode(){
  sketch=(el('codeSrc') as HTMLTextAreaElement).value;
  const err=sketch.trim()?checkSketch(sketch):null;
  mcuStatus=err?'Compile error — '+err:sketch.trim()?'Saved':'';
  commit();                       // the sketch is part of the document
  renderMcuStatus();
  if(!err&&sketch.trim()){ resetSim(); startSim(); }
}
el('codeBtn').onclick=openCode;
el('codeClose').onclick=()=>{ el('codeModal').hidden=true; };
el('codeModal').onclick=e=>{ if(e.target===el('codeModal')) el('codeModal').hidden=true; };
el('codeSave').onclick=saveCode;
el('codeBlink').onclick=()=>{ (el('codeSrc') as HTMLTextAreaElement).value=BLINK_SKETCH; };

// ===========================================================================
//  AI CIRCUIT ASSISTANT — UI wiring
// ===========================================================================
// A generated circuit goes through applyModel + commit like any other edit, so
// ⌘Z undoes the assistant exactly the way it undoes a hand-placed part. That
// matters more than it sounds: it's what makes trying a suggestion cheap.
function applyAiCircuit(c:AiCircuit){
  let n=1;
  const comps:Comp[]=c.parts.map(p=>{
    if(!(p.type in TYPES)) throw new Error(`Unknown part type "${p.type}".`);
    const comp:Comp={id:p.type+(n++),type:p.type as PartType,x:p.x,y:p.y,rot:p.rot,value:p.value};
    if(p.type==='VS'||p.type==='SQ'){
      comp.amp=p.amp??1; comp.freq=p.freq??1000; comp.off=p.off??0;
      if(p.type==='SQ') comp.duty=p.duty??0.5;
    }
    return comp;
  });
  applyModel({v:1,comps,wires:c.wires.map(w=>({...w})),probes:[]});
  commit();
  fitView();
}

// Key storage lives here rather than in ai.ts so that checking whether a key
// exists doesn't drag the SDK chunk in.
const AI_KEY='volta.anthropic.key';
const loadKey=()=>localStorage.getItem(AI_KEY)??'';
const saveKey=(k:string)=>localStorage.setItem(AI_KEY,k.trim());
const clearKey=()=>localStorage.removeItem(AI_KEY);

const aiModal=el('aiModal');
const aiOut=()=>el('aiOut');
function aiRefreshMode(){
  const has=!!loadKey();
  el('aiKeySetup').hidden=has;
  el('aiChat').hidden=!has;
}
function openAi(){
  aiModal.hidden=false; aiRefreshMode();
  (document.getElementById(loadKey()?'aiPrompt':'aiKeyInput') as HTMLElement|null)?.focus();
}
async function runAi(){
  const prompt=(el('aiPrompt') as HTMLTextAreaElement).value.trim();
  if(!prompt) return;
  const btn=el('aiSend') as HTMLButtonElement;
  btn.disabled=true; aiOut().innerHTML='<div class="empty">Thinking…</div>';
  try{
    const {askAssistant}=await import('./ai');     // loads the SDK chunk on first use
    const reply=await askAssistant({key:loadKey(),prompt,circuit:serializeModel()});
    if(reply.kind==='circuit'){
      applyAiCircuit(reply.circuit);
      // Close the sheet. It is a full-screen scrim over the canvas, so leaving
      // it up after a build hides the very thing the user asked for — which
      // reads as "nothing happened".
      aiModal.hidden=true;
      aiOut().innerHTML='';
      flashHint(`${escapeHtml(reply.circuit.notes)||'Built it.'} `
        +'Press <b>Run</b> to simulate; <span class="kbd">⌘Z</span> undoes it.');
    } else {
      aiOut().innerHTML=`<div class="aitext">${escapeHtml(reply.text)}</div>`;
    }
  }catch(e){
    // Surface the real failure — a wrong key, a rate limit and a malformed
    // circuit need completely different responses from the user.
    aiOut().innerHTML=`<div class="aibad">${escapeHtml(e instanceof Error?e.message:String(e))}</div>`;
  }finally{ btn.disabled=false; }
}
const escapeHtml=(s:string)=>s.replace(/[&<>"]/g,c=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] as string));

el('aiBtn').onclick=openAi;
el('aiClose').onclick=()=>{ aiModal.hidden=true; };
aiModal.onclick=e=>{ if(e.target===aiModal) aiModal.hidden=true; };
el('aiKeySave').onclick=()=>{
  const v=(el('aiKeyInput') as HTMLInputElement).value.trim();
  if(v){ saveKey(v); (el('aiKeyInput') as HTMLInputElement).value=''; aiRefreshMode(); }
};
el('aiForget').onclick=()=>{ clearKey(); aiOut().innerHTML=''; aiRefreshMode(); };
el('aiSend').onclick=runAi;
el('aiPrompt').addEventListener('keydown',e=>{
  if((e as KeyboardEvent).key==='Enter'&&((e as KeyboardEvent).metaKey||(e as KeyboardEvent).ctrlKey)) runAi();
});

// ===========================================================================
//  COMMUNITY — mounted only when the app is configured for it
// ===========================================================================
// Volta stays a static offline PWA. With no Supabase credentials in the build
// this whole block does nothing, the toolbar group stays hidden, and not a
// byte of the SDK is fetched — the dynamic import inside community-ui is never
// reached. That is the supported configuration, not a degraded one.

/** Draw the current document into `octx`, fitted to a W×H box.
 *  Shared by the gallery thumbnail and the About-page mosaic so both use the
 *  SAME symbol code that draws the screen — a second renderer would drift. */
function renderFitted(octx:CanvasRenderingContext2D,W:number,H:number,fill:string|null){
  if(!comps.length) return false;
  const pts=comps.flatMap(c=>bodyExtent(c));
  for(const w of wires) pts.push({x:w.x1,y:w.y1},{x:w.x2,y:w.y2});
  const xs=pts.map(p=>gx(p.x)), ys=pts.map(p=>gy(p.y));
  const pad=26;
  const x0=Math.min(...xs)-pad, x1=Math.max(...xs)+pad;
  const y0=Math.min(...ys)-pad, y1=Math.max(...ys)+pad;
  const scale=Math.min(W/(x1-x0||1), H/(y1-y0||1));

  octx.save();
  if(fill){ octx.fillStyle=fill; octx.fillRect(0,0,W,H); }
  octx.setTransform(scale,0,0,scale,
    -x0*scale+(W-(x1-x0)*scale)/2,
    -y0*scale+(H-(y1-y0)*scale)/2);

  const saved=ctx, savedRunning=running, savedSel=selected, savedHover=hover;
  ctx=octx;
  // A still picture of the circuit, not of a moment in its simulation: no flow
  // dots, no selection tint, no hover wash.
  running=false; selected=null; hover=null;
  try{
    for(const w of wires){
      octx.strokeStyle=T.wire; octx.lineWidth=3; octx.lineCap='round';
      octx.beginPath(); octx.moveTo(gx(w.x1),gy(w.y1)); octx.lineTo(gx(w.x2),gy(w.y2)); octx.stroke();
    }
    for(const c of comps) drawComponent(c,null);
  } finally {
    ctx=saved; running=savedRunning; selected=savedSel; hover=savedHover;
    octx.restore();
  }
  return true;
}

/** A small PNG of the schematic, fitted, for the gallery card. Drawn offscreen
 *  rather than cropped out of the live canvas: that one carries the scope
 *  panel, the hover chip and whatever the view is panned to. */
function thumbnailDataURL():string|null{
  const W=640, H=400;
  const off=document.createElement('canvas');
  off.width=W; off.height=H;
  const octx=off.getContext('2d');
  if(!octx) return null;
  const bg=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()||'#ffffff';
  return renderFitted(octx,W,H,bg) ? off.toDataURL('image/png') : null;
}

// ---- Lending the real circuits out --------------------------------------
// The Commons backdrop draws the app's OWN example circuits rather than
// procedurally generated ones. A generator that scatters parts around a mesh
// produces things that look like circuits to the eye and are nonsense to an
// engineer — two sources in a loop, a switch in series with nothing. These are
// the same documents the gallery ships, drawn with the same symbol code, so
// every figure on that page is a circuit that actually solves.

/** Every built-in example, as a document. Swaps the editor's own out and back;
 *  the loaders never touch the undo stack, so nothing undoable is disturbed. */
export function exampleDocs():SavedModel[]{
  const keep={comps,wires,probes:scopeProbes,uid,sel:selected,multi:multi.slice()};
  const out:SavedModel[]=[];
  try{
    for(const g of GALLERY){
      comps=[]; wires=[]; scopeProbes=[]; selected=null; multi=[];
      try{ g.fn(); out.push(serializeModel()); }catch{ /* skip a bad example */ }
    }
  } finally {
    comps=keep.comps; wires=keep.wires; scopeProbes=keep.probes;
    uid=keep.uid; selected=keep.sel; multi=keep.multi;
    refreshMeta(); renderInspector(); draw();
  }
  return out;
}

/** Pixel extent of a document, so a caller can lay several out without overlap. */
export function docBounds(doc:SavedModel):{w:number;h:number}{
  const b=docExtent(doc);
  return {w:b.x1-b.x0, h:b.y1-b.y0};
}

function docExtent(doc:SavedModel){
  const keep=comps;
  comps=doc.comps;
  const pts:Pt[]=comps.flatMap(c=>bodyExtent(c));
  comps=keep;
  for(const w of doc.wires) pts.push({x:w.x1,y:w.y1},{x:w.x2,y:w.y2});
  if(!pts.length) return {x0:0,y0:0,x1:0,y1:0};
  const xs=pts.map(p=>gx(p.x)), ys=pts.map(p=>gy(p.y));
  const pad=16;
  return {x0:Math.min(...xs)-pad, y0:Math.min(...ys)-pad,
          x1:Math.max(...xs)+pad, y1:Math.max(...ys)+pad};
}

/**
 * Draw `doc` into `target` with its top-left at (ox,oy), at the editor's own
 * scale.
 *
 * @param reveal 0..1 — wires are laid first, then parts dropped in, so it
 *               reads as a circuit being built rather than fading up.
 * @param flow   when > 0, current dots ride the wires at this phase.
 */
export function drawDoc(target:CanvasRenderingContext2D, doc:SavedModel,
                        ox:number, oy:number, reveal:number, flow:number){
  const keep={comps,wires,probes:scopeProbes,sel:selected,multi:multi.slice(),
    run:running,hov:hover,res:lastResult,net:simNet};
  const ext=docExtent(doc);
  comps=doc.comps.map(c=>({...c}));
  wires=doc.wires.map(w=>({...w}));
  scopeProbes=[]; selected=null; multi=[];
  // A still picture of the circuit, not of a moment in its simulation.
  running=false; hover=null; lastResult=null; simNet=null;

  const saved=ctx;
  ctx=target;
  target.save();
  target.translate(ox-ext.x0, oy-ext.y0);
  try{
    const total=wires.length+comps.length;
    const done=Math.floor(reveal*total);
    const nW=Math.min(wires.length,done);
    const nC=Math.max(0,done-wires.length);

    target.strokeStyle=T.wire; target.lineWidth=3; target.lineCap='round';
    target.beginPath();
    for(let i=0;i<nW;i++){
      const w=wires[i];
      target.moveTo(gx(w.x1),gy(w.y1)); target.lineTo(gx(w.x2),gy(w.y2));
    }
    target.stroke();

    for(let i=0;i<nC;i++) drawComponent(comps[i],null);

    if(flow>0&&nC>=comps.length){
      target.fillStyle=T.current;
      for(const w of wires){
        const len=Math.hypot(gx(w.x2)-gx(w.x1),gy(w.y2)-gy(w.y1));
        if(len<1) continue;
        const ux=(gx(w.x2)-gx(w.x1))/len, uy=(gy(w.y2)-gy(w.y1))/len;
        for(let d=flow%FLOW_PITCH; d<len; d+=FLOW_PITCH){
          target.beginPath();
          target.arc(gx(w.x1)+ux*d, gy(w.y1)+uy*d, 2.1, 0, Math.PI*2);
          target.fill();
        }
      }
    }
  } finally {
    target.restore();
    ctx=saved;
    comps=keep.comps; wires=keep.wires; scopeProbes=keep.probes;
    selected=keep.sel; multi=keep.multi;
    running=keep.run; hover=keep.hov; lastResult=keep.res; simNet=keep.net;
  }
}

/** What the animated backdrops need: the examples, and how to size and draw
 *  one. Shared by the About page and the Commons page so both show real
 *  circuits from one definition — see src/circuit-bg.ts for the painter. */
function backdropApi(){
  return { docs:exampleDocs() as unknown[],
    bounds:(d:unknown)=>docBounds(d as SavedModel),
    draw:(c:CanvasRenderingContext2D,d:unknown,ox:number,oy:number,rev:number,flow:number)=>
      drawDoc(c,d as SavedModel,ox,oy,rev,flow) };
}

// ---- About -----------------------------------------------------------------
// A plain view, not a modal: it is a page about the project, and it should be
// readable and scrollable rather than boxed. Wired here rather than in
// community-ui because it exists whether or not the commons is configured —
// only its sign-in call to action is conditional.
{
  const about=el('aboutView');
  const SEEN='volta.seenAbout';

  // The backdrop starts lazily and is torn down on close, so nothing animates
  // behind the editor. The import is dynamic for the same reason the paint is
  // deferred: the page should be up before the renderer starts, not after.
  let stopBackdrop:(()=>void)|null=null;
  const startBackdrop=()=>{
    if(stopBackdrop) return;
    stopBackdrop=()=>{};                       // claim the slot; the import is async
    void import('./circuit-bg').then(({startCircuitBackdrop})=>{
      if(about.hidden) { stopBackdrop=null; return; }   // closed again already
      stopBackdrop=startCircuitBackdrop(el('aboutBg') as HTMLCanvasElement,backdropApi());
      el('aboutMosaic').classList.add('ready');
    }).catch(()=>{ stopBackdrop=null; });
  };
  const openAbout=()=>{
    about.hidden=false;
    if('requestIdleCallback' in window) (window as unknown as
      {requestIdleCallback:(cb:()=>void,o?:{timeout:number})=>void})
      .requestIdleCallback(startBackdrop,{timeout:400});
    else setTimeout(startBackdrop,50);
  };
  const closeAbout=()=>{
    about.hidden=true;
    stopBackdrop?.(); stopBackdrop=null;
    el('aboutMosaic').classList.remove('ready');
    try{ localStorage.setItem(SEEN,'1'); }catch{}
  };

  el('aboutBtn').onclick=openAbout;
  el('aboutClose').onclick=closeAbout;
  el('aboutOpen').onclick=closeAbout;
  (el('aboutLicLink') as HTMLAnchorElement).href=
    'https://creativecommons.org/licenses/by-sa/4.0/';
  // The photo reveals itself only once it has genuinely decoded. naturalWidth
  // is the check that matters: a dev server answering 404s with index.html
  // would otherwise hand us an "image" that fires load and renders nothing.
  const img=el('aboutImg') as HTMLImageElement;
  const showPhoto=()=>{
    if(img.naturalWidth>0){ img.classList.add('ready'); el('aboutImgFallback').hidden=true; }
  };
  img.addEventListener('load',showPhoto);
  if(img.complete) showPhoto();
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!about.hidden) closeAbout();
  });

  // About is the landing page. Two exceptions, both cases where showing it
  // would be in the way rather than a welcome: a shared-circuit link, which
  // someone followed to see a specific circuit, and a return visit — once you
  // have been into the editor, the toolbar button is the way back.
  let seen=false;
  try{ seen=localStorage.getItem(SEEN)==='1'; }catch{}
  if(!seen&&!location.hash) openAbout();
}

if(community.configured){
  import('./community-ui').then(({mountCommunity})=>{
    const api=mountCommunity({
      serialize:()=>serializeModel(),
      load:(doc,title)=>{
        applyModel(doc as SavedModel);
        commit(); fitView(); renderInspector(); draw();
        void title;
      },
      thumbnail:()=>thumbnailDataURL(),
      hint:(html)=>flashHint(html),
      hasCircuit:()=>comps.length>0,
      // Built on first Commons open, then reused for every figure.
      backdrop:backdropApi,
    });
    // Clearing the schematic starts a document with no ancestry.
    const clearBtn=el('clearBtn');
    clearBtn.addEventListener('click',()=>api.clearLineage());
  }).catch(e=>console.error('community features unavailable:',e));
}

// ---- boot ----
// Adopt whatever theme the inline boot script settled on — this is what loads
// the stylesheet's palette into T, so it has to happen before the first draw.
applyTheme(currentTheme(),false);
buildRail(); buildGallery(); setTool('select'); renderInspector();
resize();
if(!loadFromHash()) loadRC();   // restore a shared circuit, else the default example
fitView();                      // frame whatever we loaded rather than stranding it
// The circuit we boot with is the baseline: undo can't rewind past it.
historyPrev=snapshot();
updateHistoryButtons();
