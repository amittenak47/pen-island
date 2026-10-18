/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_MAX_BYTES, webPageWidthForViewport } from "./webPage";
import { docIdentityHash, hashMarkdown } from "./annotateStore";
import {
  freezeLocalHtml, localHtmlSrcdoc, renderLocalHtml, LOCAL_HTML_CSP,
  LOCAL_HTML_MESSAGE, LOCAL_HTML_TIMEOUT_MS, UNPIN_STICKY, UNROLL_SCROLL_BOXES,
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

describe("local HTML freeze and identity", () => {
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
