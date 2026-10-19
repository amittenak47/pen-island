import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePadHubStatus } from "../util/padHubStatus";
import { HOLD_FILL_MS } from "../util/gesture";
import { HoldButton } from "./HoldButton";
import { usePopPlacement } from "./usePopPlacement";
import { usePresence } from "./usePresence";
import "./docSyncLinkPair.css";

/** The file a document came from, for the Link half. */
export interface DocLinkState {
  /** The linked file's name; null when not linked. */
  name: string | null;
  checking: boolean;
  newer: boolean;
  onCheck: () => void;
  onLink: () => void;
  onUnlink: () => void;
}

export interface DocSyncLinkPairProps {
  /** The tab's sync line, as the tab's own Sync says it ("Synced", "Pad…"). */
  syncLine: string | null;
  syncing: boolean;
  /** The tab's book is synced (the walk landed, or nothing changed since). */
  synced?: boolean;
  syncFailed?: boolean;
  onSync: () => void;
  /** Absent for kinds with no file (whiteboards, web pages). */
  link?: DocLinkState | null;
  disabled?: boolean;
}

/** Sync's dot: green synced, yellow syncing or waiting on you, red not synced, failed or offline. */
export type SyncDotState = "synced" | "syncing" | "waiting" | "unsynced";

export function SyncDot({ state }: { state: SyncDotState }) {
  return <span className="lc-sync-link-dot" data-state={state} aria-hidden="true" />;
}

/**
 * [● | 🔗] in a menu's context row, where "not synced" used to sit: two
 * equal icon squares, the words in their labels and notifications. The tab
 * has the same pair, its Sync half being the tab's own (see DocIndexChip).
 *
 * Sync is the tab's Sync, the same walk. Link is what the page's refresh
 * button was: tap checks the linked file for a newer version (or links one),
 * hold offers the rest. Each half says its status in a notification directly
 * under it, on hover, or on a tap for touch, which has no hover.
 */
export function DocSyncLinkPair({ syncLine, syncing, synced = false, syncFailed = false, onSync, link = null, disabled = false }: DocSyncLinkPairProps) {
  const syncRef = useRef<HTMLButtonElement | null>(null);
  const { status: hubStatus } = usePadHubStatus();
  const hover = useHalfHover();
  const syncText = hubStatus === "offline" && !syncing
    ? "Desktop app is offline. Try again when it's back."
    : syncLine ?? "Sync this document";
  const state: SyncDotState = syncing ? "syncing" : syncFailed || hubStatus === "offline" || !synced ? "unsynced" : "synced";
  const syncTip = useHalfTip(syncRef, hover.shown, syncText, "left");

  return <span className={`lc-sync-link-pair${link ? "" : " is-sync-only"}`} role="group" aria-label="Sync and linked file">
    <span className="lc-sync-link-half" onPointerEnter={hover.enter} onPointerLeave={hover.leave}>
      <button ref={syncRef} type="button" className={`lc-sync-link-sync${syncFailed ? " is-bad" : ""}`} disabled={disabled}
        aria-label={`Sync. ${syncText}`} aria-busy={syncing}
        onClick={() => { hover.enter(); if (!syncing) onSync(); }}>
        <SyncDot state={state} />
      </button>
    </span>
    {link && <DocLinkHalf link={link} disabled={disabled} />}
    {syncTip}
  </span>;
}

/**
 * The Link half: the chain, green linked, yellow a newer version waiting or
 * being checked, red not linked. Tap checks (or links); hold offers Check
 * now, Link to a different file and Unlink.
 */
export function DocLinkHalf({ link, disabled = false }: { link: DocLinkState; disabled?: boolean }) {
  const linkRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const hover = useHalfHover();
  const linked = Boolean(link.name);
  const linkLine = link.checking ? "Checking the file…"
    : !linked ? "Not linked. Tap to link the file this came from."
      : link.newer ? `A newer version of “${link.name}” is available. Tap to update.`
        : `Linked to “${link.name}”. Tap to check for a newer version, hold for more.`;
  const linkState = !linked ? "unlinked" : link.checking || link.newer ? "attention" : "linked";

  useEffect(() => { if (!linked) setMenuOpen(false); }, [linked]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!linkRef.current?.contains(target) && !menuRef.current?.contains(target)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The menu, not the dialog under it.
      event.preventDefault(); event.stopPropagation();
      setMenuOpen(false); linkRef.current?.focus();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape, true); };
  }, [menuOpen]);

  const linkTip = useHalfTip(linkRef, hover.shown && !menuOpen, linkLine, "right");
  const menu = usePresence(menuOpen && linked && !link.checking);
  const menuPlaced = usePopPlacement(linkRef, menuRef, menu.mounted, link.name, "below", "right");

  return <span className="lc-sync-link-half" onPointerEnter={hover.enter} onPointerLeave={hover.leave}>
    <HoldButton label="Link" holdMs={HOLD_FILL_MS} onMeasure={node => { linkRef.current = node; }}
      className={`lc-sync-link-link is-${linkState}${link.checking ? " is-working" : ""}`}
      ariaLabel={linkLine} disabled={disabled || link.checking} fillIndeterminate={link.checking}
      onTap={() => { hover.enter(); if (linked) link.onCheck(); else link.onLink(); }}
      onConfirm={() => { if (linked) setMenuOpen(open => !open); else link.onLink(); }}>
      <span className="lc-sync-link-face"><LinkIcon /></span>
    </HoldButton>
    {linkTip}
    {menu.mounted && createPortal(<div ref={menuRef} role="menu" aria-label="Linked file actions"
      className={`lc-doc-sync-pop lc-tab-hold-pop lc-sync-link-menu${menu.leaving ? " is-leaving" : ""}`} style={menuPlaced} inert={menu.leaving}>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); link.onCheck(); }}>Check now</button>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); link.onLink(); }}>Link to a different file…</button>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); link.onUnlink(); }}>Unlink</button>
    </div>, document.body)}
  </span>;
}

/** A half was entered: every other half's notification closes at once. */
export const HALF_HOVER_EVENT = "lc-sync-link-hover";

/**
 * Hover with a short grace on leave, so the pointer can cross the gap to the
 * notification. Entering one half closes the other's at once: the two never
 * stack, in the menu or in the tab.
 */
export function useHalfHover() {
  const [shown, setShown] = useState(false);
  const leaveRef = useRef(0);
  const idRef = useRef<object>({});
  useEffect(() => {
    const other = (event: Event) => {
      if ((event as CustomEvent).detail === idRef.current) return;
      window.clearTimeout(leaveRef.current);
      setShown(false);
    };
    window.addEventListener(HALF_HOVER_EVENT, other);
    return () => { window.removeEventListener(HALF_HOVER_EVENT, other); window.clearTimeout(leaveRef.current); };
  }, []);
  return {
    shown,
    enter: () => {
      window.clearTimeout(leaveRef.current);
      window.dispatchEvent(new CustomEvent(HALF_HOVER_EVENT, { detail: idRef.current }));
      setShown(true);
    },
    leave: () => {
      window.clearTimeout(leaveRef.current);
      leaveRef.current = window.setTimeout(() => setShown(false), 180);
    },
  };
}

/** One half's status, directly under it: left-aligned under Sync, right-aligned under Link. */
function useHalfTip(anchor: RefObject<HTMLElement | null>, shown: boolean, text: string, align: "left" | "right"): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const presence = usePresence(shown);
  const placed = usePopPlacement(anchor, ref, presence.mounted, text, "below", align);
  if (!presence.mounted) return null;
  return createPortal(<div ref={ref} role="status" aria-live="polite"
    className={`lc-doc-sync-pop lc-sync-link-tip is-${align}${presence.leaving ? " is-leaving" : ""}`} style={placed}>
    <div className="lc-doc-sync-line">{text}</div>
  </div>, document.body);
}

function LinkIcon() {
  return <svg className="lc-icon-svg" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="m6 10 4-4M6.5 4.5l1.7-1.7a3 3 0 0 1 4.2 4.2l-1.7 1.7M9.5 11.5l-1.7 1.7A3 3 0 0 1 3.6 9l1.7-1.7" />
  </svg>;
}
