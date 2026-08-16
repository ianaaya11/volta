// The traffic light sequencer.
//
// A 4-bit counter free-runs to 15, so a three-phase cycle has to reset itself,
// and the reset has to be decoded from BOTH bits — count 3 is Q0 AND Q1. Reset
// on Q1 alone and the counter only ever reaches 1: red, amber, red, amber, and
// green never appears at all. That is a mistake worth having a test for,
// because the circuit still looks entirely reasonable on the schematic.
import { test, expect, type Page } from '@playwright/test';

/** The three lamps sit in one column, six grid rows apart, and the example
 *  always loads at the same fit. If these ever drift the lamps simply never
 *  light and the test fails loudly, rather than measuring blank canvas. */
const LAMPS = [
  { name: 'red', x: 750, y: 192 },
  { name: 'amber', x: 750, y: 300 },
  { name: 'green', x: 750, y: 395 },
];
/** What follows what, forever. */
const NEXT: Record<string, string> = { red: 'amber', amber: 'green', green: 'red' };

/** How many pixels around a lamp are strongly its own colour.
 *
 *  A count, not a peak: a lit LED paints a filled glow disc of ~400 px, while
 *  the red-for-high-voltage wire running through the same box is a thin line
 *  worth a few dozen. Peak brightness cannot tell those apart; area can. */
const litness = (page: Page) => page.evaluate((L) => L.map(l => {
  const cv = document.getElementById('cv') as HTMLCanvasElement;
  const r = cv.getBoundingClientRect();
  const s = cv.width / r.width;                 // CSS px -> backing store px
  const half = Math.round(30 * s);
  const d = cv.getContext('2d')!
    .getImageData(Math.round(l.x * s) - half, Math.round(l.y * s) - half, half * 2, half * 2).data;
  let red = 0, amb = 0, grn = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    if (R > 200 && G < 120 && B < 120) red++;
    else if (R > 200 && G > 150 && B < 130) amb++;
    else if (G > 170 && R < 150 && B < 150) grn++;
  }
  return [red, amb, grn];
}), LAMPS);

test('the lamps take turns: red, amber, green, round again', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'Traffic light sequencer' });
  await page.click('#fitBtn');
  await page.click('#runBtn');

  const ON = 200;                        // a lit glow measures ~400; nothing else comes close
  const seen: string[] = [];
  const everLit = new Set<string>();

  // 1 Hz clock, three states: six seconds is two full laps whichever state the
  // counter happens to be in when Run is pressed.
  for (let t = 0; t < 40; t++) {
    await page.waitForTimeout(150);
    const counts = await litness(page);
    const lit = LAMPS.map((l, i) => counts[i][i] > ON ? l.name : null).filter(Boolean) as string[];

    // The decode is mutually exclusive by construction. Two lamps at once means
    // a gate is reading the wrong bit.
    expect(lit.length, `two lamps lit at t=${t}: ${lit}`).toBeLessThan(2);
    if (lit.length) {
      everLit.add(lit[0]);
      if (seen[seen.length - 1] !== lit[0]) seen.push(lit[0]);
    }
  }

  // The bit that fails when the reset is decoded from one bit instead of two:
  // the counter never reaches 2, and green is never featured.
  expect([...everLit].sort(), `only saw ${JSON.stringify(seen)}`)
    .toEqual(['amber', 'green', 'red']);

  // Two full laps, so this is a cycle and not a one-shot.
  expect(seen.length, `sequence was ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(4);

  // And they arrive in the right order, wherever the cycle was caught.
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i], `after ${seen[i - 1]} came ${seen[i]} (${JSON.stringify(seen)})`)
      .toBe(NEXT[seen[i - 1]]);
  }
});
