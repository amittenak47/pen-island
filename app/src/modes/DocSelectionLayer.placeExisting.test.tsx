/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { saveShowBooktabs, saveBooktabPosition, saveBooktabFootnotes } from "../util/booktabsPref";
import { publishBooktabPages } from "../util/booktabPages";
import { savePageFit } from "../util/readingModePref";
import { BOOKTAB_JITTER_RISE, edgeBookTabRects } from "../util/aiBookTabs";
import { DocSelectionLayer } from "./DocSelectionLayer";
import type { DocFootnote } from "../util/docFootnotes";
import type { PageFrame } from "../canvas/inkPageIndex";
import { publishDocPlacementRev, publishPdfViewPages, resetPdfFilmScopes } from "./pdfFilm";
import { makeDocFlagHolds, resetDocCameraForTests } from "../canvas/docSelectionGesture";

const MARK: DocFootnote = {
  id: "same",
  kind: "note",
  anchor: { kind: "text", start: 0, end: 8, scope: "p6" },
  excerpt: "Contents",
  createdAt: 1,
};

/**
 * A marquee mark: a box against its own page, plus the bands it was drawn at.
 *
 * The bands are body-local — a distance down the whole stack — which is what
 * makes them useless to a pane that lays the same book out narrower.
 */
const REGION_MARK: DocFootnote = {
  id: "region",
  kind: "note",
  anchor: { kind: "region", scope: "p6", x: 160.6, y: 120.4, w: 165.7, h: 60.8 },
  excerpt: "Contents",
  createdAt: 1,
  bands: [{ left: 179, top: 4313, width: 117, height: 27 }],
};

const PAGE1_MARK: DocFootnote = {
  id: "page1",
  kind: "note",
  anchor: { kind: "region", scope: "p1", x: 20, y: 20, w: 40, h: 18 },
  excerpt: "Title",
  createdAt: 1,
};

/**
 * A page whose text arrives after mount, which is what a PDF does.
 *
 * The first `place()` runs against an empty scope root and finds nothing to
 * measure. Whether the mark ever appears comes down to whether the layer is
 * still watching when the text layer lands.
 */
function mountLayer(props: { placeExisting?: boolean; paletteScope?: string }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <DocSelectionLayer
        enabled={false}
        placeExisting={props.placeExisting}
        paletteScope={props.paletteScope}
        footnotes={[MARK]}
      >
        <div data-doc-scope="p6" />
      </DocSelectionLayer>,
    ),
  );
  return { host, root };
}

function landText(host: HTMLElement) {
  const scope = host.querySelector('[data-doc-scope="p6"]')!;
  const span = document.createElement("span");
  span.textContent = "Contents";
  act(() => {
    scope.append(span);
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  publishBooktabPages("booktabs-render", []);
  resetPdfFilmScopes();
  resetDocCameraForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("placeExisting", () => {
  it("places an older ChatBot marquee and its tab on the live quote after reflow", () => {
    const quote = "Page 7 reference words for synchronization.";
    const mark: DocFootnote = {
      ...REGION_MARK, kind: "ai", excerpt: quote,
      anchor: { kind: "region", x: 28, y: 900, w: 200, h: 24 },
      bands: [{ left: 28, top: 900, width: 586, height: 28 }],
    };
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(642);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 642, 1200));
    const priorRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true, value: () => [new DOMRect(50, quoteTop, 280, 24)],
    });
    let quoteTop = 380;
    let paperResize: ResizeObserverCallback | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(node: HTMLElement) { if (node.classList.contains("lc-doc-selectable-body")) paperResize = this.callback; }
      unobserve() {}
      disconnect() {}
    });
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => window.setTimeout(() => callback(0), 0));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<DocSelectionLayer enabled={false} footnotes={[mark]}><p>{quote}</p></DocSelectionLayer>));
      const band = host.querySelector<HTMLElement>(".lc-doc-footnote-band")!;
      const tab = host.querySelector<HTMLElement>(".lc-doc-footnote-tab")!;
      expect(parseFloat(band.style.top) + parseFloat(band.style.height) / 2).toBeCloseTo(392);
      expect(parseFloat(tab.style.top)).toBe(380);
      expect(parseFloat(tab.style.left)).toBe(-14);
      expect(parseFloat(host.querySelector<HTMLElement>(".lc-doc-footnote-bookmark")!.style.left)).toBe(623);
      // The paper finishes loading without a new note or a window resize.
      quoteTop = 520;
      act(() => { paperResize!([], {} as ResizeObserver); vi.advanceTimersByTime(1); });
      expect(parseFloat(host.querySelector<HTMLElement>(".lc-doc-footnote-tab")!.style.top)).toBe(520);
      expect(parseFloat(host.querySelector<HTMLElement>(".lc-doc-footnote-band")!.style.top)).toBeGreaterThan(500);
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
      if (priorRects) Object.defineProperty(Range.prototype, "getClientRects", priorRects);
      else Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  it("watches for the text layer, which the reader deliberately does not", () => {
    /*
     * `enabled` arms the selection gestures, and the conflict panes must not
     * have those — their whole job is to be scrolled. The reader keeps the
     * layer mounted with `enabled={false}` and no watching on purpose, because
     * re-placing ribbons on every window mutation mid-flick starves ink paint
     * until scroll settle. So this is opt-in, and separate from both.
     */
    const observe = vi.spyOn(MutationObserver.prototype, "observe");

    const off = mountLayer({});
    const withoutWatching = observe.mock.calls.length;
    act(() => off.root.unmount());

    observe.mockClear();
    const on = mountLayer({ placeExisting: true });
    landText(on.host);

    expect(withoutWatching).toBe(0);
    expect(observe.mock.calls.length).toBeGreaterThan(0);
    act(() => on.root.unmount());
  });

  it("leaves selection off, so the pane still scrolls", () => {
    // `placeExisting` is placement only — no marquee, no new marks.
    const { host, root } = mountLayer({ placeExisting: true });
    expect(host.querySelector(".lc-doc-marquee-band")).toBeNull();
    act(() => root.unmount());
  });
});

describe("marks made on a wider copy of the same page", () => {
  /**
   * One page, laid out at half the width the mark was drawn at.
   *
   * jsdom measures nothing, so the boxes are stated: a body whose page 6 sits
   * 2305px down, which is where a pane scrolled to that page would have it.
   */
  function mountScaled(
    markScale: number,
    paletteScope = "",
    footnotes: readonly DocFootnote[] = [REGION_MARK],
    pdf = paletteScope !== "",
    markPageFrames?: readonly PageFrame[],
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const pageEl = (scope: string, pdfPage?: number) => (
      <div
        data-doc-scope={scope}
        {...(pdfPage != null ? { "data-pdf-page": String(pdfPage) } : {})}
      />
    );
    const tree = (notes: readonly DocFootnote[]) => (
      <DocSelectionLayer
        enabled={false}
        placeExisting
        markScale={markScale}
        markPageFrames={markPageFrames}
        paletteScope={paletteScope}
        footnotes={notes}
      >
        {pdf ? pageEl("p1", 1) : null}
        {pageEl("p6", pdf ? 6 : undefined)}
      </DocSelectionLayer>
    );
    act(() => root.render(tree(footnotes)));
    const bindBoxes = () => {
      const body = host.querySelector("[data-doc-scope=p6]")!.parentElement as HTMLElement;
      const page = host.querySelector("[data-doc-scope=p6]") as HTMLElement;
      const page1 = host.querySelector("[data-doc-scope=p1]") as HTMLElement | null;
      Object.defineProperty(body, "offsetWidth", { value: 347, configurable: true });
      body.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 347, bottom: 4000, width: 347, height: 4000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 2305, right: 347, bottom: 2740, width: 347, height: 435, x: 0, y: 2305, toJSON: () => ({}) }) as DOMRect;
      if (page1) {
        page1.getBoundingClientRect = () =>
          ({ left: 0, top: 0, right: 347, bottom: 435, width: 347, height: 435, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      }
      return { body, page };
    };
    const { body, page } = bindBoxes();
    return {
      host,
      root,
      body,
      page,
      setFootnotes(notes: readonly DocFootnote[]) {
        act(() => root.render(tree(notes)));
        bindBoxes();
      },
    };
  }

  it("clears a ChatBot spinner when an answer changes content at the same position", () => {
    const pending: DocFootnote = { ...REGION_MARK, kind: "ai", pending: "request" };
    const { host, root, setFootnotes } = mountScaled(0.5, "", [pending]);
    try {
      setFootnotes([{ ...pending }]);
      expect(host.querySelector(".lc-doc-footnote-spinner")).not.toBeNull();
      const before = host.querySelector<HTMLElement>(".lc-doc-footnote-bookmark")!.style.cssText;
      setFootnotes([{ ...pending, pending: undefined, title: "Answered quote" }]);
      const tab = host.querySelector<HTMLElement>(".lc-doc-footnote-bookmark")!;
      expect(host.querySelector(".lc-doc-footnote-spinner")).toBeNull();
      expect(tab.classList.contains("lc-doc-footnote-pending")).toBe(false);
      expect(tab.getAttribute("aria-label")).not.toContain("ChatBot is writing");
      expect(tab.getAttribute("aria-label")).toContain("Answered quote");
      expect(tab.style.cssText).toBe(before);
    } finally { act(() => root.unmount()); }
  });

  it("paints missing and empty footnote and sub-mark themes with the same defaults", () => {
    const styles = (empty: boolean) => {
      const inherited = empty ? { color: "", palette: [] } : {};
      const mark: DocFootnote = { ...REGION_MARK, ...inherited, subMarks: [{ id: "sub", kind: "underline",
        excerpt: "Contents", start: 0, end: 8, bands: REGION_MARK.bands, ...inherited }] };
      const { host, root } = mountScaled(0.5, "", [mark]);
      act(() => window.dispatchEvent(new Event("resize")));
      const band = host.querySelector<HTMLElement>(".lc-doc-footnote-band");
      const sub = host.querySelector<HTMLElement>(".lc-doc-submark-paint");
      expect(band).not.toBeNull();
      expect(sub).not.toBeNull();
      const result = [band!.style.cssText, sub!.style.cssText];
      act(() => root.unmount());
      return result;
    };
    expect(styles(true)).toEqual(styles(false));
  });

  it("preserves the authored bands relative to their page, excluding earlier page gaps", () => {
    const {host,root,setFootnotes} = mountScaled(0.5,"",[REGION_MARK],false,[{pageId:6,minY:4000,maxY:5000}]);
    setFootnotes([{...REGION_MARK}]);
    const band = host.querySelector<HTMLElement>(".lc-doc-footnote-band")!;
    expect(parseFloat(band.style.left)+parseFloat(band.style.width)/2).toBeCloseTo((179+117/2)*0.5);
    expect(parseFloat(band.style.top)+parseFloat(band.style.height)/2).toBeCloseTo(2305+(4313-4000+27/2)*0.5);
    act(()=>root.unmount());
  });

  it("brings a region anchor across in proportion", () => {
    /*
     * The anchor is x/y against its own page, so it is portable — but only in
     * proportion. Unscaled, a box drawn on a 642px page lands half a page to
     * the right on a 347px one.
     */
    const { host, root, body, page } = mountScaled(347 / 642);
    // Nudge a re-place now that the boxes answer.
    act(() => {
      page.append(document.createElement("span"));
    });
    const band = host.querySelector(".lc-doc-footnote-band") as HTMLElement | null;
    expect(band).not.toBeNull();
    const left = parseFloat(band!.style.left);
    const top = parseFloat(band!.style.top);
    /*
     * 160.6 and 120.4 scaled by 0.5405 — 86.8 and 65.1 — then padded out a
     * few px the way every quote box is. On the device this lands at 83.3 / 62
     * inside its page, with the word "Contents" at 96.7 / 75.3 inside the box.
     *
     * jsdom reports a zero offset for the page within the body whatever it is
     * told, so this pins the part that was wrong — the scale — and the page
     * offset is what the device run checks.
     */
    const width = parseFloat(band!.style.width);
    const height = parseFloat(band!.style.height);
    expect(left).toBeCloseTo(83.3, 0);
    expect(top).toBeCloseTo(59.2, 0);
    // Unscaled, this box would be 165.7 wide on a page only 347 across.
    expect(width).toBeLessThan(120);
    expect(width).toBeGreaterThan(80);
    expect(height).toBeLessThan(50);
    expect(body).toBeTruthy();
    act(() => root.unmount());
  });

  it("does not reuse bands recorded in the other layout", () => {
    /*
     * Those bands put this mark at 4313 down a stack whose page 6 starts at
     * 2305 — four pages below the words. They are ignored under
     * `placeExisting`, and the anchor answers instead.
     */
    const { host, root, page } = mountScaled(347 / 642);
    act(() => {
      page.append(document.createElement("span"));
    });
    const band = host.querySelector(".lc-doc-footnote-band") as HTMLElement;
    expect(parseFloat(band.style.top)).toBeLessThan(4313);
    act(() => root.unmount());
  });

  it("hides a footnote whose PDF page is not in view", () => {
    publishPdfViewPages("tab-1", [1], []);
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();
    act(() => {
      publishPdfViewPages("tab-1", [6], []);
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });

  it("does not remasure on camera settle when the document did not change", () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();

    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    const holds = makeDocFlagHolds("tab-1");
    act(() => holds.camera(true));
    act(() => holds.camera(false));
    expect(measured).toBe(0);
    act(() => root.unmount());
  });

  it("places from a renderer revision after a flick, not from settle itself", () => {
    publishPdfViewPages("tab-1", [1], []);
    const holds = makeDocFlagHolds("tab-1");
    act(() => holds.camera(true));
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    act(() => holds.camera(false));
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();

    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    act(() => {
      publishDocPlacementRev("tab-1", [6]);
    });
    expect(measured).toBeGreaterThan(0);

    act(() => {
      publishPdfViewPages("tab-1", [6], []);
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });

  it("drops a deleted mark instead of resurrecting it when its page returns", () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page, setFootnotes } = mountScaled(347 / 642, "tab-1", [
      PAGE1_MARK,
      REGION_MARK,
    ]);
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();

    act(() => {
      publishPdfViewPages("tab-1", [1], []);
    });
    setFootnotes([PAGE1_MARK]);
    act(() => {
      publishPdfViewPages("tab-1", [6], []);
    });
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();
    act(() => root.unmount());
  });

  it("clears ribbons when the last annotation is removed", () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page, setFootnotes } = mountScaled(347 / 642, "tab-1");
    act(() => {
      page.append(document.createElement("span"));
    });
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    setFootnotes([]);
    expect(host.querySelector(".lc-doc-footnote-band")).toBeNull();
    act(() => root.unmount());
  });

  it("places markdown text that landed during a flick", async () => {
    const holds = makeDocFlagHolds("md-1");
    const { host, root, page } = mountScaled(347 / 642, "md-1", [REGION_MARK], false);
    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    await act(async () => holds.camera(true));
    await act(async () => {
      page.append(document.createElement("span"));
      await Promise.resolve();
    });
    expect(measured).toBe(0);
    await act(async () => holds.camera(false));
    expect(measured).toBeGreaterThan(0);
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });

  it("keeps a scheduled PDF placement when a flick starts before the frame runs", async () => {
    publishPdfViewPages("tab-1", [6], []);
    const { host, root, page } = mountScaled(347 / 642, "tab-1");
    let measured = 0;
    const pageBox = page.getBoundingClientRect;
    page.getBoundingClientRect = () => {
      measured += 1;
      return pageBox.call(page);
    };
    let pending: FrameRequestCallback | null = null;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      pending = cb;
      return 99;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      if (id === 99) pending = null;
    });
    page.append(document.createElement("span"));
    await Promise.resolve();
    expect(pending).not.toBeNull();
    expect(measured).toBe(0);
    const holds = makeDocFlagHolds("tab-1");
    await act(async () => holds.camera(true));
    expect(cancel).toHaveBeenCalledWith(99);
    expect(pending).toBeNull();
    expect(measured).toBe(0);
    raf.mockRestore();
    cancel.mockRestore();
    await act(async () => holds.camera(false));
    expect(measured).toBeGreaterThan(0);
    expect(host.querySelector(".lc-doc-footnote-band")).not.toBeNull();
    act(() => root.unmount());
  });
});

describe("booktab display choices", () => {
  function mountTabs(pdf: boolean, portal = false) {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const page = this.dataset.pdfPage;
      return page ? new DOMRect(20, page === "1" ? 100 : 800, 360, 600) : new DOMRect(0, 0, 400, 1500);
    });
    const slots = document.createElement("div");
    const marksSlot = document.createElement("div");
    const tabsSlot = document.createElement("div");
    tabsSlot.className = "lc-page-booktabs-slot";
    slots.append(marksSlot, tabsSlot);
    if (portal) document.body.append(slots);
    const marks: DocFootnote[] = [
      { ...PAGE1_MARK, id: "late", kind: "ai", anchor: { kind: "region", scope: "p1", x: 50, y: 80, w: 40, h: 18 } },
      { ...PAGE1_MARK, id: "right", kind: "note", anchor: { kind: "region", scope: "p1", x: 150, y: 20, w: 40, h: 18 } },
      { ...PAGE1_MARK, id: "left", kind: "ai", anchor: { kind: "region", scope: "p1", x: 20, y: 20, w: 40, h: 18 } },
      { ...PAGE1_MARK, id: "next", kind: "ai", anchor: { kind: "region", scope: "p2", x: 20, y: 20, w: 40, h: 18 } },
    ];
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<DocSelectionLayer enabled={false} marksHost={portal ? marksSlot : null} paletteScope="booktabs-render" footnotes={marks}>
      <div data-doc-scope="p1" {...(pdf ? { "data-pdf-page": "1" } : {})} />
      <div data-doc-scope="p2" {...(pdf ? { "data-pdf-page": "2" } : {})} />
    </DocSelectionLayer>));
    const tab = (id: string) => host.querySelector<HTMLElement>(`[data-footnote-id="${id}"] .lc-doc-footnote-tab`);
    return { host, root, tab, marksSlot, tabsSlot };
  }
  it("portals visual tabs and the squares above the page mask, the quote bands stay on the page", () => {
    const { root, marksSlot, tabsSlot } = mountTabs(true, true);
    try {
      // The squares go up with the tabs: on the marks layer the page-turn lip covered them.
      expect(marksSlot.querySelector(".lc-doc-footnote-bookmark")).toBeNull();
      expect(tabsSlot.querySelectorAll(".lc-doc-footnote-bookmark")).toHaveLength(4);
      expect(marksSlot.querySelectorAll(".lc-doc-footnote-pack").length).toBeGreaterThan(0);
      expect(marksSlot.querySelector(".lc-doc-footnote-tab")).toBeNull();
      expect(tabsSlot.querySelectorAll(".lc-doc-footnote-tab")).toHaveLength(3);
      expect(tabsSlot.querySelector(".lc-doc-footnote-tab")!.getAttribute("aria-hidden")).toBe("true");
    } finally { act(() => root.unmount()); }
  });
  /** Edge tabs jitter by their id; within this of the plain edge line. */
  const nearPx = (value: string, want: number) =>
    expect(Math.abs(parseFloat(value) - want)).toBeLessThanOrEqual(BOOKTAB_JITTER_RISE + 1e-6);
  it("keeps today's beside placement and stacking, and includes other footnotes live", () => {
    // In the footnote's row needs the margin of "Slightly zoomed out".
    savePageFit("margin");
    const { host, root, tab } = mountTabs(true);
    try {
      expect(host.querySelectorAll(".lc-doc-footnote-tab")).toHaveLength(3);
      expect(tab("right")).toBeNull();
      expect(tab("left")!.style.left).toBe("-14px");
      expect(tab("left")!.style.top).toBe("120px");
      expect(tab("left")!.style.width).toBe("28px");
      expect(tab("left")!.style.height).toBe("18px");
      act(() => saveBooktabFootnotes("all"));
      expect(host.querySelectorAll(".lc-doc-footnote-tab")).toHaveLength(4);
      // Two tabs for passages on the same line split around it, 20px apart.
      expect(tab("left")!.style.top).toBe("110px");
      expect(tab("right")!.style.top).toBe("130px");
      for (const element of host.querySelectorAll(".lc-doc-footnote-tab")) {
        expect(element.tagName).toBe("SPAN");
        expect(element.getAttribute("aria-hidden")).toBe("true");
        expect(element.hasAttribute("tabindex")).toBe(false);
      }
      act(() => saveShowBooktabs(false));
      expect(host.querySelectorAll(".lc-doc-footnote-tab")).toHaveLength(0);
      expect(host.querySelectorAll(".lc-doc-footnote-bookmark")).toHaveLength(4);
      act(() => saveShowBooktabs(true));
      expect(tab("right")).not.toBeNull();
    } finally { act(() => root.unmount()); }
  });
  it("puts the squares of passages that start on one line side by side, the later nearer the edge", () => {
    savePageFit("margin"); saveBooktabFootnotes("all");
    const { host, root } = mountTabs(true);
    try {
      const square = (id: string) => host.querySelector<HTMLElement>(`[data-footnote-id="${id}"] .lc-doc-footnote-bookmark`)
        ?? document.querySelector<HTMLElement>(`.lc-doc-footnote-bookmark[data-footnote-id="${id}"]`);
      const left = square("left"), right = square("right");
      expect(left && right).toBeTruthy();
      // One row: the same top, a square's width apart.
      expect(left!.style.top).toBe(right!.style.top);
      expect(parseFloat(right!.style.left) - parseFloat(left!.style.left)).toBe(20);
    } finally { act(() => root.unmount()); }
  });
  it.each(["top", "bottom"] as const)("lays out each PDF sheet's %s tabs in reading order", edge => {
    saveBooktabPosition(edge); saveBooktabFootnotes("all");
    const { root, tab } = mountTabs(true);
    try {
      const order = ["left", "right", "late"];
      const want = edgeBookTabRects({ left: 20, top: 100, width: 360, height: 600 }, edge, order.map(id => ({ id })), true);
      let previous = -Infinity;
      for (const id of order) {
        const element = tab(id)!;
        expect(parseFloat(element.style.left)).toBeCloseTo(want.get(id)!.left, 5);
        expect(parseFloat(element.style.left)).toBeGreaterThan(previous);
        previous = parseFloat(element.style.left);
        nearPx(element.style.top, edge === "top" ? 86 : 686);
        expect(element.style.width).toBe("18px"); expect(element.style.height).toBe("28px");
      }
      expect(tab("next")!.style.left).toBe("24px");
      nearPx(tab("next")!.style.top, edge === "top" ? 786 : 1386);
      act(() => saveBooktabPosition(edge === "top" ? "bottom" : "top"));
      nearPx(tab("left")!.style.top, edge === "top" ? 686 : 86);
    } finally { act(() => root.unmount()); }
  });
  it.each(["top", "bottom"] as const)("uses text page cuts for %s and falls back in continuous mode", edge => {
    saveBooktabPosition(edge); saveBooktabFootnotes("all");
    const { root, tab } = mountTabs(false);
    try {
      expect(tab("left")!.style.left).toBe("-14px");
      // Same line: split around it rather than the second pushed down.
      expect(tab("right")!.style.top).toBe("40px");
      act(() => publishBooktabPages("booktabs-render", [
        { rect: { left: 0, top: 0, width: 400, height: 60 }, contentBottom: 60 },
        { rect: { left: 0, top: 60, width: 400, height: 60 }, contentBottom: 120 },
      ]));
      nearPx(tab("left")!.style.top, edge === "top" ? -14 : 46);
      nearPx(tab("late")!.style.top, edge === "top" ? 46 : 106);
      act(() => publishBooktabPages("booktabs-render", [
        { rect: { left: 0, top: 0, width: 400, height: 60 }, contentBottom: 60, visible: false },
        { rect: { left: 0, top: 60, width: 400, height: 60 }, contentBottom: 120, visible: true },
      ]));
      expect(tab("left")).toBeNull();
      expect(tab("late")).not.toBeNull();
      act(() => saveBooktabPosition("beside"));
      expect(tab("left")).toBeNull();
      expect(tab("late")).not.toBeNull();
      act(() => publishBooktabPages("booktabs-render", []));
      expect(tab("left")!.style.left).toBe("-14px");
      expect(tab("left")!.style.height).toBe("18px");
    } finally { act(() => root.unmount()); }
  });
});
