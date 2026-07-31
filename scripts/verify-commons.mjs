#!/usr/bin/env node
// ============================================================================
//  VERIFY THE COMMONS — against the real database
// ============================================================================
//  Everything schema.sql promises is enforced by Postgres, and none of it can
//  be checked by a unit test: row-level security, table grants, the school
//  privacy rule in the `gallery` view, and the one security-definer function
//  that lets a fork touch somebody else's row. This walks the whole path with
//  two real members and asserts what each of them can and cannot do.
//
//  It is written as much for the negative cases as the positive ones. "B can
//  publish" is reassuring; "B cannot edit A's design, cannot delete it, cannot
//  unpublish it, and cannot read anyone's reports" is the part that matters,
//  and the part that silently breaks the day a policy is edited.
//
//  Run:  node scripts/verify-commons.mjs
//
//  Credentials come from .env.local. Two member accounts are needed. If the
//  project has email confirmation switched off, the script makes them itself;
//  if not, supply two confirmed accounts:
//
//    VOLTA_TEST_A_EMAIL=... VOLTA_TEST_A_PASSWORD=... \
//    VOLTA_TEST_B_EMAIL=... VOLTA_TEST_B_PASSWORD=... node scripts/verify-commons.mjs
//
//  Everything it creates, it deletes. Rerunnable.
// ============================================================================
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// supabase-js builds a realtime client on construction and refuses to start on
// Node < 22, which has no global WebSocket. This script only ever speaks
// PostgREST and auth, so a stub that would throw if anything tried to open a
// socket is honest: nothing here subscribes, and if something ever does, it
// will say so loudly rather than silently doing nothing.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class {
    constructor() { throw new Error('verify-commons does not use realtime'); }
  };
}

// ---- environment -----------------------------------------------------------
const env = { ...process.env };
try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch { /* env vars only is fine */ }

const URL_ = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_ANON_KEY;
if (!URL_ || !KEY) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or fill .env.local).');
  process.exit(2);
}

// ---- tiny harness ----------------------------------------------------------
let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
/** Assert an operation was refused. A policy that quietly allows something is
 *  indistinguishable from one that works, until it is not. */
function denied(name, { error, data }) {
  const blocked = !!error || !data || (Array.isArray(data) && data.length === 0);
  check(name, blocked, error ? `(${error.code ?? ''} ${error.message})` : 'the write went through');
}
const section = t => console.log(`\n${t}`);

const anon = () => createClient(URL_, KEY, { auth: { persistSession: false } });

// A circuit small enough to read in a diff and real enough to solve.
const CIRCUIT = {
  v: 1,
  comps: [
    { id: 'V1', type: 'V', x: 4, y: 6, rot: 0, value: 5 },
    { id: 'R1', type: 'R', x: 8, y: 4, rot: 0, value: 1000 },
    { id: 'GND1', type: 'GND', x: 4, y: 10, rot: 0, value: 0 },
  ],
  wires: [{ x1: 4, y1: 4, x2: 8, y2: 4 }],
};

// ---- members ---------------------------------------------------------------
const stamp = Date.now().toString(36);
// Supabase runs its own validator over the address and rejects example.com and
// most unregistered domains outright. `.test` is reserved by RFC 2606 —
// guaranteed never to resolve, so a confirmation email cannot reach a stranger
// — and it gets through. Override if your project's validator disagrees.
const DOMAIN = env.VOLTA_TEST_DOMAIN ?? 'volta.test';
async function member(tag) {
  const email = env[`VOLTA_TEST_${tag}_EMAIL`] ?? `volta-verify-${tag.toLowerCase()}-${stamp}@${DOMAIN}`;
  const password = env[`VOLTA_TEST_${tag}_PASSWORD`] ?? `verify-${stamp}-${tag}`;
  const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

  let { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    const up = await sb.auth.signUp({ email, password });
    if (up.error) {
      if (up.error.code === 'over_email_send_rate_limit') {
        throw new Error(
          `${tag}: ${up.error.message}. Supabase's built-in mailer allows 2 messages `
          + 'an hour and only delivers to team members. Either wait, or — better, and '
          + 'necessary before real members ever sign up — configure custom SMTP under '
          + 'Authentication -> Emails.');
      }
      throw new Error(`${tag}: cannot sign up — ${up.error.message}`);
    }
    if (!up.data.session) {
      throw new Error(
        `${tag}: the account was created but has no session, which means this project `
        + 'requires email confirmation. Either confirm it and pass VOLTA_TEST_'
        + `${tag}_EMAIL / _PASSWORD, or turn off Authentication → Sign In / Up → `
        + '"Confirm email" in the dashboard while this runs.');
    }
    data = up.data;
  }
  return { tag, sb, email, id: data.user.id };
}

// ---- the walk --------------------------------------------------------------
const created = { designs: [] };
let A, B;
try {
  section('Members');
  A = await member('A');
  B = await member('B');
  check('two members have sessions', !!A.id && !!B.id && A.id !== B.id);

  section('Profiles');
  const handleA = `verify_a_${stamp}`.slice(0, 20);
  const handleB = `verify_b_${stamp}`.slice(0, 20);
  const pa = await A.sb.from('profiles').upsert({
    id: A.id, handle: handleA, display_name: 'Verify A',
    country: 'GH', school: 'Accra Academy', show_school: false,
  }).select().single();
  check('a member can create their own profile', !pa.error, pa.error?.message);

  const pb = await B.sb.from('profiles').upsert({
    id: B.id, handle: handleB, display_name: 'Verify B',
    country: 'GB', school: null, show_school: false,
  }).select().single();
  check('a second member can too', !pb.error, pb.error?.message);

  // The identity gate: id is checked against auth.uid(), so a profile cannot be
  // created or edited on somebody else's behalf.
  denied('B cannot edit A\'s profile', await B.sb.from('profiles')
    .update({ display_name: 'hijacked' }).eq('id', A.id).select());

  section('Publishing');
  const ins = await A.sb.from('designs').insert({
    author_id: A.id, title: `Verify RC ${stamp}`,
    description: 'Created by scripts/verify-commons.mjs',
    circuit: CIRCUIT, license: 'CC-BY-SA-4.0',
  }).select('id').single();
  check('a member can publish a design', !ins.error, ins.error?.message);
  const designId = ins.data?.id;
  if (designId) created.designs.push({ by: 'A', id: designId });

  denied('nobody can publish under another member\'s name', await B.sb.from('designs')
    .insert({ author_id: A.id, title: 'forged', circuit: CIRCUIT }).select());

  denied('an unknown licence is refused', await A.sb.from('designs')
    .insert({ author_id: A.id, title: 'all rights reserved', circuit: CIRCUIT,
              license: 'PROPRIETARY' }).select());

  section('The commons is public');
  const pub = await anon().from('gallery').select('*').eq('id', designId);
  check('a signed-out visitor can read the gallery', !pub.error && pub.data?.length === 1,
    pub.error?.message ?? `${pub.data?.length ?? 0} rows`);

  const row = pub.data?.[0];
  check('the byline carries name and country', row?.display_name === 'Verify A' && row?.country === 'GH');
  // The privacy rule, applied in the database rather than in every caller.
  check('school stays hidden while show_school is off', row?.school === null,
    `school came back as ${JSON.stringify(row?.school)}`);

  await A.sb.from('profiles').update({ show_school: true }).eq('id', A.id);
  const shown = await anon().from('gallery').select('school').eq('id', designId).single();
  check('and appears once the member opts in', shown.data?.school === 'Accra Academy',
    JSON.stringify(shown.data));
  await A.sb.from('profiles').update({ show_school: false }).eq('id', A.id);

  section('Another member can build on it');
  const opened = await B.sb.from('designs').select('circuit,title').eq('id', designId).single();
  check('B can open A\'s design', !opened.error && !!opened.data?.circuit, opened.error?.message);

  const fork = await B.sb.from('designs').insert({
    author_id: B.id, title: `Verify RC ${stamp} (fork)`,
    circuit: opened.data?.circuit ?? CIRCUIT, forked_from: designId,
  }).select('id').single();
  check('B can publish a fork', !fork.error, fork.error?.message);
  if (fork.data?.id) created.designs.push({ by: 'B', id: fork.data.id });

  // The whole reason record_fork exists: this write is on A's row, and B is
  // rightly forbidden from updating it directly.
  denied('B cannot write to A\'s row directly', await B.sb.from('designs')
    .update({ fork_count: 99 }).eq('id', designId).select());

  const rpc = await B.sb.rpc('record_fork', { source: designId });
  check('but record_fork lets the credit through', !rpc.error, rpc.error?.message);
  const counted = await anon().from('gallery').select('fork_count').eq('id', designId).single();
  check('and the original\'s fork_count moved', counted.data?.fork_count === 1,
    `fork_count = ${counted.data?.fork_count}`);

  section('What a member may not do');
  denied('B cannot edit A\'s design', await B.sb.from('designs')
    .update({ title: 'defaced' }).eq('id', designId).select());
  denied('B cannot unpublish A\'s design', await B.sb.from('designs')
    .update({ published: false }).eq('id', designId).select());
  denied('B cannot delete A\'s design', await B.sb.from('designs')
    .delete().eq('id', designId).select());
  denied('a signed-out visitor cannot publish', await anon().from('designs')
    .insert({ author_id: A.id, title: 'anon', circuit: CIRCUIT }).select());

  section('Reports are write-only');
  const rep = await B.sb.from('reports')
    .insert({ design_id: designId, reporter_id: B.id, reason: 'verification run' });
  check('a member can file a report', !rep.error, rep.error?.message);
  // Filing a report must not double as a way to read what has been reported.
  const readOwn = await B.sb.from('reports').select('*');
  check('and cannot read any, including their own',
    !!readOwn.error || (readOwn.data?.length ?? 0) === 0,
    `${readOwn.data?.length ?? 0} rows came back`);
  const readAnon = await anon().from('reports').select('*');
  check('nor can a signed-out visitor', !!readAnon.error || (readAnon.data?.length ?? 0) === 0);

  section('Moderation is locked to moderators');
  // Neither test member is one, which is the case worth checking: the queue and
  // the takedown have to be shut to an ordinary member, not merely un-shown.
  denied('an ordinary member cannot read the report queue',
    await B.sb.from('report_queue').select('*'));
  denied('nor can a signed-out visitor', await anon().from('report_queue').select('*'));

  const mod = await B.sb.rpc('moderate_set_published', { design: designId, state: false });
  check('an ordinary member cannot unpublish through the moderation RPC', !!mod.error,
    'the call succeeded');
  // And the attempt left nothing behind — the guard has to run before the
  // update, not merely report afterwards.
  const still = await anon().from('gallery').select('id').eq('id', designId);
  check('and the design is still in the commons', still.data?.length === 1);

  section('An author is in charge of their own work');
  const un = await A.sb.from('designs').update({ published: false }).eq('id', designId).select();
  check('A can unpublish', !un.error && un.data?.length === 1, un.error?.message);
  const gone = await anon().from('gallery').select('id').eq('id', designId);
  check('and it leaves the commons at once', gone.data?.length === 0);
  const mine = await A.sb.from('designs').select('id').eq('id', designId);
  check('while the author still sees their own draft', mine.data?.length === 1);
} catch (e) {
  console.error(`\n${e.message}`);
  fail++;
} finally {
  // ---- clean up ------------------------------------------------------------
  for (const d of created.designs) {
    const who = d.by === 'A' ? A : B;
    if (who) await who.sb.from('designs').delete().eq('id', d.id);
  }
  if (A) await A.sb.from('profiles').delete().eq('id', A.id);
  if (B) await B.sb.from('profiles').delete().eq('id', B.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
