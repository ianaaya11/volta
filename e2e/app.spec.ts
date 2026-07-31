// Headless-browser smoke tests — the second half of the testing strategy.
// The Vitest suites prove the ENGINE is right in isolation; these prove the
// assembled app actually boots, draws, solves, and shows the same numbers on
// screen. Each worked example asserts the operating point that BUILD-PLAN.md
// documents for it, read out of the live inspector panel.
import { test, expect, type Page } from '@playwright/test';

/** Load an example by its name in the gallery dropdown. */
async function loadExample(page: Page, name: string) {
  await page.selectOption('#gallery', { label: name });
}

/** Press Run and wait until the simulation is actually stepping. */
async function run(page: Page) {
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
}

test('boots with the default example, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('/');
  await expect(page.locator('#nodeCount')).toHaveText(/[1-9]\d* nodes/);
  await expect(page.locator('#rail .tool')).toHaveCount(16);
  expect(errors).toEqual([]);
});

test('draws the schematic onto the canvas', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#nodeCount')).toHaveText(/[1-9]\d* nodes/);
  // Count non-transparent pixels: proves the renderer ran, not just that the
  // canvas element exists.
  const painted = await page.evaluate(() => {
    const cv = document.getElementById('cv') as HTMLCanvasElement;
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(1000);
});

test('running the default example produces node voltages', async ({ page }) => {
  await page.goto('/');
  await run(page);
  await expect(page.locator('table.probes')).toBeVisible();
  expect(await page.locator('table.probes tr').count()).toBeGreaterThan(1);
});

test('BJT common-emitter amp reaches its documented 4.09 V collector', async ({ page }) => {
  await page.goto('/');
  await loadExample(page, 'BJT common-emitter amp');
  await run(page);
  // Vcc=5, Rb=470k, Rc=1k, beta=100 -> Ic=915µA -> Vc = 5 - 0.915 = 4.09 V,
  // the same number tests/bjt.test.ts pins on the engine.
  await expect(page.locator('table.probes')).toContainText('4.09 V');
});

test('NMOS common-source amp biases to Vg=2 V, Vd=3 V', async ({ page }) => {
  await page.goto('/');
  await loadExample(page, 'NMOS common-source amp');
  await run(page);
  const table = page.locator('table.probes');
  await expect(table).toContainText('2 V');
  await expect(table).toContainText('3 V');
});

test('non-inverting op-amp shows gain of 2', async ({ page }) => {
  await page.goto('/');
  await loadExample(page, 'Non-inverting op-amp');
  await run(page);
  await expect(page.locator('table.probes')).toContainText('2 V');
});

test('Bode sweeps the pre-probed RLC bandpass', async ({ page }) => {
  await page.goto('/');
  await loadExample(page, 'RLC bandpass (Bode)');
  await page.click('#bodeBtn');
  // The AC path completed and switched the panel over to the Bode plot.
  await expect(page.locator('#hint')).toContainText('AC sweep');
  // The plot really painted: the decade axis labels are drawn onto the canvas,
  // so check the lower panel band has substantially more ink than empty grid.
  const inked = await page.evaluate(() => {
    const cv = document.getElementById('cv') as HTMLCanvasElement;
    const ctx = cv.getContext('2d')!;
    const band = ctx.getImageData(0, cv.height - 200 * devicePixelRatio, cv.width, 200 * devicePixelRatio).data;
    let n = 0;
    for (let i = 3; i < band.length; i += 4) if (band[i] > 0) n++;
    return n;
  });
  expect(inked).toBeGreaterThan(5000);
});

test('placing a part updates the node count', async ({ page }) => {
  await page.goto('/');
  await page.click('#clearBtn');
  await expect(page.locator('#nodeCount')).toHaveText('0 nodes');

  await page.click('#rail .tool[data-t="R"]');
  const box = (await page.locator('#cv').boundingBox())!;
  await page.mouse.click(box.x + 200, box.y + 160);
  // A lone resistor contributes its two pins and no ground reference.
  await expect(page.locator('#nodeCount')).toHaveText('2 nodes');
});

test('share encodes the circuit into the URL and restores it on reload', async ({ page }) => {
  await page.goto('/');
  await loadExample(page, 'BJT common-emitter amp');
  const before = await page.locator('#nodeCount').textContent();

  await page.click('#shareBtn');
  const hash = await page.evaluate(() => location.hash);
  expect(hash).toMatch(/^#c=.+/);

  // A fresh load of that link must rebuild the identical circuit.
  await page.goto('/' + hash);
  await expect(page.locator('#nodeCount')).toHaveText(before!);
  await run(page);
  await expect(page.locator('table.probes')).toContainText('4.09 V');
});
