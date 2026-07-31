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
  });
  // Set when the open document came from someone else's design, so publishing
  // it records the lineage instead of quietly presenting it as original work.
  let forkedFrom: string | null = null;

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
    el('authSignedOut').hidden = !!s;
    el('authSignedIn').hidden = !s;
    el('authTitle').textContent = s ? 'Your member profile' : 'Member account';
    if (!s) { profile = null; paintAccount(false); return; }
    el('authWho').textContent = s.user.email ?? '';
    profile = await C.myProfile();
    paintAccount(true, s.user.email ?? undefined);
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

  el('authSignUp').onclick = async () => {
    say('authStatus', 'Creating your account…');
    try {
      await C.signUp(input('authEmail').value.trim(), input('authPassword').value);
      // Whether a confirmation email is required is a project setting, so say
      // what is true in both cases rather than guessing.
      say('authStatus', 'Account created. If your project requires email confirmation, '
        + 'follow the link we sent, then sign in.', 'good');
      await refreshAccount();
    } catch (e) { say('authStatus', msg(e), 'bad'); }
  };

  el('authSignOut').onclick = async () => {
    await C.signOut(); profile = null;
    await refreshAccount();
    hooks.hint('Signed out. The editor keeps working — an account is only needed to share.');
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
  el('galleryAll').onclick = () => { mineOnly = false; renderGallery(); };
  el('galleryMine').onclick = () => { mineOnly = true; renderGallery(); };
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
