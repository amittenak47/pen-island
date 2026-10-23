/**
 * WebGL2 instanced sdRoundCone (tapered capsule). Draw the stroke AABB, not
 * the full screen. AA with smoothstep + fwidth.
 *
 * One stroke per surface, drawn in two passes over the same capsules:
 * - coverage: alpha only, MAX, so each pixel keeps the highest coverage any
 *   capsule gives it and neighbouring antialiased edges no longer add up into
 *   a bead at every joint;
 * - colour: RGB only, each capsule's colour times that coverage, later
 *   capsules on top, so the ink blends along the stroke and a blot pool lies
 *   whole over the line it grew from. MAX on colour picked the lighter
 *   capsule per channel: discrete light stamps, half-hidden blots.
 * The 2D blit that presents the surface lays the stroke down once.
 */

import { SDF_SCISSOR_PAD } from "./clipBlit";
import {
  INSTANCE_FLOATS,
  type StrokeAabb,
} from "./instance";

const VERT = `#version 300 es
layout(location=0) in vec2 a_unit;
layout(location=1) in vec2 a_p0;
layout(location=2) in float a_r0;
layout(location=3) in vec2 a_p1;
layout(location=4) in float a_r1;
layout(location=5) in vec3 a_c0;
layout(location=6) in vec3 a_c1;
uniform vec2 u_view;
uniform vec2 u_origin;
out vec2 v_p;
out vec2 v_p0;
out vec2 v_p1;
out float v_r0;
out float v_r1;
out vec3 v_c0;
out vec3 v_c1;
void main() {
  float rad = max(a_r0, a_r1) + 2.5;
  vec2 mn = min(a_p0, a_p1) - vec2(rad);
  vec2 mx = max(a_p0, a_p1) + vec2(rad);
  vec2 pos = mix(mn, mx, a_unit);
  v_p = pos;
  v_p0 = a_p0;
  v_p1 = a_p1;
  v_r0 = a_r0;
  v_r1 = a_r1;
  v_c0 = a_c0;
  v_c1 = a_c1;
  // Positions stay absolute (fwidth and the SDF see host pixels); the surface
  // can be a small window onto the host starting at u_origin.
  vec2 clip = ((pos - u_origin) / u_view) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_p;
in vec2 v_p0;
in vec2 v_p1;
in float v_r0;
in float v_r1;
in vec3 v_c0;
in vec3 v_c1;
uniform int u_pass;
out vec4 frag;

float sdRoundCone(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 ba = b - a;
  float l2 = dot(ba, ba);
  if (l2 < 1e-8) return length(p - a) - ra;
  float h = clamp(dot(p - a, ba) / l2, 0.0, 1.0);
  float r = mix(ra, rb, h);
  return length(p - a - ba * h) - r;
}

void main() {
  float d = sdRoundCone(v_p, v_p0, v_p1, v_r0, v_r1);
  float rad = max(v_r0, v_r1);
  float aa = max(fwidth(d), clamp(rad * 0.4, 0.18, 0.75));
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha < 0.004) discard;
  vec2 ba = v_p1 - v_p0;
  float l2 = max(dot(ba, ba), 1e-8);
  float h = clamp(dot(v_p - v_p0, ba) / l2, 0.0, 1.0);
  vec3 rgb = mix(v_c0, v_c1, h) / 255.0;
  // Pass 0 writes coverage (a joint keeps max(a0, a1), not a0 + a1(1 - a0));
  // pass 1 writes colour, premultiplied by that coverage in the blend.
  frag = u_pass == 0 ? vec4(0.0, 0.0, 0.0, alpha) : vec4(rgb, 1.0);
}
`;

export type SdfRenderer = {
  canvas: HTMLCanvasElement;
  resize(w: number, h: number): void;
  /**
   * Host pixel at the surface's top-left. Instances and boxes stay in host
   * pixels, so a small surface can render any window of a large host.
   */
  setOrigin(x: number, y: number): void;
  upload(data: Float32Array, count: number): void;
  /**
   * Write hops `[from, count)` into the instance buffer.
   * Returns true when the buffer grew and prefix GPU data was discarded.
   */
  uploadTail(data: Float32Array, from: number, count: number): boolean;
  /** Draw one new capsule without clearing. Live path only. */
  append(data: Float32Array, index: number, aabb: StrokeAabb): void;
  draw(aabb: StrokeAabb): void;
  /** Scissor-clear `aabb`. Frozen prefix outside the box stays. */
  erase(aabb: StrokeAabb): void;
  /** Draw instances from `from` scissored to `aabb`. Does not clear. */
  redraw(aabb: StrokeAabb, from?: number): void;
  /** Draw instance ranges, flat `[from, to)` pairs, scissored to `aabb`. Does not clear. */
  redrawRanges(aabb: StrokeAabb, ranges: readonly number[]): void;
  clear(): void;
  isLost(): boolean;
  destroy(): void;
};

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function makeGlCanvas(
  w: number,
  h: number,
  peer: (w: number, h: number) => HTMLCanvasElement | null,
): HTMLCanvasElement | null {
  const canvas = peer(w, h);
  return canvas;
}

export function tryCreateSdfRenderer(
  w: number,
  h: number,
  peer: (w: number, h: number) => HTMLCanvasElement | null,
  /**
   * `preserve: false` for a surface that is fully redrawn before every read:
   * a preserved buffer has to be copied and synced each time 2D reads it.
   */
  { preserve = true }: { preserve?: boolean } = {},
): SdfRenderer | null {
  const canvas = makeGlCanvas(w, h, peer);
  if (!canvas) return null;
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: preserve,
      depth: false,
    }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const uView = gl.getUniformLocation(prog, "u_view");
  const uOrigin = gl.getUniformLocation(prog, "u_origin");
  const uPass = gl.getUniformLocation(prog, "u_pass");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  const stride = INSTANCE_FLOATS * 4;
  const specs: Array<[number, number, number]> = [
    [1, 2, 0],
    [2, 1, 2],
    [3, 2, 3],
    [4, 1, 5],
    [5, 3, 6],
    [6, 3, 9],
    // Slot 12 (hop index) is still written; nothing reads it now.
  ];
  for (const [loc, size, offsetFloats] of specs) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offsetFloats * 4);
    gl.vertexAttribDivisor(loc, 1);
  }

  gl.enable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  /** Run `drawCalls` for coverage, then again for colour. See the header. */
  const twoPass = (drawCalls: () => void) => {
    gl!.colorMask(false, false, false, true);
    gl!.blendEquation(gl!.MAX);
    gl!.uniform1i(uPass, 0);
    drawCalls();
    gl!.colorMask(true, true, true, false);
    gl!.blendEquation(gl!.FUNC_ADD);
    gl!.blendFunc(gl!.DST_ALPHA, gl!.ZERO);
    gl!.uniform1i(uPass, 1);
    drawCalls();
    // Clears honour the colour mask.
    gl!.colorMask(true, true, true, true);
  };

  let count = 0;
  let instCap = 32;
  let viewW = canvas.width;
  let viewH = canvas.height;
  let originX = 0;
  let originY = 0;
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  gl.bufferData(gl.ARRAY_BUFFER, instCap * stride, gl.DYNAMIC_DRAW);

  const bindInstAt = (index: number) => {
    gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
    const base = index * stride;
    for (const [loc, size, offsetFloats] of specs) {
      gl!.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, base + offsetFloats * 4);
    }
  };

  const growInst = (n: number) => {
    if (n <= instCap) return false;
    while (instCap < n) instCap *= 2;
    gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl!.bufferData(gl.ARRAY_BUFFER, instCap * stride, gl.DYNAMIC_DRAW);
    return true;
  };

  const scissorAabb = (aabb: StrokeAabb) => {
    const pad = SDF_SCISSOR_PAD;
    const x0 = Math.max(0, Math.floor(aabb.minX - originX) - pad);
    const y0 = Math.max(0, Math.floor(aabb.minY - originY) - pad);
    const x1 = Math.min(viewW, Math.ceil(aabb.maxX - originX) + pad);
    const y1 = Math.min(viewH, Math.ceil(aabb.maxY - originY) + pad);
    if (x1 <= x0 || y1 <= y0) {
      gl!.disable(gl.SCISSOR_TEST);
      return;
    }
    const full = x0 <= 0 && y0 <= 0 && x1 >= viewW && y1 >= viewH;
    if (full) {
      gl!.disable(gl.SCISSOR_TEST);
      return;
    }
    gl!.enable(gl.SCISSOR_TEST);
    gl!.scissor(x0, viewH - y1, x1 - x0, y1 - y0);
  };

  const resize = (nw: number, nh: number) => {
    const width = Math.max(1, nw);
    const height = Math.max(1, nh);
    if (viewW === width && viewH === height && canvas.width === width && canvas.height === height) {
      return;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    viewW = width;
    viewH = height;
    gl!.viewport(0, 0, width, height);
  };
  resize(w, h);

  return {
    canvas,
    resize,
    setOrigin(x, y) {
      originX = x;
      originY = y;
    },
    upload(data, n) {
      count = Math.max(0, n);
      growInst(Math.max(count, 1));
      gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
      if (count > 0) {
        gl!.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * INSTANCE_FLOATS));
      }
    },
    uploadTail(data, from, n) {
      count = Math.max(0, n);
      const grew = growInst(Math.max(count, 1));
      const start = grew || from <= 0 ? 0 : from;
      gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
      if (count > start) {
        gl!.bufferSubData(
          gl.ARRAY_BUFFER,
          start * stride,
          data.subarray(start * INSTANCE_FLOATS, count * INSTANCE_FLOATS),
        );
      }
      return grew;
    },
    append(data, index, aabb) {
      const grew = growInst(index + 1);
      gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
      if (grew) {
        gl!.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          data.subarray(0, (index + 1) * INSTANCE_FLOATS),
        );
      } else {
        gl!.bufferSubData(
          gl.ARRAY_BUFFER,
          index * stride,
          data.subarray(index * INSTANCE_FLOATS, (index + 1) * INSTANCE_FLOATS),
        );
      }
      count = index + 1;
      gl!.viewport(0, 0, viewW, viewH);
      gl!.useProgram(prog);
      gl!.uniform2f(uView, viewW, viewH);
      gl!.uniform2f(uOrigin, originX, originY);
      gl!.bindVertexArray(vao);
      bindInstAt(index);
      scissorAabb(aabb);
      twoPass(() => gl!.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1));
      bindInstAt(0);
      gl!.disable(gl.SCISSOR_TEST);
    },
    clear() {
      count = 0;
      gl!.viewport(0, 0, viewW, viewH);
      gl!.disable(gl.SCISSOR_TEST);
      gl!.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(aabb) {
      gl!.viewport(0, 0, viewW, viewH);
      scissorAabb(aabb);
      gl!.clear(gl.COLOR_BUFFER_BIT);
      if (count < 1) {
        gl!.disable(gl.SCISSOR_TEST);
        return;
      }
      gl!.useProgram(prog);
      gl!.uniform2f(uView, viewW, viewH);
      gl!.uniform2f(uOrigin, originX, originY);
      gl!.bindVertexArray(vao);
      bindInstAt(0);
      twoPass(() => gl!.drawArraysInstanced(gl.TRIANGLES, 0, 6, count));
      gl!.disable(gl.SCISSOR_TEST);
    },
    erase(aabb) {
      gl!.viewport(0, 0, viewW, viewH);
      scissorAabb(aabb);
      gl!.clear(gl.COLOR_BUFFER_BIT);
      gl!.disable(gl.SCISSOR_TEST);
    },
    redraw(aabb, from = 0) {
      const start = Math.max(0, Math.min(from, count));
      const n = count - start;
      if (n < 1) return;
      gl!.viewport(0, 0, viewW, viewH);
      gl!.useProgram(prog);
      gl!.uniform2f(uView, viewW, viewH);
      gl!.uniform2f(uOrigin, originX, originY);
      gl!.bindVertexArray(vao);
      bindInstAt(start);
      scissorAabb(aabb);
      twoPass(() => gl!.drawArraysInstanced(gl.TRIANGLES, 0, 6, n));
      bindInstAt(0);
      gl!.disable(gl.SCISSOR_TEST);
    },
    redrawRanges(aabb, ranges) {
      if (ranges.length < 2) return;
      gl!.viewport(0, 0, viewW, viewH);
      gl!.useProgram(prog);
      gl!.uniform2f(uView, viewW, viewH);
      gl!.uniform2f(uOrigin, originX, originY);
      gl!.bindVertexArray(vao);
      scissorAabb(aabb);
      // Ranges ascend, so in the colour pass later ink lands on top.
      twoPass(() => {
        for (let k = 0; k + 1 < ranges.length; k += 2) {
          const start = Math.max(0, Math.min(ranges[k]!, count));
          const end = Math.max(start, Math.min(ranges[k + 1]!, count));
          if (end <= start) continue;
          bindInstAt(start);
          gl!.drawArraysInstanced(gl.TRIANGLES, 0, 6, end - start);
        }
      });
      bindInstAt(0);
      gl!.disable(gl.SCISSOR_TEST);
    },
    isLost() {
      return !gl || gl.isContextLost();
    },
    destroy() {
      if (gl && !gl.isContextLost()) {
        gl.deleteBuffer(quad);
        gl.deleteBuffer(inst);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
}
