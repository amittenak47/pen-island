import { PAGE_MAX_BYTES, pageFromCapturedHtml, webPageWidthForViewport } from "./webPage";
import { liveOriginalKey, putLiveOriginal } from "./liveHtmlStore";
import { LIVE_PAGE_STORAGE_LIMIT, type LivePageStorage } from "./livePageStorage";

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

/**
 * The live page's policy, opened to the folder its file sits in when there is one.
 *
 * Only that folder's own address: images, video and audio, and the `<base>`
 * that points relative names there. Scripts and styles stay as they were.
 */
export function liveHtmlCsp(assetBase?: string | null): string {
  if (!assetBase) return LIVE_HTML_CSP;
  return LIVE_HTML_CSP
    .replace("img-src https: data: blob:", `img-src https: data: blob: ${assetBase}`)
    .replace("base-uri 'none'", `media-src ${assetBase} blob: data:; base-uri ${assetBase}`);
}

/**
 * The live page, ready for its sandboxed frame.
 *
 * `assetBase` is the address of the folder beside the file (`lcasset`, see
 * htmlAssets.ts). With it, relative names such as `3.7.mp4` load from there,
 * including the ones the page's own scripts write later. Without it they are
 * stripped, as the app has nothing to resolve them against.
 *
 * `storage` is what the page last kept in its `localStorage` (livePageStorage.ts).
 * With it the page gets a working one, seeded from that and reporting each
 * change back; without it, `localStorage` throws there as it always did.
 */
export function liveHtmlSrcdoc(original: string, nonce: string, assetBase?: string | null, storage?: LivePageStorage | null): string {
  const doc = new DOMParser().parseFromString(original, "text/html");
  if (assetBase) doc.querySelectorAll("base").forEach((node) => node.remove());
  else removeRelativeResources(doc);
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = liveHtmlCsp(assetBase);
  doc.head.prepend(policy);
  if (assetBase) {
    const base = doc.createElement("base");
    base.href = assetBase;
    policy.after(base);
  }
  const envelope = JSON.stringify({ type: LIVE_HTML_MESSAGE, nonce }).replace(/</g, "\\u003c");
  const assets = JSON.stringify(assetBase ?? null).replace(/</g, "\\u003c");
  const seeded = JSON.stringify(storage ?? null).replace(/</g, "\\u003c");
  const bridge = doc.createElement("script");
  bridge.textContent = `(function() {
    const envelope = ${envelope};
    const assets = ${assets};
    // The page's localStorage. The real one throws in this sandbox (its
    // origin is opaque), so a page lost every save. This one starts from
    // what the app kept for the document and hands each change back.
    const seeded = ${seeded};
    if (seeded) {
      const items = new Map(Object.entries(seeded));
      let pending = false;
      const changed = function() {
        if (pending) return;
        pending = true;
        queueMicrotask(function() {
          pending = false;
          parent.postMessage({...envelope, storage: Object.fromEntries(items)}, "*");
        });
      };
      const sizeWithout = function(skip) {
        let size = 0;
        for (const [key, value] of items) if (key !== skip) size += key.length + value.length;
        return size;
      };
      const store = {
        get length() { return items.size; },
        key: function(index) { const keys = [...items.keys()]; return index >= 0 && index < keys.length ? keys[index] : null; },
        getItem: function(key) { key = String(key); return items.has(key) ? items.get(key) : null; },
        setItem: function(key, value) {
          key = String(key); value = String(value);
          if (sizeWithout(key) + key.length + value.length > ${LIVE_PAGE_STORAGE_LIMIT}) {
            throw new DOMException("This page's storage is full.", "QuotaExceededError");
          }
          if (items.get(key) !== value) { items.set(key, value); changed(); }
        },
        removeItem: function(key) { if (items.delete(String(key))) changed(); },
        clear: function() { if (items.size) { items.clear(); changed(); } },
      };
      const methods = new Set(Object.keys(store));
      // localStorage.name = value and delete localStorage.name work as they do on the real one.
      const facade = new Proxy(store, {
        get: function(target, name) {
          if (typeof name !== "string" || methods.has(name)) return Reflect.get(target, name);
          return items.has(name) ? items.get(name) : undefined;
        },
        set: function(target, name, value) {
          if (typeof name !== "string" || methods.has(name)) return false;
          store.setItem(name, value);
          return true;
        },
        deleteProperty: function(target, name) { if (typeof name === "string") store.removeItem(name); return true; },
        has: function(target, name) { return methods.has(name) || items.has(name); },
        ownKeys: function() { return [...items.keys()]; },
        getOwnPropertyDescriptor: function(target, name) {
          return items.has(name) ? {value: items.get(name), writable: true, enumerable: true, configurable: true} : undefined;
        },
      });
      try {
        Object.defineProperty(window, "localStorage", {configurable: true, enumerable: true, get: function() { return facade; }});
      } catch (_) {}
    }
    // Nothing of a video or sound loads until it is played. A page's
    // preload="metadata" is free in a browser, but a video whose index sits
    // at its end is read whole to find it, and the page's load (which the app
    // waits on to show it) waits for that too.
    function holdMedia(root) {
      const found = root.matches && root.matches("video, audio") ? [root] : [];
      if (root.querySelectorAll) found.push(...root.querySelectorAll("video, audio"));
      for (const media of found) if (media.getAttribute("preload") !== "none") media.setAttribute("preload", "none");
    }
    if (assets) {
      holdMedia(document);
      new MutationObserver(function(records) {
        for (const record of records) for (const node of record.addedNodes) holdMedia(node);
      }).observe(document, {childList: true, subtree: true});
      // A page that sets src and calls load() in the same step as it adds the
      // player starts loading before the observer runs: hold it right there.
      const media = HTMLMediaElement.prototype;
      if (!media.lcHeld) {
        media.lcHeld = true;
        const load = media.load;
        media.load = function() { holdMedia(this); return load.call(this); };
        const src = Object.getOwnPropertyDescriptor(media, "src");
        if (src && src.set) Object.defineProperty(media, "src", {...src, set: function(value) { holdMedia(this); src.set.call(this, value); }});
      }
    }
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
    // Where the page's own players sit, for the app to let taps through to
    // their controls. Only with the file's folder: no player loads without it.
    let lastPlayers = "[]";
    function players() {
      const boxes = [];
      for (const media of document.querySelectorAll("video[controls], audio[controls]")) {
        const box = media.getBoundingClientRect();
        if (box.width >= 1 && box.height >= 1) boxes.push([box.left, box.top + (window.scrollY || 0), box.width, box.height].map(Math.round));
      }
      return boxes;
    }
    function report() {
      lastReport = performance.now();
      const height = Math.ceil(document.documentElement.scrollHeight);
      if (lastHeight === null || Math.abs(height - lastHeight) > 1) {
        lastHeight = height;
        parent.postMessage({...envelope, height}, "*");
      }
      if (assets) {
        const holes = players();
        const key = JSON.stringify(holes);
        if (key !== lastPlayers) {
          lastPlayers = key;
          parent.postMessage({...envelope, holes}, "*");
        }
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
    // The app's own text selection, answered from in here. The frame takes no
    // pointer, so a hold on the page is the app's gesture, but only this side
    // knows which words lie under it. Boxes go back in the page's own px.
    function readable(node) {
      const el = node.parentElement;
      return Boolean(el && node.data.trim() && !el.closest("script, style, noscript, template")
        && getComputedStyle(el).visibility !== "hidden");
    }
    function wordAt(x, y) {
      let node = null, offset = 0;
      if (document.caretPositionFromPoint) {
        const at = document.caretPositionFromPoint(x, y);
        if (at) { node = at.offsetNode; offset = at.offset; }
      } else if (document.caretRangeFromPoint) {
        const at = document.caretRangeFromPoint(x, y);
        if (at) { node = at.startContainer; offset = at.startOffset; }
      }
      if (!node || node.nodeType !== 3 || !readable(node)) return null;
      const text = node.data;
      const letter = /[\\p{L}\\p{N}_'\\u2019-]/u;
      let start = offset, end = offset;
      while (start > 0 && letter.test(text[start - 1])) start--;
      while (end < text.length && letter.test(text[end])) end++;
      if (start === end) return null;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const rects = [...range.getClientRects()];
      // The caret snaps to the nearest text: a hold on blank space is no word.
      if (!rects.some(r => x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4)) return null;
      return {text: text.slice(start, end), rects};
    }
    // Every text the band touches, as the app's own band reads a still page (textUnder).
    function textInBand(left, top, width, height) {
      const right = left + width, bottom = top + height;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const parts = [], rects = [];
      let code = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.data.trim()) continue;
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if ((!box.width && !box.height) || box.left >= right || box.right <= left || box.top >= bottom || box.bottom <= top) continue;
        if (!readable(node)) continue;
        if (node.parentElement.closest("pre, code")) code = true;
        parts.push(node.data);
        for (const r of range.getClientRects()) {
          if (rects.length < 400 && r.width > 0.5 && r.height > 0.5 && r.left < right && r.right > left && r.top < bottom && r.bottom > top) rects.push(r);
        }
      }
      const text = code
        ? parts.join("").replace(/\\n{3,}/g, "\\n\\n").replace(/[ \\t]+\\n/g, "\\n").trimEnd()
        : parts.join(" ").replace(/\\s+/g, " ").trim();
      return text ? {text, rects} : null;
    }
    function answerSelect(ask) {
      const finite = function(n) { return typeof n === "number" && Number.isFinite(n); };
      let found = null;
      if (Array.isArray(ask.band) && ask.band.length === 4 && ask.band.every(finite)) found = textInBand(...ask.band);
      else if (Array.isArray(ask.point) && ask.point.length === 2 && ask.point.every(finite)) found = wordAt(...ask.point);
      parent.postMessage({...envelope, selected: {
        id: ask.id,
        text: found ? found.text : "",
        rects: found ? found.rects.map(r => [r.left, r.top, r.width, r.height]) : [],
      }}, "*");
    }
    window.addEventListener("message", function(event) {
      const data = event.data;
      if (event.source !== parent || !data || data.type !== envelope.type || data.nonce !== envelope.nonce) return;
      if (data.select && typeof data.select === "object") { answerSelect(data.select); return; }
      const tap = data.tap;
      if (!tap || typeof tap.x !== "number" || typeof tap.y !== "number" || !Number.isFinite(tap.x) || !Number.isFinite(tap.y)) return;
      const el = document.elementFromPoint(tap.x, tap.y);
      // A tap cannot reach a video's own controls (the frame takes no
      // pointer): the app plays it in a player of its own, from here.
      const media = assets && el ? el.closest("video, audio") : null;
      // Never loaded (see holdMedia), it may have no currentSrc yet: its own src says which file.
      const source = media ? media.currentSrc || media.src || (media.querySelector("source[src]") || {}).src || "" : "";
      if (media && typeof source === "string" && source.indexOf(assets) === 0) {
        parent.postMessage({...envelope, media: {src: source, time: media.currentTime || 0, video: media.tagName === "VIDEO"}}, "*");
        media.pause();
        return;
      }
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
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href.startsWith("#")) event.preventDefault();
      // Under a <base>, "#name" would load the folder: keep it in the page.
      else if (assets) {
        event.preventDefault();
        if (location.hash !== href) location.hash = href;
      }
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
