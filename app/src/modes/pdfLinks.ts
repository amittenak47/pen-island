/**
 * Links inside a PDF: a table of contents, "see page 12", a reference to an
 * equation. A tap on one in reading jumps to its target in the same file; a
 * web link opens in the browser. Annotate mode leaves them to the pen.
 *
 * Nothing is drawn for them and nothing is read until a tap: the tap finds
 * the page under the finger, reads that page's links from pdf.js once, and
 * hit-tests them in sheet fractions, as form fields are placed.
 */

import { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

/** A box on a page's sheet, as fractions of its width and height (top-left origin). */
export interface PdfLinkBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PdfLinkTarget =
  | { kind: "dest"; dest: string | unknown[] }
  | { kind: "named"; action: string }
  | { kind: "url"; url: string };

export interface PdfLink {
  box: PdfLinkBox;
  target: PdfLinkTarget;
}

/** Where a link goes: a 1-based page, and where on it as sheet fractions when the file says. */
export interface PdfJumpTarget {
  page: number;
  /** From the sheet's top, 0-1; null for a whole-page destination. */
  y: number | null;
  /** From the sheet's left, 0-1: picks the half of a two-up sheet. */
  x: number | null;
}

interface RawAnnotation {
  subtype?: string;
  rect?: number[];
  dest?: string | unknown[] | null;
  url?: string;
  action?: string;
}

interface Viewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

const isRect = (rect: unknown): rect is number[] =>
  Array.isArray(rect) && rect.length === 4 && rect.every((v) => Number.isFinite(v));

/** A PDF rectangle in sheet fractions. */
export function sheetBox(viewport: Viewport, rect: number[]): PdfLinkBox {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0]!, rect[1]!);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2]!, rect[3]!);
  return {
    left: Math.min(x1!, x2!) / viewport.width,
    top: Math.min(y1!, y2!) / viewport.height,
    width: Math.abs(x2! - x1!) / viewport.width,
    height: Math.abs(y2! - y1!) / viewport.height,
  };
}

/** The links on one page, from its annotations. */
export function pageLinks(annotations: readonly RawAnnotation[], viewport: Viewport): PdfLink[] {
  const links: PdfLink[] = [];
  for (const note of annotations) {
    if (note.subtype !== "Link" || !isRect(note.rect)) continue;
    let target: PdfLinkTarget | null = null;
    if (typeof note.url === "string" && /^https?:\/\//i.test(note.url)) target = { kind: "url", url: note.url };
    else if (note.dest != null && (typeof note.dest === "string" || Array.isArray(note.dest))) target = { kind: "dest", dest: note.dest };
    else if (typeof note.action === "string") target = { kind: "named", action: note.action };
    if (target) links.push({ box: sheetBox(viewport, note.rect), target });
  }
  return links;
}

/** The link at sheet fraction (`x`, `y`), the smallest when they overlap. */
export function linkAt(links: readonly PdfLink[], x: number, y: number): PdfLink | null {
  let best: PdfLink | null = null;
  for (const link of links) {
    const { left, top, width, height } = link.box;
    if (x < left || x > left + width || y < top || y > top + height) continue;
    if (!best || width * height < best.box.width * best.box.height) best = link;
  }
  return best;
}

/**
 * Where an explicit destination (`[page, {name: "XYZ"}, left, top, zoom]`
 * and its kin) points, given the target page's viewport at scale 1.
 */
export function destinationPoint(dest: readonly unknown[], viewport: Viewport): { x: number | null; y: number | null } {
  const kind = (dest[1] as { name?: string } | undefined)?.name;
  const num = (i: number) => (typeof dest[i] === "number" && Number.isFinite(dest[i]) ? (dest[i] as number) : null);
  let left: number | null = null;
  let top: number | null = null;
  if (kind === "XYZ") {
    left = num(2);
    top = num(3);
  } else if (kind === "FitH" || kind === "FitBH") top = num(2);
  else if (kind === "FitV" || kind === "FitBV") left = num(2);
  else if (kind === "FitR") {
    left = num(2);
    top = num(5);
  }
  if (left == null && top == null) return { x: null, y: null };
  const [vx, vy] = viewport.convertToViewportPoint(left ?? 0, top ?? 0);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: left == null ? null : clamp(vx! / viewport.width),
    y: top == null ? null : clamp(vy! / viewport.height),
  };
}

/** The page and spot a link goes to, or null when the file names nowhere this reader can go. */
export async function resolvePdfLink(
  doc: PDFDocumentProxy,
  link: PdfLink,
  fromPage: number,
): Promise<PdfJumpTarget | null> {
  const target = link.target;
  if (target.kind === "named") {
    const to = target.action === "NextPage" ? fromPage + 1
      : target.action === "PrevPage" ? fromPage - 1
      : target.action === "FirstPage" ? 1
      : target.action === "LastPage" ? doc.numPages
      : null;
    return to != null && to >= 1 && to <= doc.numPages ? { page: to, x: null, y: null } : null;
  }
  if (target.kind !== "dest") return null;
  const explicit = typeof target.dest === "string" ? await doc.getDestination(target.dest).catch(() => null) : target.dest;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const ref = explicit[0];
  let index: number | null = null;
  if (typeof ref === "number" && Number.isInteger(ref)) index = ref;
  else if (ref && typeof ref === "object") {
    index = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]).catch(() => null);
  }
  if (index == null || index < 0 || index >= doc.numPages) return null;
  const page = await doc.getPage(index + 1);
  const point = destinationPoint(explicit, page.getViewport({ scale: 1 }));
  return { page: index + 1, ...point };
}

const TAP_SLOP_PX = 10;
const TAP_MS = 450;

/** Controls over the page answer their own taps. */
const CONTROL = "button, input, textarea, select, a, [role='button'], [role='menuitem'], [contenteditable='true']";

/**
 * Taps on a PDF's links while reading. `enabled` is reading (the page is
 * selectable); in Annotate mode the pen writes over links as over anything.
 *
 * The tap is answered after the lift's own handlers: in Pages reading a tap
 * on the facing page first brings the board over to it, and only then is
 * that page under the finger.
 */
export function usePdfLinkTaps({
  enabled,
  host,
  doc,
  onJump,
  onOpenLink,
}: {
  enabled: boolean;
  host: () => HTMLElement | null;
  doc: () => PDFDocumentProxy | null;
  onJump?: (target: PdfJumpTarget) => void;
  onOpenLink?: (url: string) => void;
}): void {
  const handlers = useRef({ host, doc, onJump, onOpenLink });
  handlers.current = { host, doc, onJump, onOpenLink };
  useEffect(() => {
    if (!enabled) return;
    const cache = new Map<string, Promise<PdfLink[]>>();
    let cacheDoc: PDFDocumentProxy | null = null;
    let press: { id: number; x: number; y: number; at: number } | null = null;

    const linksOf = (proxy: PDFDocumentProxy, n: number) => {
      if (proxy !== cacheDoc) {
        cache.clear();
        cacheDoc = proxy;
      }
      const key = String(n);
      let links = cache.get(key);
      if (!links) {
        links = proxy.getPage(n)
          .then(async (page) => pageLinks(await page.getAnnotations({ intent: "display" }) as RawAnnotation[], page.getViewport({ scale: 1 })))
          .catch(() => []);
        cache.set(key, links);
      }
      return links;
    };

    /** The page under (`x`, `y`) and the spot on its sheet, as fractions. */
    const sheetAt = (root: HTMLElement, x: number, y: number) => {
      for (const slot of root.querySelectorAll<HTMLElement>(".lc-pdf-page")) {
        const box = slot.getBoundingClientRect();
        if (x < box.left || x > box.right || y < box.top || y > box.bottom || box.height <= 0) continue;
        const sheet = slot.querySelector<HTMLElement>(".lc-pdf-spread")?.getBoundingClientRect();
        const left = sheet && sheet.width > 0 ? sheet.left : box.left;
        const width = sheet && sheet.width > 0 ? sheet.width : box.width;
        const page = Number(slot.dataset.pdfPage);
        if (!Number.isInteger(page)) continue;
        return { page, x: (x - left) / width, y: (y - box.top) / box.height };
      }
      return null;
    };

    const follow = async (x: number, y: number) => {
      const root = handlers.current.host();
      const proxy = handlers.current.doc();
      if (!root || !proxy) return;
      const at = sheetAt(root, x, y);
      if (!at) return;
      const link = linkAt(await linksOf(proxy, at.page), at.x, at.y);
      if (!link) return;
      if (link.target.kind === "url") {
        handlers.current.onOpenLink?.(link.target.url);
        return;
      }
      const target = await resolvePdfLink(proxy, link, at.page);
      if (target) handlers.current.onJump?.(target);
    };

    const onDown = (event: PointerEvent) => {
      press = event.isPrimary && event.button === 0
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
        : null;
    };
    const onUp = (event: PointerEvent) => {
      const start = press;
      press = null;
      if (!start || event.pointerId !== start.id) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
      if (event.timeStamp - start.at > TAP_MS) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".lc-board") || target.closest(CONTROL)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const { clientX, clientY } = event;
      // After the lift's own handlers (the facing page's swap among them).
      window.setTimeout(() => void follow(clientX, clientY), 0);
    };
    const onCancel = () => {
      press = null;
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    };
  }, [enabled]);
}
