// The breadboard view.
//
// tests/breadboard.test.ts owns correctness: every layout is read back off the
// board and compared to the netlist it came from, and 300 random circuits are
// fuzzed against the physical rules. None of that needs a browser.
//
// What is left here is the wiring: that the view opens on the real circuit,
// that the instructions match the picture, and — the one that matters — that a
// layout which fails its own check is refused rather than drawn. A wrong
// breadboard picture gets followed hole by hole by somebody who trusts it.
import { test, expect } from '@playwright/test';

test('opens on the circuit in the editor', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'RC low-pass (transient)' });
  await page.click('#bbBtn');
  await expect(page.locator('#bbView')).toBeVisible();
  await expect(page.locator('#bbStatus')).toContainText(/part/);

  // The RC example is a resistor feeding three parts in parallel to ground.
  const side = (await page.locator('#bbSide').textContent())!.replace(/\s+/g, ' ');
  expect(side).toMatch(/On the board/i);
  expect(side).toMatch(/rail/);
});

test('tells you which hole every leg goes in', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'RC low-pass (transient)' });
  await page.click('#bbBtn');
  const side = (await page.locator('#bbSide').textContent())!.replace(/\s+/g, ' ');
  // A hole is a column and a row — "3A" — or a rail. Anything vaguer is not
  // an instruction somebody can follow.
  expect(side).toMatch(/\d+[A-J]/);
});

test('sends the bench supply off the board, with a reason', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'RC low-pass (transient)' });
  await page.click('#bbBtn');
  const side = (await page.locator('#bbSide').textContent())!.replace(/\s+/g, ' ');
  expect(side).toMatch(/Not on the board/i);
  expect(side).toMatch(/bench supply|run leads to the rails/i);
});

test('refuses to breadboard a circuit of behavioural parts', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'Traffic light sequencer' });
  await page.click('#bbBtn');
  const side = (await page.locator('#bbSide').textContent())!.replace(/\s+/g, ' ');
  // Gates and counters have no chip and no supply pins, so they cannot be
  // built. Saying which, and why, beats drawing something impossible.
  expect(side).toMatch(/Not on the board/i);
  expect(side).toMatch(/not as a chip|real part chosen/i);
});

test('draws something, and goes away again', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'RC low-pass (transient)' });
  await page.click('#bbBtn');
  const painted = await page.evaluate(() => {
    const cv = document.getElementById('bbCanvas') as HTMLCanvasElement;
    if (!cv.width) return 0;
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  expect(painted, 'the board should actually be drawn').toBeGreaterThan(5000);

  await page.click('#bbClose');
  await expect(page.locator('#bbView')).toBeHidden();
  await expect(page.locator('#cv')).toBeVisible();
});
