// The editor is the landing page.
//
// About used to be, on the reasoning that a stranger deserves to know what they
// have opened before being handed a canvas. The people actually using this
// arrive knowing what it is, so a page to dismiss became a page in the way.
// These tests hold the new arrangement: straight to the canvas, About one
// button away, and #about still a direct link for anyone sharing it.
//
// A fresh context, because the rest of the suite runs with storage already
// primed and would not notice if a welcome screen came back.
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('a first visit lands on the editor, with nothing to dismiss', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#cv')).toBeVisible();
  await expect(page.locator('#aboutView')).toBeHidden();
  // The canvas is live immediately: a part can be placed without a click of
  // ceremony first.
  await expect(page.locator('#rail .tool[data-t="R"]')).toBeVisible();
});

test('it stays that way on a return visit', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#aboutView')).toBeHidden();
  await page.reload();
  await expect(page.locator('#aboutView')).toBeHidden();
  await expect(page.locator('#cv')).toBeVisible();
});

test('#about opens it directly, for anyone linking to it', async ({ page }) => {
  await page.goto('/#about');
  await expect(page.locator('#aboutView')).toBeVisible();
  await expect(page.locator('#aboutView h1')).toContainText('A circuit you can watch working');
  await page.click('#aboutClose');
  await expect(page.locator('#cv')).toBeVisible();
});

test('a shared-circuit link skips the landing page', async ({ page }) => {
  // Someone following a link came to see a specific circuit. Putting a page
  // about the project in front of it would be in the way, not a welcome.
  await page.goto('/');
  await page.selectOption('#gallery', { index: 1 });
  await page.click('#shareBtn');
  const url = await page.evaluate(() => location.href);
  expect(url).toContain('#');

  const fresh = await page.context().browser()!.newContext();
  const p2 = await fresh.newPage();
  await p2.goto(url);
  await expect(p2.locator('#aboutView')).toBeHidden();
  await expect(p2.locator('#nodeCount')).not.toHaveText('0 nodes');
  await fresh.close();
});

test('the About page is reachable from the editor and returns to it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#aboutBtn')).toContainText('About');
  await page.click('#aboutBtn');
  await expect(page.locator('#aboutView')).toBeVisible();
  await page.click('#aboutClose');
  await expect(page.locator('#cv')).toBeVisible();
});

test('the collage renders from the built-in examples without disturbing the document', async ({ page }) => {
  await page.goto('/#about');
  await expect(page.locator('#aboutMosaic')).toHaveClass(/ready/, { timeout: 10000 });
  // The mosaic loop swaps the document out and back; the editor behind it must
  // be exactly as it was.
  await page.click('#aboutOpen');
  await expect(page.locator('#nodeCount')).not.toHaveText('0 nodes');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
});
