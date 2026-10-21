import { PAGE_MAX_BYTES, pageFromCapturedHtml, webPageWidthForViewport } from "./webPage";
import { liveOriginalKey, putLiveOriginal } from "./liveHtmlStore";

export const LOCAL_HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; font-src https: data:; img-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
export const LOCAL_HTML_MESSAGE = "lc-local-html-render";
export const LOCAL_HTML_TIMEOUT_MS = 4000;
export const LIVE_HTML_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https:; font-src https: data:; img-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
export const LIVE_HTML_MESSAGE = "lc-live-html";

const absoluteResource = /^(https:|data:|blob:|#)/i;

/** srcdoc otherwise inherits the app's base URL. Never request its relative assets. */
function removeRelativeResources(doc: Document): void {
  doc.querySelectorAll("base").forEach((node) => node.remove());
  for (const node of doc.querySelectorAll("*")) {
    // Include lazy-image attributes which the normal freeze later promotes to src.
    for (const attr of ["src", "href", "xlink:href", "poster", "data-src", "data-lazy-src", "data-original", "data-lazy"]) {
      const value = node.getAttribute(attr);
      // Links are handled by WebDocument; resource URLs must be explicit.
      if (attr === "href" && node.tagName === "A") continue;
      if (value && !absoluteResource.test(value.trim())) node.removeAttribute(attr);
    }
    // Preserve explicit remote candidates; never resolve a relative candidate.
    for (const attr of ["srcset", "data-srcset"]) {
      const srcset = node.getAttribute(attr);
      if (srcset) {
        const explicit = srcset.split(",").map((part) => part.trim()).filter((part) => /^(https:|blob:)/i.test(part));
        if (explicit.length) node.setAttribute(attr, explicit.join(", "));
        else node.removeAttribute(attr);
      }
    }
  }
  const cleanCss = (css: string) => css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote: string, url: string) =>
      absoluteResource.test(url.trim()) ? match : 'url("data:,")')
    .replace(/@import\s+(['"])(.*?)\1[^;]*;?/gi, (match, _quote: string, url: string) =>
      /^https:/i.test(url.trim()) ? match : "");
  for (const node of doc.querySelectorAll("style")) node.textContent = cleanCss(node.textContent ?? "");
  for (const node of doc.querySelectorAll("[style]")) node.setAttribute("style", cleanCss(node.getAttribute("style") ?? ""));
}

/**
 * Runs inside the sandbox just before serializing, where layout is real.
 *
 * A frozen page is read by scrolling the board, so a box that scrolls on its
 * own (a "max-height: 70vh; overflow: auto" table) catches the finger and
 * hides rows from ink. Each one grows to its full height instead. Sideways
 * overflow stays: the board already pans wide boxes sideways.
 */
export const UNROLL_SCROLL_BOXES = `for (const el of document.querySelectorAll("*")) {
  const cs = getComputedStyle(el);
  if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight - el.clientHeight > 1) {
    el.style.setProperty("max-height", "none", "important");
    el.style.setProperty("height", "auto", "important");
    el.style.setProperty("overflow-y", "visible", "important");
  }
}`;

/**
 * Also just before serializing: nothing pinned survives the freeze.
 *
 * A frozen page does not scroll itself (the board moves it), so a sticky or
 * fixed bar has nothing to stick to and ends up pinned over whatever it
 * covered: a sticky contents bar over the title, sticky table headers over
 * the first rows. Each goes back into the flow where its markup sits.
 */
export const UNPIN_STICKY = `for (const el of document.querySelectorAll("*")) {
  const position = getComputedStyle(el).position;
  if (position === "sticky" || position === "-webkit-sticky" || position === "fixed") {
    el.style.setProperty("position", "static", "important");
  }
}`;

export function localHtmlSrcdoc(original: string, nonce: string): string {
  const doc = new DOMParser().parseFromString(original, "text/html");
  removeRelativeResources(doc);
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = LOCAL_HTML_CSP;
  doc.head.prepend(policy);
  const envelope = JSON.stringify({ type: LOCAL_HTML_MESSAGE, nonce }).replace(/</g, "\\u003c");
  // Install before the file's scripts so a synchronous script failure falls back too.
  const errors = doc.createElement("script");
  errors.textContent = `window.addEventListener("error", function(e) {
    if (e instanceof ErrorEvent) parent.postMessage({...${envelope}, error: true}, "*");
  });`;
  policy.after(errors);
  const serializer = doc.createElement("script");
  serializer.textContent = `window.addEventListener("load", async function() {
    try {
      await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 1200))]);
      await new Promise(r => setTimeout(r, 300));
      ${UNROLL_SCROLL_BOXES}
      ${UNPIN_STICKY}
      const html = (document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "<!DOCTYPE html>") + "\\n" + document.documentElement.outerHTML;
      parent.postMessage({...${envelope}, html}, "*");
    } catch (_) { parent.postMessage({...${envelope}, error: true}, "*"); }
  }, {once: true});`;
  doc.body.append(serializer);
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "<!DOCTYPE html>";
  return doctype + "\n" + doc.documentElement.outerHTML;
}

export function liveHtmlSrcdoc(original: string, nonce: string): string {
  const doc = new DOMParser().parseFromString(original, "text/html");
  removeRelativeResources(doc);
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = LIVE_HTML_CSP;
  doc.head.prepend(policy);
  const envelope = JSON.stringify({ type: LIVE_HTML_MESSAGE, nonce }).replace(/</g, "\\u003c");
  const bridge = doc.createElement("script");
  bridge.textContent = `(function() {
    const envelope = ${envelope};
    let ready = false;
    let lastHeight = null;
    let lastReport = -Infinity;
    let timer = null;
    // Walks every element: after load and after a tap only. Run on each
    // report, an animated page paid for it five times a second.
    function settle() {
      ${UNROLL_SCROLL_BOXES}
      ${UNPIN_STICKY}
    }
    function report() {
      lastReport = performance.now();
      const height = Math.ceil(document.documentElement.scrollHeight);
      if (lastHeight === null || Math.abs(height - lastHeight) > 1) {
        lastHeight = height;
        parent.postMessage({...envelope, height}, "*");
      }
    }
    function schedule() {
      if (!ready || timer !== null) return;
      timer = setTimeout(function() {
        timer = null;
        report();
      }, Math.max(0, 200 - (performance.now() - lastReport)));
    }
    window.addEventListener("load", async function() {
      await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 1200))]);
      await new Promise(r => setTimeout(r, 300));
      ready = true;
      settle();
      report();
      new ResizeObserver(schedule).observe(document.body);
      new MutationObserver(schedule).observe(document.body, {childList: true, subtree: true, attributes: true});
    }, {once: true});
    window.addEventListener("message", function(event) {
      const data = event.data;
      if (event.source !== parent || !data || data.type !== envelope.type || data.nonce !== envelope.nonce) return;
      const tap = data.tap;
      if (!tap || typeof tap.x !== "number" || typeof tap.y !== "number" || !Number.isFinite(tap.x) || !Number.isFinite(tap.y)) return;
      const el = document.elementFromPoint(tap.x, tap.y);
      if (el) {
        const options = {bubbles: true, cancelable: true, clientX: tap.x, clientY: tap.y};
        el.dispatchEvent(new PointerEvent("pointerdown", {...options, pointerType: "touch"}));
        el.dispatchEvent(new MouseEvent("mousedown", options));
        el.dispatchEvent(new PointerEvent("pointerup", {...options, pointerType: "touch"}));
        el.dispatchEvent(new MouseEvent("mouseup", options));
        // An SVG shape has no click(): send the event itself.
        if (typeof el.click === "function") el.click();
        else el.dispatchEvent(new MouseEvent("click", options));
        // An in-page link: the frame does not scroll, so the app brings its
        // target up. Measured after the page's own handlers have run.
        const link = el.closest('a[href^="#"]');
        if (link) {
          let name = link.getAttribute("href").slice(1);
          try { name = decodeURIComponent(name); } catch (_) {}
          const target = name ? (document.getElementById(name) || document.getElementsByName(name)[0]) : null;
          if (target) parent.postMessage({...envelope, anchor: target.getBoundingClientRect().top}, "*");
        }
        const focusable = el.closest("input, textarea, select, button, [tabindex], [contenteditable]") || el;
        if (focusable && typeof focusable.focus === "function") focusable.focus();
      }
      // A tap can open a section or a scroll box: settle what it showed.
      setTimeout(function() { if (ready) { settle(); schedule(); } }, 50);
    });
    document.addEventListener("click", function(event) {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (anchor && !anchor.getAttribute("href").startsWith("#")) event.preventDefault();
    }, true);
    window.open = () => null;
  })();`;
  policy.after(bridge);
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "<!DOCTYPE html>";
  return doctype + "\n" + doc.documentElement.outerHTML;
}

export interface LocalHtmlRenderOptions {
  /** Test seam: jsdom does not execute srcdoc. Production appends to body. */
  mount?: (iframe: HTMLIFrameElement) => void;
}

/** Run in an opaque origin once, accepting only this frame's matching reply. */
export function renderLocalHtml(original: string, opts: LocalHtmlRenderOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    let nonce = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (html: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("error", onError);
      iframe.remove();
      resolve(html);
    };
    const onError = () => finish(original);
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!iframe.contentWindow || event.source !== iframe.contentWindow || !data || typeof data !== "object") return;
      const reply = data as { type?: unknown; nonce?: unknown; html?: unknown; error?: unknown };
      if (reply.type !== LOCAL_HTML_MESSAGE || reply.nonce !== nonce) return;
      if (reply.error) { finish(original); return; }
      if (typeof reply.html !== "string") return;
      finish(new TextEncoder().encode(reply.html).byteLength > PAGE_MAX_BYTES ? original : reply.html);
    };
    try {
      nonce = crypto.getRandomValues(new Uint32Array(4)).join("-");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      iframe.style.cssText = `position:fixed;left:-100000px;top:0;width:${webPageWidthForViewport(window.innerWidth)}px;height:900px;visibility:hidden;pointer-events:none;border:0`;
      iframe.srcdoc = localHtmlSrcdoc(original, nonce);
      window.addEventListener("message", onMessage);
      iframe.addEventListener("error", onError);
      timer = setTimeout(onError, LOCAL_HTML_TIMEOUT_MS);
      (opts.mount ?? ((frame) => document.body.append(frame)))(iframe);
    } catch { finish(original); }
  });
}

/** Both the rendered result and static fallback use the normal page freeze. */
export async function freezeLocalHtml(original: string, opts?: LocalHtmlRenderOptions): Promise<string> {
  const rendered = await renderLocalHtml(original, opts);
  const doc = new DOMParser().parseFromString(rendered, "text/html");
  removeRelativeResources(doc);
  const frozen = (await pageFromCapturedHtml(doc.documentElement.outerHTML, "", { mode: "page" })).html;
  void putLiveOriginal(liveOriginalKey(original), original);
  return frozen;
}
