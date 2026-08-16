// ============================================================================
//  AI CIRCUIT ASSISTANT — build, explain and debug circuits from plain language
// ============================================================================
//  Two ways to reach Claude, and the app picks whichever it can:
//
//    askViaServer  — a signed-in, approved member goes through the `ask` Edge
//                    Function, which holds the owner's key. Nobody needs an
//                    Anthropic account, and no key touches a browser.
//    ai-direct.ts  — no server, so the user pastes their own key. This is what
//                    a self-hosted or offline copy falls back to, and it keeps
//                    Volta honest as a static PWA with no backend required.
//
//  Everything here is DOM-free apart from the key helpers, and carries no SDK,
//  so the schema and the validation of model output can be tested without a
//  browser or a network — and so the server path costs no download.
// ============================================================================
// The prompt lives with the Edge Function that also serves it — see the note at
// the top of that file for why the server, not the browser, owns it.
import {
  AI_PART_TYPES, BUILD_CIRCUIT_TOOL, type AiPartType,
} from '../supabase/functions/_shared/prompt';
export { AI_PART_TYPES, BUILD_CIRCUIT_TOOL };
export type { AiPartType };

const KEY_STORAGE = 'volta.anthropic.key';

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
  /** LED only. Also picks its forward voltage — see LED_COLORS in main.ts. */
  color?: string;
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

/** A Messages response, from whichever side of the wire produced it. */
interface RawReply {
  stop_reason?: string | null;
  content?: { type: string; name?: string; input?: unknown; text?: string }[];
}

// Reading the reply is identical whether the SDK made the call or the Edge
// Function forwarded it, because both return the same Messages response. That
// is the reason the function hands the body back unchanged instead of
// inventing a shape of its own.
export function interpret(response: RawReply): AssistantReply {
  // Claude Opus 5 can decline a request outright; content is then empty or
  // partial, so this has to be checked before reading any block.
  if (response.stop_reason === 'refusal') {
    throw new Error('The assistant declined that request.');
  }
  const content = response.content ?? [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'build_circuit') {
      return { kind: 'circuit', circuit: normalizeCircuit(block.input) };
    }
  }
  const text = content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '').join('\n').trim();
  if (!text) throw new Error('The assistant returned an empty response.');
  return { kind: 'text', text };
}

/** Ask through the owner's key, held by the `ask` Edge Function.
 *
 *  This is the path a signed-in, approved member takes, and it is why the pilot
 *  works without every tester owning an Anthropic account. Nothing secret
 *  crosses the wire in either direction: out goes the member's own Supabase
 *  session token, back comes a Messages response.
 *
 *  The prompt and tool schema are NOT sent — the function adds them — so this
 *  endpoint can only ever be asked about circuits. */
export async function askViaServer(opts: {
  /** Base Supabase project URL, e.g. https://abc.supabase.co */
  supabaseUrl: string;
  /** The signed-in member's access token. */
  token: string;
  prompt: string;
  circuit: unknown;
  signal?: AbortSignal;
}): Promise<AssistantReply> {
  let res: Response;
  try {
    res = await fetch(`${opts.supabaseUrl.replace(/\/$/, '')}/functions/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ prompt: opts.prompt, circuit: opts.circuit }),
      signal: opts.signal,
    });
  } catch {
    // Offline, or the function is not deployed. Either way the user is not
    // getting an answer, and the distinction is not one they can act on.
    throw new Error('Could not reach the assistant. Check your connection.');
  }

  const body = await res.json().catch(() => null) as (RawReply & { error?: string }) | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `The assistant failed (${res.status}).`);
  }
  if (!body) throw new Error('The assistant returned an unreadable response.');
  return interpret(body);
}
