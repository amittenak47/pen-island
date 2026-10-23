import { describe, expect, it } from "vitest";

import { tryCreateSdfRenderer } from "./sdf";

const glConst = new Map<string, number>();
const constOf = (name: string) => {
  if (!glConst.has(name)) glConst.set(name, 0x1000 + glConst.size);
  return glConst.get(name)!;
};

/** GL stub that records calls; `float` says whether float targets blend. */
function fakeGl(calls: [string, unknown[]][], float: boolean): WebGL2RenderingContext {
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return constOf(key);
      if (key === "isContextLost") return () => false;
      if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
      if (key === "getExtension") return () => (float ? {} : null);
      if (key === "checkFramebufferStatus") return () => constOf("FRAMEBUFFER_COMPLETE");
      return (...args: unknown[]) => {
        calls.push([key, args]);
        return {};
      };
    },
  }) as WebGL2RenderingContext;
}

function renderer(float: boolean) {
  const calls: [string, unknown[]][] = [];
  const canvas = { width: 1, height: 1, getContext: () => fakeGl(calls, float) };
  const sdf = tryCreateSdfRenderer(300, 200, () => canvas as unknown as HTMLCanvasElement)!;
  return { sdf, calls };
}

const after = (calls: [string, unknown[]][], from: number) => calls.slice(from).map(([k]) => k);

describe("coverage-weighted colour", () => {
  it("accumulates colour in a float buffer, then resolves it under the coverage", () => {
    const { sdf, calls } = renderer(true);
    expect(sdf.weighted).toBe(true);
    sdf.upload(new Float32Array(13 * 4), 4);
    const mark = calls.length;
    sdf.draw({ minX: 0, minY: 0, maxX: 120, maxY: 80 });
    const seq = after(calls, mark).filter((k) =>
      k === "bindFramebuffer" || k === "drawArraysInstanced" || k === "drawArrays" || k === "clear");
    // Clear surface and float buffer, accumulate, coverage, resolve.
    expect(seq).toEqual([
      "clear", "bindFramebuffer", "clear", "bindFramebuffer",
      "bindFramebuffer", "drawArraysInstanced", "bindFramebuffer",
      "drawArraysInstanced", "drawArrays",
    ]);
    const blends = calls.slice(mark).filter(([k]) => k === "blendFunc").map(([, a]) => a);
    expect(blends).toEqual([
      [constOf("ONE"), constOf("ONE")],
      [constOf("DST_ALPHA"), constOf("ZERO")],
    ]);
  });

  it("sizes the float buffer to what is drawn, not the whole surface", () => {
    const { sdf, calls } = renderer(true);
    sdf.upload(new Float32Array(13), 1);
    sdf.draw({ minX: 0, minY: 0, maxX: 60, maxY: 40 });
    const sizes = calls.filter(([k, a]) => k === "texImage2D" && a[2] === constOf("RGBA32F"))
      .map(([, a]) => [a[3], a[4]]);
    const [w, h] = sizes[sizes.length - 1] as [number, number];
    expect(w).toBeLessThan(300);
    expect(h).toBeLessThan(200);
    expect(w).toBeGreaterThanOrEqual(60);
  });

  it("lines the float buffer up with the surface's top edge, where draws land", () => {
    const { sdf, calls } = renderer(true);
    sdf.upload(new Float32Array(13), 1);
    const mark = calls.length;
    sdf.draw({ minX: 0, minY: 0, maxX: 60, maxY: 40 });
    const sized = calls.filter(([k, a]) => k === "texImage2D" && a[2] === constOf("RGBA32F")).at(-1)!;
    const bufH = sized[1][4] as number;
    // GL rows count from the bottom: surface rows 0..40 are buffer rows
    // (bufH - 40)..bufH only if the buffer's viewport is shifted by bufH - 200.
    const viewports = calls.slice(mark).filter(([k]) => k === "viewport").map(([, a]) => a);
    expect(viewports).toContainEqual([0, bufH - 200, 300, 200]);
  });

  it("keeps the two-pass blend when float targets cannot blend", () => {
    const { sdf, calls } = renderer(false);
    expect(sdf.weighted).toBe(false);
    sdf.upload(new Float32Array(13), 1);
    const mark = calls.length;
    sdf.draw({ minX: 0, minY: 0, maxX: 120, maxY: 80 });
    const keys = after(calls, mark);
    expect(keys.filter((k) => k === "drawArraysInstanced")).toHaveLength(2);
    expect(keys).not.toContain("bindFramebuffer");
    expect(keys).not.toContain("drawArrays");
  });
});
