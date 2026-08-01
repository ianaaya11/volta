// Steady readings.
//
// Every readout used to print the instantaneous solution at whatever timestep
// the frame landed on, so on anything oscillating the digits churned through
// the whole waveform and none of them could be read. These tests hold the two
// properties that fix is worth having: the number must STAY STILL, and it must
// be RIGHT — a steady figure that is five per cent out is worse than a moving
// one, because you would believe it.
import { test, expect, type Page } from '@playwright/test';

const GRID = 26, PAD = 40;

async function blankGrid(page: Page) {
  await page.goto('/');
  await page.click('#clearBtn');
  await page.click('#fitBtn');
  const box = (await page.locator('#cv').boundingBox())!;
  const at = (gx: number, gy: number) => ({ x: box.x + PAD + gx * GRID, y: box.y + PAD + gy * GRID });
  return {
    at,
    place: async (tool: string, gx: number, gy: number) => {
      await page.click(`#rail .tool[data-t="${tool}"]`);
      const p = at(gx, gy); await page.mouse.click(p.x, p.y);
    },
    wire: async (...pts: [number, number][]) => {
      await page.click('#rail .tool[data-t="wire"]');
      for (const [gx, gy] of pts) { const p = at(gx, gy); await page.mouse.click(p.x, p.y); }
      const last = at(...pts[pts.length - 1]); await page.mouse.click(last.x, last.y);
    },
  };
}

const nodeText = (page: Page) => () => page.locator('#roTable').innerText();

/** A 5 V, 1 kHz sine across a 1 k resistor.
 *
 *  Expected: ±5 V and 3.54 V rms, ±5 mA and 3.54 mA rms. The BOUND reads 4.99
 *  rather than 5.00 because a bound is the largest sample taken and the true
 *  peak falls between two of them; the RMS is an integral over whole cycles and
 *  is exact. That asymmetry is worth knowing about, so the tests below allow
 *  the peak a sample's worth of slack and hold the RMS to the figure. */
async function acCircuit(page: Page) {
  const g = await blankGrid(page);
  await g.place('VS', 2, 2);
  await g.place('R', 8, 2);
  await g.place('GND', 2, 8);
  await g.wire([4, 2], [8, 2]);
  await g.wire([10, 2], [10, 8]);
  await g.wire([10, 8], [2, 8]);
  await g.wire([2, 2], [2, 8]);
  await page.click('#rail .tool[data-t="select"]');
  return g;
}

test('an oscillating reading settles instead of churning', async ({ page }) => {
  await acCircuit(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  // Give the averaging window time to fill, then take several samples a good
  // fraction of a second apart. On the old build every one of these differed.
  await expect.poll(nodeText(page), { timeout: 20_000, intervals: [400] })
    .toMatch(/±/);
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    seen.add(await nodeText(page)());
    await page.waitForTimeout(450);
  }
  expect([...seen].join('\n---\n')).toBeTruthy();
  expect(seen.size, 'the node table should not change while the circuit is periodic').toBe(1);
});

test('a resistor in an AC circuit reports true RMS, not a fractional-cycle average',
  async ({ page }) => {
    const g = await acCircuit(page);
    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
    const R = g.at(8, 2);
    await page.mouse.click(R.x, R.y);

    // 5 V peak / 1 k = 5 mA peak -> 3.5355 mA rms, and 3.5355 V across it.
    await expect.poll(() => page.locator('#roLive').innerText(),
      { timeout: 25_000, intervals: [500] }).toMatch(/3\.54 V rms/);
    await expect(page.locator('#roLive')).toContainText(/3\.54 mA rms/);
    // And the bounds are the peaks, not the RMS.
    await expect(page.locator('#roLive')).toContainText(/±(4\.9\d|5) V/);
  });

test('Live puts the instantaneous value back', async ({ page }) => {
  await acCircuit(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect.poll(nodeText(page), { timeout: 20_000, intervals: [400] }).toMatch(/±(4\.9\d|5) V/);

  await page.click('[data-read="live"]');
  // Now it should be a single moving figure again — no range, and changing.
  await expect(page.locator('#roTable')).not.toContainText('±');
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    seen.add(await nodeText(page)());
    await page.waitForTimeout(120);
  }
  expect(seen.size, 'live mode should track the waveform').toBeGreaterThan(1);

  // The choice sticks across a reload — it is a preference, not a mode you have
  // to re-pick every session.
  await page.reload();
  await page.click('#runBtn');
  await expect(page.locator('[data-read="live"]')).toHaveClass(/on/);
});

test('a DC circuit shows one number, not a range of one', async ({ page }) => {
  // Bounds that are equal must collapse. "5.00 … 5.00 V" would be a worse
  // readout than the one this replaced.
  const g = await blankGrid(page);
  await g.place('V', 2, 2);
  await g.place('R', 8, 2);
  await g.place('GND', 2, 8);
  await g.wire([4, 2], [8, 2]);
  await g.wire([10, 2], [10, 8]);
  await g.wire([10, 8], [2, 8]);
  await g.wire([2, 2], [2, 8]);
  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  await expect.poll(nodeText(page), { timeout: 15_000, intervals: [300] }).toMatch(/5 V/);
  const t = await nodeText(page)();
  expect(t).not.toContain('…');
  expect(t).not.toContain('±');
  expect(t, 'a steady value needs no rms line').not.toMatch(/rms/);
});

test('the switch survives the panel being rebuilt underneath it', async ({ page }) => {
  // Regression. The readout is rewritten every animation frame, so a button
  // inside it is detached between mousedown and mouseup and cannot be pressed.
  // It now lives in a container that is only rewritten when its own text
  // changes, with the handler bound to the parent that outlives both.
  const g = await acCircuit(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect(page.locator('[data-read="steady"]')).toHaveClass(/on/);

  // Selecting a part rebuilds the whole inspector, which used to lose the
  // heading and the switch entirely.
  await page.mouse.click(g.at(8, 2).x, g.at(8, 2).y);
  await expect(page.locator('[data-read="steady"]')).toBeVisible();

  await page.click('[data-read="live"]');
  await expect(page.locator('[data-read="live"]')).toHaveClass(/on/);
  await page.click('[data-read="steady"]');
  await expect(page.locator('[data-read="steady"]')).toHaveClass(/on/);
});
