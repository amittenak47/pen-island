import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./HomeChooser.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const tracer = readFileSync(new URL("./whiteboardTracer.ts", import.meta.url), "utf8");

describe("home chooser cards", () => {
  it("labels modes with a colored kicker and blurb, not a bold title", () => {
    expect(src).toContain('kicker: "Whiteboard"');
    expect(src).toContain('kicker: "Annotate"');
    expect(src).toContain('kicker: "Explore"');
    expect(src).not.toContain('kicker: "Scratch"');
    expect(src).not.toContain('kicker: "Reading"');
    expect(src).not.toContain('kicker: "Notes"');
    expect(src).not.toContain("lc-home-card-title");
    expect(src).not.toContain("{mode.title}");
    expect(css).toMatch(/\.lc-home-card-text \{[\s\S]*?align-items: flex-start/);
    expect(css).toMatch(/\.lc-home-card-text \{[\s\S]*?text-align: left/);
    expect(css).not.toContain(".lc-home-card-title");
  });

  it("plays practice, whiteboard, and annotate icon scenes on hover", () => {
    expect(src).toContain('const HOVER_SCENES = new Set(["practice", "whiteboard", "annotate"])');
    expect(src).toContain('data-scene={hoverable ? scene : undefined}');
    expect(src).toContain("M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z");
    expect(src).not.toContain("PAGE_FOLD");
    expect(src).toContain("lc-home-wb-draw-a");
    expect(src).toContain("lc-home-wb-draw-b");
    expect(src).toContain("lc-home-box-a");
    expect(src).toContain("lc-home-box-b");
    expect(src).toContain("lc-home-net-flow");
    expect(src).toContain("lc-home-graph");
    expect(css).toContain('data-scene="in"');
    expect(css).toContain('data-scene="out"');
    // Practice braces open/close from their live pose (practiceBraces.ts); CSS keeps the idle loop.
    expect(src).toContain("createPracticeBraces");
    expect(css).not.toContain("lc-home-bra-in-l");
    expect(css).toContain("lc-home-bra-idle-l");
    expect(css).toContain("lc-home-slash-idle");
    // Whiteboard hover and leave are traced from the strokes' own geometry;
    // CSS keeps only the resting nib loop, and the page never slides.
    expect(css).toContain("lc-home-nib-place");
    expect(css).not.toContain("lc-home-nib-write");
    expect(css).not.toContain("lc-home-page-scroll");
    expect(src).toContain("createWhiteboardTracer");
    expect(tracer).toContain("getPointAtLength");
    expect(src).toContain('className="lc-home-trace"');
    // Annotate scrolls its text and curls/turns the page; lines no longer cascade in.
    expect(css).toContain("lc-home-ann-scroll");
    expect(css).toContain("lc-home-ann-turn");
    expect(css).toContain("lc-home-ann-curl");
    expect(css).not.toContain("lc-home-ann-lines");
    expect(css).toContain("lc-home-net-shoot");
    expect(css).toContain("lc-home-nib-arm");
  });

  it("keeps annotate marks off the rest page and matches the whiteboard sheet size", () => {
    expect(src).toContain('className="lc-home-glyph-sheet"');
    expect(src).not.toContain("lc-home-glyph-page");
    expect(css).toContain("lc-home-card[data-mode=\"annotate\"] .lc-home-card-icon > svg");
    expect(css).toContain("width: 78%");
    expect(css).not.toContain('data-scene="rest"] .lc-home-mark');
    expect(css).not.toContain('data-scene="out"] .lc-home-mark');
  });
});
