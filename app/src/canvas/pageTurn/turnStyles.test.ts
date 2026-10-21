import { describe, expect, it, vi } from "vitest";
import { paintTurnStyle, rollRadius, rowEdge, rowFold, type TurnStyleFrame } from "./turnStyles";

const base = { width: 400, height: 560, grip: 0.5, tension: 0.5, speed: 0 };

describe("rowFold", () => {
  it("lies flat until the edge moves in", () => {
    expect(rowFold(400, 400, 10)).toBeNull();
  });

  it("brings the free edge back to where the hand has it, round the roll", () => {
    const r = 10;
    for (const edge of [250, 0, -300]) {
      const fold = rowFold(edge, 400, r)!;
      expect(fold.over).toBe(true);
      // Flat, half way round the roll, then back by what is left of the sheet.
      const back = 400 - fold.flat - Math.PI * r;
      expect(fold.flat - back).toBeCloseTo(edge, 6);
    }
  });

  it("only starts round the roll early in the peel", () => {
    const fold = rowFold(395, 400, 10)!;
    expect(fold.over).toBe(false);
    expect(fold.turned).toBeLessThan(Math.PI);
    expect(fold.flat + 10 * Math.sin(fold.turned)).toBeCloseTo(395, 3);
  });
});

describe("rollRadius", () => {
  it("rolls tighter with tension, a corner hold and a fast hand", () => {
    const slack = rollRadius({ ...base, tension: 0 });
    const tight = rollRadius({ ...base, tension: 1 });
    expect(tight).toBeLessThan(slack);
    expect(rollRadius({ ...base, grip: 0 })).toBeLessThan(rollRadius(base));
    expect(rollRadius({ ...base, speed: 2 })).toBeLessThan(rollRadius(base));
  });
});

describe("rowEdge", () => {
  it("is furthest pulled where the page is held, bowing back above and below", () => {
    const f = { ...base, pull: 0.4, grip: 0.5 };
    const held = rowEdge(f, 280);
    expect(held).toBeCloseTo(400 - 0.4 * 800, 6);
    expect(rowEdge(f, 0)).toBeGreaterThan(held);
    expect(rowEdge(f, 560)).toBeGreaterThan(held);
    expect(rowEdge(f, 0)).toBeLessThanOrEqual(400);
  });
});

describe("paintTurnStyle", () => {
  const ctx = () => {
    const gradient = { addColorStop: vi.fn() };
    return {
      drawImage: vi.fn(), fillRect: vi.fn(), createLinearGradient: vi.fn(() => gradient),
      fillStyle: "", globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D & { drawImage: ReturnType<typeof vi.fn> };
  };
  const image = {} as CanvasImageSource;
  const frame = (over: Partial<TurnStyleFrame>): TurnStyleFrame => ({
    style: "paperback", spread: true, width: 400, height: 560, imageScale: 2,
    pull: 0.4, grip: 0.6, tension: 0.5, speed: 0, dark: false, paper: "#fff",
    images: { front: image, under: image, left: image, back: image, frontMirrored: image },
    showBack: true, showThrough: true, shadow: true, ...over,
  });

  for (const style of ["paperback", "hardcover"] as const) {
    for (const spread of [true, false]) {
      for (const dark of [false, true]) {
        it(`draws ${style}, ${spread ? "spread" : "single"}, ${dark ? "dark" : "light"} paper`, () => {
          const c = ctx();
          const info = paintTurnStyle(c, frame({ style, spread, dark, pull: style === "hardcover" ? 0.7 : 0.4 }));
          expect(c.drawImage).toHaveBeenCalled();
          if (style === "paperback") expect(info.radius).toBeGreaterThan(0);
          else expect(info.angle).toBeCloseTo(126, 0);
        });
      }
    }
  }

  it("leaves the page flat at rest: one strip of the front per row, no fold", () => {
    const c = ctx();
    paintTurnStyle(c, frame({ pull: 0, spread: false }));
    // The page underneath, then one strip per row.
    expect(c.drawImage).toHaveBeenCalledTimes(1 + Math.ceil(560 / 2));
  });
});
