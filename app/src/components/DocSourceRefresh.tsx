import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getDocSource } from "../util/docSourceStore";
import { WorkRing } from "./DocIndexChip";
import "./docSourceRefresh.css";

export interface DocSourceRefreshProps {
  docId: string | null;
  checking?: boolean;
  newer?: boolean;
  chromeHost?: HTMLElement | null;
  onCheck: () => void;
}

export function DocSourceRefresh({ docId, checking = false, newer = false, chromeHost = null, onCheck }: DocSourceRefreshProps) {
  const button = useRef<HTMLButtonElement>(null);
  const [hand, setHand] = useState(() => document.documentElement.dataset.uiHandedness === "left" ? "left" : "right");
  const [shift, setShift] = useState(0);
  const reduced = useReducedMotion();
  const hasSource = Boolean(docId && getDocSource(docId));
  useLayoutEffect(() => {
    const refresh = () => setHand(document.documentElement.dataset.uiHandedness === "left" ? "left" : "right");
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-handedness"] });
    window.addEventListener("lc-ui-handedness", refresh);
    return () => { observer.disconnect(); window.removeEventListener("lc-ui-handedness", refresh); };
  }, []);
  useLayoutEffect(() => {
    const node = button.current;
    if (!node || !hasSource) return;
    const stack = (chromeHost ?? node.closest(".lc-board") ?? document).querySelector<HTMLElement>(".lc-map-chrome-right");
    if (!stack) { setShift(0); return; }
    let frame = 0;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const tray = stack.getBoundingClientRect();
      const current = Number.parseFloat(node.style.getPropertyValue("--lc-doc-source-shift")) || 0;
      const left = hand === "left" ? rect.left - current : rect.left + current;
      const right = left + rect.width;
      const overlaps = tray.width > 0 && tray.height > 0 && rect.top < tray.bottom && rect.bottom > tray.top && left < tray.right && right > tray.left;
      setShift(overlaps ? Math.max(0, hand === "left" ? tray.right + 12 - left : right + 12 - tray.left) : 0);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(stack);
    if (node.parentElement) resize?.observe(node.parentElement);
    const mutations = new MutationObserver(schedule);
    mutations.observe(stack, { attributes: true, childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    stack.addEventListener("transitionend", schedule);
    measure();
    return () => { cancelAnimationFrame(frame); resize?.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); stack.removeEventListener("transitionend", schedule); };
  }, [chromeHost, hand, hasSource]);
  if (!hasSource) return null;
  return <button ref={button} type="button"
    className={`lc-icon lc-library-sync-trigger lc-doc-source-refresh is-${hand}${checking ? " is-working" : ""}`}
    style={{ "--lc-doc-source-shift": `${shift}px` } as CSSProperties}
    aria-label="Check for a newer version of this file" aria-busy={checking} disabled={checking} onClick={onCheck}>
    {checking
      ? <span className="lc-library-sync-face" key="ring"><WorkRing progress={null} /></span>
      : <svg key="icon" className="lc-icon-svg lc-library-sync-face" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
          strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
        </svg>}
    <AnimatePresence>{newer && !checking && <motion.span key="newer" className="lc-library-sync-dot" aria-hidden="true"
      initial={{ opacity: reduced ? 1 : 0, scale: reduced ? 1 : .7 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : .7 }} transition={{ duration: reduced ? 0 : .14 }} />}</AnimatePresence>
  </button>;
}
