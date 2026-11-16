// @ts-expect-error Node runtime module used by Vitest; app intentionally has no Node typings.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FOOTNOTE_THEMED } from "./util/footnoteTheme";
import { footnoteThemedSelectors } from "./util/footnoteThemeTestKit";

/*
 * Every stylesheet under src, read from disk: Vitest turns `.css` imports,
 * `?raw` included, into empty strings.
 */
const sheets: Record<string, string> = Object.fromEntries(
  (readdirSync(new URL(".", import.meta.url), { recursive: true }) as string[])
    .filter((path) => path.endsWith(".css"))
    .map((path) => [path, readFileSync(new URL(path.replaceAll("\\", "/"), import.meta.url), "utf8") as string]),
);

function selectorsOf(css: string): string[] {
  return [...css.replace(/\/\*[^]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
    .flatMap((match) => match[1]!.split(","))
    .map((selector) => selector.trim())
    .filter((selector) => !selector.startsWith("@"));
}

describe("footnote colour styles", () => {
  /*
   * A `[style…]` test anywhere but a selector's last part gives Blink a
   * descendant invalidation set for the style attribute: every inline-style
   * write then walks the written element's whole subtree. A page turn writes
   * the page slot of a 60,000-node note every frame, about 5 ms a write on
   * the tablet. Mark the element with a class instead (`FOOTNOTE_THEMED`).
   */
  it("never selects on the style attribute", () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(1);
    const found = Object.entries(sheets).flatMap(([path, css]) =>
      selectorsOf(css)
        .filter((selector) => /\[\s*style\b/i.test(selector))
        .map((selector) => `${path}: ${selector}`),
    );
    expect(found).toEqual([]);
  });

  it("keys a chosen colour on the class footnoteThemeVars elements wear", () => {
    expect(FOOTNOTE_THEMED).toBe("lc-fn-themed");
    const selectors = footnoteThemedSelectors();
    // The chip, badge and booktab; the band; the card and what is inside it.
    for (const expected of [
      ":root .lc-doc-footnote.lc-fn-themed",
      ":root .lc-fn-badge.lc-fn-themed",
      ":root .lc-footnote-chip.lc-fn-themed .lc-fn-badge",
      ":root .lc-doc-footnote-band.lc-fn-themed",
      ".lc-footnote-overview.lc-fn-themed",
      ".lc-footnote-overview.is-task.lc-fn-themed",
      ".lc-footnote-overview.lc-fn-themed .lc-footnote-chip",
      ".lc-footnote-overview.lc-fn-themed .lc-footnote-overview-entry-hold",
      ".lc-doc-sheet.lc-footnote-overview:not(.lc-fn-themed)",
    ]) {
      expect(selectors).toContain(expected);
    }
  });
});
