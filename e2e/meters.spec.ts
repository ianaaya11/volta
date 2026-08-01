// Voltmeter and ammeter.
//
// Neither needed a new solver stamp — an ammeter is a 0 V source whose branch
// current the engine already reports, and a voltmeter is a very large resistor.
// That makes these tests worth having: the parts are cheap to add and easy to
// get subtly wrong (a voltmeter wired in series, or an ammeter that quietly
// inserts resistance, would still produce plausible-looking numbers).
import { test, expect, type Page } from '@playwright/test';

const GRID = 26, PAD = 40;

async function blankGrid(page: Page) {
  await page.goto('/');
  await page.click('#clearBtn');
  await page.click('#fitBtn');
  const box = (await page.locator('#cv').boundingBox())!;
  const at = (gx: number, gy: number) => ({ x: box.x + PAD + gx * GRID, y: box.y + PAD + gy * GRID });
  const click = async (gx: number, gy: number) => {
    const p = at(gx, gy); await page.mouse.click(p.x, p.y);
  };
  return {
    at, click,
    place: async (tool: string, gx: number, gy: number) => {
      await page.click(`#rail .tool[data-t="${tool}"]`);
      await click(gx, gy);
    },
    wire: async (a: [number, number], b: [number, number]) => {
      await page.click('#rail .tool[data-t="wire"]');
      await click(...a); await click(...b);
      await page.keyboard.press('Escape');
    },
  };
}

/** The "Current" / "Voltage across" figure the inspector shows, in base units. */
async function live(page: Page, label: 'Voltage across' | 'Current'): Promise<number> {
  const txt = await page.locator('#inspectorBody').innerText();
  const m = new RegExp(`${label}\\s+(-?[\\d.]+)\\s*([munpk]?)`).exec(txt);
  if (!m) throw new Error(`no "${label}" in inspector:\n${txt}`);
  const scale: Record<string, number> = { '': 1, k: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12 };
  return Number(m[1]) * (scale[m[2]] ?? 1);
}

/** 10 V driving 1 kΩ, with an ammeter in series and a voltmeter across it. */
async function meteredDivider(page: Page) {
  const g = await blankGrid(page);
  await g.place('V', 3, 3);       // (3,3)-(5,3)
  await g.place('AM', 6, 3);      // (6,3)-(8,3), in series
  await g.place('R', 9, 3);       // (9,3)-(11,3)
  await g.place('VM', 9, 7);      // (9,7)-(11,7), across the resistor
  await g.place('GND', 3, 9);

  await page.click('#rail .tool[data-t="select"]');
  await g.click(4, 3);
  await page.locator('#valInput').fill('10');
  await page.locator('#valInput').dispatchEvent('change');

  await g.wire([5, 3], [6, 3]);
  await g.wire([8, 3], [9, 3]);
  await g.wire([9, 3], [9, 7]);
  await g.wire([11, 3], [11, 7]);
  await g.wire([11, 3], [11, 9]);
  await g.wire([11, 9], [3, 9]);
  await g.wire([3, 3], [3, 9]);

  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  return g;
}

test('the ammeter reads the current through it', async ({ page }) => {
  const g = await meteredDivider(page);
  await g.click(7, 3);
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Ammeter');
  // 10 V across 1 kΩ. Sign depends on which way the source faces.
  await expect.poll(async () => Math.abs(await live(page, 'Current'))).toBeCloseTo(0.01, 4);
});

test('the ammeter is an ideal short — it drops no voltage', async ({ page }) => {
  const g = await meteredDivider(page);
  await g.click(7, 3);
  // The whole point: inserting a meter must not change what it measures.
  await expect.poll(async () => Math.abs(await live(page, 'Voltage across'))).toBeLessThan(1e-6);
});

test('the voltmeter reads the voltage across it without loading the circuit', async ({ page }) => {
  const g = await meteredDivider(page);
  await g.click(10, 7);
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Voltmeter');
  await expect.poll(async () => Math.abs(await live(page, 'Voltage across'))).toBeCloseTo(10, 2);
  // Its own draw is negligible next to the 10 mA in the resistor.
  await expect.poll(async () => Math.abs(await live(page, 'Current'))).toBeLessThan(1e-5);
});

test('the ohmmeter reads a resistance, and OL when nothing is connected', async ({ page }) => {
  const g = await blankGrid(page);
  await g.place('R', 3, 3);       // (3,3)-(5,3)
  await g.place('OM', 3, 7);      // (3,7)-(5,7), across it
  await g.place('OM', 3, 12);     // a second meter, connected to nothing

  await page.click('#rail .tool[data-t="select"]');
  await g.click(4, 3);
  await page.locator('#valInput').fill('2.2k');
  await page.locator('#valInput').dispatchEvent('change');
  await g.wire([3, 3], [3, 7]);
  await g.wire([5, 3], [5, 7]);

  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  await g.click(4, 7);
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Ohmmeter');
  await expect.poll(async () => {
    const m = /Resistance\s+([\d.]+)\s*k/.exec(await page.locator('#inspectorBody').innerText());
    return m ? Number(m[1]) : NaN;
  }).toBeCloseTo(2.2, 1);

  // The unconnected one is over-limit, exactly as a bench meter shows.
  await g.click(4, 12);
  await expect(page.locator('#inspectorBody')).toContainText('OL');
});

test('a wattmeter reads real power, and its own coils disturb nothing', async ({ page }) => {
  const g = await blankGrid(page);
  // 12 V across 100 Ω = 120 mA and 1.44 W.
  await g.place('V', 3, 12);      // (3,12)-(5,12)
  await g.place('WM', 7, 12);     // I coil (7,11)/(7,13); V coil (11,11)/(11,13)
  await g.place('R', 13, 12);     // (13,12)-(15,12)
  await g.place('GND', 3, 17);

  await page.click('#rail .tool[data-t="select"]');
  await g.click(4, 12);
  await page.locator('#valInput').fill('12');
  await page.locator('#valInput').dispatchEvent('change');
  await g.click(14, 12);
  await page.locator('#valInput').fill('100');
  await page.locator('#valInput').dispatchEvent('change');

  await g.wire([5, 12], [7, 11]);       // source + into the current coil
  // Out of the current coil to the load, routed BELOW the meter rather than
  // straight across at y=13 — which is where the voltage coil's own bottom pin
  // sits. Ending a wire part-way along another now taps it, so a run that
  // happens to pass through a pin is a junction waiting to happen the moment
  // anything is drawn from that pin.
  await g.wire([7, 13], [7, 15]);
  await g.wire([7, 15], [13, 15]);
  await g.wire([13, 15], [13, 12]);     // current coil out to the load
  await g.wire([11, 11], [13, 12]);     // voltage coil across the load
  await g.wire([11, 13], [15, 12]);
  await g.wire([15, 12], [15, 17]);
  await g.wire([15, 17], [3, 17]);
  await g.wire([3, 12], [3, 17]);

  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  await g.click(9, 12);
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Wattmeter');
  const readout = async (label: string) => {
    const m = new RegExp(`${label}\\s+(-?[\\d.]+)\\s*([munk]?)`).exec(await page.locator('#inspectorBody').innerText());
    if (!m) return NaN;
    const scale: Record<string, number> = { '': 1, k: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9 };
    return Math.abs(Number(m[1]) * (scale[m[2]] ?? 1));
  };
  await expect.poll(() => readout('Load current')).toBeCloseTo(0.12, 3);
  await expect.poll(() => readout('Load voltage')).toBeCloseTo(12, 1);
  await expect.poll(() => readout('Power')).toBeCloseTo(1.44, 2);
});

test('routing to a multi-pin part does not short it through the elbow', async ({ page }) => {
  // The regression that made the wattmeter read 0 W: an auto-routed elbow
  // landing inside a part's own footprint joins two of its pins through the
  // corner. The schematic looks fine; the part is bridged.
  const g = await blankGrid(page);
  await g.place('V', 3, 12);
  await g.place('WM', 7, 12);
  await page.click('#rail .tool[data-t="wire"]');
  await g.click(5, 12);          // source pin, to the LEFT of the meter
  await g.click(7, 11);          // upper current-coil pin

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#saveBtn')]);
  let t = ''; for await (const c of await dl.createReadStream()) t += String(c);
  const { wires } = JSON.parse(t) as { wires: { x1: number; y1: number; x2: number; y2: number }[] };

  // No wire endpoint may sit strictly between the meter's two left pins —
  // that cell is what bridges them.
  const bridged = wires.some(w =>
    (w.x1 === 7 && w.y1 === 12) || (w.x2 === 7 && w.y2 === 12));
  expect(bridged).toBe(false);
});

test('both meters are on the rail and place without a console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  const g = await blankGrid(page);
  for (const t of ['VM', 'AM', 'OM', 'WM']) {
    await expect(page.locator(`#rail .tool[data-t="${t}"]`)).toHaveCount(1);
  }
  await g.place('VM', 3, 3);
  await g.place('AM', 3, 7);
  await g.place('OM', 3, 11);
  await g.place('WM', 8, 3);
  await expect(page.locator('#nodeCount')).toHaveText('11 nodes');
  expect(errors).toEqual([]);
});

test('searching the palette for "meter" finds them', async ({ page }) => {
  await page.goto('/');
  await page.fill('#partSearch', 'meter');
  await expect(page.locator('#rail .tool[data-t="VM"]')).toBeVisible();
  await expect(page.locator('#rail .tool[data-t="AM"]')).toBeVisible();
  // "Potentiometer" legitimately matches too — the search covers full names,
  // not just the two-word labels under the tiles.
  await expect(page.locator('#rail .tool[data-t="POT"]')).toBeVisible();
  await expect(page.locator('#rail .tool[data-t="R"]')).toBeHidden();
});
