/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compositePageLayers, livePageCopy, resolveExportPaperColor } from "./exportPageComposite";

describe("resolveExportPaperColor", () => {
  it("replaces transparent with paper", () => {
    expect(resolveExportPaperColor("transparent", "#f5f0e8")).toBe("#f5f0e8");
  });

  it("replaces missing / null with paper", () => {
    expect(resolveExportPaperColor(null, "#111")).toBe("#111");
    expect(resolveExportPaperColor(undefined, "#111")).toBe("#111");
  });

  it("keeps opaque theme fills", () => {
    expect(resolveExportPaperColor("#0a0a0b", "#fff")).toBe("#0a0a0b");
  });

  it("falls back when paper is empty", () => {
    expect(resolveExportPaperColor("transparent", "")).toBe("#ffffff");
  });
});

describe("compositePageLayers", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("preserves WebView text zoom and em spacing in the folded image", async () => {
    vi.stubGlobal("devicePixelRatio", 1.7);
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()); }
    });
    const slot = document.createElement("div");
    slot.innerHTML = '<p style="font-size:17px;margin-bottom:1em">Text<span style="font-size:.7em;position:relative;top:-.5em">2</span></p>';
    Object.defineProperty(slot, "offsetWidth", { value: 200 });
    slot.getBoundingClientRect = () => ({ width: 200, top: 0 }) as DOMRect;
    const original = window.getComputedStyle.bind(window);
    vi.stubGlobal("getComputedStyle", (element: Element) => {
      const resolved = original(element);
      if (element.tagName === "P" || element.tagName === "SPAN") {
        const values: Record<string, string> = element.tagName === "P"
          ? { "font-size": "14.45px", "margin-bottom": "17px", "line-height": "23.8425px" }
          : { "font-size": "10.115px", "top": "-5.95px" };
        const get = resolved.getPropertyValue.bind(resolved);
        resolved.getPropertyValue = name => values[name] ?? get(name);
      }
      return resolved;
    });
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    await compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D, bounds, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: bounds, paperColor: "#fff" });
    const xml = decodeURIComponent(sources[0].slice(sources[0].indexOf(",") + 1));
    const captured = new DOMParser().parseFromString(xml, "image/svg+xml");
    expect(captured.querySelector("foreignObject")?.getAttribute("transform")).toBe(`scale(${1 / 1.7})`);
    expect(captured.querySelector("foreignObject")?.getAttribute("width")).toBe("340");
    expect(captured.querySelector("p")?.getAttribute("style")).toContain("font-size: 14.45px");
    expect(captured.querySelector("p")?.getAttribute("style")).toContain("margin-bottom: 17px");
    expect(captured.querySelector("span")?.getAttribute("style")).toContain("top: -5.95px");
    expect(slot.querySelector("p")?.style.fontSize).toBe("17px");
  });

  it("loads DOM layers as self-contained XML data images, not tainting blob URLs", async () => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()); }
    });
    const slot = document.createElement("div");
    slot.innerHTML = '<p>Selection α<br>second line</p>';
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const drawImage = vi.fn();
    await compositePageLayers({ drawImage } as unknown as CanvasRenderingContext2D, bounds, 1,
      { contentSlot: slot, marksSlot: slot, pageBounds: bounds, paperColor: "#fff" });
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
      const xml = decodeURIComponent(source.slice(source.indexOf(",") + 1));
      const parsed = new DOMParser().parseFromString(xml, "image/svg+xml");
      expect(parsed.querySelector("parsererror")).toBeNull();
      expect(parsed.querySelector("p")?.textContent).toBe("Selection αsecond line");
    }
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it("draws the page even while the app around it is booting or the pane loading", async () => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()); }
    });
    const app = document.createElement("div");
    app.className = "lc-app lc-app-booting";
    const wrap = document.createElement("div");
    wrap.className = "lc-canvas-wrap lc-canvas-loading lc-canvas-preparing";
    const board = document.createElement("div");
    board.className = "lc-board";
    const slot = document.createElement("div");
    slot.innerHTML = "<p>Page one</p>";
    board.append(slot);
    wrap.append(board);
    app.append(wrap);
    document.body.append(app);
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    await compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D, bounds, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: bounds, paperColor: "#fff" });
    app.remove();
    const xml = decodeURIComponent(sources[0]!.slice(sources[0]!.indexOf(",") + 1));
    const captured = new DOMParser().parseFromString(xml, "image/svg+xml");
    // The transient classes still reach the picture; every stand-in overrides
    // what they hide, fade or animate.
    for (const cls of ["lc-app", "lc-canvas-wrap", "lc-board"]) {
      const style = captured.querySelector(`.${cls}`)?.getAttribute("style") ?? "";
      expect(style).toMatch(/visibility:\s*visible/);
      expect(style).toMatch(/opacity:\s*1/);
      expect(style).toMatch(/animation:\s*none/);
    }
  });

  it("reports a failed document raster instead of exporting blank paper", async () => {
    vi.stubGlobal("Image", class {
      onerror?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    await expect(compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D, bounds, 1,
      { contentSlot: document.createElement("div"), marksSlot: null, pageBounds: bounds, paperColor: "#fff" }))
      .rejects.toThrow("export layer image failed");
  });

  it("copies only the band near a picture: far blocks go in empty at their height, never cloned whole", async () => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()); }
    });
    const slot = document.createElement("div");
    Object.defineProperty(slot, "offsetWidth", { value: 200 });
    slot.getBoundingClientRect = () => ({ top: 0, width: 200 }) as DOMRect;
    // Slot units at scale 1; the picture's band is 300 to 700.
    const spans = [[0, 100], [150, 200], [260, 290], [300, 700], [760, 800]];
    const blocks = spans.map(([top, bottom], i) => {
      const p = document.createElement("p");
      p.innerHTML = `<span>block ${i}</span>`;
      p.getBoundingClientRect = () => ({ top, bottom, height: bottom - top, width: 200 }) as DOMRect;
      Object.defineProperty(p, "offsetHeight", { value: bottom - top });
      slot.append(p);
      return p;
    });
    const far = vi.spyOn(blocks[0]!, "cloneNode");
    await compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
      { minX: 0, minY: 300, maxX: 200, maxY: 700 }, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: { minX: 0, minY: 0, maxX: 200, maxY: 1000 }, paperColor: "#fff" });
    const xml = decodeURIComponent(sources[0]!.slice(sources[0]!.indexOf(",") + 1));
    const ps = Array.from(new DOMParser().parseFromString(xml, "image/svg+xml").querySelectorAll("p"));
    // A line or two from the band is kept; 100 px off it, as 150-200 is, is not.
    expect(ps.map((p) => p.textContent)).toEqual(["", "", "block 2", "block 3", ""]);
    expect(ps[1]!.getAttribute("style")).toContain("height: 50px");
    expect(far).toHaveBeenCalledWith(false);
    expect(far).not.toHaveBeenCalledWith(true);
  });

  it("leaves the selection being made out of the picture, and keeps the marks beside it", async () => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()); }
    });
    const marks = document.createElement("div");
    Object.defineProperty(marks, "offsetWidth", { value: 200 });
    marks.getBoundingClientRect = () => ({ top: 0, bottom: 1000, height: 1000, width: 200 }) as DOMRect;
    marks.innerHTML = `<div class="lc-doc-select-overlay">
      <div class="lc-doc-marquee-band"></div><span class="lc-doc-marquee-handle"></span>
      <div class="lc-doc-marquee-hit is-confirmed"></div><div class="lc-doc-select-rect"></div>
      <div class="lc-doc-highlight-band"></div><div class="lc-saved-mark">kept</div></div>`;
    await compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
      { minX: 0, minY: 0, maxX: 200, maxY: 1000 }, 1,
      { contentSlot: null, marksSlot: marks, pageBounds: { minX: 0, minY: 0, maxX: 200, maxY: 1000 }, paperColor: "#fff" });
    const xml = decodeURIComponent(sources[0]!.slice(sources[0]!.indexOf(",") + 1));
    const copy = new DOMParser().parseFromString(xml, "image/svg+xml");
    expect(copy.querySelector(".lc-doc-marquee-band, .lc-doc-marquee-handle, .lc-doc-marquee-hit, .lc-doc-select-rect, .lc-doc-highlight-band")).toBeNull();
    expect(copy.querySelector(".lc-saved-mark")?.textContent).toBe("kept");
    // The board's own layer is untouched.
    expect(marks.querySelector(".lc-doc-marquee-band")).not.toBeNull();
  });

  it("keeps an emptied block's margins only, and an inline run beside the band whole", async () => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()); }
    });
    const slot = document.createElement("div");
    Object.defineProperty(slot, "offsetWidth", { value: 200 });
    slot.getBoundingClientRect = () => ({ top: 0, width: 200 }) as DOMRect;
    const place = (el: Element, top: number, bottom: number) => {
      el.getBoundingClientRect = () => ({ top, bottom, height: bottom - top, width: 200 }) as DOMRect;
      Object.defineProperty(el, "offsetHeight", { value: bottom - top });
    };
    // A block far above the band, then a paragraph running into it whose first line is above it.
    const far = document.createElement("p");
    far.style.margin = "1em 0";
    far.innerHTML = "<span>far</span>";
    place(far, 0, 100);
    const running = document.createElement("p");
    // jsdom has no user-agent sheet: say what a browser resolves for a span.
    running.innerHTML = '<span class="early" style="display:inline">early words</span> and <span class="late" style="display:inline">late words</span>';
    place(running, 200, 500);
    place(running.querySelector(".early")!, 200, 220);
    place(running.querySelector(".late")!, 320, 340);
    slot.append(far, running);
    await compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
      { minX: 0, minY: 300, maxX: 200, maxY: 700 }, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: { minX: 0, minY: 0, maxX: 200, maxY: 1000 }, paperColor: "#fff" });
    const xml = decodeURIComponent(sources[0]!.slice(sources[0]!.indexOf(",") + 1));
    const ps = Array.from(new DOMParser().parseFromString(xml, "image/svg+xml").querySelectorAll("p"));
    const shell = ps[0]!.getAttribute("style") ?? "";
    expect(ps[0]!.textContent).toBe("");
    expect(shell).toMatch(/margin(-top)?:/);
    expect(shell).not.toContain("font-size");
    // Emptied, the early words would rewrap the lines that are in the band.
    expect(ps[1]!.textContent).toBe("early words and late words");
  });

  it("lets a touch through between any two blocks while copying a page-turn picture", async () => {
    let pausesBeforeLoad = -1;
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(_value: string) {
        pausesBeforeLoad = pauses.mock.calls.filter(([, ms]) => !ms).length;
        queueMicrotask(() => this.onload?.());
      }
    });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
    const pauses = vi.spyOn(window, "setTimeout");
    const slot = document.createElement("div");
    Object.defineProperty(slot, "offsetWidth", { value: 200 });
    slot.getBoundingClientRect = () => ({ top: 0, width: 200 }) as DOMRect;
    // Six blocks far above the band: emptied, never opened, all children of one parent.
    for (let i = 0; i < 6; i += 1) {
      const p = document.createElement("p");
      p.style.display = "block";
      p.textContent = String(i);
      p.getBoundingClientRect = () => ({ top: i * 10, bottom: i * 10 + 10, height: 10, width: 200 }) as DOMRect;
      Object.defineProperty(p, "offsetHeight", { value: 10 });
      slot.append(p);
    }
    await compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
      { minX: 0, minY: 500, maxX: 200, maxY: 600 }, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: { minX: 0, minY: 0, maxX: 200, maxY: 1000 }, paperColor: "#fff" },
      { signal: new AbortController().signal });
    // One pause per block while copying, then the two before the picture loads.
    expect(pausesBeforeLoad).toBeGreaterThanOrEqual(8);
  });

  it("stops a picture called off, before it loads or draws anything", async () => {
    const sources: string[] = [];
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()); }
    });
    const slot = document.createElement("div");
    slot.innerHTML = "<p>Page one</p>";
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const stop = new AbortController();
    const drawImage = vi.fn();
    const picture = compositePageLayers({ drawImage } as unknown as CanvasRenderingContext2D, bounds, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: bounds, paperColor: "#fff" }, { signal: stop.signal });
    stop.abort();
    await expect(picture).rejects.toMatchObject({ name: "AbortError" });
    expect(sources).toHaveLength(0);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("calls a picture off when the page changes while it is being copied", async () => {
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    // Every look at the clock is past the slice: the copy pauses at once.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
    const slot = document.createElement("div");
    slot.innerHTML = "<p>one</p><p>two</p>";
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const picture = compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D, bounds, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: bounds, paperColor: "#fff" }, { signal: new AbortController().signal });
    slot.append(document.createElement("p"));
    await expect(picture).rejects.toMatchObject({ name: "AbortError" });
  });

  it("no-ops without page bounds", async () => {
    await expect(
      compositePageLayers(
        {} as CanvasRenderingContext2D,
        { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        1,
        {
          contentSlot: null,
          marksSlot: null,
          pageBounds: null,
          paperColor: "#fff",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("paints PDF canvas content into the export rect", async () => {
    const pageBounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const exportBounds = { minX: 10, minY: 10, maxX: 190, maxY: 90 };

    const pdfCanvas = document.createElement("canvas");
    pdfCanvas.className = "lc-pdf-canvas";
    pdfCanvas.width = 200;
    pdfCanvas.height = 100;

    const slot = document.createElement("div");
    slot.style.width = "200px";
    slot.style.height = "100px";
    slot.appendChild(pdfCanvas);

    const slotRect = {
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    slot.getBoundingClientRect = () => slotRect as DOMRect;
    pdfCanvas.getBoundingClientRect = () => slotRect as DOMRect;

    const drawImage = vi.fn();
    const exportCtx = { drawImage } as unknown as CanvasRenderingContext2D;

    await compositePageLayers(exportCtx, exportBounds, 1, {
      contentSlot: slot,
      marksSlot: null,
      pageBounds,
      paperColor: "#fff",
    });

    // Page pixels land under ink — source is the live PDF bitmap, not empty paper.
    expect(drawImage).toHaveBeenCalled();
    expect(drawImage.mock.calls[0]?.[0]).toBe(pdfCanvas);
    expect(pdfCanvas.width).toBeGreaterThan(0);
    expect(pdfCanvas.height).toBeGreaterThan(0);
  });

  it("keeps opaque theme fills and rejects empty paper fallback", () => {
    expect(resolveExportPaperColor("#abc", "")).toBe("#abc");
  });
});

describe("livePageCopy", () => {
  const rect = (top: number, height: number, width = 400) =>
    () => ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON() {} }) as DOMRect;

  it("copies only the band, keeping every other block's box, under stand-ins for its ancestors", () => {
    const host = document.createElement("div");
    const wrap = document.createElement("div");
    wrap.className = "lc-md-ink-doc";
    const slot = document.createElement("div");
    slot.className = "lc-page-content-slot";
    Object.defineProperty(slot, "offsetWidth", { value: 200 });
    // Shown at twice its layout size.
    slot.getBoundingClientRect = rect(0, 2000);
    const blocks = [0, 1, 2].map((i) => {
      const p = document.createElement("p");
      p.id = `b${i}`;
      p.innerHTML = `<span>block ${i}</span>`;
      p.getBoundingClientRect = rect(i * 400, 300);
      slot.append(p);
      return p;
    });
    wrap.append(slot);
    host.append(wrap);
    document.body.append(host);

    const copy = livePageCopy(
      { contentSlot: slot, marksSlot: null, pageBounds: { minX: 10, minY: 100, maxX: 210, maxY: 1100 }, paperColor: "#fff" },
      { x: 10, y: 300, width: 200, height: 150 },
      host,
    )!;
    host.remove();

    expect(copy).not.toBeNull();
    const layer = copy.firstElementChild as HTMLElement;
    // Slot units: the band is 200–350, so the copy's layer starts 200 above it.
    expect(layer.style.top).toBe("-200px");
    expect(layer.querySelector(".lc-md-ink-doc .lc-page-content-slot")).not.toBeNull();
    const ps = Array.from(copy.querySelectorAll("p"));
    expect(ps.map((p) => p.textContent)).toEqual(["", "block 1", ""]);
    expect(ps[0]!.style.height).toBe("150px");
    expect(copy.querySelector("[id]")).toBeNull();
    expect(blocks[1]!.id).toBe("b1");
  });

  it("draws a block in the copy that Pages reading hides on the board", () => {
    const host = document.createElement("div");
    const slot = document.createElement("div");
    Object.defineProperty(slot, "offsetWidth", { value: 200 });
    slot.getBoundingClientRect = rect(0, 2000);
    const p = document.createElement("p");
    p.setAttribute("style", "content-visibility:hidden;contain-intrinsic-size:150px");
    p.textContent = "the next page";
    p.getBoundingClientRect = rect(400, 300);
    slot.append(p);
    host.append(slot);
    document.body.append(host);
    const copy = livePageCopy(
      { contentSlot: slot, marksSlot: null, pageBounds: { minX: 0, minY: 0, maxX: 200, maxY: 1000 }, paperColor: "#fff" },
      { x: 0, y: 200, width: 200, height: 150 },
      host,
    )!;
    host.remove();
    expect(copy.querySelector("p")!.style.contentVisibility).toBe("visible");
    expect(p.style.contentVisibility).toBe("hidden");
  });

  it("leaves out what follows the first block below the band, unless that block is out of the flow or has no box", () => {
    const host = document.createElement("div");
    const slot = document.createElement("div");
    Object.defineProperty(slot, "offsetWidth", { value: 200 });
    slot.getBoundingClientRect = rect(0, 4000);
    const measured: string[] = [];
    const block = (name: string, top: number, height: number, style = "") => {
      const p = document.createElement("p");
      p.textContent = name;
      if (style) p.setAttribute("style", style);
      p.getBoundingClientRect = () => {
        measured.push(name);
        return rect(top, height)();
      };
      slot.append(p);
    };
    block("a", 0, 100);
    block("b", 200, 100);
    // Below the band, but neither says where the rest of the flow is.
    block("pinned", 900, 100, "position:absolute");
    block("empty", 900, 0);
    block("c", 400, 100);
    block("d", 600, 100);
    block("e", 800, 100);
    host.append(slot);
    document.body.append(host);
    const copy = livePageCopy(
      { contentSlot: slot, marksSlot: null, pageBounds: { minX: 0, minY: 0, maxX: 200, maxY: 2000 }, paperColor: "#fff" },
      // Slot units at half size: a is 0-50, b 100-150, c 200-250, d 300-350.
      { x: 0, y: 90, width: 200, height: 120 },
      host,
    )!;
    host.remove();
    expect(Array.from(copy.querySelectorAll("p"), (p) => p.textContent)).toEqual(["", "b", "", "", "c", ""]);
    expect(measured).toEqual(["a", "b", "pinned", "empty", "c", "d"]);
  });
});

describe("waiting for a picture's fonts", () => {
  const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  let style: HTMLStyleElement;
  /** Small paints of a picture, each a look at whether its fonts have landed. */
  let looks = 0;
  beforeEach(() => {
    // A face in the app's CSS: every picture carries "@font-face".
    style = document.createElement("style");
    style.textContent = '@font-face { font-family: "Doc"; src: url(doc.woff2); }';
    document.head.append(style);
    looks = 0;
    if (typeof window.CSSFontFaceRule === "undefined") vi.stubGlobal("CSSFontFaceRule", class {});
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    // The same paint every look: the fonts are in from the first.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((..._args: unknown[]) => ({
      drawImage: () => { looks += 1; },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    })) as unknown as HTMLCanvasElement["getContext"]);
  });
  afterEach(() => {
    style.remove();
    delete document.documentElement.dataset.theme;
    document.body.textContent = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  /** A note on the board: its slot, inside a parent that sets its text. */
  const note = () => {
    const parent = document.createElement("div");
    parent.style.fontSize = "16px";
    const slot = document.createElement("div");
    slot.innerHTML = "<article><p>Page one</p></article>";
    parent.append(slot);
    document.body.append(parent);
    return { parent, slot };
  };
  /** How many looks one picture of `slot` took: a page turn's (with a signal), or an export's. */
  const looksFor = async (slot: HTMLElement, turn = true) => {
    const before = looks;
    await compositePageLayers({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D, bounds, 1,
      { contentSlot: slot, marksSlot: null, pageBounds: bounds, paperColor: "#fff" },
      turn ? { signal: new AbortController().signal } : {});
    return looks - before;
  };

  it("waits for a page-turn picture's fonts once for a note, not for every picture of it", async () => {
    const { slot } = note();
    expect(await looksFor(slot)).toBeGreaterThan(1);
    expect(await looksFor(slot)).toBe(0);
    expect(await looksFor(slot)).toBe(0);
  });

  it("waits again when what sets the fonts changes: the theme, the text size, another note", async () => {
    const { parent, slot } = note();
    expect(await looksFor(slot)).toBeGreaterThan(1);
    document.documentElement.dataset.theme = "dark";
    expect(await looksFor(slot)).toBeGreaterThan(1);
    expect(await looksFor(slot)).toBe(0);
    // A text zoom or another reading size.
    parent.style.fontSize = "20px";
    expect(await looksFor(slot)).toBeGreaterThan(1);
    expect(await looksFor(slot)).toBe(0);
    // Another note in the same slot.
    slot.innerHTML = "<article><p>Another note</p></article>";
    expect(await looksFor(slot)).toBeGreaterThan(1);
    expect(await looksFor(slot)).toBe(0);
    // A new face in the app's CSS.
    style.textContent += ' @font-face { font-family: "Math"; src: url(math.woff2); }';
    expect(await looksFor(slot)).toBeGreaterThan(1);
  });

  it("still waits for the fonts of every export", async () => {
    const { slot } = note();
    expect(await looksFor(slot)).toBeGreaterThan(1);
    expect(await looksFor(slot, false)).toBeGreaterThan(1);
    expect(await looksFor(slot, false)).toBeGreaterThan(1);
  });
});
