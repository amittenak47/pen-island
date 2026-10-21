import { useEffect, useMemo, useRef, useState } from "react";
import { LIVE_HTML_MESSAGE, liveHtmlSrcdoc } from "../util/localHtmlRender";

const TAP_EXCLUSIONS = "button, a, input, textarea, select, [role='button'], [role='menu'], [role='dialog'], .lc-board-chrome-slot, .lc-map-controls, .lc-doc-footnote, .lc-doc-footnote-pack, .lc-footnote-bubble, .lc-doc-select-overlay, .lc-doc-sheet, .lc-doc-confirm, .lc-toolbar";

interface LiveHtmlFrameProps {
  original: string;
  onHeight: (height: number) => void;
}

export function LiveHtmlFrame({ original, onHeight }: LiveHtmlFrameProps) {
  // A new original starts with a fresh nonce, measurement and growth guard.
  return <LiveHtmlFrameContent key={original} original={original} onHeight={onHeight} />;
}

function LiveHtmlFrameContent({ original, onHeight }: LiveHtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce] = useState(() => crypto.getRandomValues(new Uint32Array(4)).join("-"));
  const srcdoc = useMemo(() => liveHtmlSrcdoc(original, nonce), [original, nonce]);
  const [height, setHeight] = useState(0);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

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
      const reply = data as { type?: unknown; nonce?: unknown; height?: unknown };
      if (reply.type !== LIVE_HTML_MESSAGE || reply.nonce !== nonce) return;
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
  }, [nonce]);

  return (
    <iframe
      ref={frameRef}
      sandbox="allow-scripts"
      className="lc-live-html-frame"
      title="Live page"
      srcDoc={srcdoc}
      style={{
        position: "absolute", left: 0, top: 0, width: "100%", border: 0,
        pointerEvents: "none", background: "transparent", display: "block",
        height, visibility: height > 0 ? "visible" : "hidden", opacity: height > 0 ? 1 : 0,
      }}
    />
  );
}
