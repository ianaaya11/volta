// The -/+ buttons on the inspector's value fields.
//
// Typing "4.7k" is the fast path once you know what you want. Sweeping a value
// to watch what it does to the circuit is the slow path, and it was the only
// one this app didn't have: every change meant selecting the text, typing a new
// number and pressing Enter. These tests hold the two properties that make the
// buttons worth pressing — they land on round bench values, and an edit made
// while the simulation runs reaches the live solver instead of restarting it.
import { test, expect, type Page } from '@playwright/test';

const GRID = 26, PAD = 40;

async function placeResistor(page: Page) {
  await page.goto('/');
  await page.click('#clearBtn');
  await page.click('#fitBtn');
  const box = (await page.locator('#cv').boundingBox())!;
  const p = { x: box.x + PAD + 6 * GRID, y: box.y + PAD + 6 * GRID };
  await page.click('#rail .tool[data-t="R"]');
  await page.mouse.click(p.x, p.y);
  await page.click('#rail .tool[data-t="select"]');
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('#valInput')).toBeVisible();
  return p;
}

const val = (page: Page) => page.locator('#valInput').inputValue();
const bump = (page: Page, dir: '1' | '-1') =>
  page.click(`.stepbtn[data-for="valInput"][data-step="${dir}"]`);

test.describe('value steppers', () => {
  test('+ and - walk the 1-2-5 ladder', async ({ page }) => {
    await placeResistor(page);
    await page.fill('#valInput', '1k');
    await page.locator('#valInput').press('Enter');

    await bump(page, '1');
    expect(await val(page)).toBe('2 k');
    await bump(page, '1');
    expect(await val(page)).toBe('5 k');
    await bump(page, '-1');
    expect(await val(page)).toBe('2 k');
  });

  test('an off-ladder value snaps to the next round one', async ({ page }) => {
    await placeResistor(page);
    await page.fill('#valInput', '4.7k');
    await page.locator('#valInput').press('Enter');
    await bump(page, '1');
    expect(await val(page)).toBe('5 k');
  });

  test('arrow keys step the field too', async ({ page }) => {
    await placeResistor(page);
    await page.fill('#valInput', '100');
    await page.locator('#valInput').press('Enter');
    await page.locator('#valInput').press('ArrowUp');
    expect(await val(page)).toBe('200');
    await page.locator('#valInput').press('ArrowDown');
    expect(await val(page)).toBe('100');
  });

  test('the value never steps to zero or below', async ({ page }) => {
    await placeResistor(page);
    await page.fill('#valInput', '1');
    await page.locator('#valInput').press('Enter');
    for (let i = 0; i < 8; i++) await bump(page, '-1');
    const v = await val(page);
    expect(v).not.toBe('0');
    expect(parseFloat(v)).toBeGreaterThan(0);
  });

  test('stepping mid-run reaches the solver without restarting it', async ({ page }) => {
    const p = await placeResistor(page);
    // A resistor across a source, so the node voltages have something to say.
    const box = (await page.locator('#cv').boundingBox())!;
    const at = (gx: number, gy: number) => ({ x: box.x + PAD + gx * GRID, y: box.y + PAD + gy * GRID });
    await page.click('#rail .tool[data-t="V"]');
    await page.mouse.click(at(2, 6).x, at(2, 6).y);
    await page.click('#rail .tool[data-t="GND"]');
    await page.mouse.click(at(2, 9).x, at(2, 9).y);
    await page.click('#rail .tool[data-t="wire"]');
    for (const q of [at(2, 4), at(6, 4), at(6, 5)]) await page.mouse.click(q.x, q.y);
    await page.mouse.click(at(6, 5).x, at(6, 5).y);
    await page.click('#rail .tool[data-t="wire"]');
    for (const q of [at(6, 7), at(6, 9), at(2, 9)]) await page.mouse.click(q.x, q.y);
    await page.mouse.click(at(2, 9).x, at(2, 9).y);

    await page.click('#runBtn');
    await page.waitForTimeout(400);
    await page.click('#rail .tool[data-t="select"]');
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('#valInput')).toBeVisible();

    // Still running after the edit — the field must not have torn the sim down.
    await bump(page, '1');
    await page.waitForTimeout(200);
    const stillRunning = await page.evaluate(() =>
      !!document.getElementById('runBtn')?.textContent?.match(/stop|pause/i));
    expect(stillRunning).toBe(true);
  });
});
