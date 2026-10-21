/**
 * HEPR proof of concept: one real book, drawn by HEPR on the GPU, in a page
 * of its own. Answers M8's questions with numbers before any app code moves:
 * how long a book takes to open, how a scroll and a zoom run, how much memory
 * it holds, and how many GPU contexts and devices HEPR creates.
 *
 * Dev only (not a build input). Query:
 *   ?src=<name in POC_PDF_DIR>  &backend=webgpu|webgl  &loading=auto|all|eager
 *   &pages=1-40  &compress=1 (compressScans)
 * `window.__poc` exposes the numbers and scripted runs for CDP.
 */

type Stats = Record<string, unknown>;

const params = new URLSearchParams(location.search);
const src = params.get("src") ?? "dasgupta.pdf";
const backend = (params.get("backend") ?? "webgpu") as "webgpu" | "webgl";
const loading = (params.get("loading") ?? "auto") as "auto" | "all" | "eager";
const pages = params.get("pages") ?? undefined;
const compressScans = params.get("compress") === "1";

const hud = document.getElementById("hud")!;
const canvas = document.getElementById("view") as HTMLCanvasElement;
const stats: Stats = { src, backend, loading, pages: pages ?? "all", compressScans };
const stages: string[] = [];
(window as unknown as { __pocEarly: unknown }).__pocEarly = { stats, stages };
const t0 = performance.now();
const since = () => Math.round(performance.now() - t0);

// Count every GPU context and device created on this page, HEPR's included.
const contexts: string[] = [];
const devices: string[] = [];
for (const proto of [HTMLCanvasElement.prototype, OffscreenCanvas.prototype] as const) {
  const original = proto.getContext as (this: unknown, kind: string, ...rest: unknown[]) => unknown;
  (proto as { getContext: unknown }).getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    const ctx = original.call(this, kind, ...rest);
    if (ctx && kind !== "2d" && kind !== "bitmaprenderer") {
      const tag = `${kind} ${this.width}x${this.height}${this === canvas ? " (view)" : ""}`;
      if (!contexts.includes(tag)) contexts.push(tag);
    }
    return ctx;
  };
}
// The app's TypeScript lib has no WebGPU types; reach the prototype loosely.
const adapterClass = (globalThis as { GPUAdapter?: { prototype: { requestDevice: (...args: unknown[]) => unknown } } }).GPUAdapter;
if (adapterClass) {
  const request = adapterClass.prototype.requestDevice;
  adapterClass.prototype.requestDevice = function (this: unknown, ...args: unknown[]) {
    const caller = (new Error().stack ?? "").split("\n").slice(2, 5).map((line) => line.trim().replace(/\?v=\w+/, "")).join(" < ");
    devices.push(`device @${since()}ms from ${caller}`);
    return request.apply(this, args);
  };
}

const longTasks: number[] = [];
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  }).observe({ type: "longtask" });
} catch { /* not supported */ }

function show(extra = ""): void {
  const lines = Object.entries(stats).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  hud.textContent = `${lines.join("\n")}\ncontexts: ${contexts.join(", ") || "-"}\ndevices: ${devices.length}${extra ? `\n${extra}` : ""}`;
}

function frameSummary(intervals: number[]): Stats {
  const f = [...intervals].sort((a, b) => a - b);
  const q = (p: number) => (f.length ? +f[Math.min(f.length - 1, Math.floor(p * f.length))]!.toFixed(1) : null);
  return { frames: f.length, p50: q(0.5), p95: q(0.95), worst: f.length ? +f.at(-1)!.toFixed(1) : null, over50: f.filter((x) => x > 50).length };
}

async function main(): Promise<void> {
  const THREE = backend === "webgpu" ? await import("three/webgpu") : await import("three");
  const { pdfObjectGenerator } = await import("@soadzoor/hepr/bundler");

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // The WebGPU renderer only exists in the three/webgpu build.
  const renderer = backend === "webgpu"
    ? new (THREE as typeof import("three/webgpu")).WebGPURenderer({ canvas, antialias: true })
    : new (THREE as typeof import("three")).WebGLRenderer({ canvas, antialias: true });
  if ("init" in renderer && typeof renderer.init === "function") await renderer.init();
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x1b1d22, 1);
  stats.rendererReadyMs = since();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera.position.set(0, 0, 10);

  const pdf = await pdfObjectGenerator(`/poc-pdf/${encodeURIComponent(src)}`, {
    pageLoading: loading,
    compressScans,
    maxPagesPerRow: 1,
    pages,
    onProgress: ({ stage, value }: { stage: string; value: number }) => {
      if (value === 0 || value >= 1) stages.push(`${stage}${value >= 1 ? " done" : ""} @${since()}`);
      hud.textContent = `${stage} ${Math.round(value * 100)}% @${since()}ms`;
    },
  }, backend);
  stats.openMs = since();
  scene.add(pdf);

  const bounds = pdf.sceneData.pageBounds as { minX: number; maxX: number; minY: number; maxY: number };
  const pageCount = (await pdf.getPages()).length;
  stats.pageCount = pageCount;
  const pageW = bounds.maxX - bounds.minX;
  const docH = bounds.maxY - bounds.minY;
  const pageH = docH / Math.max(1, pageCount);
  // World units per CSS pixel: the page's width fits the screen at 1x.
  const fit = (pageW * 1.04) / window.innerWidth;
  // The object is centred on its own origin, not placed in PDF coordinates:
  // the first page's top is at +docH/2.
  const view = { x: 0, y: docH / 2 - (window.innerHeight * fit) / 2, scale: fit };

  let dirty = true;
  const intervals: number[] = [];
  let recording = false, last = 0;
  const apply = () => {
    const w = window.innerWidth * view.scale, h = window.innerHeight * view.scale;
    camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2;
    camera.position.x = view.x; camera.position.y = view.y;
    camera.updateProjectionMatrix();
  };
  pdf.addEventListener("change", () => { dirty = true; });
  let firstFrame = true;
  const tick = (t: number) => {
    if (recording && last) intervals.push(t - last);
    last = t;
    if (dirty || recording) {
      dirty = false;
      apply();
      renderer.render(scene, camera);
      if (firstFrame) { firstFrame = false; stats.firstFrameMs = since(); show(stages.slice(-6).join("\n")); }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Pan with one pointer, zoom with two or the wheel.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; scale: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = null; });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      view.x -= (e.clientX - p.x) * view.scale; view.y += (e.clientY - p.y) * view.scale;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      p.x = e.clientX; p.y = e.clientY;
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      pinch ??= { d, scale: view.scale };
      view.scale = Math.min(fit * 2, Math.max(fit / 8, pinch.scale * (pinch.d / d)));
    }
    p.x = e.clientX; p.y = e.clientY;
    dirty = true;
  });
  const lift = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch = null; };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.scale = Math.min(fit * 2, Math.max(fit / 8, view.scale * Math.exp(e.deltaY * 0.0015)));
    dirty = true;
  }, { passive: false });
  window.addEventListener("resize", () => { renderer.setSize(window.innerWidth, window.innerHeight, false); dirty = true; });

  const record = async (move: (progress: number) => void, ms: number): Promise<Stats> => {
    intervals.length = 0; longTasks.length = 0; last = 0; recording = true;
    const start = performance.now();
    await new Promise<void>((done) => {
      const step = () => {
        const p = Math.min(1, (performance.now() - start) / ms);
        move(p);
        if (p < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
    recording = false;
    return { ...frameSummary(intervals), longTasks: longTasks.length, longMax: Math.max(0, ...longTasks) };
  };

  const poc = {
    stats, stages, contexts, devices,
    /** Scroll down `pageSpan` pages in `ms`, then back to where it began. */
    async scroll(pageSpan = 20, ms = 4000) {
      const y0 = view.y;
      const down = await record((p) => { view.y = y0 - p * pageSpan * pageH; }, ms);
      view.y = y0; dirty = true;
      return down;
    },
    /** Zoom in to 2x, back, out to 1/2x and back, as one smooth gesture. */
    async zoom(ms = 3000) {
      const s0 = view.scale;
      const out = await record((p) => { view.scale = s0 * Math.pow(2, -Math.sin(p * Math.PI * 2)); }, ms);
      view.scale = s0; dirty = true;
      return out;
    },
    /** Jump to a page (1-based) and time until the next frame drew. */
    async jump(page: number) {
      const start = performance.now();
      view.y = docH / 2 - (page - 0.5) * pageH; dirty = true;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round(performance.now() - start);
    },
    memory() {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return { jsHeapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : null };
    },
    view,
  };
  (window as unknown as { __poc: typeof poc }).__poc = poc;
  stats.ready = true;
  show(stages.slice(-6).join("\n"));
}

main().catch((error: unknown) => {
  stats.error = String(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : error);
  show();
  console.error(error);
});
