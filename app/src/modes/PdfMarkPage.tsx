import { useLayoutEffect, useRef, type ReactNode } from "react";
import { pdfPageFromDocScope, type LocalRect } from "../util/docMarquee";
import { subscribePdfPageQuality } from "./pdfFilm";

/** A small compositing group, with the existing body-local mark coordinates. */
export function PdfMarkPage({ filmScope, scope, page, children }: {
  filmScope?: string; scope?: string; page?: LocalRect; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const number = pdfPageFromDocScope(scope);
  // A PDF page's marks are always grouped, even before the page's box is
  // known (just after start-up): ungrouped, they showed before the page did.
  const grouped = Boolean(filmScope && number != null);
  const box = page ?? { left: 0, top: 0, width: 0, height: 0 };
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !filmScope || number == null || !grouped) return;
    return subscribePdfPageQuality(filmScope, number, quality => {
      if (node.dataset.pdfQuality !== quality) node.dataset.pdfQuality = quality;
    });
  }, [filmScope, number, grouped]);
  if (!grouped) return <>{children}</>;
  return <div ref={ref} className="lc-doc-page-marks" data-mark-page={number!}
    style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
    <div className="lc-doc-page-marks-origin" style={{ left: -box.left, top: -box.top }}>{children}</div>
  </div>;
}
