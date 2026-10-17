import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { BoardHandle } from "../canvas/BoardHandle";
import type { ShellValue } from "../shellContext";
import type { AnnotateDoc, DocType } from "../util/annotateStore";
import type { DocFootnote } from "../util/docFootnotes";
import type { TabRecord } from "../util/tabs";
import { loadReadingPage, saveReadingPage } from "../util/readingPosition";
import { PAGE_GAP, PDF_DOC_PAD_TOP, layoutPdfPages, pdfStackFrames, type PdfNav, type PdfThumbRenderer } from "../modes/PdfDocument";
import { pdfLayoutIsSpread } from "../modes/pdfInkSpread";
import { remapPdfFootnotes } from "../modes/pdfFootnoteLayout";
import { savePdfFilmPref, loadPdfSpreadPref, savePdfSpreadPref, clearPdfFilmScope, peekPdfPageSizes, publishPdfFilmCurrent, peekPdfFilmCurrent, subscribePdfFilmCurrent, peekPdfReadingFrames, pdfSpreadSlotCountChanged, resetPdfFilmPredicted, publishPdfLayoutBusy, subscribePdfLayoutBusy } from "../modes/pdfFilm";

type Setter<T> = Dispatch<SetStateAction<T>>;

type PdfSessionArgs = Pick<ShellValue, "setPdfFilmOpen"> & {
  tab: Pick<TabRecord, "id">;
  annotateSource: { hash: string; docType: DocType } | null;
  annotateSourceRef: RefObject<{ hash: string } | null>;
  annotateDocIdRef: RefObject<string | null>;
  boardRef: RefObject<BoardHandle | null>;
  workspaceLoadGenRef: RefObject<number>;
  annotateFootnotesRef: RefObject<DocFootnote[]>;
  setAnnotateFootnotesRaw: Setter<DocFootnote[]>;
  annotatePageWidthRef: RefObject<number>;
};

/** PDF navigation, strip, thumbnails and spread layout for one workspace. */
export function usePdfSession({
  tab, annotateSource, annotateSourceRef, annotateDocIdRef, boardRef,
  workspaceLoadGenRef, annotateFootnotesRef, setAnnotateFootnotesRaw,
  annotatePageWidthRef, setPdfFilmOpen,
}: PdfSessionArgs) {
  /** pdf.js failure during open — abort the layout gate instead of "smaller file". */
  const annotatePdfErrorRef = useRef<string | null>(null);
  const [pdfNav, setPdfNav] = useState<PdfNav | null>(null);
  const pdfNavRef = useRef<PdfNav | null>(null);
  pdfNavRef.current = pdfNav;
  const [pdfSessionPage, setPdfSessionPage] = useState(0);
  const pdfThumbRef = useRef<PdfThumbRenderer | null>(null);
  const [pdfThumbReady, setPdfThumbReady] = useState(false);
  const onPdfThumbRenderer = useCallback((render: PdfThumbRenderer | null) => {
    pdfThumbRef.current = render;
    setPdfThumbReady(Boolean(render));
  }, []);
  const renderPdfThumb = useCallback((page: number) => {
    return pdfThumbRef.current?.(page) ?? Promise.resolve(null);
  }, [pdfThumbReady]);
  const togglePdfFilm = useCallback(() => {
    setPdfFilmOpen((on) => {
      const next = !on;
      savePdfFilmPref(next);
      return next;
    });
  }, []);
  const [pdfSpreadByHash, setPdfSpreadByHash] = useState<Record<string, boolean>>(
    {},
  );
  const [pdfLayoutBusy, setPdfLayoutBusy] = useState(false);
  useEffect(() => subscribePdfLayoutBusy(tab.id, setPdfLayoutBusy), [tab.id]);
  /*
   * Where this tab was in its PDF is this tab's, and dies with it.
   *
   * Not on park: a parked workspace stays mounted precisely so that coming
   * back is showing the page again rather than finding it. Closing the tab is
   * the only thing that makes the place meaningless — and leaving it behind
   * would grow the nav map by one record, with its listener sets and layout
   * timers, for every document ever opened.
   */
  useEffect(() => () => clearPdfFilmScope(tab.id), [tab.id]);
  const spreadToggleAtRef = useRef(0);
  const spreadLayoutRunRef = useRef(0);
  const annotatePdfHash =
    annotateSource?.docType === "pdf" ? annotateSource.hash : null;
  const pdfSpread = annotatePdfHash
    ? (pdfSpreadByHash[annotatePdfHash] ?? loadPdfSpreadPref(annotatePdfHash))
    : false;
  const togglePdfSpread = useCallback(() => {
    const hash = annotateSourceRef.current?.hash;
    if (!hash || boardRef.current?.isPdfInkLayoutPending()) return;
    const now = performance.now();
    if (now - spreadToggleAtRef.current < 180) return;
    spreadToggleAtRef.current = now;
    setPdfLayoutBusy(true);
    publishPdfLayoutBusy(tab.id, true);
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    const page = peekPdfFilmCurrent(tab.id);
    const fromFrames = peekPdfReadingFrames(tab.id);
    if (!fromFrames.length) { publishPdfLayoutBusy(tab.id, false); return; }
    // Keep page filing and flushing in the ink's source layout until the
    // remap installs coordinates and target frames together.
    boardRef.current?.setInkSpread(pdfLayoutIsSpread(fromFrames));
    const run = ++spreadLayoutRunRef.current;
    const loadGen = workspaceLoadGenRef.current;
    setPdfSpreadByHash((prev) => {
      const on = prev[hash] ?? loadPdfSpreadPref(hash);
      const next = !on;
      savePdfSpreadPref(hash, next);
      return { ...prev, [hash]: next };
    });
    setPdfFilmOpen(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const started = performance.now();
        const fromCount = fromFrames.length;
        let remapped = false;
        const tick = () => {
          if (run !== spreadLayoutRunRef.current || loadGen !== workspaceLoadGenRef.current) return;
          const toFrames = peekPdfReadingFrames(tab.id);
          const nowCount = toFrames.length;
          const layoutReady =
            nowCount > 0 && (fromCount < 1 || (pdfSpreadSlotCountChanged(fromCount, nowCount) &&
              pdfLayoutIsSpread(toFrames) !== pdfLayoutIsSpread(fromFrames) &&
              nowCount >= (pdfLayoutIsSpread(fromFrames) ? fromCount / 2 : fromCount * 2)));
          if (layoutReady && !remapped) {
            remapped = boardRef.current?.remapPdfInkAcrossPdfLayout(fromFrames) === true;
            if (!remapped) {
              if (performance.now() - started > 8000) {
                reconcilePdfInkLayout(pdfLayoutIsSpread(fromFrames), loadGen);
                publishPdfLayoutBusy(tab.id, false);
              } else requestAnimationFrame(tick);
              return;
            }
            const marks = remapPdfFootnotes(annotateFootnotesRef.current, fromFrames, toFrames, annotatePageWidthRef.current);
            annotateFootnotesRef.current = marks;
            setAnnotateFootnotesRaw(marks);
            if (page >= 1) boardRef.current?.aimPdfPage(page, { hold: false });
          }
          const ok =
            layoutReady && remapped &&
            (!(page >= 1) || boardRef.current?.scrollToPdfPage(page, { hold: false }) === true);
          if (ok || performance.now() - started > 8000) {
            if (!remapped) reconcilePdfInkLayout(pdfLayoutIsSpread(fromFrames), loadGen);
            if (!ok) boardRef.current?.scrollToPdfPage(page, { hold: false });
            publishPdfLayoutBusy(tab.id, false);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
    });
  }, []);
  /*
   * Ink written on the other layout, moved onto this one.
   *
   * The spread setting is per device, and a stroke's scene point depends on
   * it — so a copy synced from a tablet reading split sheets carries its ink
   * in split coordinates, and on a PC showing whole sheets it drew pages away
   * from where it was written. The copy stamps its layout (`pdfSpread`); once
   * every page's size is known here, a mismatched copy is remapped the same way
   * the spread toggle remaps.
   */
  const reconcilePdfInkLayout = (stamp: boolean, loadGen: number, marksStamp = stamp) => {
    const started = performance.now();
    const tick = () => {
      if (workspaceLoadGenRef.current !== loadGen) return;
      const board = boardRef.current;
      const frames = peekPdfReadingFrames(tab.id);
      const sizes = peekPdfPageSizes(tab.id);
      const total = pdfNavRef.current?.count ?? 0;
      if (!board || frames.length === 0 || total === 0 || sizes.length < total) {
        if (performance.now() - started < 30_000) window.setTimeout(tick, 250);
        return;
      }
      if (pdfLayoutIsSpread(frames) !== stamp) {
        const from = pdfStackFrames(
          layoutPdfPages(sizes, annotatePageWidthRef.current, stamp),
          stamp,
          PAGE_GAP,
          PDF_DOC_PAD_TOP,
        );
        if (!board.remapPdfInkAcrossPdfLayout(from)) {
          if (performance.now() - started < 30_000) window.setTimeout(tick, 250);
          return;
        }
      }
      if (pdfLayoutIsSpread(frames) !== marksStamp) {
        const from = pdfStackFrames(layoutPdfPages(sizes, annotatePageWidthRef.current, marksStamp), marksStamp, PAGE_GAP, PDF_DOC_PAD_TOP);
        const marks = remapPdfFootnotes(annotateFootnotesRef.current, from, frames, annotatePageWidthRef.current);
        annotateFootnotesRef.current = marks;
        setAnnotateFootnotesRaw(marks);
      }
      board.setInkSpread(null);
    };
    tick();
  };

  const restorePdfSessionPage = (docType: DocType, sessionDocId: string, existing: AnnotateDoc | null) => {
    const savedPdfPage = Math.floor(
      Number((existing?.board.appState as { pdfPage?: number } | undefined)?.pdfPage),
    );
    // Where it was last read, if that was after its last save: a session
    // saved since keeps the page it was saved at.
    const readPage = docType === "pdf" ? loadReadingPage(sessionDocId, existing?.updatedAt ?? 0) : 0;
    const sessionPage =
      readPage >= 1 ? readPage : Number.isFinite(savedPdfPage) && savedPdfPage >= 1 ? savedPdfPage : 0;
    setPdfSessionPage(sessionPage);
    if (sessionPage >= 1) {
      publishPdfFilmCurrent(tab.id, sessionPage);
      boardRef.current?.aimPdfPage(sessionPage);
    }
    return sessionPage;
  };

  // Workspace starts this at the original reading effect's declaration site,
  // after its other mode effects. Moving the effect here would reorder them.
  const trackPdfReadingPage = () => {
    let timer = 0;
    const unsubscribe = subscribePdfFilmCurrent(tab.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        saveReadingPage(annotateDocIdRef.current, peekPdfFilmCurrent(tab.id));
      }, 700);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  };

  const jumpPdfFilmPage = (page: number) => {
    resetPdfFilmPredicted(tab.id);
    boardRef.current?.aimPdfPage(page);
    boardRef.current?.scrollToPdfPage(page);
    setPdfFilmOpen(false);
  };

  return {
    annotatePdfErrorRef, pdfNav, setPdfNav, pdfNavRef, pdfSessionPage,
    onPdfThumbRenderer, renderPdfThumb, togglePdfFilm, pdfSpread,
    pdfLayoutBusy, togglePdfSpread, reconcilePdfInkLayout,
    restorePdfSessionPage, trackPdfReadingPage, jumpPdfFilmPage,
  };
}
