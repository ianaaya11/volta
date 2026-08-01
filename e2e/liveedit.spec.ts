// Editing a circuit while it runs.
//
// The netlist was built once, at Run. Values reached the live solver through
// syncValues, but TOPOLOGY never did — so cutting a wire mid-run left the
// solver happily solving the circuit as it used to be, and current went on
// visibly flowing round a loop that was no longer closed. A simulator being
// confidently wrong about the thing on screen is worse than one that stops.
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

/** How many pixels on the canvas are painted in the moving-current colour
 *  (--cv-current, #e0952a). This is the thing the user actually sees, so it is
 *  the thing worth asserting on. */
const currentDots = (page: Page) => page.evaluate(() => {
  const cv = document.getElementById('cv') as HTMLCanvasElement;
  const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - 224) < 26 && Math.abs(d[i + 1] - 149) < 26 && Math.abs(d[i + 2] - 42) < 40) n++;
  }
  return n;
});

/** A 5 V source driving 1 k, returned to ground the long way round so there is
 *  a stretch of return wire in open space to cut. */
async function loop(page: Page) {
  const g = await blankGrid(page);
  await g.place('V', 2, 2);
  await g.place('R', 8, 2);
  await g.place('GND', 2, 8);
  await g.wire([4, 2], [8, 2]);
  await g.wire([10, 2], [10, 8]);
  await g.wire([10, 8], [2, 8]);
  await g.wire([2, 2], [2, 8]);
  await page.click('#rail .tool[data-t="select"]');
  return g;
}

test('cutting the loop stops the current', async ({ page }) => {
  const g = await loop(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect.poll(() => currentDots(page),
    { message: 'a closed loop should show current moving' }).toBeGreaterThan(50);

  await page.click('#rail .tool[data-t="delete"]');
  await page.mouse.click(g.at(6, 8).x, g.at(6, 8).y);      // cut the return wire

  await expect.poll(() => currentDots(page),
    { message: 'an open circuit should show no current at all' }).toBe(0);
  // Still running: an open circuit is a perfectly solvable one, it just carries
  // nothing. Stopping here would be its own kind of wrong.
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
});

test('reconnecting it starts the current again', async ({ page }) => {
  const g = await loop(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await page.click('#rail .tool[data-t="delete"]');
  await page.mouse.click(g.at(6, 8).x, g.at(6, 8).y);
  await expect.poll(() => currentDots(page)).toBe(0);

  await g.wire([10, 8], [2, 8]);
  await expect.poll(() => currentDots(page),
    { message: 'closing the loop again should bring the current back' }).toBeGreaterThan(50);
});

test('removing the reference stops the run and says why', async ({ page }) => {
  const g = await loop(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  await page.click('#rail .tool[data-t="delete"]');
  await page.mouse.click(g.at(2, 8).x, g.at(2, 8).y);      // the ground symbol

  // Nothing left to solve against, so it stops rather than freezing on its last
  // good answer — a still picture of flowing current is the same lie told once.
  await expect(page.locator('#runBtn')).toHaveText(/Run/);
  await expect(page.locator('#hint')).toContainText(/no ground reference/i);
});

test('deleting the whole circuit stops the run', async ({ page }) => {
  await loop(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await page.click('#selectAllBtn');
  await page.click('#multiDel');
  await expect(page.locator('#runBtn')).toHaveText(/Run/);
  // No assertion on the hint here: deleteMulti flashes its own "Removed N
  // parts, ⌘Z puts them back" after committing, and that is the more useful
  // message of the two. An empty canvas explains itself; the Run button
  // reverting is the signal that matters.
});

test('changing a value mid-run does not restart the simulation', async ({ page }) => {
  // The rebuild is keyed on the circuit's SHAPE, so editing a resistance still
  // takes the syncValues path and the waveform continues undisturbed. Without
  // that distinction every keystroke in the inspector would reset the transient.
  const g = await loop(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await page.mouse.click(g.at(9, 2).x, g.at(9, 2).y);
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Resistor');

  const before = await currentDots(page);
  expect(before).toBeGreaterThan(50);
  await page.fill('#valInput', '2000');
  await page.locator('#valInput').press('Enter');
  // Current halves but never stops: the run was not interrupted.
  await expect.poll(() => currentDots(page),
    { message: 'a value edit should not stop the simulation' }).toBeGreaterThan(0);
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
});
