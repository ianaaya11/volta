// MCU co-simulation, end to end in the browser.
// The interpreter is unit-tested against a fake host; what these cover is the
// part that only exists once it's wired to the solver — a pin written by the
// sketch actually driving the network, and the sketch surviving save/share.
import { test, expect, type Page } from '@playwright/test';

async function loadBlink(page: Page) {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'MCU: blinking LED' });
}

/** Node voltages seen in the live readout over `ms` of watching. */
async function sampleVoltages(page: Page, ms: number): Promise<string[]> {
  const seen = new Set<string>();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    seen.add((await page.locator('table.probes').innerText()).replace(/\s+/g, ' '));
    await page.waitForTimeout(120);
  }
  return [...seen];
}

test('the blink sketch ships with the example and compiles', async ({ page }) => {
  await loadBlink(page);
  await page.click('#codeBtn');
  await expect(page.locator('#codeSrc')).toHaveValue(/digitalWrite\(led, HIGH\)/);
  await expect(page.locator('#codeSrc')).toHaveValue(/delay\(500\)/);
  await page.click('#codeClose');
});

test('the sketch drives the pin, and the circuit responds', async ({ page }) => {
  await loadBlink(page);
  await page.click('#runBtn');
  await expect(page.locator('#runBtn')).toHaveText(/Stop/);

  // Over a couple of blink periods the pin must be seen both high and low —
  // that is the whole claim: firmware state reaching the analog solver.
  const samples = await sampleVoltages(page, 3000);
  const joined = samples.join(' | ');
  expect(joined).toMatch(/5 V/);        // pin driven high
  expect(joined).toMatch(/ 0V/);        // and low again
  // The LED's forward drop only exists because the solver ran the diode model.
  expect(joined).toMatch(/\d+ mV/);
});

test('a compile error is reported instead of failing silently', async ({ page }) => {
  await page.goto('/');
  await page.click('#codeBtn');
  await page.fill('#codeSrc', 'void loop() { digitalWrite(13 HIGH); }');
  await page.click('#codeSave');
  await expect(page.locator('#codeStatus')).toContainText(/error/i);
  await expect(page.locator('#codeStatus')).toContainText(/line 1/);
});

test('an unknown function is reported as a runtime fault, not a crash', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.click('#codeBtn');
  await page.fill('#codeSrc', 'void loop(){ analogWrite(3, 128); delay(10); }');
  await page.click('#codeSave');
  await page.click('#codeClose');
  await page.waitForTimeout(600);
  await expect(page.locator('#hint')).toContainText(/unknown function/i);
  expect(errors).toEqual([]);           // reported, not thrown
});

test('the sketch travels with the circuit through Share', async ({ page }) => {
  await loadBlink(page);
  await page.click('#shareBtn');
  const hash = await page.evaluate(() => location.hash);
  const model = await page.evaluate(
    (code: string) => JSON.parse(decodeURIComponent(escape(atob(code)))),
    hash.replace(/^#c=/, ''));
  expect(model.sketch).toMatch(/digitalWrite/);

  // A fresh load of that link restores the firmware alongside the schematic.
  await page.goto('/' + hash);
  await page.click('#codeBtn');
  await expect(page.locator('#codeSrc')).toHaveValue(/digitalWrite\(led, HIGH\)/);
});
