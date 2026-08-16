// Exporting a netlist for KiCad.
//
// The unit tests in tests/netlist.test.ts check the netlist itself, byte for
// byte. What is left to prove here is the wiring between the app and that pure
// function: that the node numbers reaching the exporter are the ones the solver
// used, and that the report is shown BEFORE the download rather than after.
//
// That ordering is the whole design. A netlist that looks complete but quietly
// dropped half a board is worse than no export at all, so the honest account of
// what did not survive has to arrive while the user can still act on it.
import { test, expect } from '@playwright/test';

test('the report names what could not be carried across', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'Traffic light sequencer' });
  await page.click('#pcbBtn');
  await expect(page.locator('#pcbReport table')).toBeVisible();

  const report = (await page.locator('#pcbReport').textContent())!.replace(/\s+/g, ' ');
  // The digital parts are the ones that cannot become a board on their own.
  expect(report).toMatch(/behavioural/);
  expect(report).toMatch(/no VCC or GND pin/);
  expect(report).toMatch(/decoupling/);
  // A counter is named, with a chip suggested rather than chosen.
  expect(report).toMatch(/74HC161|CD4017/);
  // Footprints are never presented as settled.
  expect(report).toMatch(/through-hole defaults/);
});

test('an analog circuit exports clean, and says so', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'RC low-pass (transient)' });
  await page.click('#pcbBtn');
  await expect(page.locator('#pcbReport')).toBeVisible();
  const report = (await page.locator('#pcbReport').textContent())!.replace(/\s+/g, ' ');
  // R and C are real parts; only the bench supply and the ground symbol need
  // explaining. Nothing here needs a chip chosen.
  expect(report).not.toMatch(/behavioural/);
  expect(report).toMatch(/supply is not a component|2-pin/);
});

test('the file that downloads is a netlist matching the circuit', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#gallery', { label: 'RC low-pass (transient)' });
  await page.click('#pcbBtn');
  await expect(page.locator('#pcbDownload')).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#pcbDownload'),
  ]);
  expect(download.suggestedFilename()).toBe('volta-circuit.net');

  const stream = await download.createReadStream();
  const text = await new Promise<string>((resolve, reject) => {
    let s = '';
    stream.on('data', (c: Buffer) => { s += c.toString(); });
    stream.on('end', () => resolve(s));
    stream.on('error', reject);
  });

  // A KiCad netlist, with the parts the RC example actually contains.
  expect(text.startsWith('(export (version "E")')).toBe(true);
  expect(text).toContain('(tool "Volta live circuit simulator")');
  expect(text).toContain('(ref "R1")');
  expect(text).toContain('(ref "C1")');
  expect(text).toContain('(name "GND")');
  // Balanced s-expressions, or KiCad will not open it.
  expect((text.match(/\(/g) ?? []).length).toBe((text.match(/\)/g) ?? []).length);

  // The resistor and capacitor share a node, because that is what an RC is.
  const rNets = [...text.matchAll(/\(net .*?\n((?:      \(node[^\n]*\n)+)/g)]
    .map(m => m[1]).filter(b => b.includes('"R1"') && b.includes('"C1"'));
  expect(rNets.length, 'R1 and C1 should meet on a node').toBeGreaterThan(0);

  await expect(page.locator('#pcbModal')).toBeHidden();
});
