// Blocks (subcircuits).
//
// The claim being tested is the one that matters: a block behaves exactly like
// the circuit it was made of, because it *is* that circuit — expanded into the
// same devices at netlist time. So every test here compares a block against the
// discrete parts it replaced, rather than checking that a box got drawn.
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

async function nodeVolts(page: Page): Promise<string[]> {
  const rows = await page.locator('table.probes tr').all();
  const out: string[] = [];
  for (const r of rows) {
    const tds = await r.locator('td').allInnerTexts();
    if (tds.length >= 2) out.push(tds[1].trim());
  }
  return out;
}

test('the Blocks shelf explains itself before anything is on it', async ({ page }) => {
  await page.goto('/');
  const shelf = page.locator('.railgroup[data-g="Blocks"]');
  await expect(shelf).toHaveCount(1);
  await expect(shelf.locator('.railnote')).toContainText(/Make a block/i);
  await expect(shelf.locator('.tool')).toHaveCount(0);
});

test('"Make a block" is offered for a selection and leaves the circuit alone', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { index: 1 });        // RC low-pass
  const before = await page.locator('#nodeCount').innerText();
  await page.click('#selectAllBtn');
  await expect(page.locator('#multiBlock')).toBeVisible();

  page.once('dialog', d => d.accept('My RC'));
  await page.click('#multiBlock');

  // A selection with nothing outside it has no terminals, so this one is
  // refused — and refusing must not disturb the circuit.
  await expect(page.locator('#nodeCount')).toHaveText(before);
});

/** Source -> R1 -> R2 -> ground, all horizontal at y=2.
 *
 *      V(2,2)-(4,2)  wire  R1(6,2)-(8,2)  wire  R2(10,2)-(12,2)
 *      and the return runs (12,2) -> (12,6) -> (2,6) -> back to V.
 *
 *  Selecting R1 and R2 leaves exactly two nodes touching the rest of the
 *  circuit — (6,2) and (12,2) — so the block gets two terminals, and an
 *  instance dropped at (6,2) lands its pins on those same two points. */
async function seriesPair(page: Page) {
  const g = await blankGrid(page);
  await g.place('V', 2, 2);
  await g.place('R', 6, 2);
  await g.place('R', 10, 2);
  await g.place('GND', 2, 6);
  await g.wire([4, 2], [6, 2]);
  await g.wire([8, 2], [10, 2]);
  await g.wire([12, 2], [12, 6]);
  await g.wire([12, 6], [2, 6]);
  await g.wire([2, 2], [2, 6]);
  await page.click('#rail .tool[data-t="select"]');
  return g;
}

/** Shift-click each point to gather a multi-selection. */
async function pick(page: Page, ...pts: { x: number; y: number }[]) {
  await page.keyboard.press('Escape');
  await page.keyboard.down('Shift');
  for (const p of pts) await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
}

async function runAndRead(page: Page) {
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  const v = await nodeVolts(page);
  await page.click('#runBtn');
  return v;
}

test('a block solves identically to the parts it was made of', async ({ page }) => {
  const g = await seriesPair(page);
  const discrete = await runAndRead(page);
  expect(discrete.length, 'the plain circuit should solve').toBeGreaterThan(2);

  await pick(page, g.at(6, 2), g.at(10, 2));
  await expect(page.locator('#multiBlock')).toBeVisible();
  page.once('dialog', d => d.accept('Divider'));
  await page.click('#multiBlock');

  const shelf = page.locator('.railgroup[data-g="Blocks"] .tool');
  await expect(shelf).toHaveCount(1);
  await expect(shelf).toContainText('Divider');
  // Two terminals, worked out from where the selection met the rest of the
  // circuit rather than asked for.
  await expect(shelf).toHaveAttribute('title', /2 pins/);

  // Rebuild the same circuit from a clean grid, with the block standing in for
  // the two resistors. Its pins land on (6,2) and (12,2), exactly where the
  // pair's outer ends were, so the surrounding wiring is unchanged. The
  // definition outlives Clear — it is a library, not part of the document.
  await page.click('#clearBtn');
  await g.place('V', 2, 2);
  await g.place('GND', 2, 6);
  await shelf.click();
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await page.click('#rail .tool[data-t="select"]');
  await g.wire([4, 2], [6, 2]);
  await g.wire([12, 2], [12, 6]);
  await g.wire([12, 6], [2, 6]);
  await g.wire([2, 2], [2, 6]);

  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect.poll(async () => (await nodeVolts(page)).length,
    { message: 'the block should solve' }).toBe(discrete.length - 1);

  // Every node the outside world can still see reads exactly what it read
  // before. The one that vanished is the junction between the two resistors:
  // it is inside the block now, so it is allocated from the internal range and
  // never appears in a readout meant to describe the schematic you drew.
  const withBlock = await nodeVolts(page);
  for (const v of withBlock) expect(discrete, `${v} should be unchanged`).toContain(v);
});

test('two instances of one block keep their internals to themselves', async ({ page }) => {
  // If two instances shared internal nodes, two of them in series would
  // collapse into one and the voltages would move. Compared against the plain
  // two-resistor circuit rather than a hardcoded number.
  const g = await seriesPair(page);
  const discrete = await runAndRead(page);

  await pick(page, g.at(6, 2));          // wrap ONE resistor
  page.once('dialog', d => d.accept('OneK'));
  await page.click('#multiBlock');
  const shelf = page.locator('.railgroup[data-g="Blocks"] .tool');
  await expect(shelf).toHaveCount(1);
  await expect(shelf).toHaveAttribute('title', /2 pins/);

  // Two copies in series. A block is six wide, so they span (6,2)-(12,2) and
  // (14,2)-(20,2).
  await page.click('#clearBtn');
  await g.place('V', 2, 2);
  await g.place('GND', 2, 6);
  await shelf.click();
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await shelf.click();
  await page.mouse.click(g.at(14, 2).x, g.at(14, 2).y);
  await page.click('#rail .tool[data-t="select"]');
  await g.wire([4, 2], [6, 2]);
  await g.wire([12, 2], [14, 2]);
  await g.wire([20, 2], [20, 6]);
  await g.wire([20, 6], [2, 6]);
  await g.wire([2, 2], [2, 6]);

  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect.poll(async () => (await nodeVolts(page)).join('|'),
    { message: 'two blocks in series should read like the two resistors did' })
    .toBe(discrete.join('|'));
});

test('a block survives a share link — definition and all', async ({ page }) => {
  // A circuit that uses a block and does not carry its definition is a circuit
  // nobody else can open. The share link is the strictest form of that test:
  // everything needed has to be in the URL.
  const g = await seriesPair(page);
  await pick(page, g.at(6, 2), g.at(10, 2));
  page.once('dialog', d => d.accept('Keeper'));
  await page.click('#multiBlock');
  await pick(page, g.at(6, 2), g.at(10, 2));
  await page.click('#multiDel');
  await page.locator('.railgroup[data-g="Blocks"] .tool').click();
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await page.click('#rail .tool[data-t="select"]');

  const solved = (await runAndRead(page)).join('|');

  await page.click('#shareBtn');
  const url = await page.evaluate(() => location.href);
  expect(url, 'sharing should encode the circuit into the hash').toContain('#c=');

  // Open it the way a stranger would: a context that has never seen the block.
  const fresh = await page.context().browser()!.newContext();
  const other = await fresh.newPage();
  await other.goto(url);
  await expect(other.locator('.railgroup[data-g="Blocks"] .tool')).toContainText('Keeper');
  await other.click('#runBtn');
  await expect(other.locator('#runBtn')).toHaveText(/Stop/);
  await expect.poll(async () => (await nodeVolts(other)).join('|'),
    { message: 'the shared circuit should solve to what the author saw' }).toBe(solved);
  await fresh.close();
});
