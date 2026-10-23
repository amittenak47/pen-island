import { describe, expect, it, vi } from "vitest";

import { createInkLabEngine } from "./engine";

type GlStub = { lost: boolean; failCompile: boolean; calls: string[]; args?: [string, unknown[]][] };

const glConst = new Map<string, number>();
/** A distinct number per GL constant name, so a test can tell MAX from FUNC_ADD. */
const constOf = (name: string) => {
  if (!glConst.has(name)) glConst.set(name, 0x1000 + glConst.size);
  return glConst.get(name)!;
};

/** Any GL call is a no-op that answers truthy; constants are numbers. */
function fakeGl(state: GlStub): WebGL2RenderingContext {
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return constOf(key);
      if (key === "isContextLost") return () => state.lost;
      if (key === "getShaderParameter") return () => !state.failCompile;
      if (key === "getProgramParameter") return () => true;
      if (key === "getExtension") return () => null;
      return (...args: unknown[]) => {
        state.calls.push(key);
        state.args?.push([key, args]);
        return {};
      };
    },
  }) as WebGL2RenderingContext;
}

/** Records drawImage sources so a test can see what reached the host. */
function fake2d(canvas: FakeCanvas): CanvasRenderingContext2D {
  return new Proxy({}, {
    get(_t, key) {
      if (key === "canvas") return canvas;
      if (key === "drawImage") return (src: unknown) => canvas.drawn.push(src);
      return () => undefined;
    },
    set() {
      return true;
    },
  }) as CanvasRenderingContext2D;
}

let webgl: ((attrs?: WebGLContextAttributes) => WebGL2RenderingContext | null) = () => null;

const created: FakeCanvas[] = [];

class FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  drawn: unknown[] = [];
  gl: WebGL2RenderingContext | null = null;
  constructor(w = 240, h = 160) {
    created.push(this);
    this.width = w;
    this.height = h;
    this.clientWidth = w;
    this.clientHeight = h;
  }
  getContext(kind: string, attrs?: WebGLContextAttributes) {
    if (kind === "webgl2") {
      this.gl ??= webgl(attrs);
      return this.gl;
    }
    return fake2d(this);
  }
}

function stroke(engine: ReturnType<typeof createInkLabEngine>, hops = 12) {
  engine.down({ x: 20, y: 40, p: 0.5, t: 0 });
  const batch = [];
  for (let i = 1; i <= hops; i++) batch.push({ x: 20 + i * 12, y: 40 + (i % 3) * 6, p: 0.5, t: i * 8 });
  engine.move(batch);
}

function setup(state: Partial<GlStub> = {}) {
  const gl: GlStub = { lost: false, failCompile: false, calls: [], ...state };
  webgl = () => fakeGl(gl);
  return { gl, host: new FakeCanvas() as unknown as HTMLCanvasElement & FakeCanvas };
}

describe("ink lab backend selection", () => {
  it("uses WebGL2 capsules when WebGL2 starts", () => {
    const { gl, host } = setup();
    const engine = createInkLabEngine();
    expect(engine.attach(host)).toBe("webgl2");
    stroke(engine);
    const stats = engine.paint();
    expect(stats.backend).toBe("webgl2");
    expect(gl.calls).toContain("drawArraysInstanced");
    // The live stroke reaches the visible host from the GL surface.
    expect(host.drawn.some((src) => (src as FakeCanvas).gl != null)).toBe(true);
    engine.destroy();
  });

  it("issues one coverage and one colour draw per live paint however many hops arrive", () => {
    const { gl, host } = setup();
    const engine = createInkLabEngine();
    engine.attach(host);
    stroke(engine, 4);
    engine.paint();
    const batch = [];
    for (let i = 1; i <= 40; i++) batch.push({ x: 70 + i * 4, y: 60, p: 0.5, t: 40 + i * 4 });
    engine.move(batch);
    gl.calls.length = 0;
    engine.paint();
    expect(gl.calls.filter((c) => c === "drawArraysInstanced")).toHaveLength(2);
    engine.destroy();
  });

  it("redraws only the capsules near the tail as a long stroke grows", () => {
    const gl: GlStub = { lost: false, failCompile: false, calls: [], args: [] };
    webgl = () => fakeGl(gl);
    const host = new FakeCanvas(2400, 300) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine();
    engine.attach(host);
    engine.down({ x: 20, y: 100, p: 0.5, t: 0 });
    let x = 20, t = 0;
    for (let frame = 0; frame < 40; frame++) {
      const batch = [];
      for (let i = 0; i < 8; i++) batch.push({ x: (x += 6), y: 100, p: 0.5, t: (t += 4) });
      engine.move(batch);
      engine.paint();
    }
    engine.move([1, 2, 3].map(() => ({ x: (x += 6), y: 100, p: 0.5, t: (t += 4) })));
    gl.args!.length = 0;
    const stats = engine.paint();
    const drawn = gl.args!.filter(([k]) => k === "drawArraysInstanced").map(([, a]) => a[3] as number);
    expect(stats.segs).toBeGreaterThan(250);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.reduce((s, n) => s + n, 0)).toBeLessThan(40);
    // The GL surface covers the tail box, not the 2400px host.
    const surface = created.find((c) => c.gl != null && c !== (host as unknown as FakeCanvas))!;
    expect(surface.width).toBeLessThan(300);
    expect(surface.height).toBeLessThan(200);
    engine.destroy();
  });

  it("still redraws an old part of the stroke that the tail crosses", () => {
    const gl: GlStub = { lost: false, failCompile: false, calls: [], args: [] };
    webgl = () => fakeGl(gl);
    const host = new FakeCanvas(1200, 400) as unknown as HTMLCanvasElement;
    const engine = createInkLabEngine();
    engine.attach(host);
    engine.down({ x: 100, y: 200, p: 0.5, t: 0 });
    let t = 0;
    const go = (pts: [number, number][]) => {
      for (const [x, y] of pts) { engine.move([{ x, y, p: 0.5, t: (t += 6) }]); engine.paint(); }
    };
    // Right along y=200, a loop down, then up through the first stretch.
    go(Array.from({ length: 80 }, (_, i) => [100 + i * 8, 200] as [number, number]));
    go(Array.from({ length: 30 }, (_, i) => [740 - i * 2, 200 + i * 6] as [number, number]));
    go(Array.from({ length: 30 }, (_, i) => [680 - i * 16, 380 - i * 6] as [number, number]));
    gl.args!.length = 0;
    go([[180, 190], [170, 185]]);
    const drawCalls = gl.args!.filter(([k]) => k === "drawArraysInstanced").length;
    // The tail's own run plus the run it lies over near the start.
    expect(drawCalls).toBeGreaterThanOrEqual(2 * 2);
    engine.destroy();
  });

  it("hands each live frame over as a transferred bitmap from an unpreserved OffscreenCanvas", () => {
    const gl: GlStub = { lost: false, failCompile: false, calls: [] };
    let attrs: WebGLContextAttributes | undefined;
    const frames: { closed: boolean }[] = [];
    class FakeOffscreen {
      constructor(public width: number, public height: number) {}
      getContext(kind: string, a?: WebGLContextAttributes) {
        if (kind !== "webgl2") return null;
        attrs = a;
        return fakeGl(gl);
      }
      transferToImageBitmap() {
        const frame = { closed: false, close() { this.closed = true; } };
        frames.push(frame);
        return frame;
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    try {
      const host = new FakeCanvas() as unknown as HTMLCanvasElement & FakeCanvas;
      const engine = createInkLabEngine();
      expect(engine.attach(host)).toBe("webgl2");
      expect(attrs?.preserveDrawingBuffer).toBe(false);
      stroke(engine);
      engine.paint();
      expect(frames.length).toBeGreaterThan(0);
      expect(host.drawn).toContain(frames[frames.length - 1]);
      expect(frames.every((f) => f.closed)).toBe(true);
      engine.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the 2D strip when the capsule shader will not compile", () => {
    const { host } = setup({ failCompile: true });
    const engine = createInkLabEngine();
    expect(engine.attach(host)).toBe("canvas2d");
    stroke(engine);
    expect(engine.paint().backend).toBe("canvas2d");
    engine.destroy();
  });

  it("falls back to the 2D strip when webgl2 is missing", () => {
    webgl = () => null;
    const engine = createInkLabEngine();
    expect(engine.attach(new FakeCanvas() as unknown as HTMLCanvasElement)).toBe("canvas2d");
    engine.destroy();
  });

  it("skips WebGL2 when asked, even if it would start", () => {
    const { gl, host } = setup();
    const engine = createInkLabEngine({ sdf: false });
    expect(engine.attach(host)).toBe("canvas2d");
    stroke(engine);
    expect(engine.paint().backend).toBe("canvas2d");
    expect(gl.calls).not.toContain("drawArraysInstanced");
    engine.destroy();
  });

  it("drops to the 2D strip after a lost context that will not come back", () => {
    const { gl, host } = setup();
    const engine = createInkLabEngine();
    expect(engine.attach(host)).toBe("webgl2");
    gl.lost = true;
    webgl = () => null;
    stroke(engine);
    expect(engine.paint().backend).toBe("canvas2d");
    engine.destroy();
  });

  it("restarts WebGL2 after a lost context when it comes back", () => {
    const { gl, host } = setup();
    const engine = createInkLabEngine();
    engine.attach(host);
    gl.lost = true;
    const fresh: GlStub = { lost: false, failCompile: false, calls: [] };
    webgl = () => fakeGl(fresh);
    expect(engine.paint().backend).toBe("webgl2");
    engine.destroy();
  });

  it("keeps the highest coverage per pixel, and lays colour later-on-top", () => {
    const gl: GlStub = { lost: false, failCompile: false, calls: [], args: [] };
    let attrs: WebGLContextAttributes | undefined;
    webgl = (a) => {
      attrs = a;
      return fakeGl(gl);
    };
    const engine = createInkLabEngine();
    expect(engine.attach(new FakeCanvas() as unknown as HTMLCanvasElement)).toBe("webgl2");
    stroke(engine);
    engine.paint();
    // Coverage pass: alpha only, MAX. Colour pass: rgb only, colour times that
    // coverage, replacing what is under it (MAX on colour stamped light discs).
    expect(gl.args).toContainEqual(["colorMask", [false, false, false, true]]);
    expect(gl.args).toContainEqual(["blendEquation", [constOf("MAX")]]);
    expect(gl.args).toContainEqual(["colorMask", [true, true, true, false]]);
    expect(gl.args).toContainEqual(["blendEquation", [constOf("FUNC_ADD")]]);
    expect(gl.args).toContainEqual(["blendFunc", [constOf("DST_ALPHA"), constOf("ZERO")]]);
    expect(gl.args).toContainEqual(["disable", [constOf("DEPTH_TEST")]]);
    expect(attrs?.depth).toBe(false);
    engine.destroy();
  });

  it("commits lifted and replayed strokes with the same capsules", () => {
    const { gl, host } = setup();
    const engine = createInkLabEngine();
    engine.attach(host);
    stroke(engine);
    engine.paint();
    const lifted = engine.liftRaw({ x: 180, y: 40, p: 0.5, t: 120 });
    gl.calls.length = 0;
    engine.replaySpines([lifted.points]);
    expect(gl.calls).toContain("drawArraysInstanced");
    engine.destroy();
  });
});
