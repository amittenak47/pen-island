/**
 * WebGL2 instanced sdRoundCone (tapered capsule). Draw the stroke AABB, not
 * the full screen. AA with smoothstep + fwidth.
 *
 * One stroke per surface, drawn in passes over the same capsules:
 * - coverage: alpha only, MAX, so each pixel keeps the highest coverage any
 *   capsule gives it and neighbouring antialiased edges no longer add up into
 *   a bead at every joint;
 * - colour, blended by coverage where the GPU can blend float targets: each
 *   capsule adds colour x weight and weight to a float buffer, the weight
 *   falling from its centreline to almost 0 at its edge and scaled by the
 *   hop's length, and a resolve pass writes sum / weight times that
 *   coverage. Overlapping capsules mix, so no capsule's round edge shows as
 *   a ring inside the fill. A blot pool adds its own heavier disc, so it
 *   stays darker at its centre and fades into the line at its rim;
 * - otherwise colour with later capsules on top (hard edges between capsules
 *   of different colour). MAX on colour picked the lighter capsule per
 *   channel: discrete light stamps, half-hidden blots.
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
layout(location=7) in float a_pools;
layout(location=8) in vec2 a_seeds;
uniform vec2 u_view;
uniform vec2 u_origin;
out vec2 v_p;
out vec2 v_p0;
out vec2 v_p1;
out float v_r0;
out float v_r1;
out vec3 v_c0;
out vec3 v_c1;
flat out float v_pools;
flat out vec2 v_seeds;
void main() {
  // A pool's rim bulges up to RIM_BULGE past its radius.
  float rad = max(a_r0, a_r1) * (a_pools > 0.5 ? 1.05 : 1.0) + 2.5;
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
  v_pools = a_pools;
  v_seeds = a_seeds;
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
flat in float v_pools;
flat in vec2 v_seeds;
uniform int u_pass;
layout(location=0) out vec4 frag;
// Pass 2 only: pool weight, and pooled-ring strength x pool weight.
layout(location=1) out vec4 poolSum;
// A pool's disc against the line under it (whose weights add to about 2).
const float POOL_WEIGHT = 4.0;

// Blot texture, in the pool's own unit disc so it scales with the pool and
// any zoom, and seeded per blot (see poolSeed):
// - an uneven rim, bulging up to RIM_BULGE of the radius, like ink spreading;
// - soft grain, a few broad cells across the pool, so it blends, no specks;
// - a pooled edge, a thin darker ring at the rim, like a dried drop, only
//   where the pool's own ink reaches the rim (the resolve hides it where the
//   lighter line blends in) and only once the pool has grown dark.
const float RIM_BULGE = 0.03;
const float GRAIN = 0.07;
const float GRAIN_CELLS = 3.5;
const float RING_DARK = 0.12;

float hash21(vec2 p, float s) {
  // Seeds run to 4095: keep sin's argument small for highp precision.
  return fract(sin(dot(p, vec2(127.1, 311.7)) + s * 1.618) * 43758.5453);
}

float vnoise(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i, s), b = hash21(i + vec2(1.0, 0.0), s);
  float c = hash21(i + vec2(0.0, 1.0), s), d = hash21(i + vec2(1.0, 1.0), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The pool's radius in the direction of p: its rim, with the bulges.
float poolRim(vec2 p, vec2 c, float r, float s) {
  vec2 o = p - c;
  float l = length(o);
  vec2 dir = l > 1e-4 ? o / l : vec2(1.0, 0.0);
  float n = 0.85 * vnoise(dir * 3.0 + 5.0, s) + 0.15 * vnoise(dir * 7.0 + 9.0, s + 3.0);
  return r * (1.0 + RIM_BULGE * n);
}

// x: grain factor on the pool colour, y: how much of the pooled ring is here.
vec2 poolLook(vec2 p, vec2 c, float rim, float s) {
  vec2 q = (p - c) / rim;
  float e = 1.0 - length(q);
  float fade = clamp(e / 0.3, 0.0, 1.0);
  float grain = 1.0 + (vnoise(q * GRAIN_CELLS + s * 0.37, s) - 0.5) * 2.0 * GRAIN * fade;
  float ring = exp(-pow((e - 0.03) / 0.035, 2.0));
  return vec2(grain, ring);
}

// Exact tapered capsule: the hull of the two end discs. The cheaper
// length(p - a - ba*h) - mix(ra, rb, h) shrinks the radius along the hop,
// so a wide pool next to a narrow dot lost the half of its disc facing the
// dot: a "D" at a held start, a pool missing a wedge where the pen turned.
float sdTaper(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 ba = b - a;
  float l = length(ba);
  // One disc holds the other (or a lone dot): the bigger disc is the shape.
  if (l <= abs(ra - rb) + 1e-4) return min(length(p - a) - ra, length(p - b) - rb);
  vec2 dir = ba / l;
  vec2 q = vec2(abs(dot(p - a, vec2(-dir.y, dir.x))), dot(p - a, dir));
  float s = (ra - rb) / l;
  float c = sqrt(1.0 - s * s);
  float k = dot(q, vec2(-s, c));
  if (k < 0.0) return length(q) - ra;
  if (k > c * l) return length(q - vec2(0.0, l)) - rb;
  return dot(q, vec2(c, s)) - ra;
}

void main() {
  // Position along the hop and the radius there, for colour and weight.
  vec2 ba = v_p1 - v_p0;
  float l2 = dot(ba, ba);
  float h = l2 < 1e-8 ? 0.0 : clamp(dot(v_p - v_p0, ba) / l2, 0.0, 1.0);
  float r = mix(v_r0, v_r1, h);
  float d = sdTaper(v_p, v_p0, v_p1, v_r0, v_r1);
  bool poolA = v_pools > 0.5 && mod(v_pools, 2.0) > 0.5;
  bool poolB = v_pools > 1.5;
  vec2 seed = floor(v_seeds);
  // How far each pool has grown, 0-1: a pale dab gets no pooled edge.
  vec2 grown = smoothstep(0.25, 0.75, fract(v_seeds));
  float rimA = poolA ? poolRim(v_p, v_p0, max(v_r0, 0.5), seed.x) : 0.0;
  float rimB = poolB ? poolRim(v_p, v_p1, max(v_r1, 0.5), seed.y) : 0.0;
  // The bulges only add to the capsule: its own disc is the rim's floor.
  if (poolA) d = min(d, length(v_p - v_p0) - rimA);
  if (poolB) d = min(d, length(v_p - v_p1) - rimB);
  float rad = max(v_r0, v_r1);
  float aa = max(fwidth(d), clamp(rad * 0.4, 0.18, 0.75));
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha < 0.004) discard;
  vec3 rgb = mix(v_c0, v_c1, h) / 255.0;
  // Pass 0 writes coverage (a joint keeps max(a0, a1), not a0 + a1(1 - a0));
  // pass 1 writes colour, premultiplied by that coverage in the blend;
  // pass 2 adds colour and weight to the float buffer. The weight is near 0
  // at the edge, so a capsule's outline adds no step to the mix, and scales
  // with the hop's length, so slow dense dots do not outvote fast ones.
  poolSum = vec4(0.0);
  if (u_pass == 0) {
    frag = vec4(0.0, 0.0, 0.0, alpha);
    return;
  }
  if (u_pass == 1) {
    // Without the float blend a pool is its own colour inside its rim.
    vec2 pc = poolB ? v_p1 : v_p0;
    float pRim = poolB ? rimB : rimA;
    if ((poolA || poolB) && length(v_p - pc) < pRim) {
      vec2 look = poolLook(v_p, pc, pRim, poolB ? seed.y : seed.x);
      float ring = look.y * (poolB ? grown.y : grown.x);
      rgb = (poolB ? v_c1 : v_c0) / 255.0 * look.x * (1.0 - RING_DARK * ring);
    }
    frag = vec4(rgb, 1.0);
    return;
  }
  float depth = clamp(-d / max(r, 0.5), 0.0, 1.0);
  float w = alpha * (0.02 + smoothstep(0.0, 1.0, depth)) * max(sqrt(l2), 0.25 * rad) / max(rad, 0.5);
  vec4 sum = vec4(rgb * w, w);
  // A blot pool at either end: its own disc, weighted to win at its centre
  // and fade into the line toward its rim, so it reads as a pool, not a ring.
  // Its pooled ring goes to the second buffer with the pool's weight, so the
  // resolve can show it only where the pool, not the line, colours the rim.
  for (int k = 0; k < 2; k++) {
    bool on = k == 0 ? poolA : poolB;
    if (!on) continue;
    vec2 c = k == 0 ? v_p0 : v_p1;
    float rim = k == 0 ? rimA : rimB;
    vec3 ink = (k == 0 ? v_c0 : v_c1) / 255.0;
    vec2 look = poolLook(v_p, c, rim, k == 0 ? seed.x : seed.y);
    // The weight stays above zero right up to the rim, so the share there is
    // the pool's, not nothing.
    float pw = alpha * POOL_WEIGHT * (0.02 + smoothstep(0.0, 1.0, clamp(1.0 - length(v_p - c) / rim, 0.0, 1.0)));
    sum += vec4(ink * look.x * pw, pw);
    poolSum += vec4(pw, look.y * (k == 0 ? grown.x : grown.y) * pw, 0.0, 0.0);
  }
  frag = sum;
}
`;

const RESOLVE_VERT = `#version 300 es
layout(location=0) in vec2 a_unit;
void main() {
  gl_Position = vec4(a_unit * 2.0 - 1.0, 0.0, 1.0);
}
`;

const RESOLVE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_acc;
uniform sampler2D u_pool;
// Rows the float buffer sits above the surface (see accShift).
uniform int u_shift;
out vec4 frag;
const float RING_DARK = 0.12;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy) + ivec2(0, u_shift);
  vec4 acc = texelFetch(u_acc, at, 0);
  vec2 pool = texelFetch(u_pool, at, 0).rg;
  vec3 rgb = acc.a > 1e-6 ? acc.rgb / acc.a : vec3(0.0);
  // The pooled ring shows where the pool's own ink colours the rim, and
  // fades where the lighter line blends in (where a stroke enters or leaves).
  float share = acc.a > 1e-6 ? pool.r / acc.a : 0.0;
  float ring = pool.r > 1e-6 ? pool.g / pool.r : 0.0;
  rgb *= 1.0 - RING_DARK * ring * smoothstep(0.45, 0.9, share);
  frag = vec4(rgb, 1.0);
}
`;

export type SdfRenderer = {
  canvas: HTMLCanvasElement;
  /** Colour is blended by coverage in a float buffer (see the header). */
  weighted: boolean;
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

function link(gl: WebGL2RenderingContext, vert: string, frag: string) {
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  return { prog, vs, fs };
}

/**
 * A float colour buffer for the coverage-weighted blend, or null when float
 * targets cannot be rendered to and blended (colour then lies later on top).
 * 32-bit floats: a slow stroke stacks hundreds of capsules on a pixel, and
 * half floats round each one's small share of the sum into a colour shift.
 */
function createAccumulator(gl: WebGL2RenderingContext) {
  if (!gl.getExtension("EXT_color_buffer_float") || !gl.getExtension("EXT_float_blend")) return null;
  const linked = link(gl, RESOLVE_VERT, RESOLVE_FRAG);
  if (!linked) return null;
  const tex = gl.createTexture();
  // Pool weight and pooled-ring strength, for the resolve.
  const poolTex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  const vao = gl.createVertexArray();
  const unit = gl.createBuffer();
  if (!tex || !poolTex || !fbo || !vao || !unit) return null;
  let w = 0, h = 0;
  const size = (nw: number, nh: number) => {
    w = nw;
    h = nh;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, poolTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, null);
  };
  /**
   * Grow (never shrink) to cover surface pixels [0, x1) x [0, y1). The live
   * surface is host-sized but draws only a tail box at its corner, so the
   * buffer follows what is drawn. Growing starts it empty; every caller
   * clears before it draws.
   */
  const cover = (x1: number, y1: number) => {
    if (x1 <= w && y1 <= h) return;
    size(Math.max(w, x1), Math.max(h, y1));
  };
  for (const t of [tex, poolTex]) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  size(1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, poolTex, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    gl.deleteTexture(poolTex);
    gl.deleteVertexArray(vao);
    gl.deleteBuffer(unit);
    gl.deleteProgram(linked.prog);
    return null;
  }
  // The resolve pass draws the unit quad on its own vertex array.
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, unit);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.useProgram(linked.prog);
  gl.uniform1i(gl.getUniformLocation(linked.prog, "u_acc"), 0);
  gl.uniform1i(gl.getUniformLocation(linked.prog, "u_pool"), 1);
  const uShift = gl.getUniformLocation(linked.prog, "u_shift");
  const destroy = () => {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    gl.deleteTexture(poolTex);
    gl.deleteVertexArray(vao);
    gl.deleteBuffer(unit);
    gl.deleteProgram(linked.prog);
    gl.deleteShader(linked.vs);
    gl.deleteShader(linked.fs);
  };
  return { prog: linked.prog, tex, poolTex, fbo, vao, uShift, cover, height: () => h, destroy };
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

  const linked = link(gl, VERT, FRAG);
  if (!linked) return null;
  const { prog, vs, fs } = linked;
  const acc = createAccumulator(gl);
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
    [7, 1, 12],
    [8, 2, 13],
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
    if (acc) {
      weightedPasses(drawCalls);
      return;
    }
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

  /** Weighted colour into the float buffer, coverage, then the resolve. */
  const weightedPasses = (drawCalls: () => void) => {
    const g = gl!;
    acc!.cover(drawX1, drawY1);
    inAcc(() => {
      g.blendEquation(g.FUNC_ADD);
      g.blendFunc(g.ONE, g.ONE);
      g.uniform1i(uPass, 2);
      drawCalls();
    });
    g.colorMask(false, false, false, true);
    g.blendEquation(g.MAX);
    g.uniform1i(uPass, 0);
    drawCalls();
    // rgb = sum / weight, times the coverage now in the surface's alpha.
    g.colorMask(true, true, true, false);
    g.blendFunc(g.DST_ALPHA, g.ZERO);
    g.blendEquation(g.FUNC_ADD);
    g.useProgram(acc!.prog);
    g.uniform1i(acc!.uShift, accShift());
    g.bindVertexArray(acc!.vao);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, acc!.poolTex);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, acc!.tex);
    g.drawArrays(g.TRIANGLES, 0, 6);
    g.bindVertexArray(vao);
    g.useProgram(prog);
    g.colorMask(true, true, true, true);
  };

  /**
   * GL rows count up from the bottom, and draws land at the surface's top
   * left, so the float buffer (only as tall as the drawn box) is aligned to
   * the surface's top edge: surface row y is buffer row y + shift.
   */
  const accShift = () => acc!.height() - viewH;

  /** Run `fn` with the float buffer bound and the viewport and scissor shifted onto it. */
  const inAcc = (fn: () => void) => {
    const g = gl!;
    const shift = accShift();
    g.bindFramebuffer(g.FRAMEBUFFER, acc!.fbo);
    g.viewport(0, shift, viewW, viewH);
    if (scissorBox) g.scissor(scissorBox[0], scissorBox[1] + shift, scissorBox[2], scissorBox[3]);
    fn();
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, viewW, viewH);
    if (scissorBox) g.scissor(scissorBox[0], scissorBox[1], scissorBox[2], scissorBox[3]);
  };

  /** Clear the surface (scissor as set), and the float buffer with it. */
  const clearBoth = () => {
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    if (acc) inAcc(() => gl!.clear(gl!.COLOR_BUFFER_BIT));
  };

  let count = 0;
  let instCap = 32;
  let viewW = canvas.width;
  let viewH = canvas.height;
  let originX = 0;
  let originY = 0;
  /** Far corner of what the current scissor lets a draw touch. */
  let drawX1 = viewW;
  let drawY1 = viewH;
  /** The scissor rect in GL window coordinates, or null when scissoring is off. */
  let scissorBox: [number, number, number, number] | null = null;
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
    drawX1 = viewW;
    drawY1 = viewH;
    scissorBox = null;
    if (x1 <= x0 || y1 <= y0) {
      gl!.disable(gl.SCISSOR_TEST);
      return;
    }
    const full = x0 <= 0 && y0 <= 0 && x1 >= viewW && y1 >= viewH;
    if (full) {
      gl!.disable(gl.SCISSOR_TEST);
      return;
    }
    drawX1 = x1;
    drawY1 = y1;
    scissorBox = [x0, viewH - y1, x1 - x0, y1 - y0];
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
    weighted: acc !== null,
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
      drawX1 = viewW;
      drawY1 = viewH;
      scissorBox = null;
      clearBoth();
    },
    draw(aabb) {
      gl!.viewport(0, 0, viewW, viewH);
      scissorAabb(aabb);
      clearBoth();
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
      clearBoth();
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
        acc?.destroy();
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
}
