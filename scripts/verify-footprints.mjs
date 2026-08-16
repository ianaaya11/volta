#!/usr/bin/env node
// ============================================================================
//  VERIFY THE FOOTPRINTS — against KiCad's real library
// ============================================================================
//  The footprint names in src/netlist.ts are the one part of the exporter that
//  cannot be checked by reading the code: they are strings naming files in
//  somebody else's repository. A wrong one is plausible, correctly formed, and
//  only discovered when a user imports the netlist and KiCad cannot find it.
//
//  The first draft of that table contained exactly such a name — an inductor
//  footprint that does not exist. This is why the script is here.
//
//  Run:  node scripts/verify-footprints.mjs
//
//  Checks every "Library:Footprint" in the table against
//  github.com/KiCad/kicad-footprints, where each lives at
//  <Library>.pretty/<Footprint>.kicad_mod. Needs a network; no credentials.
// ============================================================================
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/netlist.ts', import.meta.url);
const REPO = 'https://api.github.com/repos/KiCad/kicad-footprints/contents';

// Library names contain dots (Connector_PinHeader_2.54mm), so the library half
// has to allow them too — the split is on the FIRST colon.
const names = [...new Set(
  [...readFileSync(SRC, 'utf8').matchAll(/'([A-Za-z0-9_.]+:[A-Za-z0-9_.-]+)'/g)].map(m => m[1]),
)].sort();

if (!names.length) {
  console.error('No footprints found in src/netlist.ts — has the table moved?');
  process.exit(1);
}

let bad = 0;
for (const name of names) {
  const i = name.indexOf(':');
  const lib = name.slice(0, i), fp = name.slice(i + 1);
  const url = `${REPO}/${encodeURIComponent(lib)}.pretty/${encodeURIComponent(fp)}.kicad_mod`;
  let ok = false;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'volta-footprint-check' } });
    ok = r.ok;
    if (r.status === 403) {
      console.error('GitHub rate-limited this check. Try again shortly.');
      process.exit(2);
    }
  } catch (e) {
    console.error(`  could not reach GitHub: ${e.message}`);
    process.exit(2);
  }
  console.log(`${ok ? '  ok    ' : '  MISSING'} ${name}`);
  if (!ok) bad++;
}

console.log(`\n${names.length - bad}/${names.length} footprints exist in KiCad's library.`);
if (bad) {
  console.error('\nA missing footprint means KiCad cannot place that part on import.');
  console.error('Find the real name in the library and correct src/netlist.ts.');
  process.exit(1);
}
