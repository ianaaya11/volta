// Coloured LEDs.
//
// Every LED used to render the same orange and simulate as a 0.7 V silicon
// diode, so a traffic light came out as three identical amber lamps that all
// lit from any supply. The colour now picks the model: red drops 1.8 V, blue
// 3.0 V. These check the two halves that matter to someone building one — the
// canvas shows the colour you chose, and the physics follows it.
import { test, expect, type Page } from '@playwright/test';

const GRID = 26, PAD = 40;

async function ledOnGrid(page: Page) {
  await page.goto('/');
  await page.click('#clearBtn');
  await page.click('#fitBtn');
  const box = (await page.locator('#cv').boundingBox())!;
  const at = (gx: number, gy: number) => ({ x: box.x + PAD + gx * GRID, y: box.y + PAD + gy * GRID });
  await page.click('#rail .tool[data-t="LED"]');
  await page.mouse.click(at(6, 6).x, at(6, 6).y);
  // The anchor is pin A; a 2-cell part draws its symbol at the MIDPOINT, so
  // that is where the colour is. Sampling the anchor reads the bare lead.
  const p = at(7, 6);
  await page.click('#rail .tool[data-t="select"]');
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('.hue').first()).toBeVisible();
  return { at, p };
}

/** Average colour of the canvas region around a grid point. Reading pixels is
 *  the only honest way to assert on a canvas: it is what the user sees. */
const patch = (page: Page, cx: number, cy: number) => page.evaluate(({ cx, cy }) => {
  const cv = document.getElementById('cv') as HTMLCanvasElement;
  const r = cv.getBoundingClientRect();
  const sx = cv.width / r.width, sy = cv.height / r.height;
  const g = cv.getContext('2d')!;
  const d = g.getImageData(Math.round((cx - r.left) * sx) - 20, Math.round((cy - r.top) * sy) - 20,
    40, 40).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  return { r: R / n, g: G / n, b: B / n };
}, { cx, cy });

test('the inspector offers all six colours', async ({ page }) => {
  await ledOnGrid(page);
  await expect(page.locator('.hue')).toHaveCount(6);
  // Red is what an LED is unless you say otherwise.
  await expect(page.locator('.hue.on')).toHaveAttribute('data-hue', 'red');
});

test('choosing a colour repaints the LED on the canvas', async ({ page }) => {
  const { p } = await ledOnGrid(page);

  // Deselect before reading pixels: a selected part wears an accent halo far
  // larger than the LED body, and it is the halo the sample would measure.
  const paint = async (hue: string) => {
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.hue').first()).toBeVisible();
    await page.click(`.hue[data-hue="${hue}"]`);
    await page.keyboard.press('Escape');
    return patch(page, p.x, p.y);
  };
  const red = await paint('red');
  const blue = await paint('blue');
  const green = await paint('green');

  // Compared BETWEEN colours, not between channels of one: the LED body is a
  // small triangle in a large patch, so the background would swamp any
  // within-sample comparison. Across samples the background is identical and
  // cancels, leaving only what the swatch changed.
  expect(red.r).toBeGreaterThan(blue.r);
  expect(blue.b).toBeGreaterThan(red.b);
  expect(green.g).toBeGreaterThan(red.g);
  expect(green.g).toBeGreaterThan(blue.g);
});

test('the panel states the forward voltage, and it changes with the colour', async ({ page }) => {
  await ledOnGrid(page);
  await page.click('.hue[data-hue="red"]');
  await expect(page.locator('#inspector')).toContainText('1.8 V');
  await page.click('.hue[data-hue="blue"]');
  await expect(page.locator('#inspector')).toContainText('3 V');
});

test('the colour follows a running circuit, glow and all', async ({ page }) => {
  // The built-in "Switch, pot & LED" example rather than a hand-built rig: it
  // is known to run, so what this measures is the colour reaching a live
  // circuit, not whether the test managed to wire one up. The LED lights, so
  // current is flowing through whichever diode model the colour selected.
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'Switch, pot & LED (click to play)' });
  await page.click('#fitBtn');
  await page.click('#runBtn');
  await page.waitForTimeout(600);

  const box = (await page.locator('#cv').boundingBox())!;
  const led = { x: box.x + 480, y: box.y + 300 };

  const recolour = async (hue: string) => {
    await page.click('#rail .tool[data-t="select"]');
    await page.mouse.click(led.x, led.y);
    // If this never appears the click missed the LED, and the test fails here
    // rather than quietly measuring empty canvas.
    await expect(page.locator('.hue').first()).toBeVisible();
    await page.click(`.hue[data-hue="${hue}"]`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    return patch(page, led.x, led.y);
  };

  const red = await recolour('red');
  const blue = await recolour('blue');

  // The glow is large and saturated, so the dominant channel flips outright.
  expect(red.r).toBeGreaterThan(red.b);
  expect(blue.b).toBeGreaterThan(blue.r);
});
