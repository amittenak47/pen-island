/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_MAX_BYTES, webPageWidthForViewport } from "./webPage";
import { docIdentityHash, hashMarkdown } from "./annotateStore";
import { IDBFactory } from "fake-indexeddb";
import { getLiveOriginal, liveOriginalKey } from "./liveHtmlStore";
import {
  freezeLocalHtml, localHtmlSrcdoc, renderLocalHtml, LOCAL_HTML_CSP,
  LOCAL_HTML_MESSAGE, LOCAL_HTML_TIMEOUT_MS, UNPIN_STICKY, UNROLL_SCROLL_BOXES,
  liveHtmlSrcdoc, LIVE_HTML_CSP, LIVE_HTML_MESSAGE,
} from "./localHtmlRender";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function harness(original = "<p>Static fallback</p>") {
  let frame!: HTMLIFrameElement;
  const removed = vi.spyOn(window, "removeEventListener");
  const promise = renderLocalHtml(original, { mount(iframe) { frame = iframe; document.body.append(frame); } });
  const match = frame.srcdoc.match(/"nonce":"([^"]+)"/)!;
  const nonce = match[1];
  const source = frame.contentWindow!;
  const reply = (html: string, overrides: { nonce?: string; source?: Window; type?: string; error?: boolean } = {}) => {
    window.dispatchEvent(new MessageEvent("message", {
      source: overrides.source ?? source,
      data: { type: LOCAL_HTML_MESSAGE, nonce, html, ...overrides },
    }));
  };
  return { promise, frame, reply, removed };
}

describe("local HTML sandbox", () => {
  it.each([
    '<!doctype html><html><head><script>window.authored = true</script></head><body>Body</body></html>',
    '<html><body>Body<script>window.authored = true</script></body></html>',
    '<title>Fragment</title><script>window.authored = true</script><p>Body</p>',
    '<p>Body</p>',
  ])("puts CSP first in a real head, including fragments: %s", (original) => {
    const doc = new DOMParser().parseFromString(localHtmlSrcdoc(original, "unique"), "text/html");
    const first = doc.head.firstChild as HTMLMetaElement;
    expect(first.tagName).toBe("META");
    expect(first.httpEquiv).toBe("Content-Security-Policy");
    expect(first.content).toBe(LOCAL_HTML_CSP);
    expect(doc.body.textContent).toContain("Body");
    expect(doc.body.lastElementChild?.tagName).toBe("SCRIPT");
  });

  it("uses only allow-scripts, an offscreen viewport-sized frame, and cleans up after the right reply", async () => {
    const { promise, frame, reply, removed } = harness();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.style.width).toBe(`${webPageWidthForViewport(window.innerWidth)}px`);
    expect(frame.style.left).toBe("-100000px");
    reply("<p>Rendered table</p>");
    expect(await promise).toBe("<p>Rendered table</p>");
    expect(frame.isConnected).toBe(false);
    expect(removed).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("ignores the wrong source, nonce, type, and malformed messages", async () => {
    const { promise, frame, reply } = harness();
    const other = document.createElement("iframe"); document.body.append(other);
    reply("spoof source", { source: other.contentWindow! });
    reply("spoof nonce", { nonce: "wrong" });
    reply("spoof type", { type: "other" });
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: null }));
    await Promise.resolve();
    expect(frame.isConnected).toBe(true);
    reply("accepted");
    expect(await promise).toBe("accepted");
  });

  it("falls back to the original after four seconds and ignores late replies", async () => {
    vi.useFakeTimers();
    const { promise, frame, reply, removed } = harness();
    await vi.advanceTimersByTimeAsync(LOCAL_HTML_TIMEOUT_MS - 1);
    expect(frame.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBe("<p>Static fallback</p>");
    expect(frame.isConnected).toBe(false);
    expect(removed).toHaveBeenCalledWith("message", expect.any(Function));
    reply("late");
    expect(await promise).toBe("<p>Static fallback</p>");
  });

  it.each(["frame", "script", "mount"])("falls back and removes the frame on %s errors", async (kind) => {
    if (kind === "mount") {
      expect(await renderLocalHtml("original", { mount() { throw new Error("mount failed"); } })).toBe("original");
      return;
    }
    const { promise, frame, reply } = harness();
    if (kind === "frame") frame.dispatchEvent(new Event("error"));
    else reply("", { error: true });
    expect(await promise).toBe("<p>Static fallback</p>");
    expect(frame.isConnected).toBe(false);
  });

  it("falls back when UTF-8 output exceeds the byte cap", async () => {
    const { promise, reply } = harness();
    // Under the character cap, over the byte cap.
    reply("é".repeat(PAGE_MAX_BYTES / 2 + 1));
    expect(await promise).toBe("<p>Static fallback</p>");
  });

  it.each([true, false])("waits for fonts with a cap, then settles before serializing (fonts ready: %s)", async ready => {
    vi.useFakeTimers();
    const doc = new DOMParser().parseFromString(localHtmlSrcdoc("<p>Rendered</p>", "nonce"), "text/html");
    const script = doc.body.lastElementChild!.textContent!;
    let onLoad!: () => Promise<void>;
    const postMessage = vi.fn();
    const fakeWindow = { addEventListener: vi.fn((_event, callback) => { onLoad = callback; }) };
    Object.defineProperty(doc, "fonts", { value: { ready: ready ? Promise.resolve() : new Promise(() => {}) } });
    new Function("window", "document", "parent", script)(fakeWindow, doc, { postMessage });
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith("load", expect.any(Function), { once: true });
    const pending = onLoad();
    await vi.advanceTimersByTimeAsync((ready ? 0 : 1200) + 299);
    expect(postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(postMessage).toHaveBeenCalledWith({ type: LOCAL_HTML_MESSAGE, nonce: "nonce", html: expect.stringMatching(/^<!DOCTYPE html>\n<html>/) }, "*");
  });

  it("never resolves relative images, linked styles, or CSS against the app", () => {
    const doc = new DOMParser().parseFromString(localHtmlSrcdoc(`
      <base href="file:///keep/"><link rel="stylesheet" href="./local.css">
      <style>@import "./local.css"; p { background:url(./figure.png) }</style>
      <img src="./figure.png"><img src="https://example.com/image.png">
      <img data-src="./lazy.png" data-srcset="./lazy-2x.png 2x">
      <a href="#table">Map</a><p id="table">Table</p>`, "nonce"), "text/html");
    expect(doc.querySelector("base")).toBeNull();
    expect(doc.querySelector("link")?.hasAttribute("href")).toBe(false);
    expect(doc.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(doc.querySelectorAll("img")[1].getAttribute("src")).toBe("https://example.com/image.png");
    expect(doc.querySelectorAll("img")[2].hasAttribute("data-src")).toBe(false);
    expect(doc.querySelectorAll("img")[2].hasAttribute("data-srcset")).toBe(false);
    expect(doc.querySelector("style")?.textContent).not.toContain("./");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("#table");
  });
});

describe("live HTML sandbox", () => {
  it.each([
    '<!doctype html><html><head><script>window.authored = true</script></head><body>Body</body></html>',
    '<script>window.authored = true</script><p>Body</p>',
  ])("puts the live CSP first and the nonce bridge before authored scripts: %s", original => {
    const srcdoc = liveHtmlSrcdoc(original, "unique-live-nonce");
    const doc = new DOMParser().parseFromString(srcdoc, "text/html");
    const policy = doc.head.firstElementChild as HTMLMetaElement;
    expect(srcdoc).toMatch(/^<!DOCTYPE html>\n/);
    expect(policy.tagName).toBe("META");
    expect(policy.httpEquiv).toBe("Content-Security-Policy");
    expect(policy.content).toBe(LIVE_HTML_CSP);
    expect(LIVE_HTML_CSP).toBe("default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https:; font-src https: data:; img-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
    expect(policy.nextElementSibling?.tagName).toBe("SCRIPT");
    expect(policy.nextElementSibling?.textContent).toContain(JSON.stringify({ type: LIVE_HTML_MESSAGE, nonce: "unique-live-nonce" }));
    expect(doc.querySelectorAll("script")[1].textContent).toBe("window.authored = true");
  });

  it("removes relative resources but keeps inline scripts and explicit allowed CDN scripts", () => {
    const doc = new DOMParser().parseFromString(liveHtmlSrcdoc(`
      <base href="file:///keep/"><link rel="stylesheet" href="./local.css">
      <script src="./local.js"></script><script src="https://cdn.jsdelivr.net/npm/example/index.js"></script>
      <style>@import "./local.css"; p { background:url(./figure.png) }</style>
      <img src="./figure.png"><img src="https://example.com/image.png">
      <script>window.inlineScript = true</script>`, "n"), "text/html");
    expect(doc.querySelector("base")).toBeNull();
    expect(doc.querySelector("link")?.hasAttribute("href")).toBe(false);
    expect(doc.querySelectorAll("script")[1].hasAttribute("src")).toBe(false);
    expect(doc.querySelectorAll("script")[2].getAttribute("src")).toBe("https://cdn.jsdelivr.net/npm/example/index.js");
    expect(doc.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(doc.querySelectorAll("img")[1].getAttribute("src")).toBe("https://example.com/image.png");
    expect(doc.querySelector("style")?.textContent).not.toContain("./");
    expect(doc.querySelectorAll("script")[3].textContent).toBe("window.inlineScript = true");
  });

  function bridgeHarness() {
    const doc = new DOMParser().parseFromString(liveHtmlSrcdoc('<button><span>Tap</span></button><a href="https://example.com/next">Next</a><a href="#inside">Inside</a>', "n"), "text/html");
    let onLoad!: () => Promise<void>;
    let onMessage!: (event: { source: unknown; data: unknown }) => void;
    let onResize!: () => void;
    let onMutation!: () => void;
    const parent = { postMessage: vi.fn() };
    const fakeWindow = { open: () => ({}), addEventListener: vi.fn((type, callback) => {
      if (type === "load") onLoad = callback;
      if (type === "message") onMessage = callback;
    }) };
    const resizeObserve = vi.fn();
    const mutationObserve = vi.fn();
    class ResizeObserver { constructor(callback: () => void) { onResize = callback; } observe = resizeObserve; }
    class MutationObserver { constructor(callback: () => void) { onMutation = callback; } observe = mutationObserve; }
    class PointerEvent extends MouseEvent {
      pointerType: string;
      constructor(type: string, options: PointerEventInit) { super(type, options); this.pointerType = options.pointerType ?? ""; }
    }
    new Function("window", "document", "parent", "ResizeObserver", "MutationObserver", "PointerEvent", doc.head.querySelector("script")!.textContent!)(
      fakeWindow, doc, parent, ResizeObserver, MutationObserver, PointerEvent,
    );
    return { doc, parent, fakeWindow, resizeObserve, mutationObserve, load: () => onLoad(), resize: () => onResize(), mutate: () => onMutation(), message: (source: unknown, data: unknown) => onMessage({ source, data }) };
  }

  it.each([true, false])("settles after fonts, then throttles changed heights from both observers (fonts ready: %s)", async ready => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const harness = bridgeHarness();
    const { doc, parent } = harness;
    let height = 700;
    Object.defineProperty(doc.documentElement, "scrollHeight", { get: () => height });
    Object.defineProperty(doc, "fonts", { value: { ready: ready ? Promise.resolve() : new Promise(() => {}) } });
    const pending = harness.load();
    await vi.advanceTimersByTimeAsync((ready ? 0 : 1200) + 299);
    expect(parent.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(parent.postMessage).toHaveBeenCalledWith({ type: LIVE_HTML_MESSAGE, nonce: "n", height: 700 }, "*");
    expect(harness.resizeObserve).toHaveBeenCalledWith(doc.body);
    expect(harness.mutationObserve).toHaveBeenCalledWith(doc.body, { childList: true, subtree: true, attributes: true });
    height = 701;
    harness.resize(); harness.mutate();
    await vi.advanceTimersByTimeAsync(200);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    height = 850;
    harness.mutate(); harness.resize();
    await vi.advanceTimersByTimeAsync(199);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: LIVE_HTML_MESSAGE, nonce: "n", height: 850 }, "*");
  });

  it("validates taps, dispatches the event sequence and focuses the closest control", () => {
    const { doc, parent, message } = bridgeHarness();
    const button = doc.querySelector("button")!;
    const span = button.querySelector("span")!;
    const elementFromPoint = vi.fn(() => span);
    Object.defineProperty(doc, "elementFromPoint", { value: elementFromPoint });
    const focus = vi.spyOn(button, "focus");
    const events: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) span.addEventListener(type, event => {
      events.push(event.type);
      expect(event.bubbles).toBe(true);
      expect(event.cancelable).toBe(true);
      if (type !== "click") {
        expect((event as MouseEvent).clientX).toBe(25);
        expect((event as MouseEvent).clientY).toBe(35);
      }
      if (type.startsWith("pointer")) expect((event as PointerEvent).pointerType).toBe("touch");
    });
    const data = { type: LIVE_HTML_MESSAGE, nonce: "n", tap: { x: 25, y: 35 } };
    message({}, data); message(parent, { ...data, nonce: "wrong" });
    message(parent, { ...data, tap: { x: "25", y: 35 } });
    expect(elementFromPoint).not.toHaveBeenCalled();
    message(parent, data);
    expect(elementFromPoint).toHaveBeenCalledWith(25, 35);
    expect(events).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("prevents non-fragment navigation and window.open", () => {
    const { doc, fakeWindow } = bridgeHarness();
    const anchors = doc.querySelectorAll("a");
    const outside = new MouseEvent("click", { bubbles: true, cancelable: true });
    const inside = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchors[0].dispatchEvent(outside); anchors[1].dispatchEvent(inside);
    expect(outside.defaultPrevented).toBe(true);
    expect(inside.defaultPrevented).toBe(false);
    expect(fakeWindow.open()).toBeNull();
  });
});

describe("inner scroll boxes", () => {
  it("grows a box that scrolls vertically and leaves one that fits", () => {
    document.body.innerHTML =
      '<div id="map" style="max-height: 70vh; overflow-x: auto; overflow-y: auto"><table></table></div>' +
      '<div id="fits" style="overflow-x: auto"></div>';
    const map = document.getElementById("map")!;
    const fits = document.getElementById("fits")!;
    Object.defineProperty(map, "scrollHeight", { value: 2000 });
    Object.defineProperty(map, "clientHeight", { value: 600 });
    Object.defineProperty(fits, "scrollHeight", { value: 40 });
    Object.defineProperty(fits, "clientHeight", { value: 40 });
    new Function(UNROLL_SCROLL_BOXES)();
    expect(map.style.getPropertyValue("max-height")).toBe("none");
    expect(map.style.getPropertyPriority("max-height")).toBe("important");
    expect(map.style.getPropertyValue("overflow-y")).toBe("visible");
    expect(fits.getAttribute("style")).toBe("overflow-x: auto");
  });

  it("runs inside the sandbox right before serializing", () => {
    const srcdoc = localHtmlSrcdoc("<p>x</p>", "n");
    expect(srcdoc.indexOf(UNROLL_SCROLL_BOXES)).toBeGreaterThan(-1);
    expect(srcdoc.indexOf(UNROLL_SCROLL_BOXES)).toBeLessThan(srcdoc.indexOf("XMLSerializer().serializeToString(document.doctype)"));
  });
});

describe("pinned bars", () => {
  it("puts sticky and fixed elements back in the flow and leaves the rest", () => {
    document.body.innerHTML =
      '<nav id="toc" style="position: sticky; top: 0">contents</nav>' +
      '<table><tr><th id="th" style="position: sticky; top: 0">h</th></tr></table>' +
      '<div id="bar" style="position: fixed; bottom: 0">bar</div>' +
      '<span id="pin" style="position: absolute; left: 0">x</span>' +
      '<p id="text">text</p>';
    new Function(UNPIN_STICKY)();
    for (const id of ["toc", "th", "bar"]) {
      const el = document.getElementById(id)!;
      expect(el.style.getPropertyValue("position")).toBe("static");
      expect(el.style.getPropertyPriority("position")).toBe("important");
    }
    expect(document.getElementById("pin")!.style.position).toBe("absolute");
    expect(document.getElementById("text")!.getAttribute("style")).toBeNull();
  });

  it("runs in the sandbox after the scroll boxes unroll, before serializing", () => {
    const srcdoc = localHtmlSrcdoc("<p>x</p>", "n");
    expect(srcdoc.indexOf(UNPIN_STICKY)).toBeGreaterThan(srcdoc.indexOf(UNROLL_SCROLL_BOXES));
    expect(srcdoc.indexOf(UNPIN_STICKY)).toBeLessThan(srcdoc.indexOf("XMLSerializer().serializeToString(document.doctype)"));
  });
});

it("has the bridge report an in-page link's target for the board to bring up", () => {
  const srcdoc = liveHtmlSrcdoc('<a href="#a">A</a><h2 id="a">A</h2>', "n-1");
  expect(srcdoc).toContain('el.closest(\'a[href^="#"]\')');
  expect(srcdoc).toContain("anchor: target.getBoundingClientRect().top");
});

describe("local HTML freeze and identity", () => {
  it("saves the original under its own hash without changing the still copy", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const original = '<p>Original</p><script>render()</script>';
    const frozen = await freezeLocalHtml(original, { mount(frame) {
      document.body.append(frame);
      const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: {
        type: LOCAL_HTML_MESSAGE, nonce, html: "<p>Rendered</p>",
      } }));
    } });
    expect(frozen).toContain("Rendered");
    expect(frozen).not.toContain("render()");
    await vi.waitFor(async () => expect(await getLiveOriginal(liveOriginalKey(original))).toBe(original));
  });

  it("keeps explicit HTTPS linked styles without inventing a base address", async () => {
    const fetch = vi.fn(async () => ({ ok: true, text: async () => "p {color:green}" }));
    vi.stubGlobal("fetch", fetch);
    const html = await freezeLocalHtml("original", { mount(frame) {
      document.body.append(frame);
      const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: {
        type: LOCAL_HTML_MESSAGE, nonce,
        html: '<link rel="stylesheet" href="https://example.com/fonts.css"><p>Content</p>',
      } }));
    } });
    expect(fetch).toHaveBeenCalledWith("./__lc-web-fetch?url=https%3A%2F%2Fexample.com%2Ffonts.css");
    expect(html).toContain("color:green");
    expect(html).toContain(".lc-web-doc");
  });

  it("keeps the rendered DOM, strips scripts and handlers, scopes CSS, and uses page mode", async () => {
    const html = await freezeLocalHtml("original", { mount(frame) {
      document.body.append(frame);
      const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: {
        type: LOCAL_HTML_MESSAGE, nonce,
        html: '<html><head><style>td {color:red}</style></head><body><table><tr><td onclick="evil()">Generated</td></tr></table><aside>Keep the whole page</aside><script>evil()</script></body></html>',
      } }));
    } });
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("[onclick]")).toBeNull();
    expect(doc.querySelector("td")?.textContent).toBe("Generated");
    expect(doc.querySelector("aside")?.textContent).toBe("Keep the whole page");
    expect(doc.querySelector("style")?.textContent).toContain(".lc-web-doc");
  });

  it("also sanitizes the static fallback", async () => {
    vi.useFakeTimers();
    const pending = freezeLocalHtml('<p onclick="evil()">Original</p><script>evil()</script>');
    await vi.advanceTimersByTimeAsync(LOCAL_HTML_TIMEOUT_MS);
    const html = await pending;
    expect(html).toContain("Original");
    expect(html).not.toMatch(/<script|onclick/);
  });

  it("keys different renders by the original text, and changed files get a new identity", () => {
    const original = '<p id="table"></p><script>render(Date.now())</script>';
    const localFileHash = hashMarkdown(original);
    const first = docIdentityHash({ docType: "web", name: "guide.html", text: "<p>First render</p>", localFileHash });
    const second = docIdentityHash({ docType: "web", name: "renamed.html", text: "<p>Second render</p>", localFileHash });
    expect(first).toBe(localFileHash);
    expect(second).toBe(first);
    expect(docIdentityHash({ docType: "web", name: "guide.html", localFileHash: hashMarkdown(original + "changed") })).not.toBe(first);
    expect(docIdentityHash({ docType: "web", name: "https://example.com", text: "one" })).toBe(
      docIdentityHash({ docType: "web", name: "https://example.com/", text: "two" }),
    );
  });
});

describe("live HTML with its file's folder", () => {
  const base = "http://lcasset.localhost/0123abcd/";
  const page = `<base href="file:///elsewhere/"><img src="official/p-1.png">
    <details><summary>Video</summary><video controls src="3.7.mp4"></video></details>
    <a href="#w5">Week 5</a><a href="https://example.com/">Out</a><p id="w5">Week 5</p>`;

  it("keeps relative names and points them at the folder, opening only that address", () => {
    const doc = new DOMParser().parseFromString(liveHtmlSrcdoc(page, "n", base), "text/html");
    const policy = doc.head.firstElementChild as HTMLMetaElement;
    expect(policy.content).toBe(LIVE_HTML_CSP
      .replace("img-src https: data: blob:", `img-src https: data: blob: ${base}`)
      .replace("base-uri 'none'", `media-src ${base} blob: data:; base-uri ${base}`));
    expect([...doc.querySelectorAll("base")].map(node => node.getAttribute("href"))).toEqual([base]);
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("official/p-1.png");
    expect(doc.querySelector("video")?.getAttribute("src")).toBe("3.7.mp4");
  });

  it("still strips relative names when the folder is not available", () => {
    const doc = new DOMParser().parseFromString(liveHtmlSrcdoc(page, "n", null), "text/html");
    expect(doc.querySelector("base")).toBeNull();
    expect(doc.querySelector("video")?.hasAttribute("src")).toBe(false);
    expect((doc.head.firstElementChild as HTMLMetaElement).content).toBe(LIVE_HTML_CSP);
  });

  function run(assetBase: string | null) {
    const doc = new DOMParser().parseFromString(liveHtmlSrcdoc(page, "n", assetBase), "text/html");
    let onMessage!: (event: { source: unknown; data: unknown }) => void;
    let onLoad!: () => Promise<void>;
    const parent = { postMessage: vi.fn() };
    const fakeWindow = { open: () => ({}), addEventListener: vi.fn((type, callback) => {
      if (type === "message") onMessage = callback;
      if (type === "load") onLoad = callback;
    }) };
    const location = { hash: "" };
    const bridge = [...doc.head.querySelectorAll("script")].find(node => node.textContent?.includes("const assets"))!;
    new Function("window", "document", "parent", "ResizeObserver", "MutationObserver", "PointerEvent", "location", bridge.textContent!)(
      fakeWindow, doc, parent, class { observe() {} }, class { observe() {} }, MouseEvent, location,
    );
    const video = doc.querySelector("video")!;
    Object.defineProperty(video, "currentSrc", { value: assetBase ? `${assetBase}3.7.mp4` : "" });
    Object.defineProperty(video, "currentTime", { value: 42.5 });
    const pause = vi.fn();
    Object.defineProperty(video, "pause", { value: pause });
    const tapOn = (el: Element) => {
      Object.defineProperty(doc, "elementFromPoint", { value: () => el, configurable: true });
      onMessage({ source: parent, data: { type: LIVE_HTML_MESSAGE, nonce: "n", tap: { x: 1, y: 1 } } });
    };
    return { doc, parent, location, video, pause, tapOn, load: () => onLoad() };
  }

  it("reports where the page's players sit, once per change", async () => {
    vi.useFakeTimers();
    const { doc, parent, video, load } = run(base);
    Object.defineProperty(doc, "fonts", { value: { ready: Promise.resolve() } });
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue({ left: 10.4, top: 300, width: 640, height: 360 } as DOMRect);
    const pending = load();
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    const holes = parent.postMessage.mock.calls.filter(([data]) => "holes" in data);
    expect(holes).toEqual([[{ type: LIVE_HTML_MESSAGE, nonce: "n", holes: [[10, 300, 640, 360]] }, "*"]]);
  });

  it("hands a tapped video from the folder to the app, at its time, and pauses it", () => {
    const { parent, video, pause, tapOn } = run(base);
    tapOn(video);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: LIVE_HTML_MESSAGE, nonce: "n",
      media: { src: `${base}3.7.mp4`, time: 42.5, video: true } }, "*");
    expect(pause).toHaveBeenCalled();
  });

  it("keeps a page's own # links in the page instead of loading the folder", () => {
    const { doc, location } = run(base);
    const [inside, outside] = doc.querySelectorAll("a");
    const insideClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    const outsideClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    inside.dispatchEvent(insideClick); outside.dispatchEvent(outsideClick);
    expect(insideClick.defaultPrevented).toBe(true);
    expect(location.hash).toBe("#w5");
    expect(outsideClick.defaultPrevented).toBe(true);
  });
});
