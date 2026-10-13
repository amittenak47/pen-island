/**
 * Drives the Home Whiteboard icon so the pencil tip follows the real stroke
 * geometry: it erases by tracing a stroke backwards and draws by tracing it
 * forwards. CSS only runs the resting idle loop; while this tracer works it
 * owns the nib transform and every stroke's dash offset through inline styles.
 */

/** The icon's viewBox is 0 0 24 24; the nib arm's origin is the pencil tip. */
const VIEW = 24;
/** Drawing speed in icon units per millisecond (a 10-unit stroke takes ~360ms). */
const DRAW_SPEED = 0.028;
/** Erasing is quicker than drawing, like a few firm passes of an eraser. */
const ERASE_SPEED = 0.05;
const LIFT_MS = 150;
const HOLD_MS = 1100;
/** Where the idle loop starts, so handing back to CSS doesn't jump. */
const PARK = { x: 16.2, y: 11.2, tilt: 18 };

type Point = { x: number; y: number };

export type WhiteboardTracer = {
  /** Erase what's on the page, then loop the hover drawings. */
  enter(): void;
  /** Erase what's on the page, draw the next resting sketch, then park. */
  leave(done: () => void): void;
  dispose(): void;
};

export function createWhiteboardTracer(card: HTMLElement): WhiteboardTracer | null {
  const arm = card.querySelector<SVGGElement>(".lc-home-nib-arm");
  const strokes = (selector: string) => [...card.querySelectorAll<SVGGeometryElement>(selector)];
  // Resting sketches in rotation (diagram, note, blank). A blank sketch has no
  // strokes; each leave draws the next sketch in the list.
  const sketches = [...card.querySelectorAll(".lc-home-wb-sketch")]
    .map(group => [...group.querySelectorAll<SVGGeometryElement>(".lc-home-trace")]);
  const rest = sketches.flat();
  const setA = strokes(".lc-home-wb-draw-a .lc-home-draw");
  const setB = strokes(".lc-home-wb-draw-b .lc-home-draw");
  if (!arm || !sketches.length || !setA.length || !setB.length) return null;
  const all = [...rest, ...setA, ...setB];
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let sketch = 0;

  // Fraction of each stroke currently on the page. The first sketch starts drawn.
  const drawn = new Map<SVGGeometryElement, number>(all.map(el => [el, sketches[0]!.includes(el) ? 1 : 0]));
  // Strokes in the order they went onto the page, so erasing runs in reverse.
  let onPage: SVGGeometryElement[] = [...sketches[0]!];
  let tip: Point = { x: PARK.x, y: PARK.y };
  let tilt = PARK.tilt;
  let run = 0;
  let raf = 0;

  const length = (el: SVGGeometryElement) => {
    try { return el.getTotalLength(); } catch { return 0; }
  };
  const pointAt = (el: SVGGeometryElement, fraction: number): Point => {
    try {
      const p = el.getPointAtLength(length(el) * fraction);
      return { x: p.x, y: p.y };
    } catch { return tip; }
  };

  function pose(point: Point, angle: number) {
    tip = point;
    tilt = angle;
    arm!.style.animation = "none";
    arm!.style.transition = "none";
    arm!.style.transform =
      `translate(${(point.x / VIEW * 100).toFixed(3)}%, ${(point.y / VIEW * 100).toFixed(3)}%) rotate(${angle.toFixed(1)}deg)`;
  }

  function setDrawn(el: SVGGeometryElement, fraction: number) {
    drawn.set(el, fraction);
    el.style.animation = "none";
    el.style.strokeDashoffset = (1 - fraction).toFixed(4);
    el.style.opacity = fraction > 0.001 ? "1" : "0";
  }

  /** Runs `step(t)` for t in 0..1 over `ms`; resolves false if superseded. */
  function tween(id: number, ms: number, step: (t: number) => void): Promise<boolean> {
    return new Promise(resolve => {
      let start: number | null = null;
      const frame = (now: number) => {
        if (id !== run) return resolve(false);
        start ??= now;
        const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
        step(t);
        if (t >= 1) return resolve(true);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });
  }

  const ease = (t: number) => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

  /** Lifted move between strokes: no ink, eased, with a slight lift in tilt. */
  function liftTo(id: number, to: Point, toTilt: number) {
    const from = tip, fromTilt = tilt;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < 0.05) return Promise.resolve(id === run);
    return tween(id, LIFT_MS + distance * 12, t => {
      const e = ease(t);
      pose({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e },
        fromTilt + (toTilt - fromTilt) * e - Math.sin(Math.PI * t) * 10);
    });
  }

  /** Moves the tip along `el` from one drawn fraction to another. */
  async function trace(id: number, el: SVGGeometryElement, from: number, to: number) {
    const units = length(el) * Math.abs(to - from);
    const speed = to > from ? DRAW_SPEED : ERASE_SPEED;
    const wobble = to > from ? 6 : 10;
    if (!(await liftTo(id, pointAt(el, from), 14))) return false;
    return tween(id, Math.max(90, units / speed), t => {
      const fraction = from + (to - from) * t;
      setDrawn(el, fraction);
      pose(pointAt(el, fraction), 14 + Math.sin(t * Math.PI * (to > from ? 3 : 7)) * wobble);
    });
  }

  async function eraseAll(id: number) {
    for (const el of [...onPage].reverse()) {
      const current = drawn.get(el) ?? 0;
      if (current > 0.001 && !(await trace(id, el, current, 0))) return false;
      onPage = onPage.filter(other => other !== el);
    }
    // Anything partly drawn when a sequence was interrupted.
    for (const el of all) if ((drawn.get(el) ?? 0) > 0.001) setDrawn(el, 0);
    return true;
  }

  async function drawAll(id: number, group: SVGGeometryElement[]) {
    for (const el of group) {
      if (!onPage.includes(el)) onPage.push(el);
      if (!(await trace(id, el, drawn.get(el) ?? 0, 1))) return false;
    }
    return true;
  }

  const hold = (id: number, ms: number) => tween(id, ms, () => {});

  function begin() {
    cancelAnimationFrame(raf);
    // Freeze the idle pose (CSS may be mid-loop) so the first lift starts there.
    if (arm!.style.transform === "" && typeof DOMMatrixReadOnly !== "undefined") {
      try {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(arm!).transform);
        tip = { x: matrix.e, y: matrix.f };
        tilt = Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
      } catch { /* keep the last known pose */ }
    }
    return ++run;
  }

  function snap(group: SVGGeometryElement[]) {
    for (const el of all) setDrawn(el, group.includes(el) ? 1 : 0);
    onPage = [...group];
  }

  function release() {
    // Back to the stylesheet for the hover strokes and the idle nib. Resting
    // strokes keep their inline state, so the sketch just drawn stays shown.
    for (const el of [...setA, ...setB]) {
      el.style.animation = "";
      el.style.strokeDashoffset = "";
      el.style.opacity = "";
    }
    arm!.style.animation = "";
    arm!.style.transition = "";
    arm!.style.transform = "";
  }

  return {
    enter() {
      const id = begin();
      if (reduced()) { snap(setA); return; }
      void (async () => {
        if (!(await eraseAll(id))) return;
        for (;;) {
          for (const group of [setA, setB]) {
            if (!(await drawAll(id, group))) return;
            if (!(await hold(id, HOLD_MS))) return;
            if (!(await eraseAll(id))) return;
          }
        }
      })();
    },
    leave(done) {
      const id = begin();
      const next = (sketch + 1) % sketches.length;
      if (reduced()) { sketch = next; snap(sketches[next]!); release(); done(); return; }
      void (async () => {
        if (!(await eraseAll(id))) return;
        sketch = next;
        if (!(await drawAll(id, sketches[next]!))) return;
        if (!(await liftTo(id, { x: PARK.x, y: PARK.y }, PARK.tilt))) return;
        release();
        done();
      })();
    },
    dispose() {
      run++;
      cancelAnimationFrame(raf);
    },
  };
}
