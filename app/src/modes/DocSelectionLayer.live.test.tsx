/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ frame: null as HTMLIFrameElement | null, select: vi.fn() }));
vi.mock("./LiveHtmlFrame", () => ({
  liveFrameIn: () => live.frame,
  selectInLivePage: live.select,
}));

import { DocSelectionLayer, type DocSelectionLayerProps } from "./DocSelectionLayer";

let host: HTMLDivElement;
let root: Root;
let hitTest: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 800, 1000));
  hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  live.frame = document.createElement("iframe");
  live.select.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
  document.body.textContent = "";
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
  return event;
}

function mount(props: Partial<DocSelectionLayerProps> = {}) {
  act(() => root.render(<DocSelectionLayer footnotes={[]} onAnnotate={vi.fn()} onSearch={vi.fn()} onAskChatBot={vi.fn()}
    onCopy={vi.fn()} {...props}>
    <div data-doc-scope="page"><p>Still copy, hidden under the live page</p></div>
  </DocSelectionLayer>));
  const page = host.querySelector<HTMLElement>("[data-doc-scope]")!;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => page });
  return page;
}

const labels = () => [...document.querySelectorAll<HTMLButtonElement>(".lc-doc-sheet-action")].map(b => b.textContent);

it("reads a band swept over a live page from the page, and offers no mark for it", async () => {
  live.select.mockResolvedValue({ text: "Words the page has", rects: [new DOMRect(30, 50, 150, 20)] });
  const onScreenshot = vi.fn(() => true);
  const page = mount({ onScreenshot });
  act(() => page.dispatchEvent(pointer("pointerdown", 40, 60)));
  act(() => { vi.advanceTimersByTime(400); });
  act(() => page.dispatchEvent(pointer("pointermove", 160, 80)));
  await act(async () => page.dispatchEvent(pointer("pointerup", 160, 80)));
  expect(live.select).toHaveBeenCalledWith(live.frame, { band: expect.objectContaining({ left: 40, top: 60, width: 120, height: 20 }) });
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Use this selection"]')!.click());
  expect(labels()).toEqual(["▣Screenshot", "Copy"]);
  await act(async () => document.querySelector<HTMLButtonElement>(".lc-doc-sheet-action")!.click());
  expect(onScreenshot).toHaveBeenCalledTimes(1);
  // Every box here measures as the whole page; the drawn selection still gives the screenshot its bounds.
  expect(onScreenshot.mock.calls[0]).toEqual([expect.objectContaining({ text: "Words the page has", live: true }), new DOMRect(0, 0, 800, 1000), expect.anything()]);
});

it("keeps drawing a band that covers the whole page", () => {
  const page = mount();
  act(() => page.dispatchEvent(pointer("pointerdown", 20, 20)));
  act(() => { vi.advanceTimersByTime(400); });
  act(() => page.dispatchEvent(pointer("pointermove", 780, 980)));
  expect(document.querySelector(".lc-doc-marquee-band")).not.toBeNull();
});

async function drawBox(page: HTMLElement) {
  live.select.mockResolvedValue({ text: "Words the page has", rects: [new DOMRect(30, 50, 150, 20)] });
  act(() => page.dispatchEvent(pointer("pointerdown", 40, 60)));
  act(() => { vi.advanceTimersByTime(400); });
  act(() => page.dispatchEvent(pointer("pointermove", 160, 80)));
  await act(async () => page.dispatchEvent(pointer("pointerup", 160, 80)));
}

it("keeps the box and its handles through a pan, and drops them on a tap", async () => {
  const page = mount();
  await drawBox(page);
  expect(document.querySelector(".lc-doc-marquee-band")).not.toBeNull();
  expect(document.querySelectorAll("[data-box-handle]")).toHaveLength(8);
  act(() => page.dispatchEvent(pointer("pointerdown", 300, 400)));
  act(() => page.dispatchEvent(pointer("pointermove", 300, 200)));
  act(() => page.dispatchEvent(pointer("pointerup", 300, 200)));
  expect(document.querySelector('[aria-label="Use this selection"]')).not.toBeNull();
  act(() => page.dispatchEvent(pointer("pointerdown", 300, 400)));
  act(() => page.dispatchEvent(pointer("pointerup", 300, 400)));
  expect(document.querySelector('[aria-label="Use this selection"]')).toBeNull();
});

it("grows the box from its bottom handle", async () => {
  const page = mount();
  await drawBox(page);
  const handle = document.querySelector<HTMLElement>('[data-box-handle="s"]')!;
  act(() => handle.dispatchEvent(pointer("pointerdown", 100, 84)));
  act(() => handle.dispatchEvent(pointer("pointermove", 100, 304)));
  expect(document.querySelector<HTMLElement>(".lc-doc-marquee-band")!.style.height).toBe("240px");
  await act(async () => handle.dispatchEvent(pointer("pointerup", 100, 304)));
  // The finger landed 4px under the edge; the box keeps its width and grows by the drag.
  expect(live.select).toHaveBeenLastCalledWith(live.frame, { band: expect.objectContaining({ left: 40, top: 60, width: 120, height: 240 }) });
  expect(document.querySelectorAll("[data-box-handle]")).toHaveLength(8);
});

it("takes the word under a hold that does not move on a live page", async () => {
  live.select.mockResolvedValue({ text: "beta", rects: [new DOMRect(60, 50, 40, 20)] });
  const changed = vi.fn();
  const page = mount({ onSelectionChange: changed });
  act(() => page.dispatchEvent(pointer("pointerdown", 75, 60)));
  act(() => { vi.advanceTimersByTime(400); });
  await act(async () => page.dispatchEvent(pointer("pointerup", 75, 60)));
  expect(live.select).toHaveBeenCalledWith(live.frame, { point: { x: 75, y: 60 } });
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ text: "beta", live: true }));
  expect(labels()).toEqual(["Copy"]);
});

it("leaves a still page's hold to the page", async () => {
  live.frame = null;
  const changed = vi.fn();
  const page = mount({ onSelectionChange: changed });
  act(() => page.dispatchEvent(pointer("pointerdown", 75, 60)));
  act(() => { vi.advanceTimersByTime(400); });
  await act(async () => page.dispatchEvent(pointer("pointerup", 75, 60)));
  expect(live.select).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({ live: true }));
});
