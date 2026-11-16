/**
 * Test helpers for the footnote colour marker ({@link FOOTNOTE_THEMED}).
 *
 * The stylesheet used to find a reader-chosen colour with
 * `[style*="--lc-fn-color"]`. It now keys on a class. These helpers check that
 * the switch changed nothing a reader can see: the class sits on exactly the
 * elements whose inline style carries the colour, and every colour rule picks
 * out the same elements its old style-attribute form did.
 */
// @ts-expect-error Node runtime module used by Vitest; app intentionally has no Node typings.
import { readFileSync } from "node:fs";
// @ts-expect-error Node runtime module used by Vitest; app intentionally has no Node typings.
import { fileURLToPath } from "node:url";
import { FOOTNOTE_THEMED } from "./footnoteTheme";

/*
 * Read from disk: Vitest hands every `.css` import, `?raw` included, over as
 * an empty string. The base goes through a variable because Vite rewrites a
 * literal `new URL("…", import.meta.url)` into an http asset URL under jsdom.
 */
const here: string = import.meta.url;
const css: string = readFileSync(fileURLToPath(new URL("../styles.css", here).href), "utf8");
const MARKER = `.${FOOTNOTE_THEMED}`;
/** What the colour rules tested before they had a class to key on. */
export const LEGACY_FOOTNOTE_TEST = '[style*="--lc-fn-color"]';

/** Every selector in styles.css that keys on the footnote colour marker. */
export function footnoteThemedSelectors(): string[] {
  const rules = css.replace(/\/\*[^]*?\*\//g, "");
  return [
    ...new Set(
      [...rules.matchAll(/([^{}]+)\{/g)]
        .flatMap((match) => match[1]!.split(","))
        .map((selector) => selector.trim())
        .filter((selector) => !selector.startsWith("@") && selector.includes(MARKER)),
    ),
  ];
}

function hasInlineColour(el: Element): boolean {
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  return !!style?.getPropertyValue("--lc-fn-color");
}

function describeElement(el: Element): string {
  const className = typeof el.className === "string" ? el.className : el.getAttribute("class") ?? "";
  return `<${el.tagName.toLowerCase()} class="${className}">`;
}

/**
 * Mismatches under `root` (inclusive): an element whose marker and inline
 * colour disagree, or a colour rule that now selects an element differently
 * from its `[style*=…]` form. Empty when the switch is exact.
 */
export function footnoteMarkerMismatches(root: ParentNode): string[] {
  const selectors = footnoteThemedSelectors();
  const elements = [...(root instanceof Element ? [root] : []), ...root.querySelectorAll("*")];
  const problems: string[] = [];
  for (const el of elements) {
    const inline = hasInlineColour(el);
    if (el.classList.contains(FOOTNOTE_THEMED) !== inline) {
      problems.push(`${describeElement(el)} ${inline ? "has the colour but no marker" : "has the marker but no colour"}`);
    }
    for (const selector of selectors) {
      const now = el.matches(selector);
      const before = el.matches(selector.replaceAll(MARKER, LEGACY_FOOTNOTE_TEST));
      if (now !== before) problems.push(`${describeElement(el)} ${now ? "now matches" : "no longer matches"} ${selector}`);
    }
  }
  return problems;
}

/** How many elements under `root` (inclusive) wear the footnote colour. */
export function footnoteThemedCount(root: ParentNode): number {
  const elements = [...(root instanceof Element ? [root] : []), ...root.querySelectorAll("*")];
  return elements.filter(hasInlineColour).length;
}
