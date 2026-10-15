/**
 * Drag a horizontal strip with a mouse or pen, and let a flick glide.
 *
 * Fingers already scroll natively (`touch-action: pan-x`), but a mouse or a
 * stylus press on the strip is just a press: the filmstrip could only be
 * moved with a wheel. Here a press that travels past a few pixels becomes a
 * drag, and letting go while moving keeps the strip gliding to a stop. A
 * press that doesn't travel stays a click, so a thumbnail still opens its
 * page; a drag never opens the thumbnail it ends on.
 */

/** Pixels a press must travel before it is a drag rather than a click. */
export const DRAG_SCROLL_THRESHOLD = 6;
/** Velocity kept per millisecond of glide (0.995^16 ≈ 0.92 per frame). */
const GLIDE_KEEP_PER_MS = 0.995;
/** Glides below this speed (px/ms) stop. */
const GLIDE_STOP = 0.02;
/** Only the last stretch of a drag sets the release speed. */
const VELOCITY_WINDOW_MS = 80;

/** One glide step: the distance to move and the speed left after `dt` ms. */
export function glideStep(velocity: number, dt: number): { dx: number; velocity: number } {
  const next = velocity * GLIDE_KEEP_PER_MS ** dt;
  return { dx: ((velocity + next) / 2) * dt, velocity: Math.abs(next) < GLIDE_STOP ? 0 : next };
}

/** Release speed (px/ms) from recent samples, newest last. */
export function releaseVelocity(samples: ReadonlyArray<{ x: number; t: number }>): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? samples[0]!;
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export function attachDragScroll(
  strip: HTMLElement,
  reducedMotion: () => boolean = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
): () => void {
  let press: { id: number; x: number; scroll: number; dragging: boolean; samples: { x: number; t: number }[] } | null = null;
  let glide = 0;
  let swallowClick = false;

  const stopGlide = () => {
    if (glide) cancelAnimationFrame(glide);
    glide = 0;
  };
  const startGlide = (velocity: number) => {
    let speed = velocity;
    let last = performance.now();
    const step = (now: number) => {
      const next = glideStep(speed, Math.min(now - last, 50));
      last = now;
      speed = next.velocity;
      const before = strip.scrollLeft;
      strip.scrollLeft -= next.dx;
      // Stopped, or pinned at an end.
      if (speed === 0 || strip.scrollLeft === before) { glide = 0; return; }
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  };

  const onDown = (event: PointerEvent) => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    stopGlide();
    press = { id: event.pointerId, x: event.clientX, scroll: strip.scrollLeft, dragging: false, samples: [{ x: event.clientX, t: event.timeStamp }] };
  };
  const onMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.x;
    if (!press.dragging) {
      if (Math.abs(dx) < DRAG_SCROLL_THRESHOLD) return;
      press.dragging = true;
      try { strip.setPointerCapture(event.pointerId); } catch { /* the press may already be over */ }
    }
    event.preventDefault();
    strip.scrollLeft = press.scroll - dx;
    press.samples.push({ x: event.clientX, t: event.timeStamp });
    if (press.samples.length > 12) press.samples.shift();
  };
  const onUp = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    const ended = press;
    press = null;
    if (!ended.dragging) return;
    swallowClick = true;
    try { strip.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    const velocity = event.type === "pointercancel" ? 0 : releaseVelocity(ended.samples);
    if (velocity !== 0 && !reducedMotion()) startGlide(velocity);
  };
  // The click a drag ends with is not a tap on the thumbnail under it.
  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  strip.addEventListener("pointerdown", onDown);
  strip.addEventListener("pointermove", onMove);
  strip.addEventListener("pointerup", onUp);
  strip.addEventListener("pointercancel", onUp);
  strip.addEventListener("click", onClick, true);
  return () => {
    stopGlide();
    strip.removeEventListener("pointerdown", onDown);
    strip.removeEventListener("pointermove", onMove);
    strip.removeEventListener("pointerup", onUp);
    strip.removeEventListener("pointercancel", onUp);
    strip.removeEventListener("click", onClick, true);
  };
}
