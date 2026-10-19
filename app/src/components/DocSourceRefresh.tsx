import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { getDocSource } from "../util/docSourceStore";
import { nativeSourcePickerAvailable } from "../util/docSourceNative";
import { HOLD_FILL_MS } from "../util/gesture";
import { WorkRing } from "./DocIndexChip";
import { HoldButton } from "./HoldButton";
import { DialogBackdrop } from "./DialogMotion";
import { DialogFrame } from "./DialogFrame";
import { usePopPlacement } from "./usePopPlacement";
import { usePresence } from "./usePresence";
import "./docSourceRefresh.css";

export interface DocSourceRefreshProps {
  docId: string | null;
  checking?: boolean;
  newer?: boolean;
  chromeHost?: HTMLElement | null;
  onCheck: () => void;
  onLink: () => void;
  onUnlink: () => void;
}

export function DocSourceRefresh({ docId, checking = false, newer = false, chromeHost = null, onCheck, onLink, onUnlink }: DocSourceRefreshProps) {
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hand, setHand] = useState(() => document.documentElement.dataset.uiHandedness === "left" ? "left" : "right");
  const [shift, setShift] = useState(0);
  const reduced = useReducedMotion();
  const hasSource = Boolean(docId && getDocSource(docId));
  const available = Boolean(docId && nativeSourcePickerAvailable());
  const menuVisible = menuOpen && hasSource && available && !checking;
  const presence = usePresence(menuVisible);
  const placed = usePopPlacement(button, pop, presence.mounted, docId);
  useEffect(() => { setMenuOpen(false); }, [docId, hasSource]);
  useEffect(() => {
    if (!menuVisible) return;
    const outside = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node) && !pop.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); button.current?.focus(); }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape); };
  }, [menuVisible]);
  useLayoutEffect(() => {
    const refresh = () => setHand(document.documentElement.dataset.uiHandedness === "left" ? "left" : "right");
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-handedness"] });
    window.addEventListener("lc-ui-handedness", refresh);
    return () => { observer.disconnect(); window.removeEventListener("lc-ui-handedness", refresh); };
  }, []);
  useLayoutEffect(() => {
    const node = button.current;
    if (!node || !available) return;
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
  }, [chromeHost, hand, available]);
  if (!available) return null;
  return <><HoldButton label={hasSource ? "Check for a newer version" : "Link this document to its file"}
    onMeasure={node => { button.current = node; }} holdMs={HOLD_FILL_MS}
    className={`lc-icon lc-hold-icon lc-library-sync-trigger lc-doc-source-refresh is-${hand}${checking ? " is-working" : ""}${hasSource ? "" : " is-unlinked"}`}
    style={{ "--lc-doc-source-shift": `${shift}px` } as CSSProperties}
    ariaLabel={hasSource ? "Check for a newer version of this file. Hold for more" : "Link this document to its file"}
    fillIndeterminate={checking} disabled={checking}
    onTap={hasSource ? onCheck : onLink} onConfirm={hasSource ? () => setMenuOpen(open => !open) : onLink}>
    {checking
      ? <span className="lc-library-sync-face" key="ring"><WorkRing progress={null} /></span>
      : <svg key="icon" className="lc-icon-svg lc-library-sync-face" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
          strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
        </svg>}
    <AnimatePresence>{hasSource && newer && !checking && <motion.span key="newer" className="lc-library-sync-dot" aria-hidden="true"
      initial={{ opacity: reduced ? 1 : 0, scale: reduced ? 1 : .7 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : .7 }} transition={{ duration: reduced ? 0 : .14 }} />}</AnimatePresence>
    {!hasSource && !checking && <svg className="lc-doc-source-link-badge" viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 10 4-4M6.5 4.5l1.7-1.7a3 3 0 0 1 4.2 4.2l-1.7 1.7M9.5 11.5l-1.7 1.7A3 3 0 0 1 3.6 9l1.7-1.7" /></svg>}
  </HoldButton>
  {presence.mounted && createPortal(<div ref={pop} role="menu" aria-label="Linked file actions"
    className={`lc-doc-sync-pop lc-tab-hold-pop lc-doc-source-menu${presence.leaving ? " is-leaving" : ""}`} style={placed}
    inert={presence.leaving}>
    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onCheck(); }}>Check now</button>
    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onLink(); }}>Link to a different file…</button>
    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onUnlink(); }}>Unlink</button>
  </div>, document.body)}</>;
}

export function DocSourceLinkDialog({ mode, fileName, documentName, pending = false, error, onCancel, onFind, onJustLink, onUpdate }: {
  mode: "missing" | "differs";
  fileName: string;
  documentName?: string;
  pending?: boolean;
  error?: string | null;
  onCancel: () => void;
  onFind?: () => void;
  onJustLink?: () => void;
  onUpdate?: () => void;
}) {
  const titleId = useId();
  const present = useIsPresent();
  const missing = mode === "missing";
  const title = missing ? "Linked file not found" : "This file is different";
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending && present) onCancel();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onCancel, pending, present]);
  return <DialogBackdrop className="lc-modal-backdrop" role="presentation" onClick={event => {
    if (event.target === event.currentTarget && !pending && present) onCancel();
  }}>
    <DialogFrame className="lc-modal lc-confirm-dialog" titleId={titleId} title={title} subtitle="" ariaLabel={title} shape="blocky"
      icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m9 15 6-6M9 6l2-2a5 5 0 0 1 7 7l-2 2M15 18l-2 2a5 5 0 0 1-7-7l2-2" /></svg>}>
      <div className="lc-dialog-body">
        <p>{missing ? `“${fileName}” isn't where it was. Find it to keep this document up to date.`
          : `“${fileName}” doesn't match the app's copy of “${documentName}”.`}</p>
        {!missing && <p className="lc-muted lc-reveal-hold-hint" role={pending ? "status" : undefined}>{pending ? "Updating…" : "Hold Update to this file briefly to confirm."}</p>}
        {error && <p className="lc-warning">{error}</p>}
      </div>
      <div className="lc-modal-actions lc-settings-foot lc-dialog-foot">
        <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onCancel}>{missing ? "Not now" : "Cancel"}</button>
        {missing ? <button type="button" className="lc-primary lc-dialog-action" disabled={pending} onClick={onFind}>Find the file…</button> : <>
          <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onJustLink}>Just link</button>
          <HoldButton label="Update to this file" className="lc-hold-danger lc-dialog-action" disabled={pending} onConfirm={() => onUpdate?.()} resetKey={error} />
        </>}
      </div>
    </DialogFrame>
  </DialogBackdrop>;
}
