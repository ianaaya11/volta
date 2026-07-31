// The digital parts, as wired into the editor.
//
// tests/digital.test.ts already pins down every truth table and state machine
// against the pure model. What's left is the bridge: that a gate's pins land
// where the symbol draws them, that a high-impedance input really does read the
// node it's wired to, that a driven output really does move that node, and that
// the one-step propagation delay lets sequential parts run at all.
import { test, expect, type Page } from '@playwright/test';

const GRID = 26, PAD = 40;   // an empty document fits to ox = oy = 40, scale 1

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

async function nodeVolts(page: Page): Promise<string[]> {
  const rows = await page.locator('table.probes tr').all();
  const out: string[] = [];
  for (const r of rows) {
    const tds = await r.locator('td').allInnerTexts();
    if (tds.length >= 2) out.push(tds[1].trim());
  }
  return out;
}

test('every digital part is on the rail and places cleanly', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  const g = await blankGrid(page);
  const added = ['LOGIC', 'NOT', 'AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR',
    'SRL', 'DL', 'DFF', 'JKFF', 'TFF', 'CNT4', 'SEG7', 'NE555', 'DAC4', 'ADC4'];
  for (const t of added) await expect(page.locator(`#rail .tool[data-t="${t}"]`)).toHaveCount(1);
  let gy = 0;
  for (const t of added) { await g.place(t, gy % 2 ? 10 : 0, gy * 2); gy++; }
  expect(errors).toEqual([]);
  // Nothing is wired together, so every pin is its own node — plus ground,
  // which digital parts bring with them whether or not one is drawn.
  await expect(page.locator('#nodeCount')).not.toHaveText('0 nodes');
});

test('an AND gate reads its inputs and drives its output', async ({ page }) => {
  const g = await blankGrid(page);
  // Two switchable sources into the two inputs. This is the test that the pin
  // ORDER on the symbol matches what the model expects, and that a
  // high-impedance input doesn't disturb what it is measuring.
  await g.place('LOGIC', 2, 2);
  await g.place('LOGIC', 2, 4);
  await g.place('AND', 6, 3);            // inputs (6,2) and (6,4); output (10,3)
  await g.wire([2, 2], [6, 2]);
  await g.wire([2, 4], [6, 4]);
  await expect(page.locator('#nodeCount')).toHaveText('4 nodes');

  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  const highs = async () => (await nodeVolts(page)).filter(v => v === '5 V').length;
  const A = g.at(2, 2), B = g.at(2, 4);
  // Both inputs low: nothing on the board is at the rail.
  await expect.poll(highs, { message: 'all inputs low' }).toBe(0);
  // One input: that source is high, the output still isn't.
  await page.mouse.click(A.x, A.y);
  await expect.poll(highs, { message: 'A high, output should stay low' }).toBe(1);
  // Both: now the source pair AND the output are all high.
  await page.mouse.click(B.x, B.y);
  await expect.poll(highs, { message: 'A and B high, output should follow' }).toBe(3);
  // And it falls again when an input goes away.
  await page.mouse.click(A.x, A.y);
  await expect.poll(highs, { message: 'A low again' }).toBe(1);
});

test('a T flip-flop halves its clock — the propagation delay makes feedback work', async ({ page }) => {
  const g = await blankGrid(page);
  // T tied high, so every clock edge toggles Q. If a sequential part could see
  // its own output within the same step this would never settle; it works only
  // because a driven output takes effect on the NEXT step.
  await g.place('LOGIC', 2, 2);          // T, held high
  await g.place('LOGIC', 2, 6);          // CLK
  await g.place('TFF', 6, 3);            // T (6,2), CLK (6,4); Q (12,2), Q̄ (12,4)
  await g.wire([2, 2], [6, 2]);
  await g.wire([2, 6], [6, 4]);

  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  const T = g.at(2, 2), CLK = g.at(2, 6);
  await page.mouse.click(T.x, T.y);                       // T high

  // Compare whole ordered snapshots rather than counting rail-high nodes: with
  // Q and Q̄ always opposite, the COUNT is the same in both states and only the
  // pattern tells them apart.
  const snap = async () => (await nodeVolts(page)).join('|');
  const clockCycle = async () => {
    await page.mouse.click(CLK.x, CLK.y);                 // rising edge
    await page.waitForTimeout(80);
    await page.mouse.click(CLK.x, CLK.y);                 // back low
    await page.waitForTimeout(80);
  };
  const rest = await snap();
  await clockCycle();
  await expect.poll(snap, { message: 'one clock cycle should toggle Q' }).not.toBe(rest);
  await clockCycle();
  await expect.poll(snap, { message: 'a second cycle should toggle it back' }).toBe(rest);
});

test('the counter example advances and the display paints a digit', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'Digital: clock → counter → display' });
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  // The four Q lines take on several different patterns as the count advances.
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    seen.add((await nodeVolts(page)).join('|'));
    if (seen.size >= 4) break;
    await page.waitForTimeout(120);
  }
  expect(seen.size, 'the counter should pass through several values').toBeGreaterThanOrEqual(4);

  // The display really painted segments: count the lit-segment red on canvas.
  const red = await page.evaluate(() => {
    const cv = document.getElementById('cv') as HTMLCanvasElement;
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 80) n++;
    }
    return n;
  });
  expect(red, 'expected lit 7-segment bars on the canvas').toBeGreaterThan(500);
});

test('the 555 astable oscillates', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: '555 astable blinks an LED' });
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  // The output swings to the 555's own 9 V supply and back, which only happens
  // if both comparators and the discharge pin are all doing their jobs.
  const highs = new Set<number>();
  for (let i = 0; i < 40; i++) {
    highs.add((await nodeVolts(page)).filter(v => v === '9 V').length);
    if (highs.size >= 2) break;
    await page.waitForTimeout(150);
  }
  expect(highs.size, 'the output should be seen both high and low').toBeGreaterThanOrEqual(2);
});
