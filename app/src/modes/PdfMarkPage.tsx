import { useLayoutEffect, useRef, type ReactNode } from "react";
import { pdfPageFromDocScope, type LocalRect } from "../util/docMarquee";
import { subscribePdfPageQuality } from "./pdfFilm";

/** A small compositing group, with the existing body-local mark coordinates. */
export function PdfMarkPage({ filmScope, scope, page, children }: {
  filmScope?: string; scope?: string; page?: LocalRect; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const number = pdfPageFromDocScope(scope);
  const grouped = Boolean(filmScope && page && number != null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !filmScope || number == null || !grouped) return;
    return subscribePdfPageQuality(filmScope, number, quality => {
      if (node.dataset.pdfQuality !== quality) node.dataset.pdfQuality = quality;
    });
  }, [filmScope, number, grouped]);
  if (!grouped || !page) return <>{children}</>;
  return <div ref={ref} className="lc-doc-page-marks" data-mark-page={number!}
    style={{ left: page.left, top: page.top, width: page.width, height: page.height }}>
    <div className="lc-doc-page-marks-origin" style={{ left: -page.left, top: -page.top }}>{children}</div>
  </div>;
}
