import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps PDF quality CSS local, fades opacity for 150ms, and respects reduced motion", () => {
  const css = readFileSync(resolve("src/styles.css"), "utf8");
  const selectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map(match => match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim())
    .filter(selector => selector.includes("data-pdf-quality"));
  expect(selectors.length).toBeGreaterThan(0);
  for (const selector of selectors) {
    expect(selector).not.toMatch(/:has\(|\bhtml\b|\bbody\b|\.lc-app|\.lc-board/);
    expect(selector).toMatch(/\.lc-pdf-page|\.lc-doc-page-marks/);
  }
  expect(css).toMatch(/\.lc-doc-page-marks\s*\{[^}]*opacity:\s*0\.5/);
  expect(css).toMatch(/\.lc-doc-page-marks\[data-pdf-quality="sharp"\]\s*\{[^}]*transition:\s*opacity 150ms/);
  expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.lc-doc-page-marks\[data-pdf-quality="sharp"\][^}]*transition:\s*none/);
});
