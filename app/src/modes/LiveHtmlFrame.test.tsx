/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LIVE_HTML_MESSAGE } from "../util/localHtmlRender";
import { LiveHtmlFrame } from "./LiveHtmlFrame";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mount() {
  const onHeight = vi.fn();
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={onHeight} />));
  const frame = host.querySelector("iframe")!;
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  const report = (height: unknown, overrides: { source?: Window; nonce?: string; type?: string } = {}) => {
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: overrides.source ?? frame.contentWindow,
      data: { type: LIVE_HTML_MESSAGE, nonce, height, ...overrides },
    })));
  };
  return { frame, nonce, onHeight, report };
}

function tapHarness(frame: HTMLIFrameElement) {
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
    left: 100, top: 200, right: 300, bottom: 500, width: 200, height: 300, x: 100, y: 200, toJSON() {},
  });
  Object.defineProperty(frame, "offsetWidth", { value: 800 });
  Object.defineProperty(frame, "offsetHeight", { value: 1200 });
  return vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
}

function pointer(type: string, overrides: Partial<PointerEventInit> = {}, time = 100, target: Element = host) {
  const values = { clientX: 150, clientY: 250, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, ...overrides };
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...values });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId }, pointerType: { value: values.pointerType },
    isPrimary: { value: values.isPrimary }, timeStamp: { value: time },
  });
  const prevent = vi.spyOn(event, "preventDefault");
  const stop = vi.spyOn(event, "stopPropagation");
  act(() => target.dispatchEvent(event));
  expect(prevent).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
}

it("uses only allow-scripts and stays hidden until a valid height arrives", async () => {
  const { frame, onHeight, report } = await mount();
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.title).toBe("Live page");
  expect(frame.style.pointerEvents).toBe("none");
  expect(frame.style.height).toBe("0px");
  expect(frame.style.visibility).toBe("hidden");
  expect(frame.style.opacity).toBe("0");
  const other = document.createElement("iframe"); document.body.append(other);
  report(100, { source: other.contentWindow! });
  report(100, { nonce: "forged" });
  report(100, { type: "other" });
  for (const height of ["100", -1, NaN, Infinity, null]) report(height);
  expect(onHeight).not.toHaveBeenCalled();
  expect(frame.style.height).toBe("0px");
  report(640);
  expect(frame.style.height).toBe("640px");
  expect(frame.style.visibility).toBe("visible");
  expect(frame.style.opacity).toBe("1");
  expect(onHeight).toHaveBeenCalledTimes(1);
  expect(onHeight).toHaveBeenCalledWith(640);
});

it("stops the sixth rapid growth until the original changes, while still accepting shrinkage", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { frame, onHeight, report } = await mount();
  for (let i = 1; i <= 6; i += 1) { now = i * 200; report(i * 100); }
  expect(frame.style.height).toBe("500px");
  expect(onHeight).toHaveBeenCalledTimes(5);
  now = 10000; report(700);
  expect(frame.style.height).toBe("500px");
  report(450); report(460);
  expect(frame.style.height).toBe("450px");
  const oldNonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  await act(async () => root.render(<LiveHtmlFrame original="<p>New original</p>" onHeight={onHeight} />));
  const nextFrame = host.querySelector("iframe")!;
  const nonce = nextFrame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  expect(nonce).not.toBe(oldNonce);
  expect(nextFrame.style.height).toBe("0px");
  act(() => window.dispatchEvent(new MessageEvent("message", {
    source: nextFrame.contentWindow, data: { type: LIVE_HTML_MESSAGE, nonce, height: 900 },
  })));
  expect(nextFrame.style.height).toBe("900px");
});

it("allows growth spaced at least 400 ms apart", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { frame, report } = await mount();
  for (let i = 1; i <= 8; i += 1) { now = i * 400; report(i * 100); }
  expect(frame.style.height).toBe("800px");
});

it("counts all consecutive growth in the two-second window before a rapid sixth report", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { frame, report } = await mount();
  for (const [index, time] of [0, 500, 700, 900, 1100, 1300].entries()) {
    now = time; report((index + 1) * 100);
  }
  expect(frame.style.height).toBe("500px");
});

it.each(["touch", "mouse"])("forwards a primary %s tap in frame CSS pixels without consuming it", async pointerType => {
  const { frame, nonce } = await mount();
  const postMessage = tapHarness(frame);
  pointer("pointerdown", { pointerType });
  pointer("pointerup", { pointerType, clientX: 154, clientY: 253 }, 300);
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith({ type: LIVE_HTML_MESSAGE, nonce, tap: { x: 216, y: 212 } }, "*");
});

it("drops drags, long presses, cancelled taps, secondary pointers, pen and right mouse presses", async () => {
  const { frame } = await mount();
  const postMessage = tapHarness(frame);
  pointer("pointerdown"); pointer("pointermove", { clientX: 159 }); pointer("pointerup");
  pointer("pointerdown"); pointer("pointerup", {}, 551);
  pointer("pointerdown"); pointer("pointercancel"); pointer("pointerup");
  pointer("pointerdown"); pointer("pointerdown", { pointerId: 2, isPrimary: false }); pointer("pointerup");
  for (const overrides of [{ pointerType: "pen" }, { isPrimary: false }, { pointerType: "mouse", button: 2 }, { clientX: 99 }]) {
    pointer("pointerdown", overrides); pointer("pointerup", overrides);
  }
  expect(postMessage).not.toHaveBeenCalled();
});

it.each([
  "button", "a", "input", "textarea", "select", "[role='button']", "[role='menu']", "[role='dialog']",
  ".lc-board-chrome-slot", ".lc-map-controls", ".lc-doc-footnote", ".lc-doc-footnote-pack", ".lc-footnote-bubble",
  ".lc-doc-select-overlay", ".lc-doc-sheet", ".lc-doc-confirm", ".lc-toolbar",
])("ignores taps in %s", async selector => {
  const { frame } = await mount();
  const postMessage = tapHarness(frame);
  const target = document.createElement(selector.startsWith(".") || selector.startsWith("[") ? "div" : selector);
  if (selector.startsWith(".")) target.className = selector.slice(1);
  if (selector.startsWith("[")) target.setAttribute("role", selector.match(/'([^']+)'/)![1]);
  host.append(target);
  pointer("pointerdown", {}, 100, target); pointer("pointerup", {}, 200, target);
  expect(postMessage).not.toHaveBeenCalled();
});

it("removes all window listeners on unmount", async () => {
  const removed = vi.spyOn(window, "removeEventListener");
  await mount();
  act(() => root.unmount());
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    expect(removed).toHaveBeenCalledWith(type, expect.any(Function), { capture: true, passive: true });
  }
  expect(removed).toHaveBeenCalledWith("message", expect.any(Function));
  root = createRoot(host);
});

it("reports an in-page link's target at its client y, scaled from the page's own px", async () => {
  const onAnchor = vi.fn();
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={vi.fn()} onAnchor={onAnchor} />));
  const frame = host.querySelector("iframe")!;
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  tapHarness(frame);
  const send = (data: object, source: Window | null = frame.contentWindow) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { source, data: { type: LIVE_HTML_MESSAGE, ...data } })));
  // Another window, or the wrong nonce, is not the page.
  send({ nonce, anchor: 600 }, window);
  send({ nonce: "forged", anchor: 600 });
  expect(onAnchor).not.toHaveBeenCalled();
  // 600 of the frame's 1200 px, in a frame drawn 300 px tall from y 200.
  send({ nonce, anchor: 600 });
  expect(onAnchor).toHaveBeenCalledWith(350);
});

it("plays a video from the page's folder in a player over the app, and ignores any other address", async () => {
  const base = "http://lcasset.localhost/0123abcd/";
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={vi.fn()} assetBase={base} />));
  const frame = host.querySelector("iframe")!;
  expect(frame.srcdoc).toContain(`<base href="${base}">`);
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  const send = (media: object) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: LIVE_HTML_MESSAGE, nonce, media } })));
  send({ src: "https://example.com/3.7.mp4", time: 3, video: true });
  send({ src: "http://lcasset.localhost/other/3.7.mp4", time: 3, video: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  send({ src: `${base}3.7.mp4`, time: 42.5, video: true });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-label")).toBe("3.7.mp4");
  const video = dialog.querySelector("video")!;
  expect(video.getAttribute("src")).toBe(`${base}3.7.mp4`);
  expect(video.controls).toBe(true);
  act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
  expect(video.currentTime).toBe(42.5);
  await act(async () => { (dialog.querySelector('[aria-label="Close 3.7.mp4"]') as HTMLButtonElement).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("never opens a player for a page without a folder", async () => {
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={vi.fn()} />));
  const frame = host.querySelector("iframe")!;
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow,
    data: { type: LIVE_HTML_MESSAGE, nonce, media: { src: "http://lcasset.localhost/x/3.7.mp4", time: 0, video: true } } })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("lets taps through to the page's players only, and only with the page's folder", async () => {
  const base = "http://lcasset.localhost/0123abcd/";
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={vi.fn()} assetBase={base} />));
  const frame = host.querySelector("iframe")!;
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  const send = (holes: unknown) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: LIVE_HTML_MESSAGE, nonce, holes } })));
  expect(host.querySelector(".lc-live-html-catcher")).toBeNull();
  expect(frame.classList.contains("has-players")).toBe(false);
  send([[10, 300, 640, 360]]);
  expect(frame.classList.contains("has-players")).toBe(true);
  const catcher = host.querySelector<HTMLElement>(".lc-live-html-catcher")!;
  expect(catcher.getAttribute("style")).toContain('path(evenodd, "M-1 -1H1000000V100000000H-1ZM10 300h640v360h-640Z")');
  send([[10, 300, "640", 360]]);
  send([[10, 300, 0, 360]]);
  expect(host.querySelector<HTMLElement>(".lc-live-html-catcher")!.getAttribute("style")).toContain("M10 300h640v360h-640Z");
  send([]);
  expect(host.querySelector(".lc-live-html-catcher")).toBeNull();
  expect(frame.classList.contains("has-players")).toBe(false);
});

it("ignores player boxes from a page without a folder", async () => {
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={vi.fn()} />));
  const frame = host.querySelector("iframe")!;
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow,
    data: { type: LIVE_HTML_MESSAGE, nonce, holes: [[0, 0, 100, 100]] } })));
  expect(host.querySelector(".lc-live-html-catcher")).toBeNull();
});

it("seeds the page's localStorage from its document and keeps each change it reports", async () => {
  localStorage.setItem("lc-live-page-storage:doc-1", JSON.stringify({ "bbt-page": "tracer" }));
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={vi.fn()} storageId="doc-1" />));
  const frame = host.querySelector("iframe")!;
  expect(frame.srcdoc).toContain('const seeded = {"bbt-page":"tracer"};');
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  const send = (storage: unknown, source: Window | null = frame.contentWindow) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { source, data: { type: LIVE_HTML_MESSAGE, nonce, storage } })));
  send({ "bbt-page": "problems" }, window);
  send([1, 2]);
  expect(JSON.parse(localStorage.getItem("lc-live-page-storage:doc-1")!)).toEqual({ "bbt-page": "tracer" });
  const srcdoc = frame.srcdoc;
  send({ "bbt-page": "problems", "bbt-last": "{}" });
  expect(JSON.parse(localStorage.getItem("lc-live-page-storage:doc-1")!)).toEqual({ "bbt-page": "problems", "bbt-last": "{}" });
  // A save never rebuilds the page.
  expect(host.querySelector("iframe")!.srcdoc).toBe(srcdoc);
  localStorage.clear();
});

it("gives a page with no document no storage of its own", async () => {
  await act(async () => root.render(<LiveHtmlFrame original="<p>Live original</p>" onHeight={vi.fn()} />));
  const frame = host.querySelector("iframe")!;
  expect(frame.srcdoc).toContain("const seeded = null;");
  const nonce = frame.srcdoc.match(/"nonce":"([^"]+)"/)![1];
  act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: LIVE_HTML_MESSAGE, nonce, storage: { a: "1" } } })));
  expect(localStorage.length).toBe(0);
});
