// Volta without a backend.
//
// The community layer is additive. With no VITE_SUPABASE_* credentials in the
// build — which is how the e2e suite builds — the whole feature must be
// absent: no toolbar group, no network calls, no SDK fetched, and an editor
// that behaves exactly as it did before any of it existed. That is the
// supported configuration for an offline PWA, so it is worth a test rather
// than an assumption.
import { test, expect } from '@playwright/test';

test('the community toolbar stays hidden when nothing is configured', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#communityGroup')).toBeHidden();
  await expect(page.locator('#galleryBtn')).toBeHidden();
  await expect(page.locator('#publishBtn')).toBeHidden();
  await expect(page.locator('#accountBtn')).toBeHidden();
});

test('no request is made to any backend', async ({ page }) => {
  const external: string[] = [];
  page.on('request', r => {
    const u = r.url();
    if (!u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:')) {
      external.push(u);
    }
  });
  await page.goto('/');
  await page.selectOption('#gallery', { index: 1 });
  await page.click('#runBtn');
  await page.waitForTimeout(800);
  expect(external).toEqual([]);
});

test('the Supabase SDK is not in the shipped bundle', async ({ page }) => {
  // Dead-code elimination should remove the community import entirely when
  // `configured` folds to false, so the chunk is never even emitted.
  const scripts: string[] = [];
  page.on('response', r => { if (r.url().endsWith('.js')) scripts.push(r.url()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(scripts.some(s => /supabase|community/i.test(s))).toBe(false);
});

test('the editor is entirely unaffected — build, run, read a value', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { index: 1 });   // RC low-pass
  await page.click('#fitBtn');
  await expect(page.locator('#nodeCount')).toHaveText('3 nodes');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect.poll(async () => (await page.locator('table.probes tr').count()) > 1).toBe(true);
});

test('the toolbar never widens the page, even with the commons showing', async ({ page }) => {
  // Regression. Making the commons buttons visible pushed the header past the
  // window, <body> gained a horizontal scrollbar, and Run ended up off the
  // right-hand edge — reachable only by scrolling the whole app sideways, which
  // also slid the canvas out from under every coordinate the tests click.
  // Forced visible here so the check holds without needing credentials.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.evaluate(() => { document.getElementById('communityGroup')!.hidden = false; });

  const m = await page.evaluate(() => {
    const run = document.getElementById('runBtn')!.getBoundingClientRect();
    return {
      bodyScrollWidth: document.body.scrollWidth,
      viewport: window.innerWidth,
      runRight: Math.round(run.right),
      runLeft: Math.round(run.left),
    };
  });
  expect(m.bodyScrollWidth).toBeLessThanOrEqual(m.viewport);
  // Run is the one control that must never move out of reach.
  expect(m.runLeft).toBeGreaterThanOrEqual(0);
  expect(m.runRight).toBeLessThanOrEqual(m.viewport);
});

test('the publish and gallery dialogs exist but are closed', async ({ page }) => {
  // They ship in the markup so the feature is one env var away, but nothing
  // may be visible or focusable until it is switched on.
  await page.goto('/');
  for (const id of ['#galleryView', '#authModal', '#publishModal', '#legalView']) {
    await expect(page.locator(id)).toBeHidden();
  }
});

test('a recovery link does nothing when the commons is switched off', async ({ page }) => {
  // The password-reset form is driven by the URL fragment, and the fragment is
  // the one thing an attacker controls for free. With no backend configured
  // there is no account to reset, so the form must stay shut rather than
  // appearing and failing.
  await page.goto('/#access_token=whatever&type=recovery');
  await expect(page.locator('#authModal')).toBeHidden();
  await expect(page.locator('#authRecovery')).toBeHidden();
  // And the editor is still the editor.
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
});

test('the terms and the privacy notice are readable without an account',
  async ({ page }) => {
    // They describe the offline editor too — "nothing leaves your device" is
    // exactly the sort of claim a person should be able to go and check — so
    // they are wired by the editor, not by the community layer, and are
    // reachable in a build with no backend at all.
    await page.goto('/');
    await page.click('#aboutBtn');
    await page.click('#aboutTerms');
    await expect(page.locator('#legalView')).toBeVisible();
    await expect(page.locator('#legalTerms')).toContainText('Terms of use');
    await expect(page.locator('#legalTerms')).toContainText(/15 years old/);
    await expect(page.locator('#legalPrivacy')).toBeHidden();

    await page.click('[data-legal="privacy"]');
    await expect(page.locator('#legalPrivacy')).toContainText('Privacy notice');
    await expect(page.locator('#legalPrivacy')).toContainText(/We do not store it/);
    await expect(page.locator('#legalTerms')).toBeHidden();

    // Marked as a draft, unmissably, so it cannot be published by accident.
    await expect(page.locator('.draftbanner')).toContainText(/not yet reviewed by a lawyer/i);

    await page.keyboard.press('Escape');
    await expect(page.locator('#legalView')).toBeHidden();
  });

test('the admin tabs are not in an unconfigured build', async ({ page }) => {
  // Members and Reports are moderator-only, and a build with no backend has no
  // moderators — nor any way to become one. They must be absent rather than
  // present-and-empty, which would advertise a control panel that is not there.
  await page.goto('/');
  await expect(page.locator('#galleryMembers')).toBeHidden();
  await expect(page.locator('#galleryReports')).toBeHidden();
  await expect(page.locator('#memberQueue')).toBeHidden();
});

// ---------------------------------------------------------------------------
//  The privacy notice has to keep up with the software
// ---------------------------------------------------------------------------
//  This document went stale the moment the served assistant shipped: it still
//  said nothing left your device, while a signed-in member's question and whole
//  circuit were being sent to a third party. Nobody noticed, because nothing
//  was watching.
//
//  So these watch. They are deliberately keyed to CAPABILITIES rather than to
//  wording — if the app can send data to Anthropic, the notice must say so, and
//  a rewrite that keeps the meaning will still pass.
test.describe('privacy notice matches what the app actually does', () => {
  const openPrivacy = async (page: import('@playwright/test').Page) => {
    await page.goto('/');
    await page.evaluate(() =>
      (document.querySelector('[data-legal="privacy"]') as HTMLElement)?.click());
    await expect(page.locator('#legalPrivacy')).toBeVisible();
    return (await page.locator('#legalPrivacy').textContent())!.replace(/\s+/g, ' ');
  };

  test('names the third party that answers assistant questions', async ({ page }) => {
    const t = await openPrivacy(page);
    expect(t).toMatch(/Anthropic/);
  });

  test('says what is sent, not merely that something is', async ({ page }) => {
    const t = await openPrivacy(page);
    // The question AND the circuit both go. Naming only one would understate it.
    expect(t).toMatch(/question/i);
    expect(t).toMatch(/circuit currently on the canvas/i);
  });

  test('discloses the per-member usage count the database keeps', async ({ page }) => {
    // ai_usage holds a row per member per day. It is small, but it is retained
    // personal data and an undisclosed one is the kind of thing that matters.
    const t = await openPrivacy(page);
    expect(t).toMatch(/count/i);
    expect(t).toMatch(/per day|today/i);
  });

  test('still distinguishes the bring-your-own-key route, which we never see', async ({ page }) => {
    const t = await openPrivacy(page);
    expect(t).toMatch(/never touches our server|we never see it/i);
  });

  test('the terms warn that assistant output is unchecked', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() =>
      (document.querySelector('[data-legal="terms"]') as HTMLElement)?.click());
    const t = (await page.locator('#legalTerms').textContent())!.replace(/\s+/g, ' ');
    expect(t).toMatch(/not checked by anyone|looks right and is not/i);
    expect(t).toMatch(/rationed|per member per day/i);
  });
});
