import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { createLiveRibbon } from "./ribbon";
import { fillMiterStroke } from "./fallback";
import { createInkLabEngine } from "./engine";
import type { SpineDot } from "./instance";
import type { InkLabPen } from "./style";

const canvas = (w = 1600, h = 200) => createCanvas(w, h) as unknown as HTMLCanvasElement;
const pen: InkLabPen = { color: "#000000", baseWidth: 8, dpr: 1, overlayScale: 1,
  pressureSensitive: false, pressureClip: 1, maxFullness: 1, speedInk: 0,
  speedFade: 0, speedBlotBlend: 0, boldness: 1 };

describe("board pen ribbon", () => {
  it("keeps retraced ink solid instead of making a bow-tie", () => {
    const ctx = canvas().getContext("2d")!;
    fillMiterStroke(ctx, [{ x: 20, y: 80, r: 6 }, { x: 120, y: 80, r: 6 },
      { x: 60, y: 80, r: 6 }], null, [0, 0, 0]);
    for (let x = 25; x < 115; x++) expect(ctx.getImageData(x, 79, 1, 1).data[3]).toBe(255);
  });
  it("keeps copied tail width bounded as an unsmoothed stroke grows", () => {
    const host = canvas(), snap = canvas();
    const ribbon = createLiveRibbon();
    const points: SpineDot[] = [];
    let width = 0;
    for (let i = 0; i < 300; i++) {
      points.push({ x: 20 + i * 4, y: 90 + Math.sin(i / 5) * 20, r: 4 });
      const box = ribbon.paint(host, snap, points, Math.max(0, points.length - 3));
      if (i > 10) width = Math.max(width, box.maxX - box.minX);
    }
    expect(width).toBeLessThan(45);
    expect(host.getContext("2d")!.getImageData(24, 90, 1, 1).data[3]).toBeGreaterThan(0);
  });

  it("keeps a stroke whose colour changes on every dot seamless: one antialiased edge", () => {
    const ctx = canvas().getContext("2d")!;
    const points: SpineDot[] = Array.from({ length: 60 }, (_, i) =>
      ({ x: 20 + i * 9, y: 90 + Math.sin(i / 6) * 30, r: 12, rgb: [40 + (i % 7) * 9, 40, 40] as [number, number, number] }));
    fillMiterStroke(ctx, points, null, [0, 0, 0]);
    for (let i = 1; i < points.length - 1; i++) {
      // Across every hop joint and through every hop's middle.
      for (const t of [0, 0.5]) {
        const a = points[i]!, b = points[i + 1]!;
        const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
        expect(ctx.getImageData(x, y, 1, 1).data[3]).toBe(255);
      }
    }
  });

  it("paints the live 2D tail without seams where frames meet", () => {
    const host = canvas(), snap = canvas();
    const ribbon = createLiveRibbon();
    const points: SpineDot[] = [];
    for (let i = 0; i < 120; i++) {
      points.push({ x: 20 + i * 6, y: 100 + Math.sin(i / 8) * 40, r: 10, rgb: [30 + (i % 5) * 12, 30, 30] });
      ribbon.paint(host, snap, points, Math.max(0, points.length - 3));
    }
    const ctx = host.getContext("2d")!;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i]!;
      expect(ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data[3]).toBe(255);
    }
  });

  it("caps only the two true endpoints, including sub-nib and zero-length hops", () => {
    const ctx = canvas().getContext("2d")!;
    const arc = vi.spyOn(ctx, "arc");
    const points = Array.from({ length: 100 }, (_, i) =>
      ({ x: 30 + Math.floor(i / 2), y: 80, r: 8 }));
    fillMiterStroke(ctx, points, null, [0, 0, 0]);
    expect(arc).toHaveBeenCalledTimes(2);
    // No interior seams/dots through a constant-width tube.
    for (let x = 32; x < 75; x++) {
      expect(ctx.getImageData(x, 80, 1, 1).data[3]).toBe(255);
    }
    arc.mockRestore();
  });

  it("On Lift leaves the live centerline identical to Off; Live reshapes it", () => {
    const run = (smoothing: number, smoothingMode: "lift" | "live") => {
      const host = canvas();
      const engine = createInkLabEngine();
      engine.attach(host);
      engine.setPen({ ...pen, smoothing, smoothingMode });
      engine.down({ x: 30, y: 80, p: 0.5, t: 0 });
      for (let i = 1; i < 50; i++) {
        engine.move([{ x: 30 + i * 5, y: 80 + Math.sin(i / 3) * 28, p: 0.5, t: i * 8 }]);
        engine.paint();
      }
      const pixels = host.getContext("2d")!.getImageData(0, 0, 400, 200).data;
      const result = engine.liftRaw();
      engine.destroy();
      return { pixels, points: result.points };
    };
    const off = run(0, "lift"), lift = run(1, "lift"), live = run(1, "live");
    expect(lift.pixels).toEqual(off.pixels);
    expect(lift.points).toEqual(off.points);
    expect(live.pixels).not.toEqual(off.pixels);
    expect(live.points).not.toEqual(off.points);
  });

  it("an idle worker replacement keeps an undo covering the new geometry", () => {
    const host = canvas();
    const engine = createInkLabEngine();
    engine.attach(host);
    engine.setPen({ ...pen, smoothing: 0 });
    engine.down({ x: 40, y: 80, p: 0.5, t: 0 });
    engine.move([{ x: 120, y: 80, p: 0.5, t: 16 }]);
    const original = engine.liftRaw();
    const patch = engine.replaceLastStroke(original.undoPatch!,
      [{ x: 40, y: 70, r: 4 }, { x: 120, y: 50, r: 4 }]);
    expect(patch).not.toBeNull();
    engine.restoreSnapPatch(patch!);
    engine.paint();
    const data = host.getContext("2d")!.getImageData(0, 0, 200, 200).data;
    expect(data.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
    engine.destroy();
  });
});
