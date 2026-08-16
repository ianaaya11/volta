// The traffic light sequencer.
//
// Two mistakes are baked into this circuit as things NOT to do, because an LLM
// asked for a traffic light makes both of them and the schematic looks fine
// either way:
//
//   The reset. CNT4 free-runs to 15, so the cycle has to reset itself, decoded
//   from every bit high in the state it stops at. Decode count 3 as Q1 alone
//   and the counter never passes 1 — red, amber, red, amber, no green.
//
//   The timing. One count per phase gives every phase the same length, which no
//   real light has. Decoding RANGES off the counter's high bits costs no extra
//   gates and gives red 4 ticks, green 4, amber 1.
//
// These assert on the solver rather than on pixels. A wire at 5 V is exactly as
// red as a lit red LED, and earlier attempts to separate them by thresholding
// canvas pixels reported the lamps permanently on, then permanently wrong.
import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

/** Which LEDs are passing real forward current, right now. */
const litNow = (page: Page) => page.evaluate(() => {
  const v = (window as unknown as { __volta: {
    comps: () => { id: string; type: string; color?: string }[];
    currents: () => Record<string, number>;
  } }).__volta;
  const hue = new Map(v.comps().filter(c => c.type === 'LED').map(c => [c.id, c.color ?? 'red']));
  const cur = v.currents();
  return [...hue].filter(([id]) => Math.abs(cur[id] ?? 0) > 1e-3).map(([, c]) => c);
});

test('red, green, amber — in that order, and amber is the brief one', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'Traffic light sequencer' });
  await page.click('#fitBtn');
  await page.click('#runBtn');

  // A full lap is 9 ticks at 1 Hz. Twenty seconds is two whole laps, which
  // matters for the timing check below: the first and last phases are clipped
  // by when sampling started and stopped, so only a second lap guarantees a
  // complete run of every colour to measure.
  const runs: [string, number][] = [];
  for (let t = 0; t < 200; t++) {
    await page.waitForTimeout(100);
    const lit = await litNow(page);

    // The decode is mutually exclusive by construction; two lamps at once means
    // a gate is reading the wrong bit.
    expect(lit.length, `two lamps lit at t=${t}: ${lit}`).toBeLessThan(2);
    const now = lit[0] ?? '-';
    if (runs.length && runs[runs.length - 1][0] === now) runs[runs.length - 1][1]++;
    else runs.push([now, 1]);
  }

  const phases = runs.filter(([n]) => n !== '-');
  const order = phases.map(([n]) => n);
  expect(new Set(order), `only saw ${JSON.stringify(order)}`)
    .toEqual(new Set(['red', 'green', 'yellow']));

  // Round again, not a one-shot.
  expect(order.length, `sequence was ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(4);

  // The order a real light uses: amber belongs between green and red, never
  // between red and green.
  // 'yellow' is the LED's colour; 'amber' is what the phase is called.
  const NEXT: Record<string, string> = { red: 'green', green: 'yellow', yellow: 'red' };
  for (let i = 1; i < order.length; i++) {
    expect(order[i], `after ${order[i - 1]} came ${order[i]} (${JSON.stringify(order)})`)
      .toBe(NEXT[order[i - 1]]);
  }

  // The timing. Only complete runs count — the first and last are clipped by
  // when sampling started and stopped.
  const whole = phases.slice(1, -1);
  const longest = (n: string) =>
    Math.max(...whole.filter(([p]) => p === n).map(([, k]) => k), 0);
  expect(longest('yellow'), `phase lengths: ${JSON.stringify(whole)}`).toBeGreaterThan(0);
  expect(longest('yellow') * 2).toBeLessThan(longest('red'));
  expect(longest('yellow') * 2).toBeLessThan(longest('green'));
});
