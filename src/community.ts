// ============================================================================
//  COMMUNITY — accounts, and a shared commons of published circuits
// ============================================================================
//  Volta is a static, offline-capable PWA and stays one. Everything here is
//  additive and optional: with no Supabase credentials configured the module
//  reports `configured === false`, the UI hides itself, and the editor works
//  exactly as it did before. The SDK is behind a dynamic import for the same
//  reason — an offline user must not pay for a network feature they cannot use.
//
//  Nothing in this file touches the DOM, so the validation and the shaping of
//  what gets published can be tested without a browser or a network.
// ============================================================================
import type { SupabaseClient, Session } from '@supabase/supabase-js';

export const LICENSE = 'CC-BY-SA-4.0';
export const LICENSE_NAME = 'CC BY-SA 4.0';
export const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

/** Every published design carries this. Shown at publish time, not buried. */
export const LICENSE_SUMMARY =
  'Anyone may use, change and republish this design, provided they credit you '
  + 'and share their version under the same terms.';

export interface Profile {
  id: string;
  handle: string;
  display_name: string;
  country: string | null;
  school: string | null;
  show_school: boolean;
}

export interface GalleryItem {
  id: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  license: string;
  fork_count: number;
  forked_from: string | null;
  created_at: string;
  handle: string;
  display_name: string;
  country: string | null;
  /** Null unless the author chose to show it — the view applies that rule. */
  school: string | null;
}

// ---- Configuration ---------------------------------------------------------
// Vite inlines these at build time. Absent, the whole feature is simply off;
// that is the supported state, not an error, and it is what keeps the app
// installable and useful with no backend at all.
const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY_ = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = !!(URL_ && KEY_);

let clientPromise: Promise<SupabaseClient> | null = null;
/** The SDK loads on first use, never at startup. */
export function client(): Promise<SupabaseClient> {
  if (!configured) return Promise.reject(new Error('Community features are not configured.'));
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(m =>
      m.createClient(URL_!, KEY_!, {
        auth: { persistSession: true, autoRefreshToken: true },
      }));
  }
  return clientPromise;
}

// ---- Validation ------------------------------------------------------------
// Mirrors the CHECK constraints in schema.sql. The database is what enforces
// them; this exists so a member gets told what is wrong before a round trip,
// not so the rules live in two places by accident.
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export function validateProfile(p: {
  handle: string; display_name: string; country?: string | null;
  school?: string | null; show_school?: boolean;
}): string | null {
  if (!HANDLE_RE.test(p.handle)) {
    return 'Handle must be 3–20 characters: lowercase letters, numbers or underscores.';
  }
  const name = p.display_name.trim();
  if (!name || name.length > 40) return 'Display name must be 1–40 characters.';
  if (p.country && !/^[A-Z]{2}$/.test(p.country)) return 'Country must be a two-letter code.';
  if (p.school && p.school.length > 80) return 'School name must be 80 characters or fewer.';
  // Switching the school on without naming one would publish an empty label.
  if (p.show_school && !p.school?.trim()) return 'Add your school, or leave "show my school" off.';
  return null;
}

/** Supabase's own floor is 6; 8 is the floor here. The gap is deliberate — a
 *  member who is told "at least 8" up front does not discover the rule from a
 *  server error after typing something they liked. */
export const PASSWORD_MIN = 8;

export function validatePassword(p: string): string | null {
  if (p.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  return null;
}

export function validateDesign(d: { title: string; description?: string | null }): string | null {
  const t = d.title.trim();
  if (!t || t.length > 80) return 'Title must be 1–80 characters.';
  if (d.description && d.description.length > 2000) return 'Description must be 2000 characters or fewer.';
  return null;
}

// ---- Auth ------------------------------------------------------------------
export async function session(): Promise<Session | null> {
  if (!configured) return null;
  const { data } = await (await client()).auth.getSession();
  return data.session;
}

export async function signUp(email: string, password: string) {
  const bad = validatePassword(password);
  if (bad) throw new Error(bad);
  const { error } = await (await client()).auth.signUp({ email, password });
  if (error) throw new Error(error.message);
}

// ---- Forgotten passwords ---------------------------------------------------
//  This is a schools tool. Forgotten passwords are not an edge case here, they
//  are a weekly event, and without this every one of them is a message to a
//  human who cannot help — nobody can read or reset a Supabase password from
//  the dashboard.

/** Where a reset link comes back to. The circuit hash is dropped deliberately:
 *  the link should land on the app, not on whatever document happened to be
 *  open in the tab that asked for it. */
export function recoveryRedirect(): string {
  return location.origin + location.pathname;
}

export async function requestPasswordReset(email: string) {
  const trimmed = email.trim();
  if (!trimmed) throw new Error('Enter your email address first.');
  const { error } = await (await client()).auth
    .resetPasswordForEmail(trimmed, { redirectTo: recoveryRedirect() });
  if (error) throw new Error(error.message);
}

/** True when this page load came from a reset email.
 *
 *  Supabase's implicit flow hands the recovery token back in the URL fragment,
 *  which is also where a shared circuit lives (`#c=...`). They cannot collide —
 *  one is a `c=` prefix and the other a token set — but the check is written
 *  against the token so a future share format cannot accidentally match. */
export function isRecoveryLink(hash: string = location.hash): boolean {
  return /(^|[#&])type=recovery(&|$)/.test(hash);
}

/** Set a new password for whoever the recovery session belongs to. */
export async function updatePassword(next: string) {
  const bad = validatePassword(next);
  if (bad) throw new Error(bad);
  const { error } = await (await client()).auth.updateUser({ password: next });
  if (error) throw new Error(error.message);
}

export async function signIn(email: string, password: string) {
  const { error } = await (await client()).auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signOut() {
  await (await client()).auth.signOut();
}

// ---- Profile ---------------------------------------------------------------
export async function myProfile(): Promise<Profile | null> {
  const s = await session();
  if (!s) return null;
  const { data, error } = await (await client())
    .from('profiles').select('*').eq('id', s.user.id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Profile) ?? null;
}

export async function saveProfile(p: Omit<Profile, 'id'>): Promise<Profile> {
  const bad = validateProfile(p);
  if (bad) throw new Error(bad);
  const s = await session();
  if (!s) throw new Error('Sign in first.');
  const row = { ...p, id: s.user.id, display_name: p.display_name.trim(),
    school: p.school?.trim() || null };
  const { data, error } = await (await client())
    .from('profiles').upsert(row).select().single();
  // 23505 is Postgres' unique violation — here it can only be the handle.
  if (error) throw new Error(error.code === '23505'
    ? 'That handle is taken — pick another.' : error.message);
  return data as Profile;
}

// ---- Designs ---------------------------------------------------------------
export interface PublishInput {
  title: string;
  description?: string | null;
  /** The document exactly as the editor serialises it. */
  circuit: unknown;
  thumbnail?: string | null;
  /** Set when this design started life as somebody else's. */
  forkedFrom?: string | null;
}

export async function publish(input: PublishInput): Promise<{ id: string }> {
  const bad = validateDesign(input);
  if (bad) throw new Error(bad);
  const s = await session();
  if (!s) throw new Error('Sign in first.');
  const sb = await client();
  const { data, error } = await sb.from('designs').insert({
    author_id: s.user.id,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    circuit: input.circuit,
    thumbnail: input.thumbnail ?? null,
    license: LICENSE,
    forked_from: input.forkedFrom ?? null,
  }).select('id').single();
  if (error) {
    throw new Error(error.code === '23503'
      ? 'Set up your member profile before publishing.' : error.message);
  }
  // Credit the original. Best-effort: a counter that failed to move is not a
  // reason to tell someone their design did not publish, because it did.
  if (input.forkedFrom) {
    try { await sb.rpc('record_fork', { source: input.forkedFrom }); } catch { /* cosmetic */ }
  }
  return data as { id: string };
}

export async function listGallery(opts: { search?: string; author?: string; limit?: number } = {}) {
  const sb = await client();
  let q = sb.from('gallery').select('*').order('created_at', { ascending: false })
    .limit(opts.limit ?? 60);
  if (opts.author) q = q.eq('handle', opts.author);
  if (opts.search?.trim()) {
    // Escape the LIKE metacharacters so a stray % does not match everything.
    const term = opts.search.trim().replace(/[%_\\]/g, m => '\\' + m);
    q = q.or(`title.ilike.%${term}%,description.ilike.%${term}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as GalleryItem[];
}

/** The full document for one design — fetched only when actually opening it. */
export async function loadDesign(id: string): Promise<{ circuit: unknown; title: string }> {
  const { data, error } = await (await client())
    .from('designs').select('circuit,title').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data as { circuit: unknown; title: string };
}

export async function myDesigns(): Promise<GalleryItem[]> {
  const p = await myProfile();
  if (!p) return [];
  return listGallery({ author: p.handle });
}

export async function deleteDesign(id: string) {
  const { error } = await (await client()).from('designs').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function report(designId: string, reason: string) {
  const s = await session();
  if (!s) throw new Error('Sign in to report a design.');
  const { error } = await (await client()).from('reports')
    .insert({ design_id: designId, reporter_id: s.user.id, reason: reason.trim() });
  if (error) throw new Error(error.message);
}

// ---- Presentation helpers --------------------------------------------------
/** How a design is credited in the gallery. Country and school are optional
 *  and, per the profile rules, school only appears if its owner opted in. */
export function byline(item: Pick<GalleryItem, 'display_name' | 'country' | 'school'>): string {
  return [item.display_name, item.school, item.country && flag(item.country)]
    .filter(Boolean).join(' · ');
}

/** A two-letter country code as its flag emoji, via the regional indicators. */
export function flag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
