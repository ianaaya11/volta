// ============================================================================
//  BRING-YOUR-OWN-KEY — the assistant without a server behind it
// ============================================================================
//  The fallback path, and the only one that exists when Volta is running as
//  what it fundamentally is: a static offline PWA with no backend. A user who
//  self-hosts the app, opens it from a file, or runs a build with no Supabase
//  credentials still gets the assistant by pasting their own Anthropic key.
//
//  This is also the only module that pulls in the Anthropic SDK, which is why
//  it is a file of its own. A signed-in member on the hosted build goes through
//  the Edge Function instead and never loads a byte of it — the assistant is a
//  rarely-opened modal, and shipping a client library to people whose requests
//  are answered by a server would be the same mistake the community layer
//  already avoids.
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { BUILD_CIRCUIT_TOOL, MAX_TOKENS, MODEL, SYSTEM } from '../supabase/functions/_shared/prompt';
import { interpret, type AssistantReply } from './ai';

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

  return interpret(response);
}