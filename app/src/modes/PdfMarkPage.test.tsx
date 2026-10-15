/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PdfMarkPage } from "./PdfMarkPage";
import { peekPdfPageQuality, publishPdfPageQuality, resetPdfFilmScopes, resetPdfPageQualities } from "./pdfFilm";

afterEach(() => { resetPdfFilmScopes(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("changes only that page's quality attribute and preserves body-local child geometry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<>
    <PdfMarkPage filmScope="book" scope="p4" page={{ left: 10, top: 900, width: 600, height: 800 }}>
      <span style={{ position: "absolute", left: 90, top: 950 }}>mark</span>
    </PdfMarkPage>
    <PdfMarkPage filmScope="book" scope="p5r" page={{ left: 10, top: 1720, width: 600, height: 800 }}>other</PdfMarkPage>
  </>));
  try {
    const page = host.querySelector<HTMLElement>('[data-mark-page="4"]')!;
    const other = host.querySelector<HTMLElement>('[data-mark-page="5"]')!;
    const child = page.querySelector("span")!, style = child.getAttribute("style");
    expect(page.dataset.pdfQuality).toBe("preview");
    expect(page.querySelector<HTMLElement>(".lc-doc-page-marks-origin")!.style.top).toBe("-900px");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(document.documentElement, { attributes: true, subtree: true });
    publishPdfPageQuality("different-book", 4, "sharp");
    publishPdfPageQuality("book", 4, "sharp");
    publishPdfPageQuality("book", 4, "sharp");
    await Promise.resolve();
    observer.disconnect();
    expect(mutations.map(m => [m.target, m.attributeName])).toEqual([[page, "data-pdf-quality"]]);
    expect(page.dataset.pdfQuality).toBe("sharp");
    expect(other.dataset.pdfQuality).toBe("preview");
    expect(page.querySelector("span")).toBe(child);
    expect(child.getAttribute("style")).toBe(style);
    resetPdfPageQualities("book");
    expect(page.dataset.pdfQuality).toBe("preview");
    expect(peekPdfPageQuality("different-book", 4)).toBe("sharp");
  } finally { act(() => root.unmount()); }
});
