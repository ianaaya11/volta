// Clicking two parts should join them, at right angles.
//
// A schematic wire that cuts diagonally across the grid is a wire nobody can
// follow, and making the user aim at individual pins to avoid one is busywork.
// These tests pin down both halves: a click anywhere on a part resolves to a
// pin, and the run that results is axis-aligned — including the case where the
// obvious elbow would send the lead back through the part it just left.
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
    click: async (gx: number, gy: number) => {
      const p = at(gx, gy); await page.mouse.click(p.x, p.y);
    },
  };
}

/** The document as saved, so we can assert on the wires themselves. */
async function model(page: Page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#saveBtn')]);
  let t = ''; for await (const c of await dl.createReadStream()) t += String(c);
  return JSON.parse(t) as { wires: { x1: number; y1: number; x2: number; y2: number }[] };
}

const orthogonal = (w: { x1: number; y1: number; x2: number; y2: number }) => w.x1 === w.x2 || w.y1 === w.y2;

test('clicking two parts joins them with right-angled segments', async ({ page }) => {
  const g = await blankGrid(page);
  await g.place('R', 3, 3);      // pins (3,3) and (5,3)
  await g.place('C', 9, 8);      // pins (9,8) and (11,8)
  await expect(page.locator('#nodeCount')).toHaveText('4 nodes');

  await page.click('#rail .tool[data-t="wire"]');
  await g.click(4, 3);           // the resistor's BODY, not a pin
  await g.click(10, 8);          // the capacitor's body

  // One net fewer: the two parts now share a node.
  await expect(page.locator('#nodeCount')).toHaveText('3 nodes');
  const { wires } = await model(page);
  expect(wires.length).toBe(2);
  expect(wires.every(orthogonal)).toBe(true);
});

test('the lead steps clear of the part instead of crossing back through it', async ({ page }) => {
  const g = await blankGrid(page);
  await g.place('R', 3, 3);      // horizontal: (3,3)-(5,3)
  await g.place('C', 9, 8);
  await page.click('#rail .tool[data-t="wire"]');
  await g.click(3, 3);           // the LEFT pin — its lead exits leftwards
  await g.click(9, 8);

  const { wires } = await model(page);
  // The elbow must be below the resistor, not to its right: a first leg running
  // right from (3,3) would lie straight along the resistor's own body.
  const first = wires.find(w => w.x1 === 3 && w.y1 === 3)!;
  expect(first).toBeTruthy();
  expect(first.x2).toBe(3);      // stepped down, not across
  expect(wires.every(orthogonal)).toBe(true);
});

test('two pins already in line get a single segment, not a spurious elbow', async ({ page }) => {
  const g = await blankGrid(page);
  await g.place('R', 3, 3);      // (3,3)-(5,3)
  await g.place('R', 9, 3);      // (9,3)-(11,3)
  await page.click('#rail .tool[data-t="wire"]');
  await g.click(5, 3);
  await g.click(9, 3);

  const { wires } = await model(page);
  expect(wires.length).toBe(1);
  expect(wires[0]).toMatchObject({ x1: 5, y1: 3, x2: 9, y2: 3 });
  await expect(page.locator('#nodeCount')).toHaveText('3 nodes');
});

test('an auto-routed join actually carries current', async ({ page }) => {
  const g = await blankGrid(page);
  // A source and a resistor placed out of line with each other, joined only by
  // auto-routed wires — if the routing were cosmetic this would not solve.
  await g.place('V', 3, 3);      // (3,3)-(5,3)
  await g.place('R', 9, 7);      // (9,7)-(11,7)
  await g.place('GND', 3, 10);

  await page.click('#rail .tool[data-t="wire"]');
  await g.click(5, 3); await g.click(9, 7);      // source + to resistor
  await page.keyboard.press('Escape');
  await page.click('#rail .tool[data-t="wire"]');
  await g.click(11, 7); await g.click(3, 10);    // resistor back to ground
  await page.keyboard.press('Escape');
  await page.click('#rail .tool[data-t="wire"]');
  await g.click(3, 3); await g.click(3, 10);     // source − to ground

  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  // The resistor sees the full source voltage, so a real current flows.
  await g.click(10, 7);
  await expect(page.locator('#inspectorBody')).toContainText('Current');
  // The sign depends on which way round the source ended up; only the
  // magnitude matters here — a broken join would read exactly 0.
  await expect.poll(async () => {
    const txt = await page.locator('#inspectorBody').innerText();
    const m = /Current\s+(-?[\d.]+)\s*([munk]?)A/.exec(txt);
    return m ? Math.abs(Number(m[1])) > 0 : false;
  }, { message: 'the auto-routed loop should carry a non-zero current' }).toBe(true);

  const { wires } = await model(page);
  expect(wires.every(orthogonal)).toBe(true);
});
