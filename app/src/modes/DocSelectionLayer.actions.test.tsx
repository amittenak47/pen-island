/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocSelectionLayer, type DocSelectionLayerProps } from "./DocSelectionLayer";
import { selectionCaptureFailure, type SelectionActionContext, type SelectionActionResult } from "./selectionAction";
import { registerPdfQuoteTextFill } from "./pdfQuoteText";

let host: HTMLDivElement;
let root: Root;
const footnotes: NonNullable<DocSelectionLayerProps["footnotes"]> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(cb => { cb(0); return 1; });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => {
    return new DOMRect(0, 0, 800, 1000);
  });
  Range.prototype.getClientRects = () => [new DOMRect(30, 50, 150, 20)] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(30, 50, 150, 20);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); window.getSelection()?.removeAllRanges(); document.body.textContent = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
async function mount(onAskAgent: DocSelectionLayerProps["onAskAgent"]) {
  act(() => root.render(<DocSelectionLayer footnotes={footnotes} onAskAgent={onAskAgent}><p data-doc-scope="p1">Selected words for a question</p></DocSelectionLayer>));
  const text = host.querySelector("p")!.firstChild!;
  const range = document.createRange(); range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  await act(async () => { text.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
}

it("keeps the selection after failed capture and opens text-only only on explicit tap", async () => {
  const draft = vi.fn();
  await mount((selection, _rect, context) => selectionCaptureFailure("Capture failed", selection.text, context, draft));
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  expect(ask).toBeTruthy();
  await act(async () => ask.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Capture failed");
  expect(button("Continue with text only")).toBeTruthy();
  expect(draft).not.toHaveBeenCalled();
  await act(async () => button("Continue with text only").click());
  expect(draft).toHaveBeenCalledTimes(1);
});

it("invalidates a pending capture on unmount", async () => {
  let context!: SelectionActionContext;
  let finish!: (result: SelectionActionResult) => void;
  await mount((_selection, _rect, current) => { context = current; return new Promise(resolve => { finish = resolve; }); });
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  await act(async () => ask.click());
  expect(context.isCurrent()).toBe(true);
  act(() => root.render(null));
  expect(context.isCurrent()).toBe(false);
  await act(async () => finish(true));
});

it("shows no continuation when the failed selection has no usable text", async () => {
  await mount((_selection, _rect, context) => selectionCaptureFailure("Image unavailable", "", context, vi.fn()));
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  await act(async () => ask.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Image unavailable");
  expect(button("Continue with text only")).toBeUndefined();
});

it("dismissal invalidates a capture before its late failure can offer a fallback", async () => {
  let context!: SelectionActionContext;
  let finish!: (result: SelectionActionResult) => void;
  const draft = vi.fn();
  await mount((_selection, _rect, current) => { context = current; return new Promise(resolve => { finish = resolve; }); });
  const ask = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes("Ask Agent"))!;
  await act(async () => ask.click());
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss selection actions"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
  expect(context.isCurrent()).toBe(false);
  await act(async () => finish(selectionCaptureFailure("Late failure", "Words", context, draft)));
  expect(button("Continue with text only")).toBeUndefined();
  expect(draft).not.toHaveBeenCalled();
});

it("reports the current native selection to document chrome and clears it on dismissal", async () => {
  const changed = vi.fn();
  act(() => root.render(<DocSelectionLayer footnotes={footnotes} onSelectionChange={changed}><p data-doc-scope="p1">Selected words for a question</p></DocSelectionLayer>));
  const text = host.querySelector("p")!.firstChild!;
  const range = document.createRange(); range.selectNodeContents(text);
  window.getSelection()!.addRange(range);
  await act(async () => { text.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
    text: "Selected words for a question",
    anchor: expect.objectContaining({ kind: "text", scope: "p1" }),
  }));
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss selection actions"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
  expect(changed).toHaveBeenLastCalledWith(null);
  act(() => root.render(null));
  expect(changed).toHaveBeenLastCalledWith(null);
});

function touchDown(target: EventTarget, pointerId: number) {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 60 });
  Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: "touch" } });
  target.dispatchEvent(event);
}

it("lets a second finger make a pinch instead of arming a hold", () => {
  vi.useFakeTimers();
  try {
    act(() => root.render(<DocSelectionLayer footnotes={footnotes}><p data-doc-scope="p1">Words to pinch over</p></DocSelectionLayer>));
    const layer = host.querySelector<HTMLElement>(".lc-doc-selectable")!;
    // The board takes the pinch at its root: the second finger stops there.
    const board = host.querySelector("p")!;
    board.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
    act(() => touchDown(host.querySelector(".lc-doc-selectable-body")!, 1));
    act(() => touchDown(board, 2));
    act(() => { vi.advanceTimersByTime(400); });
    expect(layer.classList.contains("lc-doc-selecting")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("still arms a hold left alone", () => {
  vi.useFakeTimers();
  try {
    act(() => root.render(<DocSelectionLayer footnotes={footnotes}><p data-doc-scope="p1">Words to hold</p></DocSelectionLayer>));
    const layer = host.querySelector<HTMLElement>(".lc-doc-selectable")!;
    act(() => touchDown(host.querySelector("p")!, 1));
    act(() => { vi.advanceTimersByTime(400); });
    expect(layer.classList.contains("lc-doc-selecting")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("offers ChatBot for an Android quote marquee with a durable text anchor", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Android");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const originalHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const ask = vi.fn();
  const changed = vi.fn();
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
    return event;
  };
  try {
    act(() => root.render(<DocSelectionLayer footnotes={footnotes} onAskChatBot={ask} onSelectionChange={changed}><p data-doc-scope="p1">Selected words for a question</p></DocSelectionLayer>));
    const text = host.querySelector("p")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => text });
    act(() => text.dispatchEvent(pointer("pointerdown", 40, 60)));
    act(() => { vi.advanceTimersByTime(400); });
    act(() => text.dispatchEvent(pointer("pointermove", 160, 80)));
    act(() => text.dispatchEvent(pointer("pointerup", 160, 80)));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Selected words for a question" }));
    const tray = document.createElement("button");
    tray.className = "lc-chatbot-tray";
    document.body.append(tray);
    act(() => tray.dispatchEvent(pointer("pointerdown", 800, 60)));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Selected words for a question" }));
    const confirm = document.querySelector<HTMLButtonElement>('[aria-label="Use this selection"]');
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());
    const action = document.querySelector<HTMLButtonElement>('[aria-label="Ask ChatBot"]');
    expect(action).toBeTruthy();
    await act(async () => action!.click());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      anchor: expect.objectContaining({ kind: "text", exact: "Selected words for a question", scope: "p1" }), text: "Selected words for a question",
    }));
  } finally {
    if (originalHitTest) Object.defineProperty(document, "elementFromPoint", originalHitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
    vi.useRealTimers();
  }
});

it.each(["mouse", "pen"])("finishes a %s quote after filling a PDF page that had no selectable text", async (pointerType) => {
  const changed = vi.fn();
  let finish!: () => void;
  const fill = vi.fn(async () => new Promise<boolean>(resolve => {
    finish = () => {
      host.querySelector(".lc-pdf-text")!.textContent = "Selected words for a question";
      resolve(true);
    };
  }));
  const stop = registerPdfQuoteTextFill("empty-pdf", fill);
  const descriptors = ["elementFromPoint", "caretRangeFromPoint"].map(key => [key, Object.getOwnPropertyDescriptor(document, key)] as const);
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 60 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
    return event;
  };
  try {
    act(() => root.render(<DocSelectionLayer paletteScope="empty-pdf" footnotes={footnotes} onSelectionChange={changed}>
      <div data-doc-scope="p4" data-pdf-page="4"><div className="lc-pdf-text textLayer" /></div>
    </DocSelectionLayer>));
    const page = host.querySelector<HTMLElement>("[data-pdf-page]")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => page });
    Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: (x: number) => {
      const node = page.querySelector(".lc-pdf-text")!.firstChild!;
      const range = document.createRange();
      range.setStart(node, x < 100 ? 0 : node.textContent!.length); range.collapse(true); return range;
    } });
    act(() => page.dispatchEvent(pointer("pointerdown", 40)));
    expect(fill).toHaveBeenCalledWith(4);
    act(() => page.dispatchEvent(pointer("pointerup", 160)));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => finish());
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Selected words for a question", anchor: expect.objectContaining({ kind: "text", scope: "p4", start: 0, end: 29 }),
    }));
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
  } finally {
    stop();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(document, key, descriptor);
      else Reflect.deleteProperty(document, key);
    }
  }
});

it.each([false, true])("snaps an underline to the same words after a PDF drag (deferred fill: %s)", async (deferred) => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const add = vi.fn();
  let finishFill!: () => void;
  const fill = vi.fn(() => new Promise<boolean>(resolve => {
    finishFill = () => {
      host.querySelector(".lc-pdf-text")!.innerHTML = "<span>Selected words for a question</span>";
      resolve(true);
    };
  }));
  const stop = registerPdfQuoteTextFill("underline-pdf", fill);
  const descriptors = ["elementFromPoint", "caretRangeFromPoint"].map(key => [key, Object.getOwnPropertyDescriptor(document, key)] as const);
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 60 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "pen" } });
    return event;
  };
  try {
    act(() => root.render(<DocSelectionLayer paletteScope="underline-pdf" footnotes={footnotes} subMarkMode="underline" onAddSubMark={add}
      subMarkParent={{ id: "parent", kind: "note", createdAt: 1, excerpt: "Selected words for a question",
        anchor: { kind: "text", scope: "p4", start: 0, end: 29 }, bands: [{ left: 30, top: 50, width: 150, height: 20 }] }}>
      <div data-doc-scope="p4" data-pdf-page="4"><div className="lc-pdf-text textLayer">{!deferred && <span>Selected words for a question</span>}</div></div>
    </DocSelectionLayer>));
    const page = host.querySelector<HTMLElement>("[data-pdf-page]")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => page });
    Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: (x: number) => {
      const node = page.querySelector("span")!.firstChild!;
      const range = document.createRange();
      range.setStart(node, x < 100 ? 1 : 12); range.collapse(true); return range;
    } });
    act(() => page.dispatchEvent(pointer("pointerdown", 40)));
    act(() => vi.advanceTimersByTime(400));
    act(() => page.dispatchEvent(pointer("pointermove", 160)));
    act(() => page.dispatchEvent(pointer("pointerup", 160)));
    if (deferred) {
      expect(fill).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[aria-label="Use this selection"]')).toBeNull();
      await act(async () => finishFill());
    } else expect(fill).not.toHaveBeenCalled();
    const confirm = document.querySelector<HTMLButtonElement>('[aria-label="Use this selection"]');
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: "underline", start: 0, end: 14,
      excerpt: "Selected words", anchor: expect.objectContaining({ kind: "text", scope: "p4", exact: "Selected words" }) }));
  } finally {
    stop();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(document, key, descriptor);
      else Reflect.deleteProperty(document, key);
    }
    vi.useRealTimers();
  }
});

it.each([{ highlighting: false, cancel: false }, { highlighting: true, cancel: false }, { highlighting: false, cancel: true }])(
  "waits for the complete PDF layer before confirming a touch marquee (%j)", async ({ highlighting, cancel }) => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Android");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.tagName === "SPAN" ? new DOMRect(30, 50, 150, 20) : new DOMRect(0, 0, 800, 1000);
  });
  const changed = vi.fn();
  let finishFill!: () => void;
  const fill = vi.fn(() => new Promise<boolean>(resolve => {
    // TextLayer can expose some nodes before render() has finished.
    host.querySelector(".lc-pdf-text")!.innerHTML = "<span>Selected </span>";
    finishFill = () => {
      host.querySelector("span")!.textContent += "words for a question";
      resolve(true);
    };
  }));
  const stop = registerPdfQuoteTextFill("hold-pdf", fill);
  const descriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
    return event;
  };
  try {
    act(() => root.render(<DocSelectionLayer paletteScope="hold-pdf" highlighting={highlighting} footnotes={footnotes} onSelectionChange={changed}>
      <div data-doc-scope="p4" data-pdf-page="4"><div className="lc-pdf-text textLayer" /></div>
    </DocSelectionLayer>));
    const page = host.querySelector<HTMLElement>("[data-pdf-page]")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => page });
    act(() => page.dispatchEvent(pointer("pointerdown", 40, 60)));
    expect(fill).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(fill).toHaveBeenCalledWith(4);
    act(() => page.dispatchEvent(pointer("pointermove", 160, 80)));
    act(() => page.dispatchEvent(pointer(cancel ? "pointercancel" : "pointerup", 160, 80)));
    expect(document.querySelector('[aria-label="Use this selection"]')).toBeNull();
    await act(async () => finishFill());
    if (cancel) {
      expect(document.querySelector('[aria-label="Use this selection"]')).toBeNull();
      expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Selected words for a question" }));
      return;
    }
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Selected words for a question",
      anchor: { kind: "region", scope: "p4", x: 40, y: 60, w: 120, h: 20 },
      hitRects: [{ left: 30, top: 50, width: 150, height: 20 }],
    }));
    expect(document.querySelector('[aria-label="Use this selection"]')).toBeTruthy();
  } finally {
    stop();
    if (descriptor) Object.defineProperty(document, "elementFromPoint", descriptor);
    else Reflect.deleteProperty(document, "elementFromPoint");
    vi.useRealTimers();
  }
});
