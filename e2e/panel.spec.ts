// Putting the inspector away.
//
// The canvas is the thing the app exists to show, and the panel takes 300px of
// a laptop window or 36% of a phone screen whatever is in it. These tests are
// about the space actually coming back, not about a class name changing.
import { test, expect, type Page } from '@playwright/test';

const canvasBox = (page: Page) => page.evaluate(() => {
  const r = document.getElementById('cv')!.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});

test('shutting the panel gives the width to the canvas', async ({ page }) => {
  await page.goto('/');
  const open = await canvasBox(page);
  await expect(page.locator('#inspectorToggle')).toHaveAttribute('aria-expanded', 'true');

  await page.click('#inspectorToggle');
  await expect(page.locator('#inspectorToggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#inspectorBody')).toBeHidden();

  const shut = await canvasBox(page);
  expect(shut.w, 'the canvas should be wider with the panel away').toBeGreaterThan(open.w);
  // Not a token widening: the panel is 300px and only 40px is kept for the
  // chevron, so most of it should have come back.
  expect(shut.w - open.w).toBeGreaterThan(200);
});

test('the toggle brings it back, with the readouts intact', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { index: 1 });
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect(page.locator('#roTable')).toContainText('node');

  await page.click('#inspectorToggle');
  await expect(page.locator('#inspectorBody')).toBeHidden();
  await page.click('#inspectorToggle');
  await expect(page.locator('#inspectorBody')).toBeVisible();
  // The panel is rebuilt every frame while running, so what matters is that it
  // comes back populated rather than as an empty box.
  await expect(page.locator('#roTable')).toContainText('node');
});

test('the choice is remembered, because it is about the chrome not the circuit',
  async ({ page }) => {
    await page.goto('/');
    await page.click('#inspectorToggle');
    await page.reload();
    await expect(page.locator('#inspectorBody')).toBeHidden();
    await expect(page.locator('#inspectorToggle')).toHaveAttribute('aria-expanded', 'false');

    await page.click('#inspectorToggle');
    await page.reload();
    await expect(page.locator('#inspectorBody')).toBeVisible();
  });

test('the canvas is re-measured, so clicks still land where they look',
  async ({ page }) => {
    // The canvas sizes itself from its own box. Widen the column without
    // telling it and the schematic keeps the old width, so every coordinate is
    // off by the difference — parts stop being where they are drawn.
    await page.goto('/');
    await page.click('#clearBtn');
    await page.click('#inspectorToggle');
    await page.click('#fitBtn');

    const GRID = 26, PAD = 40;
    const box = (await page.locator('#cv').boundingBox())!;
    await page.click('#rail .tool[data-t="R"]');
    await page.mouse.click(box.x + PAD + 4 * GRID, box.y + PAD + 4 * GRID);
    await page.click('#rail .tool[data-t="select"]');
    await page.mouse.click(box.x + PAD + 5 * GRID, box.y + PAD + 4 * GRID);
    await expect(page.locator('#inspectorBody h3').first(),
      'the resistor should be exactly where it was clicked').toHaveText('Resistor');
  });
