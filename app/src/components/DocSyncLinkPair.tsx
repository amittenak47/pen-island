import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePadHubStatus } from "../util/padHubStatus";
import { HOLD_FILL_MS } from "../util/gesture";
import { HoldButton } from "./HoldButton";
import { HubStatusDot } from "./HubStatusDot";
import { WorkRing } from "./DocIndexChip";
import { usePopPlacement } from "./usePopPlacement";
import { usePresence } from "./usePresence";
import "./docSyncLinkPair.css";

export interface DocSyncLinkPairProps {
  /** The tab's sync line, as the tab's own Sync says it ("Synced", "Pad…"). */
  syncLine: string | null;
  syncing: boolean;
  syncFailed?: boolean;
  onSync: () => void;
  /** The file this document came from. Absent for kinds with no file (whiteboards, web pages). */
  link?: {
    /** The linked file's name; null when not linked. */
    name: string | null;
    checking: boolean;
    newer: boolean;
    onCheck: () => void;
    onLink: () => void;
    onUnlink: () => void;
  } | null;
  disabled?: boolean;
}

/**
 * [⊙ Sync | Link] in a menu's context row, where "not synced" used to sit.
 *
 * Sync is the tab's Sync, the same walk. Link is what the page's refresh
 * button was: tap checks the linked file for a newer version (or links one),
 * hold offers the rest. Each half says its status in a notification directly
 * under it, on hover, or on a tap for touch, which has no hover.
 */
export function DocSyncLinkPair({ syncLine, syncing, syncFailed = false, onSync, link = null, disabled = false }: DocSyncLinkPairProps) {
  const syncRef = useRef<HTMLButtonElement | null>(null);
  const linkRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const leaveRef = useRef(0);
  const [hover, setHover] = useState<"sync" | "link" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { status: hubStatus } = usePadHubStatus();
  const linked = Boolean(link?.name);
  const linkLine = !link ? null
    : link.checking ? "Checking the file…"
      : !linked ? "Not linked. Tap to link the file this came from."
        : link.newer ? `A newer version of “${link.name}” is available. Tap to update.`
          : `Linked to “${link.name}”. Tap to check for a newer version, hold for more.`;
  const syncText = hubStatus === "offline" && !syncing
    ? "Desktop app is offline. Try again when it's back."
    : syncLine ?? "Sync this document";

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
  useEffect(() => () => window.clearTimeout(leaveRef.current), []);

  const syncTip = useHalfTip(syncRef, hover === "sync" && !menuOpen, syncText, "left");
  const linkTip = useHalfTip(linkRef, hover === "link" && !menuOpen && linkLine != null, linkLine ?? "", "right");
  const menu = usePresence(menuOpen && linked && !link?.checking);
  const menuPlaced = usePopPlacement(linkRef, menuRef, menu.mounted, link?.name, "below", "right");
  const enter = (half: "sync" | "link") => { window.clearTimeout(leaveRef.current); setHover(half); };
  const exit = () => {
    window.clearTimeout(leaveRef.current);
    leaveRef.current = window.setTimeout(() => setHover(null), 180);
  };

  return <span className={`lc-sync-link-pair${link ? "" : " is-sync-only"}`} role="group" aria-label="Sync and linked file">
    <span className="lc-sync-link-half" onPointerEnter={() => enter("sync")} onPointerLeave={exit}>
      <button ref={syncRef} type="button" className={`lc-sync-link-sync${syncFailed ? " is-bad" : ""}`} disabled={disabled}
        aria-label={`Sync. ${syncText}`} aria-busy={syncing}
        onClick={() => { enter("sync"); if (!syncing) onSync(); }}>
        {syncing ? <WorkRing progress={null} /> : <HubStatusDot />}
        <span>Sync</span>
      </button>
    </span>
    {link && <span className="lc-sync-link-half" onPointerEnter={() => enter("link")} onPointerLeave={exit}>
      <HoldButton label="Link" holdMs={HOLD_FILL_MS} onMeasure={node => { linkRef.current = node; }}
        className={`lc-sync-link-link${linked ? "" : " is-unlinked"}${link.checking ? " is-working" : ""}`}
        ariaLabel={linkLine ?? "Link"} disabled={disabled || link.checking} fillIndeterminate={link.checking}
        onTap={() => { enter("link"); if (linked) link.onCheck(); else link.onLink(); }}
        onConfirm={() => { if (linked) setMenuOpen(open => !open); else link.onLink(); }}>
        <span className="lc-sync-link-face">
          <span>Link</span>
          {link.checking ? <WorkRing progress={null} /> : <LinkIcon />}
          {linked && link.newer && !link.checking && <span className="lc-library-sync-dot" aria-hidden="true" />}
        </span>
      </HoldButton>
    </span>}
    {syncTip}
    {linkTip}
    {menu.mounted && createPortal(<div ref={menuRef} role="menu" aria-label="Linked file actions"
      className={`lc-doc-sync-pop lc-tab-hold-pop lc-sync-link-menu${menu.leaving ? " is-leaving" : ""}`} style={menuPlaced} inert={menu.leaving}>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); link?.onCheck(); }}>Check now</button>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); link?.onLink(); }}>Link to a different file…</button>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); link?.onUnlink(); }}>Unlink</button>
    </div>, document.body)}
  </span>;
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
