// ============================================================================
//  COMMUNITY — UI wiring
// ============================================================================
//  Everything the commons needs from the editor arrives through `hooks`, and
//  everything it gives back goes out the same way. That keeps this module from
//  reaching into the editor's internals, and it is what lets the whole feature
//  be absent — with no credentials configured, `mountCommunity` is never
//  called and main.ts is unchanged.
// ============================================================================
import * as C from './community';

export interface CommunityHooks {
  /** The current document, exactly as Save writes it. */
  serialize(): unknown;
  /** Replace the editor's document — the same path Open uses. */
  load(doc: unknown, title: string): void;
  /** A small PNG data URL of the schematic as it stands. */
  thumbnail(): string | null;
  /** Say something in the editor's hint bar. */
  hint(html: string): void;
  /** True when there is anything worth sharing. */
  hasCircuit(): boolean;
  /** Show the terms or the privacy notice. Owned by the editor, not by this
   *  module, since both apply with or without an account. */
  openLegal(which: 'terms' | 'privacy'): void;
  /** The built-in examples, and how to measure and draw one. Used for the
   *  Commons backdrop, so it shows real circuits rather than invented ones. */
  backdrop(): {
    docs: unknown[];
    bounds(doc: unknown): { w: number; h: number };
    draw(ctx: CanvasRenderingContext2D, doc: unknown,
         ox: number, oy: number, reveal: number, flow: number): void;
  };
}

const el = (id: string) => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e;
};
const input = (id: string) => el(id) as HTMLInputElement;
const esc = (s: string) => s.replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** A handful of countries up front, then the rest — enough to be worldwide
 *  without shipping a localisation library for a single dropdown. */
const COUNTRIES: [string, string][] = [
  ['', 'Prefer not to say'],
  ['GH', 'Ghana'], ['NG', 'Nigeria'], ['KE', 'Kenya'], ['ZA', 'South Africa'],
  ['EG', 'Egypt'], ['MA', 'Morocco'], ['TZ', 'Tanzania'], ['UG', 'Uganda'],
  ['ET', 'Ethiopia'], ['RW', 'Rwanda'], ['SN', 'Senegal'], ['CI', "Côte d'Ivoire"],
  ['GB', 'United Kingdom'], ['US', 'United States'], ['CA', 'Canada'],
  ['IE', 'Ireland'], ['FR', 'France'], ['DE', 'Germany'], ['ES', 'Spain'],
  ['IT', 'Italy'], ['NL', 'Netherlands'], ['PL', 'Poland'], ['PT', 'Portugal'],
  ['SE', 'Sweden'], ['NO', 'Norway'], ['TR', 'Türkiye'],
  ['IN', 'India'], ['PK', 'Pakistan'], ['BD', 'Bangladesh'], ['CN', 'China'],
  ['JP', 'Japan'], ['KR', 'South Korea'], ['ID', 'Indonesia'], ['PH', 'Philippines'],
  ['VN', 'Vietnam'], ['MY', 'Malaysia'], ['SG', 'Singapore'],
  ['AU', 'Australia'], ['NZ', 'New Zealand'],
  ['BR', 'Brazil'], ['MX', 'Mexico'], ['AR', 'Argentina'], ['CL', 'Chile'],
  ['CO', 'Colombia'], ['PE', 'Peru'],
  ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['IL', 'Israel'],
];

export function mountCommunity(hooks: CommunityHooks) {
  el('communityGroup').hidden = false;
  (el('licLink') as HTMLAnchorElement).href = C.LICENSE_URL;
  el('pubLicenseText').textContent = C.LICENSE_SUMMARY;

  const sel = el('profCountry') as HTMLSelectElement;
  sel.innerHTML = COUNTRIES.map(([c, n]) =>
    `<option value="${c}">${c ? C.flag(c) + '  ' : ''}${esc(n)}</option>`).join('');

  let profile: C.Profile | null = null;
  // Resolve who is signed in straight away — the toolbar should say so without
  // waiting for someone to open the account panel first.
  void C.session().then(async s => {
    if (!s) return;
    profile = await C.myProfile().catch(() => null);
    paintAccount(true, s.user.email ?? undefined);
    void refreshModerator();
  });
  // A reset link produces a real session, so without this the modal would show
  // the profile form to somebody whose only reason for being here is that they
  // cannot get in.
  let recovering = false;
  // What the age screen and the consent box collected during THIS sign-up. The
  // profile is created later — a member signs up first and fills in who they
  // are afterwards — so the answers have to survive the gap. Not persisted:
  // once the profile row exists, that row is the record.
  const consentThisSession = { age: false, terms: null as string | null };

  // Set when the open document came from someone else's design, so publishing
  // it records the lineage instead of quietly presenting it as original work.
  let forkedFrom: string | null = null;

  // Arriving from a reset email. The SDK has already exchanged the fragment for
  // a session by the time this module loads, so all that is left is to put the
  // right form in front of the member. Checked before anything else touches the
  // hash, because the handler clears it.
  if (C.isRecoveryLink()) {
    recovering = true;
    el('authModal').hidden = false;
    void refreshAccount();
  }

  const say = (id: string, msg: string, kind: 'good' | 'bad' | '' = '') => {
    el(id).innerHTML = msg ? `<div class="${kind === 'bad' ? 'aibad' : kind === 'good' ? 'aigood' : 'empty'}">${esc(msg)}</div>` : '';
  };

  // ---- account ------------------------------------------------------------
  /** Who you are, in the toolbar. Three states worth distinguishing: signed
   *  out, signed in with a profile, and signed in without one — that last is a
   *  half-finished setup, and saying so is more use than showing an email. */
  function paintAccount(signedIn: boolean, email?: string) {
    const label = el('accountLabel');
    const btn = el('accountBtn');
    if (!signedIn) {
      label.textContent = 'Sign in';
      btn.title = 'Sign in to share your designs';
    } else if (profile) {
      label.textContent = '@' + profile.handle;
      btn.title = `${profile.display_name}${email ? ' · ' + email : ''} — edit your profile`;
    } else {
      label.textContent = 'Finish profile';
      btn.title = 'Pick a handle and display name before sharing';
    }
  }

  async function refreshAccount() {
    const s = await C.session();
    el('authRecovery').hidden = !recovering;
    el('authSignedOut').hidden = recovering || !!s;
    el('authSignedIn').hidden = recovering || !s;
    el('authTitle').textContent = recovering ? 'Choose a new password'
      : s ? 'Your member profile' : 'Member account';
    if (recovering) {
      el('authRecoveryWho').textContent = s?.user.email ?? 'your account';
      // No session behind a recovery link means the link is spent — they expire
      // in an hour and are single-use. Saying so beats letting them type a
      // password and meet "Auth session missing" on submit.
      say('authRecoveryStatus', s ? ''
        : 'That reset link has expired or has already been used. '
          + 'Close this and ask for a new one.', s ? '' : 'bad');
      return;
    }
    if (!s) {
      // Sign-out has to drop the role with the session, or the Reports button
      // stays in the toolbar for the next person to use this browser.
      profile = null; moderator = false;
      el('galleryReports').hidden = true;
      if (showingReports) { showReports(false); void renderGallery(); }
      paintAccount(false);
      return;
    }
    el('authWho').textContent = s.user.email ?? '';
    profile = await C.myProfile();
    paintAccount(true, s.user.email ?? undefined);
    void refreshModerator();
    if (profile) {
      input('profHandle').value = profile.handle;
      input('profName').value = profile.display_name;
      sel.value = profile.country ?? '';
      input('profSchool').value = profile.school ?? '';
      input('profShowSchool').checked = profile.show_school;
    } else {
      // A first-time member gets a starting point rather than four blank boxes.
      input('profHandle').value = (s.user.email ?? '').split('@')[0]
        .toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
      input('profName').value = '';
    }
  }

  const openAuth = async () => {
    el('authModal').hidden = false;
    say('authStatus', ''); say('profStatus', '');
    await refreshAccount();
  };

  el('accountBtn').onclick = openAuth;
  el('authClose').onclick = () => { el('authModal').hidden = true; };
  el('authModal').onclick = e => { if (e.target === el('authModal')) el('authModal').hidden = true; };

  el('authSignIn').onclick = async () => {
    say('authStatus', 'Signing in…');
    try {
      await C.signIn(input('authEmail').value.trim(), input('authPassword').value);
      say('authStatus', '');
      await refreshAccount();
    } catch (e) { say('authStatus', msg(e), 'bad'); }
  };

  // The extra fields belong to creating an account, not to signing in to one.
  // Showing them from the start makes signing in look like a form to fill.
  const showNewOnly = (on: boolean) => {
    el('authNewOnly').hidden = !on;
    el('authWhyAge').hidden = !on;
  };
  el('authEmail').addEventListener('input', () => showNewOnly(true));

  el('authWhyAge').onclick = () => say('authStatus',
    `The commons is for members of ${C.MIN_AGE} and over, because publishing means `
    + 'strangers can see your name and your work. The editor needs no account and '
    + 'always works in full. Your date of birth is used to check your age and then '
    + 'discarded — it is never stored.');

  el('authSignUp').onclick = async () => {
    showNewOnly(true);
    // Both gates before the account exists, so an account is never created for
    // somebody who cannot have one.
    const bad = C.checkAge(input('authDob').value);
    if (bad) { say('authStatus', bad, 'bad'); return; }
    if (!input('authTerms').checked) {
      say('authStatus', 'Please read and accept the terms and the privacy notice.', 'bad');
      return;
    }
    say('authStatus', 'Creating your account…');
    try {
      await C.signUp(input('authEmail').value.trim(), input('authPassword').value);
      consentThisSession.age = true;
      consentThisSession.terms = C.TERMS_VERSION;
      // Whether a confirmation email is required is a project setting, so say
      // what is true in both cases rather than guessing.
      say('authStatus', 'Account created. If your project requires email confirmation, '
        + 'follow the link we sent, then sign in.', 'good');
      await refreshAccount();
    } catch (e) { say('authStatus', msg(e), 'bad'); }
  };

  el('authForgot').onclick = async () => {
    say('authStatus', 'Sending a reset link…');
    try {
      await C.requestPasswordReset(input('authEmail').value);
      // Deliberately the same message whether or not that address has an
      // account. Saying "no such member" turns this box into a way to find out
      // who is registered.
      say('authStatus', 'If that address has an account, a reset link is on its way. '
        + 'Open it on this device — the link signs you in just long enough to '
        + 'set a new password.', 'good');
    } catch (e) { say('authStatus', msg(e), 'bad'); }
  };

  el('authSetPassword').onclick = async () => {
    say('authRecoveryStatus', 'Saving…');
    try {
      await C.updatePassword(input('authNewPassword').value);
      recovering = false;
      input('authNewPassword').value = '';
      // Drop the recovery token from the address bar. Leaving it there means a
      // reload replays this screen, and it survives in history and in anything
      // the member pastes the URL into.
      history.replaceState(null, '', location.pathname + location.search);
      await refreshAccount();
      say('profStatus', 'Password changed. You are signed in.', 'good');
      hooks.hint('Password changed — you are signed in.');
    } catch (e) { say('authRecoveryStatus', msg(e), 'bad'); }
  };

  el('authSignOut').onclick = async () => {
    await C.signOut(); profile = null;
    await refreshAccount();
    hooks.hint('Signed out. The editor keeps working — an account is only needed to share.');
  };

  el('profDelete').onclick = async () => {
    // Two steps, because it cannot be undone and the button sits next to Save.
    if (!confirm('Delete your account?\n\nThis removes your login, your profile '
      + 'and every design you have published. It cannot be undone.')) return;
    const typed = prompt('This is permanent. Type DELETE to confirm.');
    if (typed?.trim().toUpperCase() !== 'DELETE') { say('delStatus', 'Cancelled.'); return; }
    say('delStatus', 'Deleting…');
    try {
      await C.deleteAccount();
      profile = null;
      el('authModal').hidden = true;
      await refreshAccount();
      hooks.hint('Your account and everything you published have been deleted.');
    } catch (e) { say('delStatus', msg(e), 'bad'); }
  };

  el('profSave').onclick = async () => {
    say('profStatus', 'Saving…');
    try {
      profile = await C.saveProfile({
        handle: input('profHandle').value.trim().toLowerCase(),
        display_name: input('profName').value,
        country: sel.value || null,
        school: input('profSchool').value || null,
        show_school: input('profShowSchool').checked,
        // Carried from the account that was created, or from the row that
        // already has them. The database refuses to publish without both.
        age_confirmed: profile?.age_confirmed ?? consentThisSession.age,
        terms_version: profile?.terms_version ?? consentThisSession.terms,
      });
      say('profStatus', 'Saved.', 'good');
      paintAccount(true);
    } catch (e) { say('profStatus', msg(e), 'bad'); }
  };

  // ---- publish ------------------------------------------------------------
  el('publishBtn').onclick = async () => {
    if (!hooks.hasCircuit()) { hooks.hint('Draw something first — there is nothing to share yet.'); return; }
    const s = await C.session();
    if (!s) { await openAuth(); say('authStatus', 'Sign in to share a design.', ''); return; }
    if (!profile) profile = await C.myProfile();
    if (!profile) { await openAuth(); say('profStatus', 'Set up your profile before sharing.', ''); return; }

    el('publishModal').hidden = false;
    say('pubStatus', '');
    input('pubLicense').checked = false;
    const thumb = hooks.thumbnail();
    const img = el('pubThumb') as HTMLImageElement;
    if (thumb) { img.src = thumb; img.hidden = false; } else img.hidden = true;
    el('pubForked').hidden = !forkedFrom;
    if (forkedFrom) el('pubForked').textContent =
      'This started from another member\'s design. Sharing it will credit them.';
  };

  const closePublish = () => { el('publishModal').hidden = true; };
  el('publishClose').onclick = closePublish;
  el('publishCancel').onclick = closePublish;
  el('publishModal').onclick = e => { if (e.target === el('publishModal')) closePublish(); };

  el('publishGo').onclick = async () => {
    if (!input('pubLicense').checked) {
      say('pubStatus', 'Tick the licence box — the commons only works if everything in it '
        + 'can actually be reused.', 'bad');
      return;
    }
    say('pubStatus', 'Sharing…');
    try {
      await C.publish({
        title: input('pubTitle').value,
        description: (el('pubDesc') as HTMLTextAreaElement).value,
        circuit: hooks.serialize(),
        thumbnail: hooks.thumbnail(),
        forkedFrom,
      });
      closePublish();
      hooks.hint('Shared with the commons. Anyone can now open it and build on it.');
    } catch (e) { say('pubStatus', msg(e), 'bad'); }
  };

  // ---- gallery ------------------------------------------------------------
  const view = el('galleryView');
  let mineOnly = false;

  async function renderGallery() {
    showReports(false);
    const grid = el('galleryGrid');
    const empty = el('galleryEmpty');
    grid.innerHTML = '<div class="galempty">Loading…</div>';
    empty.hidden = true;
    try {
      const items = mineOnly ? await C.myDesigns()
        : await C.listGallery({ search: input('gallerySearch').value });
      grid.innerHTML = '';
      if (!items.length) {
        empty.hidden = false;
        empty.textContent = mineOnly
          ? "You haven't shared anything yet. Build a circuit, then press Share."
          : 'Nothing here yet — be the first to share a design.';
        return;
      }
      for (const it of items) grid.appendChild(card(it));
    } catch (e) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = msg(e);
    }
  }

  function card(it: C.GalleryItem): HTMLElement {
    const d = document.createElement('article');
    d.className = 'galcard';
    d.innerHTML =
      `<div class="galthumb">${it.thumbnail
        ? `<img src="${esc(it.thumbnail)}" alt="" loading="lazy">`
        : '<span>no preview</span>'}</div>`
      + `<h4>${esc(it.title)}</h4>`
      + `<p class="galby">${esc(C.byline(it))}</p>`
      + (it.description ? `<p class="galdesc">${esc(it.description)}</p>` : '')
      + `<p class="galmeta">${it.fork_count} ${it.fork_count === 1 ? 'fork' : 'forks'}`
      + `${it.forked_from ? ' · built on another design' : ''}</p>`
      + `<div class="galact">`
      + `<button class="btn primary" data-open="${it.id}">Open &amp; build on it</button>`
      + `<button class="btn icon ghost" data-report="${it.id}" title="Report this design">!</button>`
      + `</div>`;

    d.querySelector<HTMLElement>('[data-open]')!.onclick = async () => {
      try {
        const got = await C.loadDesign(it.id);
        hooks.load(got.circuit, got.title);
        // The opened design becomes the parent of whatever you share next, so
        // credit follows the work without anyone having to remember to add it.
        forkedFrom = it.id;
        input('pubTitle').value = `${got.title} (remix)`;
        (el('pubDesc') as HTMLTextAreaElement).value = '';
        closeGallery();
        hooks.hint(`Opened <b>${esc(got.title)}</b> by ${esc(it.display_name)}. `
          + 'Change anything you like — sharing it back will credit them.');
      } catch (e) { alert(msg(e)); }
    };
    d.querySelector<HTMLElement>('[data-report]')!.onclick = async () => {
      const why = prompt('What is wrong with this design?');
      if (!why?.trim()) return;
      try { await C.report(it.id, why); alert('Reported. Thank you.'); }
      catch (e) { alert(msg(e)); }
    };
    return d;
  }

  // ---- moderation ---------------------------------------------------------
  // The button appears only if the database says this member is a moderator.
  // That check is a convenience: reports_read is what actually decides, and to
  // anyone else the queue simply comes back empty.
  let moderator = false;
  let showingReports = false;

  async function refreshModerator() {
    moderator = await C.amModerator().catch(() => false);
    el('galleryReports').hidden = !moderator;
    if (!moderator && showingReports) { showingReports = false; void renderGallery(); }
    if (moderator) void countReports();
  }

  async function countReports() {
    try {
      const n = (await C.reportQueue()).length;
      const pill = el('reportCount');
      pill.textContent = n ? String(n) : '';
      pill.hidden = !n;
    } catch { /* the badge is not worth an error message */ }
  }

  /** Both panes live in the same view; only one is ever on screen. */
  function showReports(on: boolean) {
    showingReports = on;
    el('reportQueue').hidden = !on;
    el('galleryGrid').hidden = on;
    if (on) el('galleryEmpty').hidden = true;
  }

  async function renderReports() {
    showReports(true);
    const q = el('reportQueue');
    q.innerHTML = '<div class="galempty">Loading…</div>';
    let rows: C.ReportRow[];
    try { rows = await C.reportQueue(); }
    catch (e) { q.innerHTML = `<div class="galempty">${esc(msg(e))}</div>`; return; }
    if (!rows.length) {
      q.innerHTML = '<div class="galempty">Nothing reported. That is the good outcome.</div>';
      el('reportCount').hidden = true;
      return;
    }
    q.innerHTML = '';
    for (const r of rows) q.appendChild(reportCard(r));
    void countReports();
  }

  function reportCard(r: C.ReportRow): HTMLElement {
    const d = document.createElement('article');
    d.className = 'repcard' + (r.published ? '' : ' down');
    const who = r.author_name
      ? `${esc(r.author_name)}${r.author_handle ? ' · @' + esc(r.author_handle) : ''}`
      : 'author deleted';
    d.innerHTML =
      `<div class="galthumb">${r.thumbnail
        ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy">`
        : '<span>no preview</span>'}</div>`
      + `<h4>${esc(r.title)}</h4>`
      + `<p class="repmeta">${who} · reported ${new Date(r.created_at).toLocaleDateString()}`
      + `${r.published ? '' : ' · <b>currently down</b>'}</p>`
      + `<p class="repreason">${esc(r.reason)}</p>`
      + `<div class="repact">`
      + `<button class="btn" data-open>Look at it</button>`
      + `<button class="btn" data-toggle>${r.published ? 'Take it down' : 'Put it back'}</button>`
      + `<button class="btn ghost" data-dismiss>Dismiss</button>`
      + `</div>`;

    // Judging a circuit without opening it is guessing. This loads it into the
    // editor exactly as a member would see it.
    d.querySelector<HTMLElement>('[data-open]')!.onclick = async () => {
      try {
        const got = await C.loadDesign(r.design_id);
        hooks.load(got.circuit, got.title);
        forkedFrom = null;          // reviewing is not forking
        closeGallery();
        hooks.hint(`Reviewing <b>${esc(got.title)}</b>. Reopen the commons to act on the report.`);
      } catch (e) { alert(msg(e)); }
    };

    d.querySelector<HTMLElement>('[data-toggle]')!.onclick = async () => {
      try {
        await C.setPublished(r.design_id, !r.published);
        await renderReports();
      } catch (e) { alert(msg(e)); }
    };

    d.querySelector<HTMLElement>('[data-dismiss]')!.onclick = async () => {
      // Dismissing destroys the report, so it asks. Taking a design down is
      // reversible from this same card; this is not.
      if (!confirm('Dismiss this report? The design stays as it is and the report is deleted.')) return;
      try { await C.dismissReport(r.id); await renderReports(); }
      catch (e) { alert(msg(e)); }
    };
    return d;
  }

  el('galleryReports').onclick = () => { void renderReports(); };

  // ---- terms & privacy ----------------------------------------------------
  // The view itself is owned by main.ts, because it exists whether or not the
  // commons is configured — the privacy notice describes the offline editor
  // too, and "we collect nothing" is a thing worth being able to read. These
  // are the links inside the sign-up form, where the terms are being agreed to
  // and so have to be reachable without losing what has been typed.
  el('authTermsLink').onclick = e => { e.preventDefault(); hooks.openLegal('terms'); };
  el('authPrivacyLink').onclick = e => { e.preventDefault(); hooks.openLegal('privacy'); };

  // ---- cross-links --------------------------------------------------------
  // The commons and the About page each need a way to the other and back to
  // the editor; a full-screen view with no labelled exit is a dead end.
  const about = el('aboutView');
  el('aboutCta').hidden = false;
  el('aboutCommons').hidden = false;
  el('aboutCommons').onclick = () => { about.hidden = true; void openGallery(); mineOnly = false; renderGallery(); };
  el('galleryAbout').onclick = () => { closeGallery(); about.hidden = false; };
  el('aboutRegister').onclick = async () => {
    about.hidden = true;
    await openAuth();
    say('authStatus', 'Pick an email and password, then choose Create account.', '');
  };
  el('aboutLogin').onclick = async () => { about.hidden = true; await openAuth(); };

  // The animated backdrop runs only while the Commons is open — it is scenery,
  // and scenery behind a hidden view is pure heat. Loaded on first open so the
  // editor never pays for it.
  let stopBackdrop: (() => void) | null = null;
  async function openGallery() {
    view.hidden = false;
    if (!stopBackdrop) {
      const { startCircuitBackdrop } = await import('./circuit-bg');
      stopBackdrop = startCircuitBackdrop(el('commonsBg') as HTMLCanvasElement, hooks.backdrop());
    }
  }
  function closeGallery() {
    view.hidden = true;
    stopBackdrop?.();
    stopBackdrop = null;
  }

  el('galleryBtn').onclick = () => { void openGallery(); mineOnly = false; renderGallery(); };
  el('galleryClose').onclick = closeGallery;
  el('galleryAll').onclick = () => { mineOnly = false; showReports(false); renderGallery(); };
  el('galleryMine').onclick = () => { mineOnly = true; showReports(false); renderGallery(); };
  let t: number | undefined;
  el('gallerySearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(renderGallery, 250) as unknown as number;
  });
  el('gallerySearch').addEventListener('keydown', e => {
    if ((e as KeyboardEvent).key === 'Escape') { input('gallerySearch').value = ''; renderGallery(); }
  });

  // A new document is nobody's fork. Publishing a blank-slate circuit as a
  // remix of whatever you last opened would credit the wrong person.
  return { clearLineage: () => { forkedFrom = null; } };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
