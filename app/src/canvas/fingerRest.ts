/**
 * Notice when a finger holding the page has come to rest.
 *
 * A finger that stays down without moving is a reader looking, not a gesture
 * about to start. `onRest` runs once the finger has stayed within `slopPx` of
 * where it last moved for `restMs`; `onResume` runs when a rested finger moves
 * past the slop again (and the rest timer restarts from there).
 */
export type FingerRest = {
  /** Finger down at (x, y). */
  start(x: number, y: number): void;
  /** Finger moved to (x, y). Jitter within the slop is ignored. */
  move(x: number, y: number): void;
  /** Finger up or gesture abandoned. */
  stop(): void;
  /** True between `onRest` and the next move, lift or stop. */
  readonly rested: boolean;
};

export function makeFingerRest(options: {
  restMs: number;
  slopPx: number;
  onRest: () => void;
  onResume: () => void;
}): FingerRest {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let anchor: { x: number; y: number } | null = null;
  let rested = false;
  const arm = (x: number, y: number) => {
    if (timer) clearTimeout(timer);
    anchor = { x, y };
    timer = setTimeout(() => {
      timer = null;
      rested = true;
      options.onRest();
    }, options.restMs);
  };
  return {
    start(x, y) {
      rested = false;
      arm(x, y);
    },
    move(x, y) {
      if (!anchor) return;
      if (Math.hypot(x - anchor.x, y - anchor.y) <= options.slopPx) return;
      if (rested) {
        rested = false;
        options.onResume();
      }
      arm(x, y);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      anchor = null;
      rested = false;
    },
    get rested() {
      return rested;
    },
  };
}
