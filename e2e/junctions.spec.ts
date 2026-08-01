// Tapping a rail, and parts that are not in the circuit.
//
// Two faults with one story behind them. A branch drawn onto a rail looked
// connected and was not, so a whole component could be missing from the
// simulation with nothing on screen saying so; and a component missing from
// the simulation still got a vote on the timestep, which is chosen from the
// fastest element present, so an inductor wired to nothing could slow
// everything else by a factor of a thousand.
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

const nodes = (page: Page) => page.locator('#nodeCount').innerText();

/** Two vertical resistors: R1's top pin at (2,2), R2's at (6,6). */
async function pair(page: Page) {
  const g = await blankGrid(page);
  await page.click('#rail .tool[data-t="select"]');
  await page.keyboard.press('r');
  await g.place('R', 2, 2);
  await g.place('R', 6, 6);
  await page.click('#rail .tool[data-t="select"]');
  return g;
}

test('a wire ending part-way along another one taps it', async ({ page }) => {
  const g = await pair(page);
  await g.wire([2, 2], [10, 2]);          // a rail from R1's top pin
  await page.click('#rail .tool[data-t="select"]');
  const before = await nodes(page);

  await g.wire([6, 2], [6, 6]);           // a branch ENDING on the rail
  await page.click('#rail .tool[data-t="select"]');
  await expect(page.locator('#nodeCount'),
    'the branch should join the rail, merging two nodes into one')
    .not.toHaveText(before);
  expect(parseInt(await nodes(page), 10)).toBe(parseInt(before, 10) - 1);
});

test('a wire crossing another does NOT connect to it', async ({ page }) => {
  // The schematic convention, and the reason the rule wants an ENDPOINT on a
  // segment rather than any point of one touching any point of another.
  const g = await pair(page);
  await g.wire([2, 2], [10, 2]);
  await page.click('#rail .tool[data-t="select"]');
  const before = await nodes(page);

  await g.wire([6, 0], [6, 6]);           // straight over the rail and onwards
  await page.click('#rail .tool[data-t="select"]');
  await expect(page.locator('#nodeCount')).toHaveText(before);
});

test('the tap shows a junction dot, so the drawing agrees with the circuit',
  async ({ page }) => {
    // A connection with no dot would be the same lie in the other direction.
    const g = await pair(page);
    await g.wire([2, 2], [10, 2]);
    await g.wire([6, 2], [6, 6]);
    await page.click('#rail .tool[data-t="select"]');
    const dot = await page.evaluate(({ GRID, PAD }) => {
      const cv = document.getElementById('cv') as HTMLCanvasElement;
      const dpr = cv.width / cv.getBoundingClientRect().width;
      const x = Math.round((PAD + 6 * GRID) * dpr), y = Math.round((PAD + 2 * GRID) * dpr);
      const d = cv.getContext('2d')!.getImageData(x - 6, y - 6, 12, 12).data;
      // The junction dot is a filled blob; count how much ink is at the tap.
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 200) ink++;
      return ink;
    }, { GRID, PAD });
    expect(dot, 'a filled dot should mark the junction').toBeGreaterThan(30);
  });

test('opening an old circuit does not silently rewire it', async ({ page }) => {
  // The reason this is done by splitting at draw time rather than by a netlist
  // rule. A rule that treats any point inside a segment as joined changes what
  // an EXISTING drawing means: the built-in 555 runs its discharge rail through
  // the point where the LED's cathode wire begins, and the rule shorted the LED
  // and stopped it oscillating. Any saved design could have the same overlap.
  await page.goto('/');
  await page.selectOption('#gallery', { label: '555 astable blinks an LED' });
  await expect(page.locator('#nodeCount')).toHaveText('7 nodes');
});

test('a part wired to nothing does not set the pace for the rest', async ({ page }) => {
  // The timestep comes from the fastest time constant present. A 1 mH inductor
  // against a 2 k resistor is 0.5 us where a 1 uF capacitor is 1 ms, so an
  // inductor lying on the canvas unconnected used to force a step a thousand
  // times finer than the circuit needed, and the RC below took minutes of real
  // time to discharge instead of a second.
  const g = await blankGrid(page);
  await page.click('#rail .tool[data-t="select"]');
  await page.keyboard.press('r');
  await g.place('V', 2, 2); await g.place('C', 10, 2); await g.place('R', 14, 2);
  await g.place('L', 22, 2);                       // connected to nothing at all
  await g.place('GND', 2, 8);
  await page.click('#rail .tool[data-t="select"]');
  for (let i = 0; i < 3; i++) await page.keyboard.press('r');
  await g.place('R', 4, 2);
  await page.click('#rail .tool[data-t="select"]');
  await g.wire([2, 2], [4, 2]); await g.wire([6, 2], [10, 2]); await g.wire([10, 2], [14, 2]);
  await g.wire([2, 4], [10, 4]); await g.wire([10, 4], [14, 4]); await g.wire([2, 4], [2, 8]);
  await page.click('#rail .tool[data-t="select"]');

  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await page.mouse.click(g.at(10, 3).x, g.at(10, 3).y);      // watch the capacitor
  await page.click('#rail .tool[data-t="delete"]');
  await page.mouse.click(g.at(2, 3).x, g.at(2, 3).y);        // remove the source
  await page.click('#rail .tool[data-t="select"]');
  await page.mouse.click(g.at(10, 3).x, g.at(10, 3).y);

  await expect.poll(() => page.locator('#roLive').innerText(),
    { message: 'the discharge should take a moment, not minutes',
      timeout: 8_000, intervals: [300] }).toMatch(/Voltage across\s*0V/);
});
