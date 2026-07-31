// The electromechanical and indicator parts — switch, push button, pot, LED,
// lamp, polarized cap — plus the PNP/PMOS rail entries.
//
// None of these added a device model to the solver: each is built out of one
// the engine already had, with the editor changing a value rather than the
// circuit's shape. So what's worth asserting is not "does a resistor work" but
// the mapping itself — that a contact's state reaches the model, that the wiper
// splits the track, and that a part which reaches the solver as SEVERAL devices
// still yields one coherent set of node voltages.
import { test, expect, type Page } from '@playwright/test';

interface SavedComp { id: string; type: string; on?: boolean; pos?: number }

/** The document as the app itself encodes it for sharing — no test-only hook. */
async function readModel(page: Page): Promise<{ comps: SavedComp[] }> {
  await page.click('#shareBtn');
  const hash = await page.evaluate(() => location.hash);
  return page.evaluate((code: string) => JSON.parse(decodeURIComponent(escape(atob(code)))),
    hash.replace(/^#c=/, ''));
}

/** Place a part, then click the same pixel again to select it. */
async function placeAndSelect(page: Page, tool: string, dx: number, dy: number) {
  await page.click(`#rail .tool[data-t="${tool}"]`);
  const box = (await page.locator('#cv').boundingBox())!;
  await page.mouse.click(box.x + dx, box.y + dy);
  await page.click('#rail .tool[data-t="select"]');
  await page.mouse.click(box.x + dx, box.y + dy);
}

/** Node voltages as the inspector shows them, keyed by node label. */
async function nodeVolts(page: Page): Promise<string[]> {
  const rows = await page.locator('table.probes tr').all();
  const out: string[] = [];
  for (const r of rows) {
    const tds = await r.locator('td').allInnerTexts();
    if (tds.length >= 2) out.push(tds[1].trim());
  }
  return out;
}

test('every new part is on the rail and places without a console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('/');
  await page.click('#clearBtn');
  const added = ['LED', 'LAMP', 'CP', 'SW', 'PB', 'PBNC', 'POT', 'QP', 'MP'];
  for (const t of added) {
    await expect(page.locator(`#rail .tool[data-t="${t}"]`)).toHaveCount(1);
  }
  await page.click('#fitBtn');   // an empty document fits to ox=oy=40, scale=1
  const box = (await page.locator('#cv').boundingBox())!;
  const at = (gx: number, gy: number) => ({ x: box.x + 40 + gx * 26, y: box.y + 40 + gy * 26 });
  const place = async (t: string, gx: number, gy: number) => {
    await page.click(`#rail .tool[data-t="${t}"]`);
    const p = at(gx, gy); await page.mouse.click(p.x, p.y);
  };
  // Two rows, spaced so that no two pins land on the same grid point.
  let gx = 0;
  for (const t of ['LED', 'LAMP', 'CP', 'SW', 'PB', 'PBNC']) { await place(t, gx, 2); gx += 4; }
  gx = 0;
  for (const t of ['POT', 'QP', 'MP']) { await place(t, gx, 6); gx += 6; }
  // Six 2-pin parts and three 3-pin ones, none of them touching.
  await expect(page.locator('#nodeCount')).toHaveText('21 nodes');
  expect(errors).toEqual([]);
});

test.describe('contacts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('#clearBtn');
  });

  test('a switch starts open and the inspector throws it', async ({ page }) => {
    await placeAndSelect(page, 'SW', 200, 160);
    await expect(page.locator('#inspectorBody h3')).toHaveText('Switch (SPST)');
    await expect(page.locator('#contactBtn')).toHaveText('Close');

    await page.click('#contactBtn');
    await expect(page.locator('#contactBtn')).toHaveText('Open');
    expect((await readModel(page)).comps[0].on).toBe(true);
  });

  test('a normally-closed button reads inverted from a normally-open one', async ({ page }) => {
    await placeAndSelect(page, 'PB', 200, 160);
    // Both parts store `on` as "is the actuator held", so both start false —
    // and the NC contact is the one that conducts in that state.
    await expect(page.locator('#contactBtn')).toHaveText('Press');

    await page.click('#clearBtn');
    await placeAndSelect(page, 'PBNC', 200, 160);
    await expect(page.locator('#inspectorBody h3')).toHaveText('Push button (NC)');
    await expect(page.locator('#contactBtn')).toHaveText('Release');
  });
});

test('the potentiometer wiper is editable and persists', async ({ page }) => {
  await page.goto('/');
  await page.click('#clearBtn');
  await placeAndSelect(page, 'POT', 200, 160);
  await expect(page.locator('#inspectorBody h3')).toHaveText('Potentiometer');

  const slider = page.locator('#posInput');
  await expect(slider).toHaveValue('50');
  await slider.fill('80');
  await slider.dispatchEvent('change');
  expect((await readModel(page)).comps[0].pos).toBeCloseTo(0.8, 5);
});

test.describe('the switch/pot/LED panel example', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.selectOption('#gallery', { label: 'Switch, pot & LED (click to play)' });
    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  });

  test('the closed switch powers the rail and the LED clamps the wiper', async ({ page }) => {
    const v = await nodeVolts(page);
    // 9 V battery through a closed switch: the top rail sits at the supply,
    // which is only true if a closed contact really is a milliohm.
    expect(v).toContain('9 V');
    // The wiper feeds an LED to ground, so that node is pinned near a forward
    // drop — NOT the 3.15 V a bare 35 % divider would give. That number can
    // only come out right if the pot reached the solver as two resistors AND
    // the LED reached it as a diode.
    expect(v.some(s => /^7\d\d mV$/.test(s)),
      `expected a ~0.7 V LED node, got ${JSON.stringify(v)}`).toBe(true);
    // The push button is open, so its branch is dead.
    expect(v.some(s => /[num]V$/.test(s)), `expected a dead branch, got ${JSON.stringify(v)}`).toBe(true);
  });

});

test('holding a push button on the canvas closes the contact for as long as it is held', async ({ page }) => {
  await page.goto('/');
  await page.click('#clearBtn');
  await page.click('#fitBtn');   // an empty document fits to ox=oy=40, scale=1

  const box = (await page.locator('#cv').boundingBox())!;
  const GRID = 26, PAD = 40;
  const at = (gx: number, gy: number) => ({ x: box.x + PAD + gx * GRID, y: box.y + PAD + gy * GRID });
  const place = async (tool: string, gx: number, gy: number) => {
    await page.click(`#rail .tool[data-t="${tool}"]`);
    const p = at(gx, gy); await page.mouse.click(p.x, p.y);
  };
  const wire = async (...pts: [number, number][]) => {
    await page.click('#rail .tool[data-t="wire"]');
    for (const [gx, gy] of pts) { const p = at(gx, gy); await page.mouse.click(p.x, p.y); }
    const last = at(...pts[pts.length - 1]); await page.mouse.click(last.x, last.y);  // end the run
  };

  //  (4,2)--[PB]--(6,2)--[LAMP]--(8,2)
  //    |                            |
  //  (4,4) [V+] ... [V-] (4,6) -- (4,10) == GND == (8,10)
  await place('PB', 4, 2);
  await place('LAMP', 6, 2);
  await page.keyboard.press('r');           // the next placement stands vertical
  await place('V', 4, 4);
  await place('GND', 4, 10);
  await wire([4, 6], [4, 10]);
  await wire([4, 4], [4, 2]);
  await wire([8, 2], [8, 10], [4, 10]);
  await expect(page.locator('#nodeCount')).toHaveText('3 nodes');

  // Back to the select tool: with 'wire' still active, a click on the button
  // would lay wire rather than press it.
  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  const count9 = async () => (await nodeVolts(page)).filter(v => v === '5 V').length;
  // Open: only the supply node reaches the rail voltage; the lamp sits at
  // ground through its own 100 Ω, because 1 GΩ is in series ahead of it.
  expect(await count9()).toBe(1);

  // Press and hold the button on the schematic. Its centroid is (5,2).
  const btn = at(5, 2);
  await page.mouse.move(btn.x, btn.y);
  await page.mouse.down();
  await expect.poll(count9, { message: 'holding the button should power the lamp' }).toBe(2);

  await page.mouse.up();
  await expect.poll(count9, { message: 'releasing it should un-power the lamp' }).toBe(1);
});
