/**
 * A captured web page as the paper under the ink.
 *
 * Same column as markdown/EPUB: sanitised HTML, measured height, board camera.
 * Local files can also run in an opaque frame above the still copy.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { promoteLazyImages, type WebHtmlSource } from "../util/webPage";
import { columnIsMeasurable } from "./AnnotateDocument";
import { LiveHtmlFrame } from "./LiveHtmlFrame";

export interface WebDocumentProps {
  html: string;
  url: string;
  /** A frozen file has no address to browse, including through its links. */
  localFile?: boolean;
  /** The device-local original runs above the frozen page while Live is on. */
  live?: string | null;
  /** Where the live page's own folder is served, for its videos and pictures. */
  assetBase?: string | null;
  /** The document's id, under which its live page's `localStorage` is kept. */
  storageId?: string | null;
  onMeasure?: (height: number) => void;
  selectable?: boolean;
  /** An in-page link was followed: bring its target, now at this client y, into view. */
  onAnchor?: (clientY: number) => void;
  /** Reading-mode taps on links fetch a new snapshot instead of leaving the app. */
  onNavigate?: (url: string) => void;
  /** Vite / fetch_html GET — page JS never ran. */
  source?: WebHtmlSource;
  /** Why the rendered capture was not used. Surfaced in the address bar. */
  note?: string;
}

/** The element an in-page `#name` link points at: by id, else by `name`. */
function anchorTarget(root: ParentNode, href: string): Element | null {
  let name = href.slice(1);
  try { name = decodeURIComponent(name); } catch { /* the raw name is the next best guess */ }
  if (!name) return null;
  // Compared, not put in a selector: ids from the wild need no escaping then.
  const marked = [...root.querySelectorAll("[id], [name]")];
  return marked.find((el) => el.id === name) ?? marked.find((el) => el.getAttribute("name") === name) ?? null;
}

export function WebDocument({
  html,
  url,
  localFile = false,
  live,
  assetBase = null,
  storageId = null,
  onMeasure,
  selectable = false,
  onNavigate,
  onAnchor,
  source,
}: WebDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onAnchorRef = useRef(onAnchor);
  onAnchorRef.current = onAnchor;
  const localFileRef = useRef(localFile);
  localFileRef.current = localFile;
  const [liveMeasurement, setLiveMeasurement] = useState<{ original: string; height: number } | null>(null);
  const liveHeight = live && liveMeasurement?.original === live ? liveMeasurement.height : 0;
  const onLiveHeight = useCallback((height: number) => {
    if (live) setLiveMeasurement({ original: live, height });
  }, [live]);
  // Back from Live, the still copy fades in as the live page faded in.
  const wasLive = useRef(Boolean(live));
  const [stillReturned, setStillReturned] = useState(false);
  useEffect(() => {
    if (wasLive.current && !live) setStillReturned(true);
    if (live) setStillReturned(false);
    wasLive.current = Boolean(live);
  }, [live]);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    promoteLazyImages(node);
    const report = () => {
      // Mounted in a slot that has no width yet, the page lays out a few
      // pixels wide and measures tens of thousands tall. That height became
      // the board's scroll limit, and the board kept it after the page settled,
      // so the page scrolled far past its end. Wait for a real column, as the
      // markdown reader does; the observer reports again when it arrives.
      if (!columnIsMeasurable(node.clientWidth)) return;
      const height = Math.max(node.scrollHeight, liveHeight);
      if (height > 0) onMeasureRef.current?.(height);
    };
    report();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [html, liveHeight]);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      // A contents list's own links: the page has no scroll of its own, so
      // the board brings the target up.
      if (href?.startsWith("#")) {
        const at = anchorTarget(node, href);
        if (at) onAnchorRef.current?.(at.getBoundingClientRect().top);
        return;
      }
      if (localFileRef.current || !href || href.startsWith("mailto:")) return;
      onNavigateRef.current?.(href);
    };
    // A middle click on a link would open it in a new window: links open
    // here, in this tab, with a plain click only.
    const onAuxClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (anchor) event.preventDefault();
    };
    node.addEventListener("click", onClick);
    node.addEventListener("auxclick", onAuxClick);
    return () => {
      node.removeEventListener("click", onClick);
      node.removeEventListener("auxclick", onAuxClick);
    };
  }, [html]);

  /*
   * Which of the three kinds of paper this is — see `WebHtmlSource`.
   *
   * The note that used to sit here as a paragraph has moved to the address bar.
   * It was rendered inside the scrolling page, so it scrolled away and read as
   * part of the site's own content, which is why nobody saw it.
   */
  return (
    <div className="lc-web-doc-wrap" style={live ? { position: "relative", minHeight: liveHeight } : undefined}>
      <div
        ref={nodeRef}
        className={[
          "lc-web-doc",
          source === "reader" && "is-reader",
          stillReturned && !live && "is-still-return",
        ].filter(Boolean).join(" ")}
        data-doc-scope={url}
        aria-hidden={live || !selectable ? true : undefined}
        style={live ? { visibility: "hidden" } : undefined}
        // eslint-disable-next-line react/no-danger -- sanitised in fetchWebPage
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {live && <LiveHtmlFrame original={live} onHeight={onLiveHeight} onAnchor={onAnchor} assetBase={assetBase} storageId={storageId} />}
    </div>
  );
}
