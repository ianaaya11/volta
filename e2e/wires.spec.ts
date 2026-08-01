// Getting rid of a wire.
//
// Wires were the one thing on the schematic that could be drawn but never
// removed. The Delete tool checked for a component first and only looked for a
// wire if it found none — and a component's grab area is padded 0.7 of a square
// past its outline and accepts another 0.7 beyond that, which is a 1.4-square
// halo. Every wire in a schematic starts at a pin, so that halo covered the
// start of all of them, and a short link between two adjacent parts was inside
// it end to end. Aiming at such a wire deleted a resistor instead.
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

/** Two resistors two squares apart, joined by a short link, plus a stray wire
 *  in open ground. R1 occupies (2,2)-(4,2); R2 (8,2)-(10,2); the link runs
 *  (4,2)-(8,2), which is entirely inside both parts' grab halos. */
async function twoResistors(page: Page) {
  const g = await blankGrid(page);
  await g.place('R', 2, 2);
  await g.place('R', 8, 2);
  await g.wire([4, 2], [8, 2]);
  await g.wire([4, 6], [12, 6]);
  await page.click('#rail .tool[data-t="select"]');
  return g;
}

test('the Delete tool removes the wire you aimed at, not the part beside it',
  async ({ page }) => {
    const g = await twoResistors(page);
    await page.click('#rail .tool[data-t="delete"]');
    await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);

    // Both resistors are still there — clicking each one selects it, which it
    // could not do if it had been deleted.
    await page.click('#rail .tool[data-t="select"]');
    await page.mouse.click(g.at(3, 2).x, g.at(3, 2).y);
    await expect(page.locator('#inspectorBody h3').first()).toHaveText('Resistor');
    await page.mouse.click(g.at(9, 2).x, g.at(9, 2).y);
    await expect(page.locator('#inspectorBody h3').first()).toHaveText('Resistor');

    // And the link is gone: nothing is selectable where it ran.
    await page.keyboard.press('Escape');
    await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
    await expect(page.locator('#inspectorBody h3').first()).not.toHaveText('Wire');
  });

test('a wire can be selected and deleted like anything else', async ({ page }) => {
  const g = await twoResistors(page);
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Wire');
  await expect(page.locator('#inspectorBody')).toContainText('(4, 2) to (8, 2)');

  await page.keyboard.press('Delete');
  await expect(page.locator('#inspectorBody h3').first()).not.toHaveText('Wire');

  // Gone for good: clicking the same spot finds nothing.
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await expect(page.locator('#inspectorBody h3').first()).not.toHaveText('Wire');
});

test('the Delete wire button in the inspector works too', async ({ page }) => {
  const g = await twoResistors(page);
  await page.mouse.click(g.at(8, 6).x, g.at(8, 6).y);      // the stray wire
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Wire');
  await page.click('#wireDel');
  await page.mouse.click(g.at(8, 6).x, g.at(8, 6).y);
  await expect(page.locator('#inspectorBody h3').first()).not.toHaveText('Wire');
});

test('a part is still grabbed by its own lead, where a wire also starts',
  async ({ page }) => {
    // The pin is the one place both are at distance zero. Handing it to the
    // wire would make a part undraggable by its lead, so the part wins on its
    // own outline.
    const g = await twoResistors(page);
    await page.mouse.click(g.at(4, 2).x, g.at(4, 2).y);
    await expect(page.locator('#inspectorBody h3').first()).toHaveText('Resistor');

    // And it really drags from there.
    await page.mouse.move(g.at(4, 2).x, g.at(4, 2).y);
    await page.mouse.down();
    await page.mouse.move(g.at(4, 10).x, g.at(4, 10).y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await page.mouse.click(g.at(3, 10).x, g.at(3, 10).y);
    await expect(page.locator('#inspectorBody h3').first(),
      'the resistor should have moved with the drag').toHaveText('Resistor');
  });

test('the Delete tool still removes a part when a part is what you clicked',
  async ({ page }) => {
    const g = await twoResistors(page);
    await page.click('#rail .tool[data-t="delete"]');
    await page.mouse.click(g.at(3, 2).x, g.at(3, 2).y);     // on R1's body
    await page.click('#rail .tool[data-t="select"]');
    await page.mouse.click(g.at(3, 2).x, g.at(3, 2).y);
    await expect(page.locator('#inspectorBody h3').first()).not.toHaveText('Resistor');
  });

test('a selected wire does not survive the document being replaced', async ({ page }) => {
  // The selection holds a reference into the wires array, and Open replaces
  // that array wholesale — a held reference would leave the inspector offering
  // to delete a wire that is no longer in the document.
  const g = await twoResistors(page);
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await expect(page.locator('#inspectorBody h3').first()).toHaveText('Wire');
  await page.selectOption('#gallery', { index: 1 });
  await expect(page.locator('#inspectorBody h3').first()).not.toHaveText('Wire');
});
