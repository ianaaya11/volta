// Touch input smoke tests — the other half of Phase 6's "per-platform launch +
// touch tests". These run in a touch-capable mobile context, because the
// Capacitor iOS/Android shells render exactly this build with a finger as the
// only input device.
//
// The editor listens for POINTER events rather than mouse events for this
// reason: touch never synthesizes the mousemove stream a drag needs, so a
// mouse-only editor can place a part on a phone but cannot move one.
//
// Everything is observed through the app's own Share encoding — the circuit is
// serialized into the URL hash — so these assert on real user-visible state
// without production code carrying any test hook.
import { test, expect, type Page } from '@playwright/test';

interface SavedComp { id: string; type: string; x: number; y: number }

/** Read the live document back by asking the app to encode it into the URL. */
async function readModel(page: Page): Promise<{ comps: SavedComp[]; wires: unknown[] }> {
  await page.click('#shareBtn');
  const hash = await page.evaluate(() => location.hash);
  const b64 = hash.replace(/^#c=/, '');
  return page.evaluate(
    (code: string) => JSON.parse(decodeURIComponent(escape(atob(code)))),
    b64,
  );
}

/** Centre of the canvas in page coordinates, plus a grid-step helper. */
async function canvasOrigin(page: Page) {
  const box = (await page.locator('#cv').boundingBox())!;
  return { x: box.x, y: box.y };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.click('#clearBtn');
  await expect(page.locator('#nodeCount')).toHaveText('0 nodes');
});

test('the app is touch-capable and gives the canvas real width on a phone', async ({ page }, info) => {
  expect(info.project.use.hasTouch).toBe(true);

  // The stage must opt out of browser gesture handling, or a drag scrolls the
  // page instead of moving a part.
  const touchAction = await page.evaluate(() =>
    getComputedStyle(document.getElementById('stage')!).touchAction);
  expect(touchAction).toBe('none');

  // Regression guard: the desktop layout's fixed 64px rail and 280px inspector
  // left the schematic 68px wide on a 412px phone. The canvas must get most of
  // the viewport, and enough height to be worth drawing on.
  const { canvasW, viewportW, canvasH } = await page.evaluate(() => {
    const c = document.getElementById('cv')!.getBoundingClientRect();
    return { canvasW: c.width, canvasH: c.height, viewportW: window.innerWidth };
  });
  expect(canvasW).toBeGreaterThan(viewportW * 0.9);
  expect(canvasH).toBeGreaterThan(250);
});

test('tapping the grid places a part', async ({ page }) => {
  await page.tap('#rail .tool[data-t="R"]');
  const o = await canvasOrigin(page);
  await page.touchscreen.tap(o.x + 130, o.y + 130);

  await expect(page.locator('#nodeCount')).toHaveText('2 nodes');
  const model = await readModel(page);
  expect(model.comps).toHaveLength(1);
  expect(model.comps[0].type).toBe('R');
});

test('a touch drag moves a placed part', async ({ page }) => {
  // Place a resistor, then switch to Select and drag it with a touch pointer.
  await page.tap('#rail .tool[data-t="R"]');
  const o = await canvasOrigin(page);
  await page.touchscreen.tap(o.x + 130, o.y + 130);
  const before = (await readModel(page)).comps[0];

  await page.tap('#rail .tool[data-t="select"]');
  // Drive real touch-type pointer events: pointerdown on the part, a couple of
  // moves, then pointerup. This is the exact sequence a finger produces, and
  // the sequence a mouse-only editor would ignore entirely.
  await page.evaluate(({ x, y }) => {
    const stage = document.getElementById('stage')!;
    const opts = { pointerId: 1, pointerType: 'touch', bubbles: true, isPrimary: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x, clientY: y }));
    stage.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x + 52, clientY: y }));
    stage.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x + 104, clientY: y + 52 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x + 104, clientY: y + 52 }));
  }, { x: o.x + 130, y: o.y + 130 });

  const after = (await readModel(page)).comps[0];
  expect(after.id).toBe(before.id);          // same part...
  expect(after.x).toBeGreaterThan(before.x); // ...moved by the drag
  expect(after.y).toBeGreaterThan(before.y);
});

test('tap-to-tap wiring works, and tapping the start point ends the run', async ({ page }) => {
  await page.tap('#rail .tool[data-t="wire"]');
  const o = await canvasOrigin(page);
  const GRID = 26;
  // Three taps in a row lay two wire segments.
  await page.touchscreen.tap(o.x + 4 * GRID, o.y + 4 * GRID);
  await page.touchscreen.tap(o.x + 6 * GRID, o.y + 4 * GRID);
  await page.touchscreen.tap(o.x + 8 * GRID, o.y + 4 * GRID);
  expect((await readModel(page)).wires).toHaveLength(2);

  // Tapping the current start point again ends the run rather than extending
  // it — a double-tap can't be used here, that's the browser's zoom gesture.
  await page.touchscreen.tap(o.x + 8 * GRID, o.y + 4 * GRID);
  await page.touchscreen.tap(o.x + 12 * GRID, o.y + 8 * GRID);
  expect((await readModel(page)).wires).toHaveLength(2); // no stray segment
});

test('a tapped part opens the inspector for editing', async ({ page }) => {
  await page.tap('#rail .tool[data-t="R"]');
  const o = await canvasOrigin(page);
  await page.touchscreen.tap(o.x + 130, o.y + 130);

  await page.tap('#rail .tool[data-t="select"]');
  await page.touchscreen.tap(o.x + 130, o.y + 130);
  await expect(page.locator('#inspectorBody')).toContainText('Resistor');
  await expect(page.locator('#valInput')).toHaveValue('1 k');
});
