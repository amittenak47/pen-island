/** PDF mark placement without retaining pdf.js's selectable spans. */
import type { TextContent, TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import { rangeFromAnchor, supplyDocText, textAnchorOffsets, type DocAnchor, type TextAnchor } from "./docAnchors";
import { localRects, mergeLineRuns, scaleOf, type LocalRect } from "./docMarquee";

type Run = { item: TextItem; start: number; end: number };
type Font = { family: string; ascent: number; height: number; top: number };
type Box = LocalRect & { angle: number; advance: number; font: string };

let measureContext: CanvasRenderingContext2D | null = null;
function context(): CanvasRenderingContext2D | null {
  return measureContext ??= document.createElement("canvas").getContext("2d");
}

/**
 * TextLayer appends nonempty strings in content order, even whitespace. Its
 * marked-content wrappers are spans; hasEOL appends a textless BR. Neither
 * changes streamOf's nearest block, so neither contributes a newline. The
 * page's DIV supplies the separator only when reading several pages at once.
 */
export function pdfTextRuns(content: TextContent): { text: string; runs: Run[] } {
  let text = "";
  let divs = 0;
  const runs: Run[] = [];
  for (const item of content.items) {
    // Match TextLayer's MAX_TEXT_DIVS_TO_RENDER guard (including empty divs).
    if (divs > 100000) break;
    if (!("str" in item)) continue;
    divs += 1;
    if (!item.str) continue;
    const start = text.length;
    text += item.str;
    runs.push({ item, start, end: text.length });
  }
  return { text, runs };
}

export class PdfTextGeometry {
  readonly text: string;
  readonly runs: Run[];
  private readonly fonts = new Map<string, Font>();
  private readonly boxes = new Map<Run, Box>();
  private readonly advances = new Map<Run, Map<number, number>>();

  constructor(
    readonly content: TextContent,
    readonly viewport: PageViewport,
    private readonly families: ReadonlyMap<string, string> = new Map(),
  ) {
    const stream = pdfTextRuns(content);
    this.text = stream.text;
    this.runs = stream.runs;
  }

  /** Font loading and placement revisions can change canvas text metrics. */
  invalidate(): void {
    this.fonts.clear();
    this.boxes.clear();
    this.advances.clear();
  }

  private font(style: TextStyle): Font {
    const family = this.families.get(style.fontFamily) ?? style.fontFamily;
    let font = this.fonts.get(family);
    if (font) return font;
    const ctx = context();
    if (ctx) ctx.font = `30px ${family}`;
    const metrics = ctx?.measureText("");
    const ascent = metrics?.fontBoundingBoxAscent ?? 0;
    const descent = Math.abs(metrics?.fontBoundingBoxDescent ?? 0);
    // TextLayer uses these same metrics, then the PDF style, then 0.8.
    const ratio = ascent ? ascent / (ascent + descent) : style.ascent || (style.descent ? 1 + style.descent : 0.8);
    const height = ascent ? (ascent + descent) / 30 : 1;
    font = { family, ascent: ratio, height, top: (1 - height) / 2 };
    this.fonts.set(family, font);
    return font;
  }

  private box(run: Run): Box {
    const cached = this.boxes.get(run);
    if (cached) return cached;
    const { item } = run;
    const style = this.content.styles[item.fontName];
    const font = this.font(style);
    const { pageWidth, pageHeight, pageX, pageY } = this.viewport.rawDims;
    const fit = this.viewport.scale;
    const [a, b, c, d, x, y] = item.transform;
    // TextLayer uses rawDims, a flipped Y, and percentage positions rounded
    // to 0.01%. Use that rounding too, including CropBox origins.
    const angle = Math.atan2(-b, a) + (style.vertical ? Math.PI / 2 : 0);
    const height = Math.hypot(c, d);
    const ascent = height * font.ascent;
    const left = x - pageX + ascent * Math.sin(angle);
    const top = pageY + pageHeight - y - ascent * Math.cos(angle);
    const rounded = (value: number, size: number) => Number((100 * value / size).toFixed(2)) * size / 100 * fit;
    const size = Number(height.toFixed(2)) * fit;
    const box: Box = {
      left: rounded(left, pageWidth), top: rounded(top, pageHeight),
      width: size, height: size * font.height, angle,
      advance: (style.vertical ? item.height : item.width) * fit,
      font: `${size}px ${font.family}`,
    };
    // Range boxes cover the font's ascent/descent inside its line-height: 1
    // span. This inset rotates with the text, just as the DOM range does.
    box.left -= size * font.top * Math.sin(angle);
    box.top += size * font.top * Math.cos(angle);
    this.boxes.set(run, box);
    return box;
  }

  private advance(run: Run, offset: number, box: Box): number {
    if (offset <= 0) return 0;
    if (offset >= run.item.str.length) return box.advance;
    let cache = this.advances.get(run);
    if (!cache) this.advances.set(run, cache = new Map());
    const cached = cache.get(offset);
    if (cached != null) return cached;
    const ctx = context();
    if (!ctx) return 0;
    ctx.font = box.font;
    ctx.direction = run.item.dir === "rtl" ? "rtl" : "ltr";
    const full = ctx.measureText(run.item.str).width;
    const width = ctx.measureText(run.item.str.slice(0, offset)).width;
    const advance = full > 0 ? width / full * box.advance : 0;
    cache.set(offset, advance);
    return advance;
  }

  /** Unmerged item pieces in sheet-local CSS pixels. */
  rects(anchor: TextAnchor): LocalRect[] {
    const offsets = textAnchorOffsets(this.text, anchor);
    if (!offsets) return [];
    const rects: LocalRect[] = [];
    for (const run of this.runs) {
      if (run.end <= offsets.start) continue;
      if (run.start >= offsets.end) break;
      const from = Math.max(0, offsets.start - run.start);
      const to = Math.min(run.item.str.length, offsets.end - run.start);
      if (to <= from) continue;
      const box = this.box(run);
      let start = this.advance(run, from, box);
      let end = this.advance(run, to, box);
      if (run.item.dir === "rtl") [start, end] = [box.advance - end, box.advance - start];
      const cos = Math.cos(box.angle), sin = Math.sin(box.angle);
      const points = [
        [start, 0], [end, 0], [start, box.height], [end, box.height],
      ].map(([x, y]) => ({ x: box.left + x * cos - y * sin, y: box.top + x * sin + y * cos }));
      const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
      const right = Math.max(...points.map(p => p.x)), bottom = Math.max(...points.map(p => p.y));
      if (right > left && bottom > top) rects.push({ left, top, width: right - left, height: bottom - top });
    }
    return rects;
  }

  columnRight(): number | null {
    let right = -Infinity;
    for (const run of this.runs) {
      if (!run.item.str.trim()) continue;
      const box = this.box(run);
      const cos = Math.cos(box.angle), sin = Math.sin(box.angle);
      right = Math.max(right, box.left, box.left + box.advance * cos, box.left - box.height * sin,
        box.left + box.advance * cos - box.height * sin);
    }
    return Number.isFinite(right) ? right : null;
  }
}

const pageGeometry = new WeakMap<Element, PdfTextGeometry>();

export function bindPdfTextGeometry(root: HTMLElement, geometry: PdfTextGeometry): void {
  pageGeometry.set(root, geometry);
  supplyDocText(root, geometry.text);
  const layer = root.querySelector(".lc-pdf-text");
  if (layer) supplyDocText(layer, geometry.text);
}

export function pdfTextGeometry(root: Element): PdfTextGeometry | undefined {
  return pageGeometry.get(root);
}

export function invalidatePdfTextGeometry(body: HTMLElement, pages: readonly number[] | "all" = "all"): void {
  const wanted = pages === "all" ? null : new Set(pages);
  for (const root of body.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
    if (!wanted || wanted.has(Number(root.dataset.pdfPage))) pageGeometry.get(root)?.invalidate();
  }
}

/** Shared with placement, panel anchoring and exports; null means use the DOM. */
export function pdfAnchorRects(root: Element, anchor: DocAnchor): LocalRect[] | null {
  const geometry = pageGeometry.get(root);
  if (!geometry || anchor.kind !== "text") return null;
  const shift = root.getAttribute("data-pdf-half") === "right" ? -geometry.viewport.width / 2 : 0;
  return geometry.rects(anchor).map(rect => ({ ...rect, left: rect.left + shift }));
}

export function anchorLocalRects(body: HTMLElement, root: HTMLElement, anchor: DocAnchor): LocalRect[] {
  const rects = pdfAnchorRects(root, anchor);
  if (rects == null) {
    const range = rangeFromAnchor(root, anchor);
    return range ? localRects(body, range) : [];
  }
  const origin = body.getBoundingClientRect(), page = root.getBoundingClientRect();
  const scale = scaleOf(body) || 1;
  return mergeLineRuns(rects.map(rect => ({ ...rect,
    left: rect.left + (page.left - origin.left) / scale,
    top: rect.top + (page.top - origin.top) / scale,
  })));
}

export function pdfTextColumnRight(body: HTMLElement, root: HTMLElement): number | null {
  const geometry = pageGeometry.get(root);
  const right = geometry?.columnRight();
  if (right == null) return null;
  const scale = scaleOf(body) || 1;
  const shift = root.dataset.pdfHalf === "right" ? -geometry!.viewport.width / 2 : 0;
  return right + shift + (root.getBoundingClientRect().left - body.getBoundingClientRect().left) / scale;
}
