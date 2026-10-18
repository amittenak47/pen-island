import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { popPlacement } from "../util/popPlacement";

/**
 * Keeps a fixed-position notification next to its button on any screen.
 *
 * Measures the notification as rendered (it sizes to its text), places it with
 * `popPlacement`, and again on resize, scroll and when `content` changes (a
 * list opening). Hidden until the first measurement so it never flashes at
 * the wrong spot.
 */
export function usePopPlacement(
  trigger: RefObject<HTMLElement | null>,
  pop: RefObject<HTMLElement | null>,
  visible: boolean,
  content: unknown,
  prefer: "below" | "above" = "below",
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", top: 0, left: 0 });
  // The side is chosen when the notification opens and kept until it closes:
  // collapsing a list inside it must not make it jump to the other side.
  const side = useRef<"above" | "below" | null>(null);
  useLayoutEffect(() => {
    if (!visible) { side.current = null; setStyle({ visibility: "hidden", top: 0, left: 0 }); return; }
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      const box = pop.current?.getBoundingClientRect();
      if (!button || !box) return;
      const at = popPlacement(button, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight }, 8, 8, prefer, side.current ?? undefined);
      side.current = at.above ? "above" : "below";
      // Hold the edges that face the button: above it, the bottom edge; lined
      // up with its right edge, the right edge. A list opening or a width
      // animating inside then grows away from the button without being placed
      // again every frame.
      const vertical = at.above ? { bottom: window.innerHeight - (at.top + box.height) } : { top: at.top };
      const rightAligned = at.left + box.width >= button.right - 1;
      setStyle(rightAligned ? { ...vertical, right: window.innerWidth - (at.left + box.width) } : { ...vertical, left: at.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [trigger, pop, visible, content, prefer]);
  return style;
}
