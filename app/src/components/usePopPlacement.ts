import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

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
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!visible) { setStyle({ visibility: "hidden", top: 0, left: 0 }); return; }
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      const box = pop.current?.getBoundingClientRect();
      if (!button || !box) return;
      const at = popPlacement(button, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
      setStyle({ top: at.top, left: at.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [trigger, pop, visible, content]);
  return style;
}
