// MCU interpreter — 14 checks, no circuit required.
// The host interface is the whole seam between the sketch and the analog
// engine, so a fake host here exercises the language, the pin I/O and — the
// part that actually matters — that the program runs in SIMULATED time and
// resumes correctly across timesteps.
import { describe, it, expect } from 'vitest';
import { Mcu, McuError, checkSketch, tokenize, type McuHost } from '../src/mcu';

/** A host with a clock the test drives by hand. */
function fakeHost() {
  const pins = new Map<number, boolean>();
  const modes = new Map<number, boolean>();
  const writes: { pin: number; high: boolean; at: number }[] = [];
  let t = 0;
  const host: McuHost = {
    readPin: p => pins.get(p) ?? false,
    writePin: (p, high) => { pins.set(p, high); writes.push({ pin: p, high, at: t }); },
    setMode: (p, out) => { modes.set(p, out); },
    nowMs: () => t,
  };
  return {
    host, writes, modes, pins,
    advance: (ms: number) => { t += ms; },
    get time() { return t; },
    setInput: (p: number, v: boolean) => pins.set(p, v),
  };
}

const BLINK = `
  int led = 13;
  void setup() { pinMode(led, OUTPUT); }
  void loop() {
    digitalWrite(led, HIGH);
    delay(500);
    digitalWrite(led, LOW);
    delay(500);
  }`;

describe('tokenizer and parser', () => {
  it('handles comments, floats and multi-character operators', () => {
    const toks = tokenize('a >= 1.5; // note\n/* block */ b++;');
    expect(toks.map(t => t.text)).toContain('>=');
    expect(toks.map(t => t.text)).toContain('++');
    expect(toks.some(t => t.text === 'note')).toBe(false);
  });

  it('reports the line number of a syntax error', () => {
    const err = checkSketch('void loop() {\n  int x = ;\n}');
    expect(err).toMatch(/line 2/);
  });

  it('rejects a sketch with neither setup() nor loop()', () => {
    expect(checkSketch('int x = 1;')).toMatch(/setup\(\) or loop\(\)/);
  });

  it('accepts a valid sketch', () => {
    expect(checkSketch(BLINK)).toBeNull();
  });
});

describe('language', () => {
  const runExpr = (body: string) => {
    const h = fakeHost();
    // Pin 0 carries the result out so the test can read it.
    const mcu = new Mcu(`void loop(){ ${body} delay(1000); }`);
    mcu.run(h.host);
    return h;
  };

  it('evaluates arithmetic with correct precedence', () => {
    const h = runExpr('int x = 2 + 3 * 4; digitalWrite(x, HIGH);');
    expect(h.writes[0].pin).toBe(14);
  });

  it('runs if/else', () => {
    const h = runExpr('int x = 5; if (x > 3) { digitalWrite(1, HIGH); } else { digitalWrite(2, HIGH); }');
    expect(h.writes.map(w => w.pin)).toEqual([1]);
  });

  it('runs for loops with compound assignment', () => {
    const h = runExpr('int n = 0; for (int i = 0; i < 4; i++) { n += 2; } digitalWrite(n, HIGH);');
    expect(h.writes[0].pin).toBe(8);
  });

  it('short-circuits && so the right side is not evaluated', () => {
    // If && evaluated eagerly, the unknown-variable lookup would throw.
    const h = fakeHost();
    const mcu = new Mcu('void loop(){ int x = 0; if (x != 0 && undefinedVar > 1) { } digitalWrite(7, HIGH); delay(100); }');
    mcu.run(h.host);
    expect(mcu.error).toBeNull();
    expect(h.writes[0].pin).toBe(7);
  });

  it('reports an undefined variable as a runtime error instead of crashing', () => {
    const h = fakeHost();
    const mcu = new Mcu('void loop(){ digitalWrite(nope, HIGH); delay(1); }');
    mcu.run(h.host);
    expect(mcu.error).toMatch(/not defined/);
  });

  it('reports an unknown function', () => {
    const h = fakeHost();
    const mcu = new Mcu('void loop(){ analogWrite(3, 128); delay(1); }');
    mcu.run(h.host);
    expect(mcu.error).toMatch(/unknown function "analogWrite\(\)"/);
  });
});

describe('pins and simulated time', () => {
  it('applies pinMode from setup()', () => {
    const h = fakeHost();
    new Mcu(BLINK).run(h.host);
    expect(h.modes.get(13)).toBe(true);
  });

  it('blinks on the simulated clock, not the wall clock', () => {
    const h = fakeHost();
    const mcu = new Mcu(BLINK);

    mcu.run(h.host);                       // setup + first write, then blocks
    expect(h.writes).toEqual([{ pin: 13, high: true, at: 0 }]);

    // Time has not advanced: re-running must not move the program on.
    mcu.run(h.host); mcu.run(h.host);
    expect(h.writes).toHaveLength(1);

    h.advance(499); mcu.run(h.host);       // still inside the delay
    expect(h.writes).toHaveLength(1);

    h.advance(1); mcu.run(h.host);         // 500 ms reached — pin goes low
    expect(h.writes[1]).toEqual({ pin: 13, high: false, at: 500 });

    h.advance(500); mcu.run(h.host);       // and the loop comes round again
    expect(h.writes[2]).toEqual({ pin: 13, high: true, at: 1000 });
  });

  it('reads inputs back from the circuit', () => {
    const h = fakeHost();
    const mcu = new Mcu(`
      void setup(){ pinMode(2, INPUT); pinMode(9, OUTPUT); }
      void loop(){ digitalWrite(9, digitalRead(2)); delay(10); }`);
    h.setInput(2, true);
    mcu.run(h.host);
    expect(h.writes.find(w => w.pin === 9)?.high).toBe(true);

    h.setInput(2, false); h.advance(10); mcu.run(h.host);
    expect(h.writes.filter(w => w.pin === 9).pop()?.high).toBe(false);
  });

  it('survives a spin loop instead of hanging', () => {
    // while(1){} would lock the browser without a step budget. The run must
    // return, having made progress but not finished.
    const h = fakeHost();
    const mcu = new Mcu('void loop(){ while (1) { } }');
    mcu.run(h.host, 500);
    expect(mcu.error).toBeNull();          // not an error — just not done
  });

  it('reset() returns the program to its starting state', () => {
    const h = fakeHost();
    const mcu = new Mcu(BLINK);
    mcu.run(h.host);
    h.advance(500); mcu.run(h.host);
    expect(h.writes).toHaveLength(2);

    mcu.reset();
    mcu.run(h.host);                       // starts from setup() again
    expect(h.writes[2].high).toBe(true);
  });
});

describe('McuError', () => {
  it('carries the line number for the editor to show', () => {
    try { new Mcu('void loop(){ int = 3; }'); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(McuError); expect((e as McuError).line).toBe(1); }
  });
});
