import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdfTextRuns, PdfTextGeometry } from "./pdfTextGeometry";
import { anchorFromRange, rangeFromAnchor, textOf, textAnchorOffsets } from "./docAnchors";

const fixture = resolve("src/modes/fixtures/two-pages.pdf");
let pdfjs, pdf, loading, contents, viewports, dom;
const previous = new Map();

beforeAll(async () => {
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  // Keep the existing fixture and add real PDF lines so the worker supplies
  // empty EOL items, spaces, multiple lines and repeated quotes as well.
  const source = await PDFDocument.load(readFileSync(fixture));
  const font = await source.embedFont(StandardFonts.Helvetica);
  const page = source.getPages()[0];
  page.drawText("A second line with proportional letters.", { x: 72, y: 640, size: 18, font });
  page.drawText("Repeated words", { x: 72, y: 600, size: 18, font });
  page.drawText("Repeated words", { x: 72, y: 560, size: 18, font });
  loading = pdfjs.getDocument({ data: await source.save(), standardFontDataUrl: `${resolve("node_modules/pdfjs-dist/standard_fonts")}/` });
  pdf = await loading.promise;
  const pages = await Promise.all([pdf.getPage(1), pdf.getPage(2)]);
  contents = await Promise.all(pages.map(p => p.getTextContent()));
  viewports = pages.map(p => p.getViewport({ scale: 1 }));
  dom = new JSDOM("<body></body>");
  for (const key of ["window", "document", "Node", "NodeFilter", "HTMLElement", "Element", "getComputedStyle"]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  }
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = createCanvas(1, 1);
    canvas.remove = () => {};
    return canvas.getContext("2d");
  };
});

afterAll(async () => {
  await loading?.destroy();
  dom?.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

async function layerFor(content, viewport) {
  const layer = document.createElement("div");
  document.body.append(layer);
  const text = new pdfjs.TextLayer({ container: layer, viewport, textContentSource: {
    ...content, items: content.items.map(item => "str" in item && !content.styles[item.fontName]?.vertical ? { ...item, width: 0 } : item),
  } });
  await text.render();
  return layer;
}

function anchors(text, runs) {
  const first = runs[0], last = runs.at(-1);
  return [
    { start: 0, end: text.length },
    { start: 0, end: Math.min(4, text.length) },
    { start: text.length - 4, end: text.length },
    ...runs.map(run => ({ start: run.start, end: run.end })),
    { start: first.start + 2, end: first.end - 2 },
    { start: first.start + 3, end: last.end - 2 },
  ].map(offsets => ({ kind: "text", ...offsets, exact: text.slice(offsets.start, offsets.end) }));
}

describe("PDF anchor stream parity with the real TextLayer", () => {
  it("has identical characters and anchor boundaries, including skipped empty/EOL and marked items", async () => {
    for (let n = 0; n < contents.length; n++) {
      const content = contents[n];
      const item = content.items.find(item => item.str);
      const marked = { ...content, items: [
        { type: "beginMarkedContent" }, { ...item, str: "", hasEOL: true },
        ...content.items, { type: "endMarkedContent" },
      ] };
      const layer = await layerFor(marked, viewports[n]);
      const geometry = new PdfTextGeometry(marked, viewports[n], pdfjs.TextLayer.fontFamilyMap);
      expect(geometry.text).toBe(textOf(layer));
      expect(layer.querySelector("br")).not.toBeNull();
      expect(geometry.text).not.toContain("\n");
      for (const anchor of anchors(geometry.text, geometry.runs)) {
        const range = rangeFromAnchor(layer, anchor);
        expect(range?.toString()).toBe(anchor.exact);
        expect(anchorFromRange(layer, range)).toMatchObject(anchor);
        expect(textAnchorOffsets(geometry.text, anchor)).toEqual({ start: anchor.start, end: anchor.end });
        expect(geometry.rects(anchor).length).toBeGreaterThan(0);
      }
    }
  });

  it("preserves page/block separators in composite streams and ranges crossing them", async () => {
    const book = document.createElement("div");
    const strings = [];
    for (let n = 0; n < contents.length; n++) {
      book.append(await layerFor(contents[n], viewports[n]));
      strings.push(pdfTextRuns(contents[n]).text);
    }
    const stream = strings.join("\n");
    expect(textOf(book)).toBe(stream);
    const start = strings[0].length - 4, end = strings[0].length + 5;
    const range = rangeFromAnchor(book, { kind: "text", start, end, exact: stream.slice(start, end) });
    expect(anchorFromRange(book, range)).toMatchObject({ start, end, exact: stream.slice(start, end) });
    // The synthetic separator occupies an offset but has no DOM text node.
    expect(range.toString()).toBe(stream.slice(start, end).replace("\n", ""));
  });

  it("shares quote recovery and veto, including ambiguous and missing quotes", async () => {
    const layer = await layerFor(contents[0], viewports[0]);
    const geometry = new PdfTextGeometry(contents[0], viewports[0]);
    const exact = "second line", start = geometry.text.indexOf(exact);
    const recovered = { kind: "text", start: 0, end: 4, exact, prefix: "A ", suffix: " with" };
    expect(textAnchorOffsets(geometry.text, recovered)).toEqual({ start, end: start + exact.length });
    expect(rangeFromAnchor(layer, recovered)?.toString()).toBe(exact);
    expect(geometry.rects(recovered)).toEqual(geometry.rects({ ...recovered, start, end: start + exact.length }));
    for (const exact of ["words that are gone", "Repeated words"]) {
      const anchor = { kind: "text", start: 0, end: 4, exact };
      expect(rangeFromAnchor(layer, anchor)).toBeNull();
      expect(geometry.rects(anchor)).toEqual([]);
    }
  });
});

// jsdom cannot lay out ranges. Run the same real text content in Chromium when
// available, so the 1.5px promise is checked against actual browser glyph boxes.
const browser = [process.env.PDF_GEOMETRY_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(path => path && existsSync(path));

it.skipIf(!browser)("matches laid-out DOM range rectangles within 1.5px at both page scales and spread halves", async () => {
  const css = readFileSync(resolve("src/styles.css"), "utf8");
  const textCss = css.slice(css.indexOf(".lc-pdf-text.textLayer {"), css.indexOf(".lc-pdf-text.textLayer ::selection"));
  const script = await build({ bundle: true, write: false, format: "iife", target: "es2022", stdin: {
    resolveDir: process.cwd(), contents: String.raw`
      import { TextLayer } from "pdfjs-dist";
      import { PdfTextGeometry, bindPdfTextGeometry, anchorLocalRects } from "./src/util/pdfTextGeometry";
      import { alignTextLayerToGlyphs } from "./src/util/pdfTextFit";
      import { rangeFromAnchor, textOf, anchorFromRange, anchorFromUniqueQuote } from "./src/util/docAnchors";
      import { localRects, mergeLineRuns } from "./src/util/docMarquee";
      (async function run(contents, dimensions, makeAnchors) {
        const failures = [], composites = new Map(); let checked = 0;
        for (const fit of [1, 0.7]) for (const half of ["left", "right"]) for (let n = 0; n < contents.length; n++) {
          const content = contents[n], rawDims = dimensions[n];
          const viewport = { rawDims, scale: fit, rotation: 0, width: rawDims.pageWidth * fit, height: rawDims.pageHeight * fit };
          const body = document.createElement("div"), root = document.createElement("div"), spread = document.createElement("div"), layer = document.createElement("div");
          Object.assign(body.style, { position: "relative", width: viewport.width + "px", height: viewport.height + "px", transform: "translate(11px, 7px) scale(0.85)", transformOrigin: "0 0" });
          Object.assign(root.style, { position: "relative", width: viewport.width / 2 + "px", height: viewport.height + "px", marginTop: "18px", marginLeft: "23px" });
          root.dataset.pdfHalf = half;
          Object.assign(spread.style, { position: "absolute", width: viewport.width + "px", height: viewport.height + "px", transform: half === "right" ? "translateX(-" + viewport.width / 2 + "px)" : "none" });
          layer.className = "lc-pdf-text textLayer";
          layer.style.setProperty("--total-scale-factor", fit);
          spread.append(layer); root.append(spread); body.append(root); document.body.append(body);
          const text = new TextLayer({ container: layer, viewport, textContentSource: { ...content, items: content.items.map(item => "str" in item ? { ...item, width: 0 } : item) } });
          await text.render();
          alignTextLayerToGlyphs(spread, text.textDivs, content.items, fit);
          const geometry = new PdfTextGeometry(content, viewport, TextLayer.fontFamilyMap);
          if (geometry.text !== textOf(root)) throw Error("stream mismatch");
          bindPdfTextGeometry(root, geometry);
          for (const anchor of makeAnchors(geometry.text, geometry.runs)) {
            const range = rangeFromAnchor(root, anchor);
            const domRects = localRects(body, range), rects = anchorLocalRects(body, root, anchor);
            if (domRects.length !== rects.length) failures.push({ anchor, domRects, rects });
            else for (let i = 0; i < rects.length; i++) for (const key of ["left", "top", "width", "height"]) {
              if (Math.abs(rects[i][key] - domRects[i][key]) > 1.5) failures.push({ key, fit, half, anchor, dom: domRects[i], geometry: rects[i] });
            }
            if (anchorFromRange(root, range).exact !== anchor.exact) throw Error("anchor mismatch");
            checked++;
          }
          const anchor = makeAnchors(geometry.text, geometry.runs)[0];
          const placed = anchorLocalRects(body, root, anchor);
          const children = [...layer.childNodes];
          layer.replaceChildren();
          if (textOf(root) !== geometry.text || !anchorFromUniqueQuote(root, geometry.text)) throw Error("missing cached text");
          if (JSON.stringify(anchorLocalRects(body, root, anchor)) !== JSON.stringify(placed)) throw Error("marks moved after text eviction");
          layer.append(...children);
          const key = fit + half, pair = composites.get(key) || [];
          pair.push({ body, root, geometry }); composites.set(key, pair);
        }
        for (const pair of composites.values()) {
          const book = document.createElement("div");
          Object.assign(book.style, { position: "relative", width: "800px", transform: "translate(11px, 7px) scale(0.85)", transformOrigin: "0 0" });
          for (const entry of pair) { entry.body.style.transform = "none"; book.append(entry.body); }
          document.body.append(book);
          const stream = pair.map(entry => entry.geometry.text).join("\n"), seam = pair[0].geometry.text.length;
          if (textOf(book) !== stream) throw Error("block separator mismatch");
          const anchor = { kind: "text", start: seam - 4, end: seam + 5, exact: stream.slice(seam - 4, seam + 5) };
          const range = rangeFromAnchor(book, anchor), domRects = localRects(book, range);
          const rects = mergeLineRuns([
            ...anchorLocalRects(book, pair[0].root, { kind: "text", start: seam - 4, end: seam }),
            ...anchorLocalRects(book, pair[1].root, { kind: "text", start: 0, end: 4 }),
          ]);
          if (anchorFromRange(book, range).exact !== anchor.exact) throw Error("block anchor mismatch");
          if (domRects.length !== rects.length) failures.push({ block: true, domRects, rects });
          else for (let i = 0; i < rects.length; i++) for (const key of ["left", "top", "width", "height"]) {
            if (Math.abs(rects[i][key] - domRects[i][key]) > 1.5) failures.push({ block: true, key, dom: domRects[i], geometry: rects[i] });
          }
          checked++;
          book.remove();
        }
        document.body.textContent = JSON.stringify({ checked, failures });
      })(${JSON.stringify(contents)}, ${JSON.stringify(viewports.map(v => v.rawDims))}, ${anchors.toString()}).catch(error => { document.body.textContent = JSON.stringify({ error: String(error) }); });
    `,
  } });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/test.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/test.js" ? script.outputFiles[0].text : `<style>${textCss}</style><body><script>window.onerror = message => { document.body.textContent = JSON.stringify({error: message}); };</script><script src="/test.js"></script></body>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { stdout } = await promisify(execFile)(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--dump-dom", "--virtual-time-budget=4000", `http://127.0.0.1:${server.address().port}`], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const body = stdout.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
    if (!body.startsWith("{")) throw Error(stdout);
    const result = JSON.parse(body.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    expect(result.error).toBeUndefined();
    expect(result.checked).toBeGreaterThan(30);
    expect(result.failures).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}, 45000);
