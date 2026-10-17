import { useLayoutEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent } from "react";

/** Open-sheet floor: grab bar, presets, and a usable composer — not a clipped stub. */
export const AGENT_SHEET_MIN_PX = 400;

export function settleSheetHeight(height: number, available: number, initial: number, snap: boolean): number {
  const min = Math.min(AGENT_SHEET_MIN_PX, available);
  const clamped = Math.max(min, Math.min(available, height));
  if (!snap) return clamped;
  const stops = [initial, available * .25, available * .5, available * .75].map(n => Math.max(min, Math.min(available, n)));
  const nearest = stops.reduce((a, b) => Math.abs(b - clamped) < Math.abs(a - clamped) ? b : a);
  return Math.abs(nearest - clamped) <= 24 ? nearest : clamped;
}

/** Pointer samples update only the shell, once per animation frame. Geometry is
 * measured on open/resize/start, never against document content during drag. */
export function useAgentSheet(panel: RefObject<HTMLElement | null>, mobile: boolean, open: boolean, close: () => void) {
  const saved = useRef<number | null>(null);
  const available = useRef(0);
  const initial = useRef(0);
  const drag = useRef<{ id: number; y: number; height: number; next: number; shell: number; travel: number } | null>(null);
  const raf = useRef(0);
  const apply = (height: number) => { if (panel.current) panel.current.style.height = `${height}px`; };
  /*
   * The shell stays on the screen bottom and its top is clipped to the
   * pointer. Sliding the whole shell down instead pushed the composer off the
   * screen and stretched the transcript over the panel: dragging, and even a
   * tap on the handle, showed a "maximized" chat for as long as it lasted.
   * The handle rides the clip edge (`--lc-sheet-clip`) so the bar stays under
   * the finger.
   */
  const translate = () => {
    const d = drag.current;
    if (!d || !panel.current) return;
    const top = Math.max(0, d.shell - d.next);
    panel.current.style.setProperty("--lc-sheet-clip", `${top}px`);
    panel.current.style.clipPath = `inset(${top}px 0 0 0 round var(--lc-r-block) var(--lc-r-block) 0 0)`;
  };
  const unclip = () => {
    panel.current?.style.removeProperty("--lc-sheet-clip");
    panel.current?.style.removeProperty("clip-path");
  };
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    node.inert = !open;
    if (!mobile) { node.style.cssText = ""; return; }
    // Closed sheets need no viewport measurement or resize subscription.
    // Mounting the inactive panel on a tab switch otherwise forces layout of
    // the entire PDF before the new tab can paint.
    if (!open) {
      // Closed, the whole sheet waits just below the screen and slides up as
      // one piece. It used to sit 12px down and clipped to a small pill, so
      // opening grew a window out of the middle of the full-size panel: a
      // cropped slice of messages and the sessions column with no sheet edge.
      node.style.transform = "translate3d(0,100%,0)";
      node.style.visibility = "hidden";
      node.style.pointerEvents = "none";
      document.documentElement.style.setProperty("--lc-agent-open", "0");
      return;
    }
    const resize = () => {
      const vv = window.visualViewport;
      const bottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
      const headerBottom = document.querySelector(".lc-header")?.getBoundingClientRect().bottom ?? 0;
      available.current = Math.max(0, bottom - Math.max(headerBottom, vv?.offsetTop ?? 0) - 8);
      const height = drag.current?.next ?? saved.current;
      if (height != null) {
        const next = settleSheetHeight(height, available.current, initial.current || height, false);
        if (drag.current) {
          drag.current.next = next;
          drag.current.shell = available.current;
          apply(drag.current.shell);
        } else apply(next);
      } else {
        node.style.removeProperty("height");
      }
      node.style.bottom = "0px";
      node.style.maxHeight = `${available.current}px`;
      node.style.transform = "translate3d(0,0,0) scale(1)";
      translate();
      node.style.visibility = open ? "visible" : "hidden";
      node.style.pointerEvents = open ? "auto" : "none";
      node.inert = !open;
      document.documentElement.style.setProperty("--lc-agent-open", open ? "1" : "0");
      document.documentElement.style.setProperty("--lc-agent-peek", "0px");
    };
    resize();
    window.addEventListener("resize", resize); window.visualViewport?.addEventListener("resize", resize);
    const header = document.querySelector(".lc-header");
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    if (header) observer?.observe(header);
    return () => {
      cancelAnimationFrame(raf.current); raf.current = 0; drag.current = null;
      node.style.removeProperty("transition");
      node.style.removeProperty("--lc-sheet-clip");
      node.style.removeProperty("clip-path");
      document.documentElement.style.removeProperty("--lc-agent-peek");
      window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); observer?.disconnect();
      document.documentElement.style.removeProperty("--lc-agent-open");
      document.documentElement.classList.remove("lc-agent-dragging");
    };
  }, [panel, mobile, open]);
  const down = (e: ReactPointerEvent<HTMLElement>) => {
    if (!mobile || !open || e.button !== 0 || !panel.current) return;
    e.preventDefault();
    const height = panel.current.getBoundingClientRect().height;
    initial.current ||= height;
    drag.current = { id: e.pointerId, y: e.clientY, height, next: height, shell: available.current, travel: 0 };
    panel.current.style.transition = "none";
    document.documentElement.classList.add("lc-agent-dragging");
    // Lay the chat out once at the largest reachable size. Moving that fixed
    // shell keeps its visible top on the pointer without relaying out every turn.
    apply(available.current);
    translate();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    d.travel = Math.max(d.travel, Math.abs(d.y - e.clientY));
    d.next = settleSheetHeight(d.height + d.y - e.clientY, available.current, initial.current, false);
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; translate(); });
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    cancelAnimationFrame(raf.current); raf.current = 0; drag.current = null;
    const cancel = e.type === "pointercancel" || e.type === "lostpointercapture";
    saved.current = cancel ? d.height : settleSheetHeight(d.height + d.y - e.clientY, available.current, initial.current, true);
    apply(saved.current);
    unclip();
    if (panel.current) {
      // Commit the unclipped style while transitions are still off: dropping
      // both at once let the sheet's clip-path transition replay the drag
      // clip back to zero, a 240ms wipe (a flash) after every lift-off.
      void getComputedStyle(panel.current).clipPath;
      panel.current.style.removeProperty("transition");
    }
    document.documentElement.classList.remove("lc-agent-dragging");
    document.dispatchEvent(new Event("lc-agent-drag-end"));
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!cancel && d.travel < 8 && Math.abs(e.clientY - d.y) < 8) close();
  };
  return { down, move, end };
}
