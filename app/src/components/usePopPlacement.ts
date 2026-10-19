import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { popPlacement } from "../util/popPlacement";

/**
 * Keeps a fixed-position notification next to its button on any screen.
 *
 * Measures the notification as rendered (it sizes to its text), places it with
 * `popPlacement`, and again whenever its size changes (text changing, a width
 * sliding, a list folding open), on resize and on scroll. Hidden until the
 * first measurement so it never flashes at the wrong spot.
 *
 * The edge facing the button is what is held: below it, the top edge; above
 * it, the bottom edge. Growing or shrinking then happens away from the button,
 * and the notification never covers it. Taller than the room on its side, it
 * is capped there and scrolls.
 */
export function usePopPlacement(
  trigger: RefObject<HTMLElement | null>,
  pop: RefObject<HTMLElement | null>,
  visible: boolean,
  content: unknown,
  prefer: "below" | "above" = "below",
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>(HIDDEN);
  // The side is chosen when the notification opens and kept until it closes:
  // collapsing a list inside it must not make it jump to the other side.
  const side = useRef<"above" | "below" | null>(null);
  const last = useRef("");
  useLayoutEffect(() => {
    if (!visible) { side.current = null; last.current = ""; setStyle(HIDDEN); return; }
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      const el = pop.current;
      const box = el?.getBoundingClientRect();
      if (!button || !el || !box) return;
      // Its natural height, not the capped one, decides where it fits.
      const height = Math.max(box.height, el.scrollHeight);
      const view = { width: window.innerWidth, height: window.innerHeight };
      const at = popPlacement(button, { width: box.width, height }, view, GAP, 8, prefer, side.current ?? undefined);
      side.current = at.above ? "above" : "below";
      const vertical = at.above ? { bottom: view.height - (button.top - GAP) } : { top: at.top };
      // Lined up with the button's right edge: hold the right edge, so a
      // width sliding inside grows to the left, away from the window's edge.
      const rightAligned = at.left + box.width >= button.right - 1;
      const next: CSSProperties = {
        ...vertical,
        ...(rightAligned ? { right: view.width - (at.left + box.width) } : { left: at.left }),
        maxHeight: at.maxHeight,
        ...(height > at.maxHeight + 0.5 ? { overflowY: "auto" as const } : {}),
      };
      const key = JSON.stringify(next);
      if (key === last.current) return;
      last.current = key;
      setStyle(next);
    };
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (pop.current) observer?.observe(pop.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [trigger, pop, visible, content, prefer]);
  return style;
}

const GAP = 8;
const HIDDEN: CSSProperties = { visibility: "hidden", top: 0, left: 0 };
