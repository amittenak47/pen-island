/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PdfDocument } from "./PdfDocument";
import { DocSelectionLayer } from "./DocSelectionLayer";
import { fillPdfQuoteText } from "./pdfQuoteText";
import { publishPdfFilmCurrent, publishPdfViewPages, resetPdfFilmScopes } from "./pdfFilm";
import { textAnchorOffsets, textOf } from "../util/docAnchors";
import { anchorLocalRects } from "../util/pdfTextGeometry";
import { makeDocFlagHolds, resetDocCameraForTests } from "../canvas/docSelectionGesture";

const pdf = vi.hoisted(() => ({
  builds: vi.fn(), text: vi.fn(), gate: null as Promise<void> | null, partial: false,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs?worker", () => ({ default: class {} }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  const viewport = (scale: number) => ({ width: 400 * scale, height: 600 * scale, scale,
    rawDims: { pageWidth: 400, pageHeight: 600, pageX: 0, pageY: 0 }, clone: ({ scale }: { scale: number }) => viewport(scale) });
  return {
    GlobalWorkerOptions: {}, PDFWorker: { create: () => ({}) },
    TextLayer: class {
      textDivs: HTMLElement[] = [];
      constructor(private options: { container: HTMLElement; textContentSource: { items: { str: string }[] } }) {}
      cancel() {}
      async render() {
        pdf.builds(this.options.container.closest("[data-pdf-page]")?.getAttribute("data-pdf-page"));
        if (pdf.partial) {
          const span = document.createElement("span"); span.textContent = "Selected ";
          this.textDivs.push(span); this.options.container.append(span);
        }
        await pdf.gate;
        if (pdf.partial) { this.textDivs[0].textContent = this.options.textContentSource.items[0].str; return; }
        for (const item of this.options.textContentSource.items) {
          const span = document.createElement("span"); span.textContent = item.str;
          this.textDivs.push(span); this.options.container.append(span);
        }
      }
    },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 5, getPage: async (pageNumber: number) => ({
      pageNumber, getViewport: ({ scale }: { scale: number }) => viewport(scale),
      getTextContent: pdf.text, render: () => ({ promise: Promise.resolve(), cancel() {} }),
    }) }), destroy: async () => {} }),
  };
});

let host: HTMLElement, root: Root;
const scope = "lazy-text";
const descriptors = ["elementFromPoint", "caretRangeFromPoint"].map(key => [key, Object.getOwnPropertyDescriptor(document, key)] as const);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {}, fillRect() {}, clearRect() {}, measureText: (text: string) => ({ width: text.length * 10 }),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 600));
  Range.prototype.getClientRects = () => [new DOMRect(30, 50, 150, 20)] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(30, 50, 150, 20);
  pdf.builds.mockClear(); pdf.text.mockReset(); pdf.gate = null; pdf.partial = false;
  pdf.text.mockResolvedValue({ items: [{ str: "Selected words for a question", width: 290, height: 20,
    transform: [20, 0, 0, 20, 30, 530], fontName: "body", dir: "ltr" }],
    styles: { body: { fontFamily: "serif", ascent: 0.8 } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); window.getSelection()?.removeAllRanges();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(document, key, descriptor);
    else Reflect.deleteProperty(document, key);
  }
  resetPdfFilmScopes(); resetDocCameraForTests();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function mount(changed = vi.fn()) {
  await act(async () => root.render(<DocSelectionLayer paletteScope={scope} footnotes={[]} onSelectionChange={changed}>
    <PdfDocument filmScope={scope} bytes={new ArrayBuffer(1)} frameWidth={400} selectable />
  </DocSelectionLayer>));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  return host.querySelector<HTMLElement>('[data-pdf-page="1"]')!;
}
function pointer(type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 60 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  return event;
}

it("paints pages scrolled past and supplies text/anchor geometry without building spans", async () => {
  const page = await mount();
  expect(page.hasAttribute("data-painted")).toBe(true);
  expect(textOf(page)).toBe("Selected words for a question");
  // Quote search and saved mark bands work while the layer is empty.
  const anchor = { kind: "text" as const, start: 2, end: 7, exact: "words", scope: "p1" };
  expect(textAnchorOffsets(textOf(page), anchor)).toEqual({ start: 9, end: 14 });
  const bands = anchorLocalRects(host.querySelector<HTMLElement>(".lc-doc-selectable-body")!, page, anchor);
  expect(bands.length).toBeGreaterThan(0);
  for (const n of [2, 3, 4]) {
    act(() => { publishPdfFilmCurrent(scope, n); publishPdfViewPages(scope, [n], []); });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
  }
  expect(pdf.text).toHaveBeenCalled();
  expect(pdf.builds).not.toHaveBeenCalled();
  expect(host.querySelector(".lc-pdf-text span")).toBeNull();
});

it.each([false, true])("fills on pointerdown and completes that drag after lift, even while the camera is busy (partial: %s)", async (partial) => {
  const changed = vi.fn();
  const page = await mount(changed);
  const body = host.querySelector<HTMLElement>(".lc-doc-selectable-body")!;
  const anchor = { kind: "text" as const, start: 0, end: 29, exact: "Selected words for a question" };
  const bands = anchorLocalRects(body, page, anchor);
  let finish!: () => void;
  pdf.partial = partial;
  pdf.gate = new Promise<void>(resolve => { finish = resolve; });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => page });
  Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: (x: number) => {
    const node = page.querySelector("span")!.firstChild!;
    const range = document.createRange(); range.setStart(node, x < 100 ? 0 : node.textContent!.length); range.collapse(true); return range;
  } });
  const holds = makeDocFlagHolds(scope); act(() => holds.camera(true));
  act(() => page.dispatchEvent(pointer("pointerdown", 40)));
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(pdf.builds).toHaveBeenCalledTimes(1);
  expect(pdf.builds).toHaveBeenCalledWith("1");
  act(() => page.dispatchEvent(pointer("pointerup", 160)));
  if (partial) {
    // A second gesture during render must join it rather than select the
    // incomplete text that pdf.js has already appended.
    act(() => page.dispatchEvent(pointer("pointerdown", 40)));
    act(() => page.dispatchEvent(pointer("pointerup", 160)));
  }
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => finish());
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Selected words for a question",
    anchor: expect.objectContaining({ kind: "text", scope: "p1", start: 0, end: 29 }) }));
  expect(document.querySelector('[role="menu"]')).toBeTruthy();
  expect(textOf(page)).toBe(anchor.exact);
  expect(anchorLocalRects(body, page, anchor)).toEqual(bands);
  act(() => holds.camera(false));
  expect(await fillPdfQuoteText(scope, 1)).toBe(true);
  expect(pdf.builds).toHaveBeenCalledTimes(1);
  act(() => { publishPdfFilmCurrent(scope, 4); publishPdfViewPages(scope, [4], []); });
  expect(page.querySelector("span")).toBeNull();
});
