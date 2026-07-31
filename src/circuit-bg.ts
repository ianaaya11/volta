// ============================================================================
//  CIRCUIT BACKDROP — the app's own circuits, drawing themselves
// ============================================================================
//  Every figure on the Commons page is one of the built-in gallery examples:
//  the RC low-pass, the 555 astable, the common-emitter amp, the counter and
//  the rest. They are drawn by the editor's own symbol code, so the backdrop is
//  literally the thing the app makes.
//
//  This module used to generate circuits procedurally — a mesh with parts
//  scattered around it. That produced figures that read as circuits to the eye
//  and as nonsense to anyone who could actually read one: two sources in a
//  single loop, a switch in series with nothing. Borrowing the real documents
//  is less code AND cannot produce a circuit that would not solve.
//
//  What is left here is placement and timing: where each figure goes, how fast
//  the pen moves, how long current runs before it fades.
// ============================================================================

const STEP_MS = 90;           // one tick of the pen
const BUILD_TICKS = 34;       // ticks to lay a whole circuit down
const LIVE_TICKS = 90;        // how long current runs once it is complete
const FADE_TICKS = 26;
const MAX_FIGURES = 6;
const MARGIN = 26;            // keep figures clear of each other

/** The document shape is opaque here — main.ts owns it and does the drawing. */
export interface BackdropApi {
  docs: unknown[];
  bounds(doc: unknown): { w: number; h: number };
  draw(ctx: CanvasRenderingContext2D, doc: unknown,
       ox: number, oy: number, reveal: number, flow: number): void;
}

interface Figure {
  doc: unknown;
  x: number; y: number; w: number; h: number;
  phase: 'build' | 'live' | 'fade';
  ticks: number;
  flow: number;
}

export function startCircuitBackdrop(canvas: HTMLCanvasElement, api: BackdropApi): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx || !api.docs.length) return () => {};

  let W = 0, H = 0;
  let figures: Figure[] = [];

  // Walk the examples as a shuffled bag rather than picking at random, so the
  // same circuit does not turn up three times on one screen.
  let bag: unknown[] = [];
  const nextDoc = (): unknown => {
    if (!bag.length) {
      bag = api.docs.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  };

  /** Find somewhere clear for the next circuit, or decline. */
  function place(): Figure | null {
    const doc = nextDoc();
    const { w, h } = api.bounds(doc);
    if (w <= 0 || h <= 0 || w > W || h > H) return null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = Math.random() * (W - w);
      const y = Math.random() * (H - h);
      const clash = figures.some(f =>
        x - MARGIN < f.x + f.w && x + w + MARGIN > f.x &&
        y - MARGIN < f.y + f.h && y + h + MARGIN > f.y);
      // Declining beats forcing an overlap: two circuits drawn on top of each
      // other read as one unreadable tangle, and the count then settles at
      // whatever the page genuinely fits.
      if (!clash) return { doc, x, y, w, h, phase: 'build', ticks: 0, flow: 0 };
    }
    return null;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = r.width; H = r.height;
    figures = [];
  }

  function tick() {
    const c = ctx!;
    c.clearRect(0, 0, canvas.width, canvas.height);

    // One per tick: placing the whole set at once means later figures must
    // dodge earlier ones chosen the same instant, and the last has nowhere left.
    if (figures.length < MAX_FIGURES) {
      const f = place();
      if (f) { f.ticks = -Math.floor(Math.random() * 30); figures.push(f); }
    }

    for (const f of figures) {
      f.ticks++;
      if (f.ticks < 0) continue;
      let reveal = 1, alpha = 1;
      if (f.phase === 'build') {
        reveal = Math.min(1, f.ticks / BUILD_TICKS);
        if (f.ticks >= BUILD_TICKS) { f.phase = 'live'; f.ticks = 0; }
      } else if (f.phase === 'live') {
        f.flow += 1.1;
        if (f.ticks > LIVE_TICKS) { f.phase = 'fade'; f.ticks = 0; }
      } else {
        f.flow += 1.1;
        alpha = Math.max(0, 1 - f.ticks / FADE_TICKS);
      }
      c.globalAlpha = alpha;
      api.draw(c, f.doc, f.x, f.y, reveal, f.phase === 'build' ? 0 : f.flow);
      c.globalAlpha = 1;
    }
    figures = figures.filter(f => !(f.phase === 'fade' && f.ticks > FADE_TICKS));
  }

  let raf = 0, last = 0, stopped = false;
  function frame(t: number) {
    if (stopped) return;
    if (t - last >= STEP_MS) { last = t; tick(); }
    raf = requestAnimationFrame(frame);
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();

  // Reduced motion still gets circuits, just finished ones sitting still.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (let i = 0; i < 220; i++) tick();
  } else {
    raf = requestAnimationFrame(frame);
  }

  return () => { stopped = true; cancelAnimationFrame(raf); ro.disconnect(); };
}
