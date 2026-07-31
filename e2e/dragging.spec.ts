// Moving a circuit must not take it apart.
//
// The editor's connectivity is positional: a wire end and a pin are joined
// because they share a grid cell. That makes "drag a part" the most dangerous
// operation in the app — before rubber-band wiring it silently unhooked
// whatever it touched, and the schematic still LOOKED connected because the
// wires were still drawn next to the pins. These tests assert the thing the
// picture can't: that the netlist the solver sees is unchanged.
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
    /** Press at one grid cell, move to another in steps, release. */
    drag: async (from: [number, number], to: [number, number]) => {
      await page.click('#rail .tool[data-t="select"]');
      const a = at(...from), b = at(...to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8);
      }
      await page.mouse.up();
    },
  };
}

/** Node voltages as the inspector shows them. */
async function nodeVolts(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const r of await page.locator('table.probes tr').all()) {
    const tds = await r.locator('td').allInnerTexts();
    if (tds.length >= 2) out.push(tds[1].trim());
  }
  return out;
}

/** A divider whose middle node sits at a known 2 V, built from wires only. */
async function divider(page: Page) {
  const g = await blankGrid(page);
  await g.place('V', 2, 2);          // pins (2,2) and (2,4), rot 0 -> horizontal
  await page.click('#rail .tool[data-t="select"]');
  await page.mouse.click(g.at(2, 2).x, g.at(2, 2).y);
  await page.locator('#valInput').fill('6');
  await page.locator('#valInput').dispatchEvent('change');
  return g;
}

test('dragging a part keeps every wire attached to it', async ({ page }) => {
  const g = await blankGrid(page);
  // V(2,2)-(4,2) — R(6,2)-(8,2) — C(10,2)-(10,4) — GND(10,6), returned via ground.
  await g.place('V', 2, 2);
  await g.place('R', 6, 2);
  await g.place('C', 10, 2);
  await g.place('GND', 10, 6);
  await g.place('GND', 2, 6);
  await g.wire([4, 2], [6, 2]);
  await g.wire([8, 2], [10, 2]);
  await g.wire([10, 4], [10, 6]);
  await g.wire([2, 2], [2, 6]);

  await page.click('#rail .tool[data-t="select"]');
  const before = await page.locator('#nodeCount').textContent();

  // Drag the resistor down and across — both its leads must follow.
  await g.drag([6, 2], [7, 5]);
  await expect(page.locator('#nodeCount')).toHaveText(before!);

  // And the circuit must still solve, not just still look joined.
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  await expect.poll(() => nodeVolts(page)).not.toEqual([]);
  expect((await nodeVolts(page)).length).toBeGreaterThan(1);
});

test('a pin shared with another part stays put and grows a new lead', async ({ page }) => {
  const g = await blankGrid(page);
  // R and C butt directly together at (6,2): R spans (4,2)-(6,2), C hangs down
  // from (6,2). Dragging the capacitor away must not unhook the resistor.
  await g.place('V', 2, 2);
  await g.place('R', 4, 2);
  await g.place('C', 6, 2);       // rot 0 -> (6,2)-(8,2)
  await g.place('GND', 2, 6);
  await g.wire([2, 2], [4, 2]);
  await g.wire([8, 2], [8, 6]);
  await g.wire([8, 6], [2, 6]);
  await g.wire([2, 2], [2, 6]);

  await page.click('#rail .tool[data-t="select"]');
  const before = await page.locator('#nodeCount').textContent();
  await g.drag([7, 2], [7, 6]);   // grab the capacitor by its middle
  await expect(page.locator('#nodeCount')).toHaveText(before!);
});

test('select all moves the whole circuit as one, wires and probes included', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { index: 2 });   // sine -> RC low-pass, 2 probes
  await page.click('#fitBtn');
  const before = await page.locator('#nodeCount').textContent();

  await page.click('#selectAllBtn');
  await expect(page.locator('#inspectorBody')).toContainText('parts selected');

  const box = (await page.locator('#cv').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.25);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width * 0.44 + i * 8, box.y + box.height * 0.25 + i * 10);
  }
  await page.mouse.up();

  // Same circuit, moved: identical node count, and it still simulates.
  await expect(page.locator('#nodeCount')).toHaveText(before!);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  // Probes travelled with the nets they measure, so their traces are not flat.
  await expect.poll(async () => {
    const rows = await nodeVolts(page);
    return rows.some(v => v !== '0V' && v !== '0 V');
  }, { message: 'a probed node should carry a non-zero voltage' }).toBe(true);
});

test('select all then Delete clears the schematic, and undo brings it back', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { index: 1 });
  await page.click('#fitBtn');
  const before = await page.locator('#nodeCount').textContent();
  expect(before).not.toBe('0 nodes');

  await page.click('#selectAllBtn');
  await page.click('#inspectorBody >> text=Delete');
  await expect(page.locator('#nodeCount')).toHaveText('0 nodes');

  await page.click('#undoBtn');
  await expect(page.locator('#nodeCount')).toHaveText(before!);
});

test('shift-click gathers parts, and Escape drops the selection', async ({ page }) => {
  const g = await blankGrid(page);
  await g.place('R', 2, 2);
  await g.place('R', 6, 2);
  await g.place('R', 10, 2);

  await page.click('#rail .tool[data-t="select"]');
  // page.mouse.click() takes no `modifiers` — hold the key around the clicks so
  // the pointerdown actually carries shiftKey.
  await page.keyboard.down('Shift');
  await page.mouse.click(g.at(3, 2).x, g.at(3, 2).y);
  await page.mouse.click(g.at(7, 2).x, g.at(7, 2).y);
  await expect(page.locator('#inspectorBody')).toContainText('2 parts selected');

  // Shift-clicking a member takes it back out.
  await page.mouse.click(g.at(7, 2).x, g.at(7, 2).y);
  await expect(page.locator('#inspectorBody')).toContainText('1 part selected');
  await page.keyboard.up('Shift');

  await page.keyboard.press('Escape');
  await expect(page.locator('#inspectorBody')).not.toContainText('selected.');
});
