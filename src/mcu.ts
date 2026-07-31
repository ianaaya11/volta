// ============================================================================
//  MCU CO-SIMULATION — run microcontroller code against the live analog sim
// ============================================================================
//  A small C-like language (the Arduino subset: setup/loop, int/float, if,
//  while, for, and the digital I/O builtins) tokenized, parsed and interpreted
//  here. No DOM, no engine import — the interpreter talks to the circuit only
//  through the McuHost interface, which is what lets it be tested standalone.
//
//  The hard requirement is that the program runs in SIMULATED time, not wall
//  time: `delay(500)` must block for 500 ms of circuit time, however fast or
//  slow the solver is actually running. So execution has to be resumable
//  mid-program across solver timesteps. That's why the evaluator is written as
//  generators — a `delay` yields out of arbitrarily deep recursion, the driver
//  parks it, and the next timestep resumes exactly where it left off.
// ============================================================================

export interface McuHost {
  /** Digital read of a pin, thresholded by the caller from the node voltage. */
  readPin(pin: number): boolean;
  /** Drive a pin high or low. */
  writePin(pin: number, high: boolean): void;
  /** Configure a pin as output (true) or high-impedance input (false). */
  setMode(pin: number, output: boolean): void;
  /** Simulated time in milliseconds since the run started. */
  nowMs(): number;
}

// ---- Tokenizer -------------------------------------------------------------
type TokKind = 'num' | 'id' | 'punct' | 'eof';
interface Tok { kind: TokKind; text: string; pos: number; line: number }

const KEYWORDS = new Set(['int', 'float', 'long', 'bool', 'void', 'if', 'else', 'while', 'for', 'return']);
const PUNCT = [
  '&&', '||', '==', '!=', '<=', '>=', '++', '--', '+=', '-=', '*=', '/=',
  '{', '}', '(', ')', ';', ',', '=', '<', '>', '+', '-', '*', '/', '%', '!',
];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j])) j++;
      out.push({ kind: 'num', text: src.slice(i, j), pos: i, line }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ kind: 'id', text: src.slice(i, j), pos: i, line }); i = j; continue;
    }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (!p) throw new McuError(`Unexpected character "${c}"`, line);
    out.push({ kind: 'punct', text: p, pos: i, line }); i += p.length;
  }
  out.push({ kind: 'eof', text: '', pos: i, line });
  return out;
}

export class McuError extends Error {
  constructor(msg: string, public line: number) { super(`line ${line}: ${msg}`); }
}

// ---- AST -------------------------------------------------------------------
type Expr =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string; line: number }
  | { k: 'call'; name: string; args: Expr[]; line: number }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'assign'; name: string; op: string; e: Expr; line: number };

type Stmt =
  | { k: 'decl'; name: string; e: Expr | null; line: number }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] | null }
  | { k: 'while'; cond: Expr; body: Stmt[] }
  | { k: 'for'; init: Stmt | null; cond: Expr | null; step: Stmt | null; body: Stmt[] }
  | { k: 'return' };

interface Program { globals: Stmt[]; setup: Stmt[]; loop: Stmt[] }

// ---- Parser (recursive descent) --------------------------------------------
function parse(src: string): Program {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const at = (t: string) => toks[p].text === t;
  const eat = (t: string) => { if (at(t)) { p++; return true; } return false; };
  const expect = (t: string) => {
    if (!eat(t)) throw new McuError(`expected "${t}" but found "${peek().text || 'end of file'}"`, peek().line);
  };
  const isType = () => ['int', 'float', 'long', 'bool'].includes(peek().text);

  function primary(): Expr {
    const t = peek();
    if (t.kind === 'num') { p++; return { k: 'num', v: parseFloat(t.text) }; }
    if (eat('(')) { const e = expression(); expect(')'); return e; }
    if (eat('!')) return { k: 'un', op: '!', e: unary() };
    if (eat('-')) return { k: 'un', op: '-', e: unary() };
    if (t.kind === 'id') {
      p++;
      if (eat('(')) {
        const args: Expr[] = [];
        if (!at(')')) { do { args.push(expression()); } while (eat(',')); }
        expect(')');
        return { k: 'call', name: t.text, args, line: t.line };
      }
      if (at('++') || at('--')) {
        const op = peek().text; p++;
        return { k: 'assign', name: t.text, op: op === '++' ? '+=' : '-=', e: { k: 'num', v: 1 }, line: t.line };
      }
      return { k: 'var', name: t.text, line: t.line };
    }
    throw new McuError(`unexpected "${t.text || 'end of file'}"`, t.line);
  }
  const unary = (): Expr => primary();

  // Precedence climbing: * / % > + - > comparisons > == != > && > ||
  const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
  function binary(level: number): Expr {
    if (level >= LEVELS.length) return unary();
    let l = binary(level + 1);
    while (LEVELS[level].includes(peek().text)) {
      const op = peek().text; p++;
      l = { k: 'bin', op, l, r: binary(level + 1) };
    }
    return l;
  }
  function expression(): Expr {
    const save = p;
    if (peek().kind === 'id') {
      const name = peek().text; const line = peek().line; p++;
      const op = peek().text;
      if (['=', '+=', '-=', '*=', '/='].includes(op)) { p++; return { k: 'assign', name, op, e: expression(), line }; }
      p = save;
    }
    return binary(0);
  }

  function block(): Stmt[] {
    if (eat('{')) {
      const out: Stmt[] = [];
      while (!at('}')) {
        if (peek().kind === 'eof') throw new McuError('missing "}"', peek().line);
        out.push(statement());
      }
      expect('}');
      return out;
    }
    return [statement()];
  }

  function simpleStatement(): Stmt {
    if (isType()) {
      p++;
      const t = peek();
      if (t.kind !== 'id') throw new McuError('expected a variable name', t.line);
      p++;
      const e = eat('=') ? expression() : null;
      return { k: 'decl', name: t.text, e, line: t.line };
    }
    return { k: 'expr', e: expression() };
  }

  function statement(): Stmt {
    const line = peek().line;
    if (eat('if')) {
      expect('('); const cond = expression(); expect(')');
      const then = block();
      const els = eat('else') ? block() : null;
      return { k: 'if', cond, then, else: els };
    }
    if (eat('while')) {
      expect('('); const cond = expression(); expect(')');
      return { k: 'while', cond, body: block() };
    }
    if (eat('for')) {
      expect('(');
      const init = at(';') ? null : simpleStatement(); expect(';');
      const cond = at(';') ? null : expression(); expect(';');
      const step = at(')') ? null : simpleStatement(); expect(')');
      return { k: 'for', init, cond, step, body: block() };
    }
    if (eat('return')) { if (!at(';')) expression(); expect(';'); return { k: 'return' }; }
    const s = simpleStatement();
    if (!eat(';')) throw new McuError(`expected ";" after this statement`, line);
    return s;
  }

  // Top level: globals plus the two well-known functions.
  const prog: Program = { globals: [], setup: [], loop: [] };
  while (peek().kind !== 'eof') {
    if (peek().text === 'void' || (isType() && toks[p + 2]?.text === '(')) {
      p++;
      const name = peek().text; const line = peek().line; p++;
      expect('('); expect(')');
      const body = block();
      if (name === 'setup') prog.setup = body;
      else if (name === 'loop') prog.loop = body;
      else throw new McuError(`only setup() and loop() are supported, not "${name}()"`, line);
      continue;
    }
    const s = simpleStatement();
    if (!eat(';')) throw new McuError('expected ";"', peek().line);
    prog.globals.push(s);
  }
  if (!prog.loop.length && !prog.setup.length) {
    throw new McuError('no setup() or loop() found — an Arduino sketch needs at least one', 1);
  }
  return prog;
}

// ---- Interpreter -----------------------------------------------------------
/** A yielded request to suspend. `ms` is a delay; `null` is just a step tick. */
type Yield = { ms: number } | null;

const CONSTS: Record<string, number> = { HIGH: 1, LOW: 0, OUTPUT: 1, INPUT: 0, INPUT_PULLUP: 2, true: 1, false: 0 };

export class Mcu {
  private prog: Program;
  private vars = new Map<string, number>();
  private gen: Generator<Yield, void, unknown> | null = null;
  private waitUntil = 0;
  /** Set when the program hits a runtime fault; execution stops. */
  error: string | null = null;

  constructor(source: string) { this.prog = parse(source); }

  reset(): void {
    this.vars.clear();
    this.gen = null;
    this.waitUntil = 0;
    this.error = null;
  }

  /**
   * Advance the program until it blocks on a delay or spends its step budget.
   * The budget is what keeps `while(1){}` from freezing the browser: the
   * program simply gets a slice of steps per timestep and resumes next time.
   */
  run(host: McuHost, budget = 4000): void {
    if (this.error) return;
    const now = host.nowMs();
    if (now < this.waitUntil) return;
    if (!this.gen) this.gen = this.main(host);
    try {
      for (let i = 0; i < budget; i++) {
        const r = this.gen.next();
        if (r.done) { this.gen = null; return; }
        const y = r.value;
        if (y && y.ms > 0) {
          this.waitUntil = host.nowMs() + y.ms;
          if (host.nowMs() < this.waitUntil) return;
        }
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private *main(host: McuHost): Generator<Yield, void, unknown> {
    for (const s of this.prog.globals) yield* this.stmt(s, host);
    for (const s of this.prog.setup) yield* this.stmt(s, host);
    // loop() runs forever, exactly as on hardware.
    for (;;) {
      for (const s of this.prog.loop) yield* this.stmt(s, host);
      yield null;                      // guarantee progress on an empty loop()
    }
  }

  private *stmt(s: Stmt, host: McuHost): Generator<Yield, void, unknown> {
    switch (s.k) {
      case 'decl':
        this.vars.set(s.name, s.e ? yield* this.eval(s.e, host) : 0);
        yield null; return;
      case 'expr':
        yield* this.eval(s.e, host); yield null; return;
      case 'if':
        if (yield* this.eval(s.cond, host)) { for (const t of s.then) yield* this.stmt(t, host); }
        else if (s.else) { for (const t of s.else) yield* this.stmt(t, host); }
        return;
      case 'while':
        while (yield* this.eval(s.cond, host)) {
          for (const t of s.body) yield* this.stmt(t, host);
          yield null;                  // a spin loop still yields to the solver
        }
        return;
      case 'for': {
        if (s.init) yield* this.stmt(s.init, host);
        while (s.cond ? yield* this.eval(s.cond, host) : true) {
          for (const t of s.body) yield* this.stmt(t, host);
          if (s.step) yield* this.stmt(s.step, host);
          yield null;
        }
        return;
      }
      case 'return': return;
    }
  }

  private *eval(e: Expr, host: McuHost): Generator<Yield, number, unknown> {
    switch (e.k) {
      case 'num': return e.v;
      case 'var': {
        if (e.name in CONSTS) return CONSTS[e.name];
        const v = this.vars.get(e.name);
        if (v === undefined) throw new McuError(`"${e.name}" is not defined`, e.line);
        return v;
      }
      case 'un': {
        const v = yield* this.eval(e.e, host);
        return e.op === '!' ? (v ? 0 : 1) : -v;
      }
      case 'bin': {
        const l = yield* this.eval(e.l, host);
        // Short-circuit, so `x != 0 && 100/x > 1` behaves as written.
        if (e.op === '&&') return l ? ((yield* this.eval(e.r, host)) ? 1 : 0) : 0;
        if (e.op === '||') return l ? 1 : ((yield* this.eval(e.r, host)) ? 1 : 0);
        const r = yield* this.eval(e.r, host);
        switch (e.op) {
          case '+': return l + r; case '-': return l - r;
          case '*': return l * r; case '/': return r === 0 ? 0 : l / r;
          case '%': return r === 0 ? 0 : l % r;
          case '==': return l === r ? 1 : 0; case '!=': return l !== r ? 1 : 0;
          case '<': return l < r ? 1 : 0; case '>': return l > r ? 1 : 0;
          case '<=': return l <= r ? 1 : 0; case '>=': return l >= r ? 1 : 0;
        }
        return 0;
      }
      case 'assign': {
        const rhs = yield* this.eval(e.e, host);
        const cur = this.vars.get(e.name) ?? 0;
        const v = e.op === '=' ? rhs
          : e.op === '+=' ? cur + rhs : e.op === '-=' ? cur - rhs
          : e.op === '*=' ? cur * rhs : (rhs === 0 ? cur : cur / rhs);
        this.vars.set(e.name, v);
        return v;
      }
      case 'call': {
        const a: number[] = [];
        for (const x of e.args) a.push(yield* this.eval(x, host));
        switch (e.name) {
          case 'pinMode': host.setMode(a[0], a[1] === 1); return 0;
          case 'digitalWrite': host.writePin(a[0], a[1] !== 0); return 0;
          case 'digitalRead': return host.readPin(a[0]) ? 1 : 0;
          case 'delay': yield { ms: a[0] }; return 0;
          case 'delayMicroseconds': yield { ms: a[0] / 1000 }; return 0;
          case 'millis': return Math.floor(host.nowMs());
          case 'micros': return Math.floor(host.nowMs() * 1000);
          case 'abs': return Math.abs(a[0]);
          case 'min': return Math.min(a[0], a[1]);
          case 'max': return Math.max(a[0], a[1]);
          case 'constrain': return Math.min(Math.max(a[0], a[1]), a[2]);
          default: throw new McuError(`unknown function "${e.name}()"`, e.line);
        }
      }
    }
  }
}

/** Parse-check a sketch without running it. Returns null when it's valid. */
export function checkSketch(src: string): string | null {
  try { new Mcu(src); return null; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
}
