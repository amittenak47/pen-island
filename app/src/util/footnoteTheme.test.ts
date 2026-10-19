import { describe, expect, it } from "vitest";

import {
  footnoteThemeVars,
  contrastRatio,
  readableInk,
  readableInkOn,
  relativeLuminance,
} from "./footnoteTheme";

describe("footnoteThemeVars", () => {
  it("keeps numbers readable on light, dark and mid-tone badge colours", () => {
    for (const color of ["#fff3e2", "#111111", "#777777", "#0d9488", "#e90074"]) {
      const style = footnoteThemeVars(color, [color, color]);
      const fill = String(style["--lc-fn-badge-fill" as keyof typeof style]);
      const ink = String(style["--lc-fn-badge-ink" as keyof typeof style]);
      expect(fill).toBe(color);
      expect(contrastRatio(fill, ink)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("puts selected color in --lc-fn-color and rotates it to --lc-fn-p0", () => {
    const palette = ["#483838", "#42855b", "#90b77d", "#d2d79f"];
    const style = footnoteThemeVars("#90b77d", palette);
    expect(style["--lc-fn-color" as keyof typeof style]).toBe("#90b77d");
    expect(style["--lc-fn-p0" as keyof typeof style]).toBe("#90b77d");
    expect(style["--lc-fn-p1" as keyof typeof style]).toBe("#483838");
  });

  it("assigns light/deep from non-primary by luminance", () => {
    const palette = ["#111111", "#888888", "#eeeeee", "#ff0000"];
    const style = footnoteThemeVars("#ff0000", palette);
    expect(style["--lc-fn-deep" as keyof typeof style]).toBe("#111111");
    expect(style["--lc-fn-light" as keyof typeof style]).toBe("#eeeeee");
  });

  it("falls back to palette[0] when primary missing", () => {
    const palette = ["#0d9488", "#5eead4", "#99f6e4", "#ccfbf1"];
    const style = footnoteThemeVars(undefined, palette);
    expect(style["--lc-fn-color" as keyof typeof style]).toBe("#0d9488");
  });

  it("keeps label ink dark when the selected primary is a pastel", () => {
    const palette = ["#90b77d", "#b6d7a8", "#d9ead3", "#eef6eb"];
    const style = footnoteThemeVars("#b6d7a8", palette, "#f8fafc");
    expect(style["--lc-fn-color" as keyof typeof style]).toBe("#b6d7a8");
    const ink = String(style["--lc-fn-ink" as keyof typeof style]);
    expect(relativeLuminance(ink)).toBeLessThanOrEqual(0.38);
  });

  it("uses light label ink on a dark theme panel", () => {
    const palette = ["#90b77d", "#b6d7a8", "#d9ead3", "#eef6eb"];
    const style = footnoteThemeVars("#b6d7a8", palette, "#141416");
    const ink = String(style["--lc-fn-ink" as keyof typeof style]);
    expect(relativeLuminance(ink)).toBeGreaterThan(0.5);
  });

  it("captions on the page stay readable with a light palette on a dark theme", () => {
    // The panel's label ink is light here (it sits on a dark wash); the caption sits on white paper.
    const palette = ["#ffd6e0", "#ffe5b4", "#c1f0dc", "#d6e4ff"];
    const style = footnoteThemeVars("#ffd6e0", palette, "#141416");
    const panelInk = String(style["--lc-fn-ink" as keyof typeof style]);
    const paperInk = String(style["--lc-fn-paper-ink" as keyof typeof style]);
    expect(contrastRatio(panelInk, "#ffffff")).toBeLessThan(3);
    expect(contrastRatio(paperInk, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // In the square's own hue (pink), darkened: not another palette colour.
    const [r, g, b] = [1, 3, 5].map(i => parseInt(paperInk.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g!); expect(r).toBeGreaterThan(b!);
    // A square colour that already reads on white is used as it is.
    const own = footnoteThemeVars("#1d4ed8", ["#111111", "#888888", "#eeeeee", "#1d4ed8"], "#141416");
    expect(own["--lc-fn-paper-ink" as keyof typeof own]).toBe("#1d4ed8");
  });

  it("tints nested chips from the palette, not the raw panel", () => {
    const palette = ["#90b77d", "#b6d7a8", "#d9ead3", "#eef6eb"];
    const style = footnoteThemeVars("#b6d7a8", palette, "#141416");
    expect(style["--lc-fn-chip" as keyof typeof style]).not.toBe("#141416");
    expect(style["--lc-fn-wash" as keyof typeof style]).not.toBe("#141416");
  });
});

describe("readableInk", () => {
  it("prefers a dark candidate over pastels", () => {
    expect(readableInk("#eeeeee", "#483838", "#90b77d")).toBe("#483838");
  });

  it("falls back when every candidate is too light", () => {
    expect(readableInk("#eef6eb", "#d9ead3", "#b6d7a8")).toBe("#1c1917");
  });
});

describe("readableInkOn", () => {
  it("picks light ink on a dark wash", () => {
    const ink = readableInkOn("#1a1a1c", ["#eef6eb", "#1c1917"]);
    expect(relativeLuminance(ink)).toBeGreaterThan(0.5);
  });
});

describe("relativeLuminance", () => {
  it("ranks white above black", () => {
    expect(relativeLuminance("#ffffff")).toBeGreaterThan(relativeLuminance("#000000"));
  });
});
