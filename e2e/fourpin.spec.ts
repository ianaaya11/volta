// The four-terminal parts: dependent sources, transformer, relay — plus the DC
// motor, which is two-terminal but carries mechanical state.
//
// The engine's own stamps are covered by tests/controlled.test.ts and
// tests/transformer.test.ts. What's left, and what these check, is the editor
// half: that pin order on the symbol matches the node order the stamp expects,
// that a part expanding into several devices still reports one coherent set of
// node voltages, and that the state the SOLVER doesn't model — an armature
// position, a shaft speed — is integrated and fed back correctly.
import { test, expect, type Page } from '@playwright/test';

const GRID = 26, PAD = 40;   // an empty document fits to ox = oy = 40, scale 1

/** Clear to the known transform, then address the canvas in grid coordinates. */
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
    select: async (gx: number, gy: number) => {
      await page.click('#rail .tool[data-t="select"]');
      const p = at(gx, gy); await page.mouse.click(p.x, p.y);
    },
  };
}

/** Node voltages as the inspector shows them. */
async function nodeVolts(page: Page): Promise<string[]> {
  const rows = await page.locator('table.probes tr').all();
  const out: string[] = [];
  for (const r of rows) {
    const tds = await r.locator('td').allInnerTexts();
    if (tds.length >= 2) out.push(tds[1].trim());
  }
  return out;
}

test('every four-terminal part is on the rail and places cleanly', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  const g = await blankGrid(page);
  const added = ['E', 'G', 'F', 'H', 'XF', 'RLY', 'MOT'];
  for (const t of added) await expect(page.locator(`#rail .tool[data-t="${t}"]`)).toHaveCount(1);
  let gx = 0;
  for (const t of ['E', 'G', 'F', 'H', 'XF', 'RLY']) { await g.place(t, gx, 2); gx += 6; }
  await g.place('MOT', 0, 8);
  // Six four-pin parts and one two-pin one, none of them touching. The motor's
  // internal node is deliberately NOT counted: it isn't on the grid.
  await expect(page.locator('#nodeCount')).toHaveText('26 nodes');
  expect(errors).toEqual([]);
});

test('a VCVS placed on the canvas multiplies its input, pins in the drawn order', async ({ page }) => {
  const g = await blankGrid(page);
  // The control port is the LEFT pair and the output the RIGHT pair; getting
  // that backwards is the mistake this catches, and it would still "work"
  // electrically, just with the gain applied to the wrong port.
  await page.keyboard.press('r');
  await g.place('V', 0, 2);                    // (0,2)+ .. (0,4)−
  await page.keyboard.press('r'); await page.keyboard.press('r'); await page.keyboard.press('r');
  await g.place('E', 4, 3);                    // ctrl (4,2)/(4,4), out (8,2)/(8,4)
  await page.keyboard.press('r');
  await g.place('R', 8, 2);                    // (8,2)..(8,4) load across the output
  await g.place('GND', 0, 6);
  await g.wire([0, 2], [4, 2]);                // source + to ctrl+
  await g.wire([0, 4], [0, 6]);                // source − to ground
  await g.wire([4, 4], [0, 6]);                // ctrl − to ground
  await g.wire([8, 4], [0, 6]);                // out − to ground

  await page.click('#rail .tool[data-t="select"]');
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);
  // 5 V source, gain 2 (the default) -> 10 V out.
  const v = await nodeVolts(page);
  expect(v, JSON.stringify(v)).toContain('5 V');
  expect(v, JSON.stringify(v)).toContain('10 V');
});

test('the transformer example steps 10 V up to 20 V', async ({ page }) => {
  // Instantaneous values, deliberately: this checks that the two windings are
  // in step at every moment, which is a statement about the waveform and not
  // about its bounds. The readout defaults to steady figures — see
  // e2e/readings.spec.ts — so this asks for the live ones.
  await page.addInitScript(() => localStorage.setItem('volta.readMode', 'live'));
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'Transformer steps 10 V up to 20 V' });
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  // Both nodes are on the same sine, so their instantaneous ratio is the turns
  // ratio at any moment the primary isn't near a zero crossing.
  await expect.poll(async () => {
    const rows = await page.locator('table.probes tr').all();
    const v: number[] = [];
    for (const r of rows) {
      const tds = await r.locator('td').allInnerTexts();
      if (tds.length >= 2) v.push(parseFloat(tds[1]));
    }
    // rows are [node 0, node 1 = primary, node 2 = secondary]
    if (v.length < 3 || Math.abs(v[1]) < 3) return null;   // too near a crossing to divide
    return Math.abs(v[2] / v[1]);
  }, { message: 'secondary should sit at √(L2/L1) = 2× the primary' })
    .toBeGreaterThan(1.9);
});

test.describe('relay and motor', () => {
  // A 12 V supply. The button carries only coil current; the relay contact
  // carries the motor. Built by hand rather than loaded from the gallery so the
  // test knows exactly where every part is on screen.
  //
  //   (2,0)────────────────(10,0)          supply rail
  //     │                    │
  //   (2,2)─[PB]─(4,2)─(6,2)=coil+       contact A=(10,2)
  //     │                 coil−=(6,4)    contact B=(10,4)
  //   [12V]                  │              │
  //     │                    │            [MOT]
  //   (2,12)───────────────(10,12)         ground rail
  test.beforeEach(async ({ page }) => {
    const g = await blankGrid(page);
    await g.place('PB', 2, 2);
    await g.place('RLY', 6, 3);
    await page.keyboard.press('r');            // vertical from here on
    await g.place('V', 2, 4);
    await g.place('MOT', 10, 6);
    await g.place('GND', 2, 12);
    await g.wire([2, 6], [2, 12]);
    await g.wire([2, 4], [2, 2], [2, 0], [10, 0], [10, 2]);
    await g.wire([4, 2], [6, 2]);
    await g.wire([6, 4], [6, 12]);
    await g.wire([10, 4], [10, 6]);
    await g.wire([10, 8], [10, 12]);
    await g.wire([2, 12], [6, 12], [10, 12]);
    // ground, supply, coil+, motor+ — the motor's internal node stays hidden
    await expect(page.locator('#nodeCount')).toHaveText('4 nodes');
    await page.click('#rail .tool[data-t="select"]');
    // Default source value is 5 V; the relay needs more than that to pull in.
    const p = (await page.locator('#cv').boundingBox())!;
    await page.mouse.click(p.x + PAD + 2 * GRID, p.y + PAD + 5 * GRID);
    await expect(page.locator('#inspectorBody h3').first()).toHaveText('Voltage');
    await page.locator('#valInput').fill('12');
    await page.locator('#valInput').dispatchEvent('change');
  });

  test('the coil closes the contact, and only while it is energised', async ({ page }) => {
    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
    const at12 = async () => (await nodeVolts(page)).filter(v => v === '12 V').length;
    // Button open: only the supply is at the rail voltage.
    expect(await at12()).toBe(1);

    const box = (await page.locator('#cv').boundingBox())!;
    const btn = { x: box.x + PAD + 3 * GRID, y: box.y + PAD + 2 * GRID };  // PB centroid (3,2)
    await page.mouse.move(btn.x, btn.y);
    await page.mouse.down();
    // Supply, coil and motor terminal — the contact only closes once the coil
    // current has ramped past the pull-in threshold, so this needs a poll.
    await expect.poll(at12, { message: 'the relay should pull in' }).toBe(3);

    await page.mouse.up();
    await expect.poll(at12, { message: 'the relay should drop out' }).toBe(1);
  });

  test('the motor draws a stall current that falls as its back-EMF builds', async ({ page }) => {
    const box = (await page.locator('#cv').boundingBox())!;
    // Latch the button through the inspector rather than holding it on the
    // canvas: pressing it there would also SELECT it, and the live readout
    // would then be showing the coil instead of the motor.
    await page.mouse.click(box.x + PAD + 3 * GRID, box.y + PAD + 2 * GRID);
    await expect(page.locator('#inspectorBody h3').first()).toHaveText('Push button (NO)');
    await page.click('#contactBtn');

    // Now select the motor, so the inspector reads it out live.
    await page.mouse.click(box.x + PAD + 10 * GRID, box.y + PAD + 7 * GRID);
    await expect(page.locator('#inspectorBody h3').first()).toHaveText('DC motor');

    await page.click('#runBtn');
    await expect(page.locator('#runBtn')).toHaveText(/Stop/);
    // This test watches a number CHANGE, so it needs the live reading. The
    // readout defaults to steady figures — see e2e/readings.spec.ts — and
    // steady would report the whole fall as one band, "0 … 2.4 A", which is a
    // true description of the run and useless for detecting a fall within it.
    await page.click('[data-read="live"]');

    const amps = async () => {
      const t = await page.locator('#readoutHost .readout').innerText();
      const m = /Current\s+([-\d.]+)\s*(m|µ|n|k)?A/.exec(t);
      if (!m) return null;
      const scale = { m: 1e-3, 'µ': 1e-6, n: 1e-9, k: 1e3 }[m[2] ?? ''] ?? 1;
      return parseFloat(m[1]) * scale;
    };
    // Stalled, the only thing limiting current is the 5 Ω armature: 12/5 ≈ 2.4 A.
    await expect.poll(amps, { message: 'expected a stall current near 2.4 A' })
      .toBeGreaterThan(1.5);
    // As the shaft speeds up its back-EMF opposes the supply and the current
    // collapses. That can only happen if the mechanical state is being
    // integrated and written back into the circuit.
    await expect.poll(amps, { message: 'back-EMF should choke the current back', timeout: 20000 })
      .toBeLessThan(0.8);
  });
});
