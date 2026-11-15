/** Touch origins survive a page corner consuming its first pointerdown. */
const touches = new Map<number, { x: number; y: number; target: EventTarget | null }>();

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY, target: event.target });
    }
  }, true);
  window.addEventListener("pointermove", event => {
    const touch = touches.get(event.pointerId);
    if (touch) { touch.x = event.clientX; touch.y = event.clientY; }
  }, true);
  const release = (event: PointerEvent) => {
    // Page turns send a synthetic cancel to stop one-finger handlers. The
    // finger is still down, and remains available to start a pinch.
    if (event.type === "pointerup" || event.isTrusted) touches.delete(event.pointerId);
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", () => touches.clear());
}

export function touchPointersIn(root: Element): Map<number, { x: number; y: number }> {
  return new Map([...touches].filter(([, touch]) => touch.target instanceof Node && root.contains(touch.target))
    .map(([id, touch]) => [id, { x: touch.x, y: touch.y }]));
}

/**
 * Bring a handler's own list of the fingers down on `root` in line with the
 * ones really down.
 *
 * A handler on an element misses a lift that a window listener kept to
 * itself: a page turn lining up a flick behind the one going over. That
 * finger stayed on the handler's list, and the next touch counted as a
 * second finger: a pinch began, moved the page, and, its own lift kept away
 * too, never ended, so pages stopped turning. The list here always sees the
 * lift (it listens first, on the window).
 */
export function syncTouchPointers(own: Map<number, { x: number; y: number }>, root: Element): void {
  const live = touchPointersIn(root);
  for (const id of [...own.keys()]) if (!live.has(id)) own.delete(id);
  for (const [id, touch] of live) own.set(id, touch);
}
