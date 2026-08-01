// Reshaping a wire, and getting around the canvas.
//
// A wire could be drawn and deleted but never adjusted — the only way to make
// one longer was to delete it and draw it again, and the only way to move the
// view was to find a patch of empty grid to drag, which a schematic that fills
// the screen does not have.
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

const heading = (page: Page) => page.locator('#inspectorBody h3').first();

async function dragGrid(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** Two resistors with a gap between them, joined only part of the way:
 *  R1 at (2,2)-(4,2), R2 at (12,2)-(14,2), and a stub from (4,2) to (8,2). */
async function gap(page: Page) {
  const g = await blankGrid(page);
  await g.place('R', 2, 2);
  await g.place('R', 12, 2);
  await g.wire([4, 2], [8, 2]);
  await page.click('#rail .tool[data-t="select"]');
  return g;
}

test('a selected wire offers grab handles at its ends', async ({ page }) => {
  const g = await gap(page);
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await expect(heading(page)).toHaveText('Wire');
  await expect(page.locator('#inspectorBody')).toContainText('Drag either end');
});

test('dragging an end along the wire extends it, and nothing else moves',
  async ({ page }) => {
    const g = await gap(page);
    const nodesBefore = await page.locator('#nodeCount').innerText();

    await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
    await expect(heading(page)).toHaveText('Wire');
    await dragGrid(page, g.at(8, 2), g.at(12, 2));

    // The stub now reaches the second resistor, so two nodes have become one.
    await expect(page.locator('#nodeCount')).not.toHaveText(nodesBefore);
    await expect(page.locator('#inspectorBody')).toContainText('(4, 2) to (12, 2)');

    // Both resistors are exactly where they were — extending a wire must not
    // drag the circuit around with it.
    await page.keyboard.press('Escape');
    await page.mouse.click(g.at(3, 2).x, g.at(3, 2).y);
    await expect(heading(page)).toHaveText('Resistor');
    await page.mouse.click(g.at(13, 2).x, g.at(13, 2).y);
    await expect(heading(page)).toHaveText('Resistor');
  });

test('a wire swung round to a new axis stays a single segment', async ({ page }) => {
  // The fixed end is (4,2). Dropping the other end at (4,8) lines the two up
  // again, just vertically — so the result should be one wire, not an L with a
  // zero-length leg.
  const g = await gap(page);
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await dragGrid(page, g.at(8, 2), g.at(4, 8));
  await expect(page.locator('#inspectorBody')).toContainText('(4, 2) to (4, 8)');
  await expect(page.locator('#inspectorBody')).toContainText('6-square');
});

test('an end dragged diagonally becomes two segments that meet at a corner',
  async ({ page }) => {
    const g = await gap(page);
    await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
    await dragGrid(page, g.at(8, 2), g.at(10, 8));

    // Somewhere on each leg there is now a wire; on the straight line between
    // the two ends — where a diagonal would have run — there is not.
    await page.keyboard.press('Escape');
    await page.mouse.click(g.at(9, 5).x, g.at(9, 5).y);
    await expect(heading(page), 'a diagonal would pass through here').not.toHaveText('Wire');

    await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
    await expect(heading(page), 'the horizontal leg should still be there').toHaveText('Wire');
  });

test('dragging an end onto the other one removes the wire', async ({ page }) => {
  const g = await gap(page);
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await dragGrid(page, g.at(8, 2), g.at(4, 2));
  await page.keyboard.press('Escape');
  await page.mouse.click(g.at(6, 2).x, g.at(6, 2).y);
  await expect(heading(page)).not.toHaveText('Wire');
});

test('the Pan tool moves the view from anywhere, including over a part',
  async ({ page }) => {
    const g = await gap(page);
    // Starting the drag on top of a resistor: with Select this would move the
    // part, which is exactly why a dedicated tool is worth having.
    await page.click('#rail .tool[data-t="pan"]');
    await dragGrid(page, g.at(3, 2), g.at(3, 10));

    // The part did not move in the document, but it did move on screen — so
    // where it used to be there is now nothing, and 8 squares down there it is.
    await page.click('#rail .tool[data-t="select"]');
    await page.mouse.click(g.at(3, 2).x, g.at(3, 2).y);
    await expect(heading(page)).not.toHaveText('Resistor');
    await page.mouse.click(g.at(3, 10).x, g.at(3, 10).y);
    await expect(heading(page)).toHaveText('Resistor');
  });

test('the Pan tool never edits the circuit', async ({ page }) => {
  const g = await gap(page);
  const nodes = await page.locator('#nodeCount').innerText();
  await page.click('#rail .tool[data-t="pan"]');
  await dragGrid(page, g.at(6, 2), g.at(6, 9));      // straight across the wire
  await page.mouse.click(g.at(3, 2).x, g.at(3, 2).y); // and a plain click on a part
  await expect(page.locator('#nodeCount')).toHaveText(nodes);
  await expect(heading(page)).not.toHaveText('Resistor');
});

test('picking a part from the rail places one, then hands you back Select',
  async ({ page }) => {
    // The tool used to stay armed, so every later click anywhere on the grid
    // dropped another copy and the only way out was Escape — which meant a
    // stray click after placing something left a part you had not asked for,
    // usually noticed several actions later.
    const g = await blankGrid(page);
    await page.click('#rail .tool[data-t="R"]');
    await page.mouse.click(g.at(2, 2).x, g.at(2, 2).y);
    await expect(page.locator('#rail .tool.active')).toHaveAttribute('data-t', 'select');

    const nodes = await page.locator('#nodeCount').innerText();
    await page.mouse.click(g.at(2, 8).x, g.at(2, 8).y);
    await expect(page.locator('#nodeCount'),
      'a second click should place nothing').toHaveText(nodes);
  });

test('shift keeps the tool armed for laying out a row', async ({ page }) => {
  const g = await blankGrid(page);
  await page.click('#rail .tool[data-t="R"]');
  await page.keyboard.down('Shift');
  for (const y of [2, 6, 10]) await page.mouse.click(g.at(2, y).x, g.at(2, y).y);
  await page.keyboard.up('Shift');
  await expect(page.locator('#rail .tool.active')).toHaveAttribute('data-t', 'R');
  await expect(page.locator('#nodeCount')).toHaveText('6 nodes');
});

test('double-tapping a rail tile locks it, for a phone with no shift key',
  async ({ page }) => {
    const g = await blankGrid(page);
    await page.dblclick('#rail .tool[data-t="R"]');
    await expect(page.locator('#rail .tool[data-t="R"]')).toHaveClass(/locked/);
    for (const y of [2, 6, 10]) await page.mouse.click(g.at(2, y).x, g.at(2, y).y);
    await expect(page.locator('#nodeCount')).toHaveText('6 nodes');
    await expect(page.locator('#rail .tool.active')).toHaveAttribute('data-t', 'R');

    // Escape lets go of it.
    await page.keyboard.press('Escape');
    await expect(page.locator('#rail .tool.active')).toHaveAttribute('data-t', 'select');
    await expect(page.locator('#rail .tool[data-t="R"]')).not.toHaveClass(/locked/);
  });
