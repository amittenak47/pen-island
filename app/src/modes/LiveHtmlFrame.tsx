import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LIVE_HTML_MESSAGE, liveHtmlSrcdoc } from "../util/localHtmlRender";
import { DialogPresence } from "../components/DialogMotion";
import { MediaPlayerDialog } from "../components/MediaPlayerDialog";
import { readLivePageStorage, writeLivePageStorage } from "../util/livePageStorage";

const TAP_EXCLUSIONS = "button, a, input, textarea, select, [role='button'], [role='menu'], [role='dialog'], .lc-board-chrome-slot, .lc-map-controls, .lc-doc-footnote, .lc-doc-footnote-pack, .lc-footnote-bubble, .lc-doc-select-overlay, .lc-doc-sheet, .lc-doc-confirm, .lc-toolbar";

interface LiveHtmlFrameProps {
  original: string;
  onHeight: (height: number) => void;
  /** The page followed one of its own `#` links: its target is at this client y. */
  onAnchor?: (clientY: number) => void;
  /** Where the file's own folder is served, for its relative names (see htmlAssets.ts). */
  assetBase?: string | null;
  /** The document whose page this is: its `localStorage` is kept under this id (livePageStorage.ts). */
  storageId?: string | null;
}

interface PlayingMedia { src: string; start: number; video: boolean }
/** A player's box in the page's own px: x, y, width, height. */
type PlayerBox = [number, number, number, number];

function playerBoxes(value: unknown): PlayerBox[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const boxes = value.filter((box): box is PlayerBox => Array.isArray(box) && box.length === 4
    && box.every((n) => typeof n === "number" && Number.isFinite(n)) && box[2] > 0 && box[3] > 0);
  return boxes.length === value.length ? boxes : null;
}

/** The whole page but the players: what the catcher keeps for the board. */
function catcherClip(boxes: PlayerBox[]): string {
  const holes = boxes.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w}Z`).join("");
  return `path(evenodd, "M-1 -1H1000000V100000000H-1Z${holes}")`;
}

export function LiveHtmlFrame({ original, onHeight, onAnchor, assetBase = null, storageId = null }: LiveHtmlFrameProps) {
  // A new original, folder or document starts with a fresh nonce, measurement and growth guard.
  return <LiveHtmlFrameContent key={`${storageId ?? ""}\n${assetBase ?? ""}\n${original}`} original={original} onHeight={onHeight}
    onAnchor={onAnchor} assetBase={assetBase} storageId={storageId} />;
}

function LiveHtmlFrameContent({ original, onHeight, onAnchor, assetBase = null, storageId = null }: LiveHtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce] = useState(() => crypto.getRandomValues(new Uint32Array(4)).join("-"));
  // Read once: the page's own saves must not rebuild (and so reload) the page.
  const [storage] = useState(() => storageId ? readLivePageStorage(storageId) : null);
  const srcdoc = useMemo(() => liveHtmlSrcdoc(original, nonce, assetBase, storage), [original, nonce, assetBase, storage]);
  const [height, setHeight] = useState(0);
  const [playing, setPlaying] = useState<PlayingMedia | null>(null);
  const [players, setPlayers] = useState<PlayerBox[]>([]);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  const onAnchorRef = useRef(onAnchor);
  onAnchorRef.current = onAnchor;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let currentHeight = 0;
    const growthTimes: number[] = [];
    let growthStopped = false;
    let down: { id: number; x: number; y: number; time: number } | null = null;
    const tapPointer = (event: PointerEvent) => event.isPrimary &&
      (event.pointerType === "touch" || (event.pointerType === "mouse" && event.button === 0));
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.source !== frame.contentWindow || !data || typeof data !== "object") return;
      const reply = data as { type?: unknown; nonce?: unknown; height?: unknown; anchor?: unknown; media?: unknown; holes?: unknown };
      if (reply.type !== LIVE_HTML_MESSAGE || reply.nonce !== nonce) return;
      if ("storage" in reply) {
        if (storageId) writeLivePageStorage(storageId, (reply as { storage?: unknown }).storage);
        return;
      }
      if ("holes" in reply) {
        const boxes = assetBase ? playerBoxes(reply.holes) : null;
        if (boxes) setPlayers(boxes);
        return;
      }
      if (reply.media && typeof reply.media === "object") {
        const media = reply.media as { src?: unknown; time?: unknown; video?: unknown };
        // Only a file from the page's own folder: the page picks what plays, not where from.
        if (!assetBase || typeof media.src !== "string" || !media.src.startsWith(assetBase)) return;
        const start = typeof media.time === "number" && Number.isFinite(media.time) && media.time > 0 ? media.time : 0;
        setPlaying({ src: media.src, start, video: media.video !== false });
        return;
      }
      if (typeof reply.anchor === "number" && Number.isFinite(reply.anchor)) {
        // The page's own px; the board scales the frame.
        const rect = frame.getBoundingClientRect();
        if (frame.offsetHeight > 0) onAnchorRef.current?.(rect.top + reply.anchor * rect.height / frame.offsetHeight);
        return;
      }
      const next = reply.height;
      if (typeof next !== "number" || !Number.isFinite(next) || next < 0) return;
      if (next > currentHeight) {
        if (growthStopped) return;
        const now = performance.now();
        while (growthTimes.length && now - growthTimes[0] >= 2000) growthTimes.shift();
        if (growthTimes.length >= 5 && now - growthTimes[growthTimes.length - 1] < 400) {
          growthStopped = true;
          return;
        }
        growthTimes.push(now);
      } else {
        growthTimes.length = 0;
      }
      currentHeight = next;
      setHeight(next);
      onHeightRef.current(next);
    };
    const onDown = (event: PointerEvent) => {
      if (down) { down = null; return; }
      if (!tapPointer(event)) return;
      if (event.target instanceof Element && event.target.closest(TAP_EXCLUSIONS)) return;
      const rect = frame.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
    };
    const onMove = (event: PointerEvent) => {
      if (down?.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) down = null;
    };
    const onUp = (event: PointerEvent) => {
      if (!down || down.id !== event.pointerId) return;
      const tap = down;
      down = null;
      if (!tapPointer(event)) return;
      if (event.timeStamp - tap.time > 450 || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) return;
      const rect = frame.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      frame.contentWindow?.postMessage({
        type: LIVE_HTML_MESSAGE, nonce,
        tap: {
          x: (event.clientX - rect.left) * frame.offsetWidth / rect.width,
          y: (event.clientY - rect.top) * frame.offsetHeight / rect.height,
        },
      }, "*");
    };
    const onCancel = (event: PointerEvent) => {
      if (down?.id === event.pointerId) down = null;
    };
    const options = { capture: true, passive: true };
    window.addEventListener("message", onMessage);
    window.addEventListener("pointerdown", onDown, options);
    window.addEventListener("pointermove", onMove, options);
    window.addEventListener("pointerup", onUp, options);
    window.addEventListener("pointercancel", onCancel, options);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pointerdown", onDown, options);
      window.removeEventListener("pointermove", onMove, options);
      window.removeEventListener("pointerup", onUp, options);
      window.removeEventListener("pointercancel", onCancel, options);
    };
  }, [nonce, assetBase, storageId]);

  return <>
    <iframe
      ref={frameRef}
      sandbox="allow-scripts"
      className={`lc-live-html-frame${players.length ? " has-players" : ""}`}
      title="Live page"
      srcDoc={srcdoc}
      style={{
        position: "absolute", left: 0, top: 0, width: "100%", border: 0,
        // With players on the page, styles.css decides (Scroll mode only).
        pointerEvents: players.length ? undefined : "none", background: "transparent", display: "block",
        height, visibility: height > 0 ? "visible" : "hidden", opacity: height > 0 ? 1 : 0,
      }}
    />
    {/*
      * The page's players work as in a browser while no ink tool is out.
      *
      * In Scroll mode the frame takes the pointer (styles.css), and this
      * catcher over it takes it back everywhere but the players' boxes, which
      * hit-testing leaves to the frame through the clip's holes. A drag on the
      * page still reaches the board and pans; a tap on a player reaches its
      * own controls. With an ink tool out neither takes the pointer, and a tap
      * on a video opens the player below instead.
      */}
    {players.length > 0 && <div className="lc-live-html-catcher" aria-hidden="true"
      style={{ position: "absolute", left: 0, top: 0, width: "100%", height, clipPath: catcherClip(players) }} />}
    {/* On the body: the board's transform would hold a fixed overlay inside the page. */}
    {createPortal(<DialogPresence>{playing && <MediaPlayerDialog key={playing.src} src={playing.src} start={playing.start}
      video={playing.video} onClose={() => setPlaying(null)} />}</DialogPresence>, document.body)}
  </>;
}
