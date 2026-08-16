// ============================================================================
//  ask — the circuit assistant, served with the owner's key instead of yours
// ============================================================================
//  Volta is a static site, so there is nowhere in the app to hide an API key:
//  anything in the bundle ships to every visitor. Until this function existed
//  the only honest option was to make each person paste their own key, which
//  meant the assistant did not work for the people the pilot is actually for.
//
//  So the key lives here, as a project secret, and the browser never sees it:
//
//      browser --(Supabase JWT)--> this function --(owner's key)--> Anthropic
//
//  Three gates before a request costs anything:
//    1. a valid signed-in Supabase user,
//    2. that user's `approved` flag — the same one the admin page sets, so the
//       assistant is limited to invited testers by construction,
//    3. a per-user daily call cap, enforced in the database rather than here,
//       because a counter in an edge runtime is a counter per instance.
//
//  The request body carries only a question and the circuit on screen. The
//  system prompt and the tool schema are added on this side, so an approved
//  tester cannot repoint the owner's key at a general-purpose conversation.
// ============================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { BUILD_CIRCUIT_TOOL, MAX_TOKENS, MODEL, SYSTEM } from '../_shared/prompt.ts';

// The app is served from a different origin than the function (GitHub Pages vs
// supabase.co), so the browser preflights. Authorisation is a bearer token
// rather than a cookie, so a wildcard origin grants nothing on its own — the
// JWT check below is what actually guards this.
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

/** Calls per member per UTC day. Generous for a lesson, bounded for a bill. */
const DAILY_CAP = 40;

/** Longest question accepted. Anything past this is not a circuit question. */
const MAX_PROMPT = 4000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!apiKey || !url || !anon) {
    // A misconfigured deployment must not read as "you are not allowed".
    return json({ error: 'The assistant is not configured on this server.' }, 503);
  }

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Sign in to use the assistant.' }, 401);

  // Acting as the caller, so RLS and auth.uid() apply exactly as they do from
  // the browser. This function holds no service-role key and cannot escalate.
  const db = createClient(url, anon, { global: { headers: { Authorization: auth } } });

  const { data: who, error: whoErr } = await db.auth.getUser();
  if (whoErr || !who?.user) return json({ error: 'Sign in to use the assistant.' }, 401);

  let body: { prompt?: unknown; circuit?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400);
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: 'Ask a question first.' }, 400);
  if (prompt.length > MAX_PROMPT) return json({ error: 'That question is too long.' }, 400);

  // Approval and the daily cap are one database call, taken BEFORE the model
  // runs. It counts the attempt rather than the success: a retry loop against a
  // failing model is exactly the case a cap exists to bound.
  const { data: left, error: capErr } = await db.rpc('ai_take_turn', { p_cap: DAILY_CAP });
  if (capErr) {
    const m = capErr.message ?? '';
    if (m.includes('not approved')) {
      return json({ error: 'Your account is waiting to be approved for the pilot.' }, 403);
    }
    if (m.includes('daily limit')) {
      return json({ error: `You have used all ${DAILY_CAP} assistant requests for today.` }, 429);
    }
    return json({ error: 'Could not check your assistant allowance.' }, 500);
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: [BUILD_CIRCUIT_TOOL],
      messages: [{
        role: 'user',
        content: `Circuit currently on the canvas (JSON):\n${
          JSON.stringify(body.circuit ?? null)
        }\n\n${prompt}`,
      }],
    }),
  });

  if (!upstream.ok) {
    // Upstream detail can carry the key's own account information, so it is
    // logged for the owner and not returned to the caller.
    console.error('anthropic', upstream.status, await upstream.text());
    return json({ error: 'The assistant is unavailable right now.' }, 502);
  }

  // Handed back unchanged: the browser already knows how to read a Messages
  // response, because the bring-your-own-key path parses the same shape.
  const reply = await upstream.json();
  return json({ ...reply, remaining: left });
});
