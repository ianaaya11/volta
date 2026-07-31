// ============================================================================
//  AI CIRCUIT ASSISTANT — build, explain and debug circuits from plain language
// ============================================================================
//  Talks to the Claude API directly from the browser with a key the user
//  supplies, so the app stays a static offline-capable PWA with no backend.
//  The trade-off is deliberate and stated in the UI: a key in localStorage is
//  readable by anything running on the page, which suits a personal tool rather
//  than a public deployment.
//
//  Everything here is DOM-free apart from the key helpers, so the schema and
//  the validation of model output can be tested without a browser or a network.
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';

/** Thinking counts against max_tokens on this model, so leave real headroom. */
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;
const KEY_STORAGE = 'zuri.anthropic.key';

/** Part types the assistant is allowed to place. */
export const AI_PART_TYPES = [
  'R', 'C', 'L', 'V', 'VS', 'SQ', 'I', 'D', 'QN', 'QP', 'MN', 'MP', 'OA', 'GND',
  'LED', 'LAMP', 'CP', 'SW', 'PB', 'PBNC', 'POT',
  'E', 'G', 'F', 'H', 'XF', 'RLY', 'MOT',
] as const;
export type AiPartType = (typeof AI_PART_TYPES)[number];

export interface AiPart {
  type: AiPartType;
  x: number;
  y: number;
  rot: 0 | 90 | 180 | 270;
  value?: number;
  amp?: number;
  freq?: number;
  off?: number;
  duty?: number;
}
export interface AiWire { x1: number; y1: number; x2: number; y2: number }
export interface AiCircuit { parts: AiPart[]; wires: AiWire[]; notes: string }

export type AssistantReply =
  | { kind: 'circuit'; circuit: AiCircuit }
  | { kind: 'text'; text: string };

// ---- API key (the only browser-coupled part) -------------------------------
export const loadKey = (): string => localStorage.getItem(KEY_STORAGE) ?? '';
export const saveKey = (k: string): void => localStorage.setItem(KEY_STORAGE, k.trim());
export const clearKey = (): void => localStorage.removeItem(KEY_STORAGE);

// ---- The tool the model calls to hand back a circuit ------------------------
// `strict: true` guarantees the arguments validate against this schema, so the
// only checks left on our side are the semantic ones normalizeCircuit does.
const PART_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...AI_PART_TYPES], description: 'Part kind.' },
    x: { type: 'integer', description: 'Grid x of pin A (the anchor).' },
    y: { type: 'integer', description: 'Grid y of pin A (the anchor).' },
    rot: { type: 'integer', enum: [0, 90, 180, 270], description: 'Rotation in degrees.' },
    value: { type: 'number', description: 'Ω / F / H / V / A depending on the part. 0 for parts without one.' },
    amp: { type: 'number', description: 'VS and SQ only: peak amplitude in volts.' },
    freq: { type: 'number', description: 'VS and SQ only: frequency in Hz.' },
    off: { type: 'number', description: 'VS and SQ only: DC offset in volts.' },
    duty: { type: 'number', description: 'SQ only: duty cycle, 0 to 1.' },
  },
  required: ['type', 'x', 'y', 'rot', 'value'],
  additionalProperties: false,
} as const;

export const BUILD_CIRCUIT_TOOL = {
  name: 'build_circuit',
  description:
    'Replace the schematic with a new circuit. Call this whenever the user asks you to build, '
    + 'add, change, fix, or lay out a circuit. Emit the COMPLETE circuit every time — the parts '
    + 'and wires you return replace everything currently on the canvas.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      parts: { type: 'array', items: PART_SCHEMA },
      wires: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x1: { type: 'integer' }, y1: { type: 'integer' },
            x2: { type: 'integer' }, y2: { type: 'integer' },
          },
          required: ['x1', 'y1', 'x2', 'y2'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string', description: 'One or two sentences for the user on what you built and why.' },
    },
    required: ['parts', 'wires', 'notes'],
    additionalProperties: false,
  },
} as const;

// The geometry rules are the whole ballgame: a model that gets pin positions
// wrong produces a circuit that looks plausible and simulates as disconnected
// junk, so they're spelled out concretely with a worked example.
const SYSTEM = `You are the circuit assistant inside Zuri, a live analog circuit simulator.
You build, explain and debug circuits on an integer grid.

GEOMETRY — get this exactly right or the circuit will not connect:
- Every coordinate is an integer grid cell. Parts connect only where pins share a cell,
  or where a wire joins their cells.
- A 2-terminal part (R, C, L, V, VS, SQ, I, D) has pin A at (x,y) and pin B two cells
  away along its rotation: rot 0 -> (x+2,y), rot 90 -> (x,y+2), rot 180 -> (x-2,y),
  rot 270 -> (x,y-2).
- GND has one pin, at (x,y). It defines 0 V. EVERY circuit needs at least one.
- QN (NPN) and MN (NMOS) have three pins. At rot 0: base/gate at (x,y),
  collector/drain at (x+2,y-2), emitter/source at (x+2,y+2).
- OA (op-amp) at rot 0: output at (x+4,y), non-inverting input at (x,y-1),
  inverting input at (x,y+1).
- Wires run between two grid cells and are ideal. Use them to join pins that
  are not already touching. Prefer horizontal or vertical runs.

PART VALUES:
- R ohms, C farads, L henries, V volts, I amps. D, LED, QN, QP, MN, MP, OA, GND,
  SW, PB and PBNC take value 0.
- LED is a diode that lights — always give it a series resistor. LAMP is a
  filament bulb; its value is its resistance in ohms. CP is a polarized
  capacitor (value in farads); its first pin is the + plate.
- SW is a latching switch, PB a push button that is open until held, PBNC one
  that is closed until held. All three start in their resting state.
- POT is a 3-pin potentiometer: value is the whole track in ohms, and its pins
  are [one end, wiper, the other end] in that order.
- E, G, F and H are the dependent sources, pins [out+, out-, ctrl+, ctrl-].
  Value is the gain: E volts per volt, G amps per volt, F amps per amp, H volts
  per amp. E and G sense a voltage across their control pins; F and H sense the
  current flowing THROUGH theirs, so wire that current straight through them.
- XF is a transformer, pins [primary+, primary-, secondary+, secondary-]. Value
  is the primary inductance in henries; the turns ratio is the square root of
  the inductance ratio, so give it a secondary of 4x for a 1:2 step-up.
- RLY is a relay, pins [coil+, coil-, contact A, contact B]. Value is the coil
  resistance; the contact closes above about 20 mA of coil current. Put a diode
  across the coil, cathode to coil+, to catch the switch-off spike.
- MOT is a DC motor with two pins; value is its armature resistance in ohms.
- VS is a sine source and SQ a square source: set amp (peak volts), freq (Hz),
  off (DC offset). SQ also takes duty (0-1, use 0.5 for a symmetric square).
  A 0-to-5 V pulse is off 2.5 with amp 2.5.

WORKED EXAMPLE — 5 V source, 1 kΩ series resistor, 1 µF cap to ground:
  parts: V at (4,4) rot 90 value 5      -> pins (4,4) and (4,6)
         GND at (4,8)
         R at (6,4) rot 0 value 1000    -> pins (6,4) and (8,4)
         C at (8,4) rot 90 value 1e-6   -> pins (8,4) and (8,6)
         GND at (8,8)
  wires: (4,6)-(4,8)   source minus down to ground
         (4,4)-(6,4)   source plus across to the resistor
         (8,6)-(8,8)   cap bottom down to ground

RULES:
- Call build_circuit for any request to build or change a circuit, and return the
  WHOLE circuit — what you return replaces the canvas.
- Keep layouts on even coordinates where you can, and leave room between parts.
- For questions about an existing circuit ("why is this not working", "what does
  this do"), just answer in text. Do not call the tool.
- Be brief. The user is looking at the schematic, not reading an essay.`;

/** Reject model output that is syntactically valid but electrically nonsense. */
export function normalizeCircuit(raw: unknown): AiCircuit {
  const c = raw as Partial<AiCircuit> | null;
  if (!c || !Array.isArray(c.parts) || !Array.isArray(c.wires)) {
    throw new Error('The assistant returned something that is not a circuit.');
  }
  if (!c.parts.length) throw new Error('The assistant returned a circuit with no parts.');
  const allowed = new Set<string>(AI_PART_TYPES);
  const parts = c.parts.map((p, i) => {
    if (!allowed.has(p.type)) throw new Error(`Unknown part type "${p.type}" at index ${i}.`);
    for (const k of ['x', 'y'] as const) {
      if (!Number.isFinite(p[k])) throw new Error(`Part ${i} has a non-numeric ${k}.`);
    }
    return { ...p, x: Math.round(p.x), y: Math.round(p.y), rot: (p.rot ?? 0) as AiPart['rot'] };
  });
  if (!parts.some(p => p.type === 'GND')) {
    throw new Error('That circuit has no ground, so it has no 0 V reference to solve against.');
  }
  const wires = c.wires.map((w, i) => {
    for (const k of ['x1', 'y1', 'x2', 'y2'] as const) {
      if (!Number.isFinite(w[k])) throw new Error(`Wire ${i} has a non-numeric ${k}.`);
    }
    return { x1: Math.round(w.x1), y1: Math.round(w.y1), x2: Math.round(w.x2), y2: Math.round(w.y2) };
  });
  return { parts, wires, notes: typeof c.notes === 'string' ? c.notes : '' };
}

/** Ask the assistant. Returns either a circuit to apply, or prose to display. */
export async function askAssistant(opts: {
  key: string;
  prompt: string;
  /** The circuit currently on screen, so it can explain or modify what's there. */
  circuit: unknown;
  signal?: AbortSignal;
}): Promise<AssistantReply> {
  const client = new Anthropic({
    apiKey: opts.key,
    // Required to call the API from a page rather than a server. The key is the
    // user's own and never leaves their browser except to api.anthropic.com.
    dangerouslyAllowBrowser: true,
  });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    // The schema is a readonly literal so the tests can assert on its shape;
    // the SDK's Tool type wants mutable arrays. Same object either way.
    tools: [BUILD_CIRCUIT_TOOL as unknown as Anthropic.Tool],
    messages: [{
      role: 'user',
      content:
        `Circuit currently on the canvas (JSON):\n${JSON.stringify(opts.circuit)}\n\n${opts.prompt}`,
    }],
  }, { signal: opts.signal });

  // Claude Opus 5 can decline a request outright; content is then empty or
  // partial, so this has to be checked before reading any block.
  if (response.stop_reason === 'refusal') {
    throw new Error('The assistant declined that request.');
  }

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'build_circuit') {
      return { kind: 'circuit', circuit: normalizeCircuit(block.input) };
    }
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text).join('\n').trim();
  if (!text) throw new Error('The assistant returned an empty response.');
  return { kind: 'text', text };
}
