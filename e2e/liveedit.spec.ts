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

/** How many pixels on the canvas are painted in the moving-current colour.
 *  This is the thing the user actually sees, so it is the thing worth asserting
 *  on — but it means the test has to know the colour, so it reads it from the
 *  stylesheet rather than hardcoding one and going stale the next time somebody
 *  restyles the schematic. */
const currentDots = (page: Page) => page.evaluate(() => {
  const hex = getComputedStyle(document.documentElement)
    .getPropertyValue('--cv-current').trim();
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`--cv-current is not a plain hex colour: ${hex}`);
  const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
  const cv = document.getElementById('cv') as HTMLCanvasElement;
  const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - r) < 26 && Math.abs(d[i + 1] - g) < 26 && Math.abs(d[i + 2] - b) < 40) n++;
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

test('deleting the part that forced a fine timestep speeds the run back up',
  async ({ page }) => {
    // The timestep comes from the fastest time constant in the circuit. A 1 mH
    // inductor against a 2 k resistor is 0.5 us where a 1 uF capacitor is 1 ms,
    // so the inductor wins by a factor of two thousand and every other part
    // crawls — and it gets that vote even when it is wired to nothing.
    //
    // Deleting it mid-run used to leave the step where it was, because
    // rebuildLive rebuilt the netlist and the solver but never chose the step
    // again. The RC discharge below then took minutes of real time instead of
    // a second, which looks exactly like current that will not stop.
    const g = await blankGrid(page);
    await page.click('#rail .tool[data-t="select"]');
    await page.keyboard.press('r');                       // vertical
    await g.place('V', 2, 2);
    await g.place('C', 10, 2);
    await g.place('R', 14, 2);
    await g.place('L', 22, 2);                            // wired to nothing
    await g.place('GND', 2, 8);
    await page.click('#rail .tool[data-t="select"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press('r');   // back to horizontal
    await g.place('R', 4, 2);
    await page.click('#rail .tool[data-t="select"]');
    await g.wire([2, 2], [4, 2]); await g.wire([6, 2], [10, 2]); await g.wire([10, 2], [14, 2]);
    await g.wire([2, 4], [10, 4]); await g.wire([10, 4], [14, 4]); await g.wire([2, 4], [2, 8]);
    await page.click('#rail .tool[data-t="select"]');

    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
    await expect.poll(() => currentDots(page)).toBeGreaterThan(20);

    // Take out the inductor, then the source. What is left is a charged cap
    // across 1k || 2k — about 0.67 ms of time constant, which should be gone
    // almost as soon as it is looked at.
    await page.click('#rail .tool[data-t="delete"]');
    await page.mouse.click(g.at(22, 3).x, g.at(22, 3).y);
    await page.mouse.click(g.at(2, 3).x, g.at(2, 3).y);

    await expect.poll(() => currentDots(page),
      { message: 'the discharge should finish in a moment, not in minutes',
        timeout: 10_000, intervals: [400] }).toBe(0);
  });

test('a circuit that has finished discharging reads zero, not 2.7e-35',
  async ({ page }) => {
    // Backward Euler does not land on exactly zero; it lands on a few times
    // 1e-35. Printed as-is that reads like a measurement, and the panel goes on
    // reporting voltages and currents on a dead circuit.
    // Live readings, which is what the instantaneous solution looks like — and
    // where the residue showed up. The steady readout keeps a rolling window on
    // purpose, so it goes on reporting the discharge it just watched until that
    // window has rolled past; that is the window working, not residue.
    await page.addInitScript(() => localStorage.setItem('volta.readMode', 'live'));
    const g = await blankGrid(page);
    await page.click('#rail .tool[data-t="select"]');
    await page.keyboard.press('r');
    await g.place('V', 2, 2); await g.place('C', 10, 2);
    await g.place('R', 14, 2); await g.place('GND', 2, 8);
    await page.click('#rail .tool[data-t="select"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press('r');
    await g.place('R', 4, 2);
    await page.click('#rail .tool[data-t="select"]');
    await g.wire([2, 2], [4, 2]); await g.wire([6, 2], [10, 2]); await g.wire([10, 2], [14, 2]);
    await g.wire([2, 4], [10, 4]); await g.wire([10, 4], [14, 4]); await g.wire([2, 4], [2, 8]);
    await page.click('#rail .tool[data-t="select"]');

    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
    await page.mouse.click(g.at(10, 3).x, g.at(10, 3).y);       // scope the capacitor
    await page.click('#rail .tool[data-t="delete"]');
    await page.mouse.click(g.at(2, 3).x, g.at(2, 3).y);         // remove the source
    await page.click('#rail .tool[data-t="select"]');
    await page.mouse.click(g.at(10, 3).x, g.at(10, 3).y);

    // Wait for the discharge to actually finish, then check HOW it is reported.
    await expect.poll(() => page.locator('#roLive').innerText(),
      { message: 'the capacitor should reach zero', timeout: 20_000, intervals: [300] })
      .toMatch(/Voltage across\s*0V/);

    const live = await page.locator('#roLive').innerText();
    expect(live, 'no residue dressed up as a reading').not.toMatch(/e-\d/);
    expect(live).toMatch(/Current\s*0A/);
    expect(live).toMatch(/Power\s*0W/);

    const table = await page.locator('#roTable').innerText();
    expect(table, 'and the node table too').not.toMatch(/e-\d/);
    expect(table).toMatch(/0V/);
  });
