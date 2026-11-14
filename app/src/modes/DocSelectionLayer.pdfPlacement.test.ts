/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

import { documentUsesPdfPlacement } from "./DocSelectionLayer";

describe("whether a selectable body holds a PDF", () => {
  it("finds a PDF's document, or its pages placed in the body itself", () => {
    const pdf = document.createElement("div");
    pdf.innerHTML = '<div class="lc-pdf-doc"><div data-pdf-page="1"></div></div>';
    expect(documentUsesPdfPlacement(pdf)).toBe(true);
    const pages = document.createElement("div");
    pages.innerHTML = '<div data-pdf-page="4"></div>';
    expect(documentUsesPdfPlacement(pages)).toBe(true);
  });

  it("answers for a note without searching it", () => {
    const note = document.createElement("div");
    note.innerHTML = `<div class="lc-md-ink-doc">${"<p>words <span>and</span> more</p>".repeat(50)}</div>`;
    const search = vi.spyOn(note, "querySelector");
    const searchAll = vi.spyOn(note, "querySelectorAll");
    expect(documentUsesPdfPlacement(note)).toBe(false);
    expect(documentUsesPdfPlacement(note)).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(searchAll).not.toHaveBeenCalled();
  });

  it("notices a PDF that arrives later in the same body", () => {
    const body = document.createElement("div");
    expect(documentUsesPdfPlacement(body)).toBe(false);
    body.innerHTML = '<div class="lc-pdf-doc"></div>';
    expect(documentUsesPdfPlacement(body)).toBe(true);
  });
});
