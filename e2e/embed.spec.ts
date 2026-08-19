// Volta embedded in somebody else's page.
//
// An academic platform integrates Volta by pointing an iframe at the deployed
// URL, so every deploy reaches their students without them re-uploading
// anything. That makes "works inside a cross-origin iframe" a supported
// configuration rather than an accident, and supported configurations need a
// test or they break silently — the failure would show up as a blank panel on
// somebody else's site, where nobody would think to look at us.
//
// The host page is served from 127.0.0.1 and the frame from localhost. Same
// server, different origins — which is exactly the third-party situation a
// partner's site creates, with partitioned storage and no shared cookies, while
// still being a real HTTP page rather than about:blank (whose opaque origin
// blocks the subresource load and tests nothing).
import { test, expect } from '@playwright/test';

// Chrome refuses to let one local-network page frame another (Private/Local
// Network Access). That guard protects real users from a public site reaching
// into their LAN — it has nothing to say about the actual deployment, which is
// a public HTTPS origin framed by another public HTTPS origin. Disabled here so
// the test can reach the dev server; the behaviour under test is untouched.
test.use({ launchOptions: { args: [
  '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks',
] } });

const FRAME = 'http://localhost:5173/';
const HOST = 'http://127.0.0.1:5173/__embed_host';

async function embed(page: import('@playwright/test').Page) {
  await page.route('**/__embed_host', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8">
      <style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>
      <iframe id="volta" src="${FRAME}"></iframe>`,
  }));
  await page.goto(HOST);
  const frame = page.frameLocator('#volta');
  await frame.locator('#cv').waitFor({ timeout: 20000 });
  return frame;
}

test('the editor loads and simulates inside a cross-origin frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));

  const f = await embed(page);
  await expect(f.locator('#cv')).toBeVisible();

  // Not merely present — actually solving. A canvas that renders but cannot run
  // is the failure a screenshot would miss.
  await f.locator('#runBtn').click();
  await expect(f.locator('#runBtn')).toHaveText(/Stop/);

  expect(errors, `console errors in the frame: ${errors.join('; ')}`).toEqual([]);
});

test('storage still works, so a circuit survives a reload', async ({ page }) => {
  // Third-party storage is partitioned rather than shared, which is fine — the
  // circuit persists per embedding site. What would not be fine is it being
  // blocked outright, which is how this breaks on stricter browsers.
  const f = await embed(page);
  const ok = await page.frames()[1].evaluate(() => {
    try {
      localStorage.setItem('__embed_probe', '1');
      const v = localStorage.getItem('__embed_probe');
      localStorage.removeItem('__embed_probe');
      return v === '1';
    } catch { return false; }
  });
  expect(ok, 'localStorage is blocked in the frame').toBe(true);
});

test('the toolbar is usable, not just the canvas', async ({ page }) => {
  const f = await embed(page);
  // The things a lesson would actually reach for.
  await expect(f.locator('#gallery')).toBeVisible();
  await expect(f.locator('#runBtn')).toBeVisible();
  await expect(f.locator('#rail .tool[data-t="R"]')).toBeVisible();
  await f.locator('#gallery').selectOption({ label: 'RC low-pass (transient)' });
  await expect(f.locator('#nodeCount')).not.toHaveText('0 nodes');
});

test('it lands on the editor, with no page to dismiss first', async ({ page }) => {
  // An embedded tool that opens on a page about itself wastes the panel it was
  // given. This is the same landing rule as the standalone app, held here too
  // because an integration is where it would matter most.
  const f = await embed(page);
  await expect(f.locator('#aboutView')).toBeHidden();
  await expect(f.locator('#cv')).toBeVisible();
});
