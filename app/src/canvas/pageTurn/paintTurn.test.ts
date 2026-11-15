import { describe, expect, it } from "vitest";
import { curlGeometry, foldReflection } from "./curl";
import { MARKS_THROUGH, PRINT_THROUGH, bookBack, flatSheet, paintTurn, underBlur } from "./paintTurn";

describe("flatSheet", () => {
  const frame = { layout: "sheet" as const, width: 400, height: 600, bottom: false };
  /** Where the flat sheet ends at the height nearest `y`. */
  const foldAt = (flat: { x: number; y: number }[], y: number) =>
    flat.slice(1, -1).reduce((best, p) => (Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best)).x;

  it("folds a sheet held by its side top to bottom, leading where it is held", () => {
    const flat = flatSheet({ ...frame, corner: { x: 0, y: 270 }, restY: 270 });
    const held = foldAt(flat, 270);
    expect(held).toBeCloseTo(200, 0);
    // Above and below, the paper trails behind the hand.
    expect(foldAt(flat, 0)).toBeGreaterThan(held + 10);
    expect(foldAt(flat, 600)).toBeGreaterThan(held + 10);
  });

  it("keeps the fold straight at rest", () => {
    const flat = flatSheet({ ...frame, corner: { x: 400, y: 270 }, restY: 270 });
    expect(foldAt(flat, 0)).toBeCloseTo(400, 5);
    expect(foldAt(flat, 600)).toBeCloseTo(400, 5);
  });
});

describe("the page being turned to", () => {
  /** A 2D context that records which pictures were drawn, and at what alpha. */
  function recordingContext() {
    const drawn: Array<{ image: unknown; alpha: number; args: unknown[] }> = [];
    let alpha = 1;
    const target: Record<string, unknown> = {
      drawImage: (image: unknown, ...args: unknown[]) => drawn.push({ image, alpha, args }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      getTransform: () => ({ d: 1 }),
    };
    const ctx = new Proxy(target, {
      get: (t, key) => (key === "globalAlpha" ? alpha : key in t ? t[key as string] : () => {}),
      set: (t, key, value) => {
        if (key === "globalAlpha") alpha = value as number;
        else t[key as string] = value;
        return true;
      },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
  }
  const to = { width: 400, height: 600 } as unknown as HTMLCanvasElement;
  const soft = { width: 80, height: 120 } as unknown as HTMLCanvasElement;
  const frame = (x: number) => ({
    layout: "sheet" as const, width: 400, height: 600, from: null, to, toBlur: soft,
    sourceWidth: 400, sourceHeight: 600, corner: { x, y: 600 }, bottom: true, paper: "#fff",
  });

  it("the back of the sheet shows its print faintly and its marks more strongly", () => {
    const from = { width: 400, height: 600 } as unknown as HTMLCanvasElement;
    const marks = { width: 400, height: 600 } as unknown as HTMLCanvasElement;
    // A corner curl, and a sheet held by its side: both have a back.
    for (const restY of [undefined, 300]) {
      const { ctx, drawn } = recordingContext();
      paintTurn(ctx, { ...frame(120), from, fromMarks: marks, restY, corner: { x: 120, y: restY ?? 600 } });
      expect(drawn.some((d) => d.image === from && d.alpha === PRINT_THROUGH)).toBe(true);
      expect(drawn.some((d) => d.image === marks && d.alpha === MARKS_THROUGH)).toBe(true);
    }
    expect(MARKS_THROUGH).toBeGreaterThan(PRINT_THROUGH);
  });

  it("shows through its softened copy as the turn starts, and comes sharp as it lands", () => {
    const early = recordingContext();
    const p0 = paintTurn(early.ctx, frame(380));
    const softEarly = early.drawn.find((d) => d.image === soft);
    expect(p0).toBeLessThan(0.2);
    expect(softEarly?.alpha).toBeGreaterThan(0.7);
    expect(early.drawn.findIndex((d) => d.image === to)).toBeLessThan(early.drawn.findIndex((d) => d.image === soft));

    const late = recordingContext();
    const p1 = paintTurn(late.ctx, frame(-370));
    expect(p1).toBeGreaterThan(0.9);
    const softLate = late.drawn.find((d) => d.image === soft);
    expect(softLate === undefined || softLate.alpha < 0.05).toBe(true);
  });

  it("draws a small stand-in for the page turned to at its own size, beside a full picture of the other", () => {
    const from = { width: 400, height: 600 } as unknown as HTMLCanvasElement;
    const small = { width: 100, height: 150 } as unknown as HTMLCanvasElement;
    const { ctx, drawn } = recordingContext();
    paintTurn(ctx, { ...frame(200), from, to: small, toBlur: null });
    const under = drawn.find((d) => d.image === small)!;
    // The whole stand-in, not a 400 by 600 corner of it.
    expect(under.args.slice(0, 4)).toEqual([0, 0, 100, 150]);
    expect(drawn.find((d) => d.image === from)!.args.slice(0, 4)).toEqual([0, 0, 400, 600]);
  });

  it("puts a book sheet's stand-in on its back when it has no picture of the spread it goes to", () => {
    const back = { width: 100, height: 150 } as unknown as HTMLCanvasElement;
    const book = { ...frame(0), layout: "book" as const, width: 800, from: null, to: null, toBlur: null, back, corner: { x: 120, y: 600 } };
    const live = recordingContext();
    paintTurn(live.ctx, book);
    expect(live.drawn.some((d) => d.image === back)).toBe(true);
    // A pictured turn draws its back from the picture.
    const pictured = recordingContext();
    paintTurn(pictured.ctx, { ...book, to: { width: 800, height: 600 } as unknown as HTMLCanvasElement });
    expect(pictured.drawn.some((d) => d.image === back)).toBe(false);
  });

  it("draws no softened copy when there is none", () => {
    const { ctx, drawn } = recordingContext();
    paintTurn(ctx, { ...frame(200), toBlur: null });
    expect(drawn.every((d) => d.image !== soft)).toBe(true);
    expect(underBlur(0)).toBe(1);
    expect(underBlur(1)).toBe(0);
  });
});

describe("the back of a book's turning sheet, live", () => {
  // One page of a 400 x 600 spread: the sheet is 200 wide, bound at x 200.
  const sheet = { width: 200, height: 600, bottom: true };
  const matrix = (transform: string) => transform.match(/-?[\d.e]+/g)!.map(Number);
  const apply = ([a, b, c, d, e, f]: number[], x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f });

  it("is nowhere while the sheet lies flat", () => {
    expect(bookBack({ ...sheet, corner: { x: 200, y: 600 } })).toBeNull();
  });

  it("lies on the left page, the right way round, once the sheet is over", () => {
    const back = bookBack({ ...sheet, corner: { x: -200, y: 600 } })!;
    const m = matrix(back.transform);
    expect(m.map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(back.clipPath).toBe("polygon(200.00px 0.00px, 0.00px 0.00px, 0.00px 600.00px, 200.00px 600.00px)");
  });

  it("puts each point of the page where the canvas's flap would draw it", () => {
    // A corner peel part way over, the fold on a slant.
    const frame = { ...sheet, corner: { x: 40, y: 430 } };
    const m = matrix(bookBack(frame)!.transform);
    const r = foldReflection(curlGeometry(frame.corner, 200, 600, true));
    for (const [x, y] of [[0, 0], [150, 600], [60, 300], [200, 580]] as const) {
      // The canvas: the page mirrored into the sheet, reflected, past the spine.
      const want = apply(r, 200 - x, y);
      const got = apply(m, x, y);
      expect(got.x).toBeCloseTo(want.x + 200, 1);
      expect(got.y).toBeCloseTo(want.y, 1);
    }
  });

  it("leaves the canvas's flap clear for it, with only the shading drawn", () => {
    const filled: unknown[] = [];
    const target: Record<string, unknown> = {
      createLinearGradient: () => ({ addColorStop: () => {} }),
      getTransform: () => ({ d: 1 }),
    };
    target.fillRect = () => filled.push(target.fillStyle);
    const ctx = new Proxy(target, { get: (t, key) => (key in t ? t[key as string] : () => {}) }) as unknown as CanvasRenderingContext2D;
    const frame = {
      layout: "book" as const, width: 400, height: 600, from: null, to: null, sourceWidth: 1, sourceHeight: 1,
      corner: { x: -120, y: 300 }, bottom: true, restY: 300, paper: "paper",
    };
    paintTurn(ctx, frame);
    expect(filled).toContain("paper");
    filled.length = 0;
    paintTurn(ctx, { ...frame, liveBack: true });
    expect(filled).not.toContain("paper");
  });
});
