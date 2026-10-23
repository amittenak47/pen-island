import { describe, expect, it } from "vitest";

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

class FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  drawn: unknown[] = [];
  gl: WebGL2RenderingContext | null = null;
  constructor(w = 240, h = 160) {
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

  it("issues one instanced draw per live paint however many hops arrive", () => {
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
    expect(gl.calls.filter((c) => c === "drawArraysInstanced")).toHaveLength(1);
    engine.destroy();
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

  it("keeps the highest coverage per pixel instead of stacking capsule edges", () => {
    const gl: GlStub = { lost: false, failCompile: false, calls: [], args: [] };
    let attrs: WebGLContextAttributes | undefined;
    webgl = (a) => {
      attrs = a;
      return fakeGl(gl);
    };
    const engine = createInkLabEngine();
    expect(engine.attach(new FakeCanvas() as unknown as HTMLCanvasElement)).toBe("webgl2");
    expect(gl.args).toContainEqual(["blendEquation", [constOf("MAX")]]);
    expect(gl.args).toContainEqual(["disable", [constOf("DEPTH_TEST")]]);
    expect(gl.calls).not.toContain("blendFunc");
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
