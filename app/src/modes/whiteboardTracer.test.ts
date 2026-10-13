/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhiteboardTracer } from "./whiteboardTracer";

const SVG = "http://www.w3.org/2000/svg";

function card() {
  const root = document.createElement("div");
  const svg = document.createElementNS(SVG, "svg");
  const group = (cls: string, parent: Element = svg, attrs: Record<string, string> = {}) => {
    const g = document.createElementNS(SVG, "g");
    g.setAttribute("class", cls);
    for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
    parent.appendChild(g);
    return g;
  };
  const strokes = (parent: Element, cls: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("class", cls);
      parent.appendChild(p);
    }
  };
  const rest = group("lc-home-wb-rest");
  strokes(group("lc-home-wb-sketch", rest, { "data-sketch": "diagram" }), "lc-home-trace", 5);
  strokes(group("lc-home-wb-sketch", rest, { "data-sketch": "note" }), "lc-home-trace", 3);
  group("lc-home-wb-sketch", rest, { "data-sketch": "blank" });
  strokes(group("lc-home-wb-draw-a"), "lc-home-draw", 2);
  strokes(group("lc-home-wb-draw-b"), "lc-home-draw", 2);
  group("lc-home-nib-arm");
  root.appendChild(svg);
  document.body.appendChild(root);
  return root;
}

/** Strokes of one resting sketch that are currently fully drawn. */
function drawnIn(root: Element, sketch: string) {
  return [...root.querySelectorAll<SVGElement>(`[data-sketch="${sketch}"] .lc-home-trace`)]
    .filter(el => el.style.opacity === "1" && Number(el.style.strokeDashoffset) < 0.001).length;
}

describe("whiteboard tracer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "performance"] });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    // jsdom has no SVG geometry; give every stroke a 10-unit length.
    Object.assign(Element.prototype, {
      getTotalLength: () => 10,
      getPointAtLength: (length: number) => ({ x: length, y: 0 }),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("rotates the resting page between the diagram, the note and a blank page on each leave", async () => {
    const root = card();
    const tracer = createWhiteboardTracer(root)!;
    expect(tracer).not.toBeNull();
    const rests: string[] = [];
    const leave = async () => {
      let done = false;
      tracer.leave(() => { done = true; });
      for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(true);
      rests.push(`diagram:${drawnIn(root, "diagram")} note:${drawnIn(root, "note")}`);
    };
    await leave();
    await leave();
    await leave();
    expect(rests).toEqual(["diagram:0 note:3", "diagram:0 note:0", "diagram:5 note:0"]);
  });

  it("erases the resting sketch before drawing the hover set, and never draws both", async () => {
    const root = card();
    const tracer = createWhiteboardTracer(root)!;
    tracer.enter();
    let overlapped = false;
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(50);
      const hover = [...root.querySelectorAll<SVGElement>(".lc-home-draw")].some(el => el.style.opacity === "1");
      if (hover && drawnIn(root, "diagram") > 0) overlapped = true;
    }
    expect(drawnIn(root, "diagram")).toBe(0);
    expect(overlapped).toBe(false);
    tracer.dispose();
  });
});
