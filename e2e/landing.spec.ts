// About is the landing page — for someone arriving for the first time.
//
// The rest of the suite runs as a returning visitor (see the storageState in
// playwright.config.ts), so this file is where the first-visit path is
// actually exercised. It uses a fresh context to get there.
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('a first visit lands on About, not the editor', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#aboutView')).toBeVisible();
  await expect(page.locator('h1')).toContainText('A circuit you can watch working');
  // Two ways in, one at the top and one at the foot of the page.
  await expect(page.locator('#aboutClose')).toBeVisible();
  await expect(page.locator('#aboutOpen')).toBeVisible();
});

test('opening the editor is remembered, so it does not reappear', async ({ page }) => {
  await page.goto('/');
  await page.click('#aboutOpen');
  await expect(page.locator('#aboutView')).toBeHidden();
  await expect(page.locator('#cv')).toBeVisible();

  await page.reload();
  await expect(page.locator('#aboutView')).toBeHidden();
  await expect(page.locator('#cv')).toBeVisible();
});

test('a shared-circuit link skips the landing page', async ({ page }) => {
  // Someone following a link came to see a specific circuit. Putting a page
  // about the project in front of it would be in the way, not a welcome.
  await page.goto('/');
  await page.click('#aboutOpen');
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
  await page.click('#aboutOpen');
  await expect(page.locator('#aboutBtn')).toContainText('About');
  await page.click('#aboutBtn');
  await expect(page.locator('#aboutView')).toBeVisible();
  await page.click('#aboutClose');
  await expect(page.locator('#cv')).toBeVisible();
});

test('the collage renders from the built-in examples without disturbing the document', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#aboutMosaic')).toHaveClass(/ready/, { timeout: 10000 });
  // The mosaic loop swaps the document out and back; the editor behind it must
  // be exactly as it was.
  await page.click('#aboutOpen');
  await expect(page.locator('#nodeCount')).not.toHaveText('0 nodes');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
});
