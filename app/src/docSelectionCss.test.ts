import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** Selectors of rules keyed on a mode class the selection layer toggles. */
function selectorsFor(modeClass: string): string[] {
  return [...css.matchAll(/([^{}]+)\{/g)]
    .flatMap((match) => match[1]!.split(","))
    .map((selector) => selector.replace(/\/\*[^]*?\*\//g, "").trim())
    .filter((selector) => selector.includes(modeClass));
}

describe("selection mode styles stay cheap on a long PDF", () => {
  // A textbook's body holds ~25k glyph spans. A mode class that restyles the
  // body or every span cost about a second per Underline tap on the tablet.
  for (const mode of [".lc-doc-submark-armed", ".lc-doc-panel-open", ".lc-doc-selecting"]) {
    it(`${mode} never restyles every PDF span or a PDF's whole body`, () => {
      for (const selector of selectorsFor(mode)) {
        expect(selector, selector).not.toMatch(/\.lc-pdf-text\s+span|\.lc-pdf-text\s*\*/);
        if (/\.lc-doc-selectable-body(\s|$|\*)/.test(selector) || selector.endsWith(".lc-doc-selectable-body")) {
          expect(selector, selector).toContain(":not(:has(> .lc-pdf-doc))");
        }
      }
    });
  }
});
