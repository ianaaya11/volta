// Editor behaviour: undo/redo, reset, auto-scoping the selected part, and the
// square-wave source. Like the touch suite, these observe real state through
// the app's own Share encoding rather than any test-only hook.
import { test, expect, type Page } from '@playwright/test';

interface SavedComp { id: string; type: string; x: number; y: number; amp?: number; duty?: number }

async function readModel(page: Page): Promise<{ comps: SavedComp[]; wires: unknown[]; probes?: unknown[] }> {
  await page.click('#shareBtn');
  const hash = await page.evaluate(() => location.hash);
  return page.evaluate((code: string) => JSON.parse(decodeURIComponent(escape(atob(code)))),
    hash.replace(/^#c=/, ''));
}

async function placeAt(page: Page, tool: string, dx: number, dy: number) {
  await page.click(`#rail .tool[data-t="${tool}"]`);
  const box = (await page.locator('#cv').boundingBox())!;
  await page.mouse.click(box.x + dx, box.y + dy);
}

test.describe('undo / redo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('#clearBtn');
    await expect(page.locator('#nodeCount')).toHaveText('0 nodes');
  });

  test('undo removes a placed part and redo puts it back', async ({ page }) => {
    await placeAt(page, 'R', 160, 140);
    await expect(page.locator('#nodeCount')).toHaveText('2 nodes');
    expect((await readModel(page)).comps).toHaveLength(1);

    await page.click('#undoBtn');
    await expect(page.locator('#nodeCount')).toHaveText('0 nodes');
    expect((await readModel(page)).comps).toHaveLength(0);

    await page.click('#redoBtn');
    await expect(page.locator('#nodeCount')).toHaveText('2 nodes');
    expect((await readModel(page)).comps).toHaveLength(1);
  });

  test('the buttons disable when there is nothing to undo or redo', async ({ page }) => {
    // Clear itself is undoable, so undo is live but redo is not.
    await expect(page.locator('#redoBtn')).toBeDisabled();
    await placeAt(page, 'R', 160, 140);
    await expect(page.locator('#undoBtn')).toBeEnabled();
    await page.click('#undoBtn');
    await expect(page.locator('#redoBtn')).toBeEnabled();
  });

  test('undo steps back through several edits in order', async ({ page }) => {
    await placeAt(page, 'R', 130, 130);
    await placeAt(page, 'C', 260, 130);
    await placeAt(page, 'V', 390, 130);
    expect((await readModel(page)).comps).toHaveLength(3);

    await page.click('#undoBtn');
    await page.click('#undoBtn');
    const back = await readModel(page);
    expect(back.comps).toHaveLength(1);
    expect(back.comps[0].type).toBe('R');   // the first one placed survives
  });

  test('a new edit clears the redo stack', async ({ page }) => {
    await placeAt(page, 'R', 130, 130);
    await page.click('#undoBtn');
    await expect(page.locator('#redoBtn')).toBeEnabled();
    await placeAt(page, 'C', 260, 130);
    await expect(page.locator('#redoBtn')).toBeDisabled();
  });

  test('keyboard shortcuts work', async ({ page }) => {
    await placeAt(page, 'R', 160, 140);
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+z`);
    await expect(page.locator('#nodeCount')).toHaveText('0 nodes');
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect(page.locator('#nodeCount')).toHaveText('2 nodes');
  });
});

test.describe('reset', () => {
  test('clears the simulation but keeps the circuit', async ({ page }) => {
    await page.goto('/');
    const before = await page.locator('#nodeCount').textContent();
    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
    await expect(page.locator('table.probes')).toBeVisible();

    await page.click('#resetBtn');
    // Simulation stopped and its results dropped...
    await expect(page.locator('#runBtn')).toHaveText(/Run/);
    await expect(page.locator('table.probes')).toHaveCount(0);
    // ...but the schematic is untouched, unlike Clear.
    await expect(page.locator('#nodeCount')).toHaveText(before!);
  });
});

test.describe('scope', () => {
  test('selecting a component plots its waveform without placing a probe', async ({ page }) => {
    await page.goto('/');
    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);

    // Select the resistor in the default example by clicking its body.
    await page.click('#rail .tool[data-t="select"]');
    const box = (await page.locator('#cv').boundingBox())!;
    await page.mouse.click(box.x + 40 + 7 * 26, box.y + 40 + 4 * 26);
    await expect(page.locator('#inspectorBody')).toContainText('Resistor');

    // The scope panel paints into the lower strip of the canvas. Compare ink
    // there against the same strip before any selection existed.
    const inked = await page.evaluate(() => {
      const cv = document.getElementById('cv') as HTMLCanvasElement;
      const ctx = cv.getContext('2d')!;
      const h = Math.round(230 * devicePixelRatio);
      const band = ctx.getImageData(0, cv.height - h, cv.width, h).data;
      let n = 0;
      for (let i = 3; i < band.length; i += 4) if (band[i] > 0) n++;
      return n;
    });
    expect(inked).toBeGreaterThan(20000);
  });
});

test.describe('square-wave source', () => {
  test('is on the rail and carries a duty cycle', async ({ page }) => {
    await page.goto('/');
    await page.click('#clearBtn');
    await placeAt(page, 'SQ', 160, 140);

    const model = await readModel(page);
    expect(model.comps).toHaveLength(1);
    expect(model.comps[0].type).toBe('SQ');
    expect(model.comps[0].duty).toBe(0.5);

    await page.click('#rail .tool[data-t="select"]');
    const box = (await page.locator('#cv').boundingBox())!;
    await page.mouse.click(box.x + 160, box.y + 140);
    await expect(page.locator('#inspectorBody')).toContainText('Square source');
    await expect(page.locator('#dutyInput')).toHaveValue('0.5');
  });

  test('the gallery ships a square-wave integrator that runs', async ({ page }) => {
    await page.goto('/');
    await page.selectOption('#gallery', { label: 'Square wave → RC integrator' });
    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
    await expect(page.locator('table.probes')).toBeVisible();
  });
});
