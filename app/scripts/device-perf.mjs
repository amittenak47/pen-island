import { execFile } from 'node:child_process';
import { createReadStream, existsSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE = 'dev.lc.whiteboard';
export const MAX_TRACE_BYTES = 400 * 1024 * 1024;
const exec = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function guardTraceSize(bytes) {
  if (bytes > MAX_TRACE_BYTES) throw Error('Trace exceeds 400 MB; aborted. Record a shorter window.');
  return bytes;
}
export function guardOutputPath(out, repo = resolve(APP, '..')) {
  const path = relative(repo, out);
  if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) {
    throw Error('Performance output must be outside the repository. Use OS temp or an external --out directory.');
  }
  return out;
}
async function outputDirectory(raw) {
  const out = raw ? resolve(raw) : await mkdtemp(join(tmpdir(), 'pen-island-perf-'));
  guardOutputPath(out);
  // Resolve the nearest existing ancestor before creating anything, including junctions.
  let ancestor = out;
  const tail = [];
  for (;;) {
    try {
      guardOutputPath(join(await realpath(ancestor), ...tail), await realpath(resolve(APP, '..')));
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      tail.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  await mkdir(out, { recursive: true });
  return out;
}

export async function adb(args) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
  const bundled = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  try {
    return (await exec(existsSync(bundled) ? bundled : 'adb', args,
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout.trim();
  } catch (e) {
    throw Error(`adb ${args[0]} failed: ${e.code === 'ENOENT' ? 'adb not found in SDK or PATH' : e.stderr?.trim() || e.message}`);
  }
}
export function connectedDevices(output) {
  return output.split(/\r?\n/).map(s => s.trim().split(/\s+/))
    .filter(([, state]) => state === 'device').map(([serial]) => serial);
}
export async function tablet(reconnect = false) {
  let devices = connectedDevices(await adb(['devices']));
  if (!devices.length && reconnect) {
    const services = await adb(['mdns', 'services']);
    const address = services.split(/\r?\n/).find(s => /_adb-tls-connect\._tcp\.?\s/.test(s))?.trim().split(/\s+/).at(-1);
    if (!address) throw Error('No adb device and no _adb-tls-connect service. Enable wireless debugging on the tablet.');
    await adb(['connect', address]);
    devices = connectedDevices(await adb(['devices']));
  }
  if (!devices.length) throw Error('No connected adb tablet (retry failed or device offline). Enable wireless debugging and pair first.');
  if (devices.length > 1) {
    const selected = process.env.ANDROID_SERIAL;
    if (devices.includes(selected)) return selected;
    throw Error('Multiple adb devices; set ANDROID_SERIAL to the tablet serial.');
  }
  return devices[0];
}

/** All requests, opening, and trace completion have independent deadlines. */
export async function openPage(port = 9323, onEvent = () => {}) {
  if (typeof WebSocket === 'undefined') throw Error('Node 22+ with built-in WebSocket is required.');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error(`CDP target list: HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find(t => t.type === 'page' && t.title === 'Pen Island')
    || targets.find(t => t.type === 'page' && /tauri|localhost:1420/.test(t.url));
  if (!page?.webSocketDebuggerUrl) throw Error(`No Pen Island page on port ${port}. Use connect first (desktop: remote debugging port 9222).`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0, fatal;
  const close = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fatal || Error('CDP socket closed')); }
    pending.clear();
    ws.close();
  };
  const exitClose = () => ws.close();
  process.once('exit', exitClose);
  ws.addEventListener('close', () => { close(); process.removeListener('exit', exitClose); });
  ws.addEventListener('message', ({ data }) => {
    try {
      const m = JSON.parse(data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      } else if (m.method) onEvent(m);
    } catch (e) { fatal = e; close(); }
  });
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => { close(); rej(Error('CDP socket open timeout')); }, 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); rej(Error('CDP socket error')); }, { once: true });
    });
  } catch (e) { close(); throw e; }
  const call = (method, params = {}) => new Promise((res, rej) => {
    if (fatal || ws.readyState !== WebSocket.OPEN) { rej(fatal || Error('CDP socket is closed')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: res, reject: rej, timer, method });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(id); rej(e); }
  });
  return { call, close, title: page.title, check: () => { if (fatal) throw fatal; },
    evaluate: async expression => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(`Page evaluation failed: ${r.exceptionDetails.text}`);
      return r.result?.value;
    } };
}

async function connect(port) {
  const serial = await tablet(true);
  const pids = (await adb(['-s', serial, 'shell', 'pidof', PACKAGE])).split(/\s+/).filter(Boolean);
  if (!pids.length) throw Error(`${PACKAGE} is not running. Open Pen Island on the tablet, then retry.`);
  const sockets = await adb(['-s', serial, 'shell', 'cat', '/proc/net/unix']);
  const socket = sockets.split(/\r?\n/).map(s => s.trim().split(/\s+/).at(-1)?.replace(/^@/, ''))
    .find(s => pids.some(pid => s === `webview_devtools_remote_${pid}`));
  if (!socket) throw Error('Running app has no WebView debugging socket. Use a debuggable APK and open its WebView.');
  await adb(['-s', serial, 'forward', `tcp:${port}`, `localabstract:${socket}`]);
  const cdp = await openPage(port);
  try { console.log(`Connected: ${cdp.title} (port ${port})`); } finally { cdp.close(); }
}

/** Reversible hooks, bounded logs, no app data writes. Serialized into the page. */
export function pageHooks() {
  window.__penPerf?.stop();
  const data = { idb: [], quality: [], errors: [], dropped: 0, startedAt: performance.now() };
  const undo = [], origins = new WeakMap();
  const add = (kind, row) => { if (data[kind].length < 2000) data[kind].push(row); else data.dropped++; };
  const listen = (type, fn) => { addEventListener(type, fn, true); undo.push(() => removeEventListener(type, fn, true)); };
  listen('error', e => add('errors', { at: performance.now(), message: String(e.message).slice(0, 1000), source: e.filename, line: e.lineno, column: e.colno }));
  listen('unhandledrejection', e => add('errors', { at: performance.now(), message: String(e.reason?.stack || e.reason).slice(0, 2000) }));
  for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype]) {
    for (const method of ['get', 'getAll', 'getAllKeys', 'getKey', 'openCursor', 'openKeyCursor', 'count']) {
      const original = proto[method];
      if (!original) continue;
      const wrapped = function (...args) {
        const request = original.apply(this, args);
        origins.set(request, { store: this.objectStore ? `${this.objectStore.name}/${this.name}` : this.name,
          method, at: performance.now(), caller: (new Error().stack || '').split('\n').slice(2, 9).join('\n') });
        return request;
      };
      proto[method] = wrapped;
      undo.push(() => { if (proto[method] === wrapped) proto[method] = original; });
    }
  }
  const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  const get = function () {
    const start = performance.now();
    const value = desc.get.call(this), ms = performance.now() - start, origin = origins.get(this);
    if (ms > 15 && origin) add('idb', { ...origin, ms, waited: start - origin.at, n: Array.isArray(value) ? value.length : 1 });
    return value;
  };
  Object.defineProperty(IDBRequest.prototype, 'result', { ...desc, get });
  undo.push(() => { if (Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result').get === get) Object.defineProperty(IDBRequest.prototype, 'result', desc); });
  const states = new WeakMap();
  const visible = el => {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.99) return false;
    }
    return el.getClientRects().length > 0;
  };
  const sample = () => {
    for (const el of document.querySelectorAll('.lc-pdf-page, .lc-doc-page-marks')) {
      if (el.closest('.lc-page-booktabs-slot')) continue;
      const kind = el.classList.contains('lc-pdf-page') ? 'page' : 'marks';
      const q = el.dataset.pdfQuality ?? null;
      const shown = kind === 'marks' ? visible(el) : q === 'sharp';
      const state = `${q}:${shown}`;
      if (states.get(el) !== state) {
        add('quality', { at: performance.now(), page: el.dataset.pdfPage ?? el.dataset.markPage ?? '?', kind, q, visible: shown, initial: !states.has(el) });
        states.set(el, state);
      }
    }
  };
  let raf;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sample(); }); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pdf-quality', 'class', 'style'] });
  listen('transitionend', schedule);
  sample();
  const stop = () => { observer.disconnect(); cancelAnimationFrame(raf); for (const f of undo.reverse()) f(); delete window.__penPerf; return data; };
  window.__penPerf = { stop, data };
  return true;
}

/** Streaming JSON tokenizer: yields each member of traceEvents, never the array. */
export async function* traceEvents(chunks) {
  let prefix = '', started = false, ended = false, depth = 0, quoted = false, escaped = false, pieces = [];
  const decoder = new StringDecoder('utf8');
  for await (const chunk of chunks) {
    let s = typeof chunk === 'string' ? chunk : decoder.write(chunk), offset = 0;
    if (!started) {
      prefix += s;
      const m = /"traceEvents"\s*:\s*\[/.exec(prefix);
      if (!m) { if (prefix.length > 65536) throw Error('Expected a Chrome traceEvents array near the start of the file.'); continue; }
      s = prefix.slice(m.index + m[0].length); prefix = ''; started = true;
    }
    let begin = depth ? 0 : -1;
    for (; offset < s.length && !ended; offset++) {
      const c = s[offset];
      if (!depth) {
        if (c === ']') { ended = true; break; }
        if (/[\s,]/.test(c)) continue;
        if (c !== '{') throw Error('Invalid trace event JSON.');
        depth = 1; begin = offset; continue;
      }
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (!depth) {
          const tail = s.slice(begin, offset + 1);
          yield JSON.parse(pieces.length ? pieces.join('') + tail : tail);
          pieces = []; begin = -1;
        }
      }
    }
    if (depth && begin >= 0) pieces.push(s.slice(begin));
  }
  if (!started || !ended || depth) throw Error('Incomplete trace: traceEvents array was not closed.');
}

const threadKey = e => `${e.pid}:${e.tid}`;
const taskName = n => /^(?:ThreadControllerImpl::RunTask|RunTask|TaskQueueManager::ProcessTaskFromWorkQueue)$/.test(n);
const drawName = n => /^(?:DrawFn_DrawGL|DrawFrame|drawFrame)$/.test(n);
const recalcName = n => /^(?:UpdateLayoutTree|RecalculateStyles|Document::recalcStyle)$/.test(n);
const causeName = n => /InvalidationTracking|ScheduleStyleRecalculation/.test(n);
const callbackName = n => /FunctionCall|EvaluateScript|EventDispatch|TimerFire|FireAnimationFrame|Layout|recalcStyle/.test(n);
const top = (rows, n = 12) => rows.sort((a, b) => b.ms - a.ms).slice(0, n);
// Timeline locations are one-based; normalize to CDP/source-map zero-based columns.
const location = d => d?.url ? { functionName: d.functionName || '', url: d.url,
  line: Math.max(0, (d.lineNumber ?? 1) - 1), column: Math.max(0, (d.columnNumber ?? 1) - 1) } : null;

/** Retain one compact copy of relevant spans only; input is bounded at 400 MB. */
export async function summarizeEvents(events) {
  const names = new Map(), threads = new Map();
  let count = 0, capture = null, t0 = Infinity;
  for await (const e of events) {
    count++;
    if (e.name === 'PenIslandCapture') { capture = e.args; continue; }
    const key = threadKey(e);
    if (e.ph === 'M' && e.name === 'thread_name') { names.set(key, e.args?.name || ''); continue; }
    if (!Number.isFinite(e.ts)) continue;
    t0 = Math.min(t0, e.ts);
    if (!['X', 'B', 'E', 'I', 'i'].includes(e.ph)) continue;
    const relevant = taskName(e.name) || drawName(e.name) || recalcName(e.name) || causeName(e.name) || callbackName(e.name);
    // Keep all B/E boundaries so unnamed E events pair with the correct B.
    if (!relevant && e.ph !== 'B' && e.ph !== 'E') continue;
    const d = e.args?.data || e.args?.beginData || {};
    const row = { name: e.name, ph: e.ph, ts: e.ts, dur: e.dur || 0, relevant,
      frame: d.frame, loc: location(d), elements: e.args?.elementCount ?? e.args?.beginData?.elementCount ?? d.elementCount,
      cause: causeName(e.name) ? { reason: d.reason || d.invalidationSet?.[0]?.id || '', node: d.nodeName || '',
        change: d.changedClass || d.changedAttribute || d.changedId || d.changedPseudo || '', loc: location(d.stackTrace?.[0]) } : null };
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(row);
  }
  const frames = { draws: 0, gaps: 0, over33: 0, over50: 0, over100: 0, worstMs: 0,
    drawCosts: { over33: 0, over50: 0, over100: 0, worstMs: 0 } };
  let taskCount = 0;
  const tasks = [], recalcs = [];
  for (const [key, rows] of threads) {
    rows.sort((a, b) => a.ts - b.ts || (b.dur - a.dur));
    const stack = [], spans = [];
    for (const r of rows) {
      if (r.ph === 'B') stack.push(r);
      else if (r.ph === 'E') {
        const b = stack.pop();
        if (b?.relevant) { b.dur = Math.max(0, r.ts - b.ts); spans.push(b); }
      } else if (r.relevant) spans.push(r);
    }
    spans.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const name = names.get(key) || '';
    if (/RenderThread/.test(name)) {
      let prev;
      for (const r of spans) if (drawName(r.name)) {
        frames.draws++;
        const cost = r.dur / 1000;
        frames.drawCosts.worstMs = Math.max(frames.drawCosts.worstMs, cost);
        for (const n of [33, 50, 100]) if (cost > n) frames.drawCosts[`over${n}`]++;
        if (prev !== undefined) {
          const gap = (r.ts - prev) / 1000;
          frames.gaps++; frames.worstMs = Math.max(frames.worstMs, gap);
          for (const n of [33, 50, 100]) if (gap > n) frames[`over${n}`]++;
        }
        prev = r.ts;
      }
    }
    if (!/CrRendererMain|RendererMain/.test(name)) continue;
    const long = spans.filter(r => taskName(r.name) && r.dur > 50000);
    taskCount += long.length;
    for (const r of top(long.map(r => ({ ...r, ms: r.dur / 1000 })))) {
      const callees = new Map();
      for (const c of spans) if (c !== r && !taskName(c.name) && c.dur > 0 && c.ts >= r.ts && c.ts + c.dur <= r.ts + r.dur) {
        const label = `${c.name}:${JSON.stringify(c.loc)}`;
        const old = callees.get(label) || { name: c.name, loc: c.loc, ms: 0, count: 0 };
        old.ms += c.dur / 1000; old.count++; callees.set(label, old);
      }
      tasks.push({ name: r.name, ms: r.ms, atMs: (r.ts - t0) / 1000, thread: key, callees: top([...callees.values()], 8) });
    }
    const big = top(spans.filter(r => recalcName(r.name) && r.dur > 0).map(r => ({ ...r, ms: r.dur / 1000 })));
    for (const r of big) {
      const causes = new Map();
      for (const c of spans) if (c.cause && c.ts >= r.ts - 120000 && c.ts <= r.ts + r.dur
        && (!r.frame || !c.frame || r.frame === c.frame)) {
        const label = JSON.stringify(c.cause), old = causes.get(label) || { name: c.name, ...c.cause, count: 0 };
        old.count++; causes.set(label, old);
      }
      recalcs.push({ name: r.name, ms: r.ms, atMs: (r.ts - t0) / 1000, elements: r.elements ?? null,
        causes: [...causes.values()].sort((a, b) => b.count - a.count).slice(0, 12) });
    }
  }
  const quality = capture?.hooks?.quality || [], pages = new Map(), startedAt = capture?.hooks?.startedAt || 0;
  for (const q of quality) {
    const page = String(q.page);
    if (!pages.has(page)) pages.set(page, { page, sharpAtMs: null, marksAtMs: null, baseline: false });
    const p = pages.get(page);
    p.baseline ||= !!q.initial;
    if (q.kind === 'page' && q.q === 'sharp' && p.sharpAtMs === null) p.sharpAtMs = q.at - startedAt;
    if ((q.kind === 'marks' || q.kind === 'marks-mount') && q.visible === true && p.marksAtMs === null) p.marksAtMs = q.at - startedAt;
  }
  const pageTiming = [...pages.values()].map(p => ({ ...p,
    marksAfterSharpMs: p.sharpAtMs !== null && p.marksAtMs !== null ? p.marksAtMs - p.sharpAtMs : null }));
  return { events: count, frames, longTaskCount: taskCount, longTasks: top(tasks), styleRecalcs: top(recalcs),
    idb: top((capture?.hooks?.idb || []).filter(r => r.ms > 15), 2000), pageTiming,
    errors: capture?.hooks?.errors || [], gpu: capture?.gpu || null, hooksAvailable: !!capture?.hooks,
    droppedHookEntries: capture?.hooks?.dropped || 0, dataLoss: !!capture?.dataLoss,
    notes: ['Callee times include children and may overlap.', 'Invalidation causes are candidates on the same thread/frame within 120 ms before or during recalc.',
      'Page timings are first observed sharp/visible states; baseline states may predate recording.'] };
}

export async function summarizeFile(path) {
  guardTraceSize((await stat(path)).size);
  let bytes = 0;
  async function* chunks() {
    for await (const b of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      guardTraceSize(bytes += b.length);
      yield b;
    }
  }
  return summarizeEvents(traceEvents(chunks()));
}

export function sourceMapper(assets = join(APP, 'dist', 'assets')) {
  let cachedName, consumer;
  return loc => {
    if (!loc) return '';
    const fallback = `${loc.functionName || '(anonymous)'} ${loc.url}:${loc.line + 1}:${loc.column + 1}`;
    let bundle;
    try { bundle = basename(new URL(loc.url).pathname); } catch { bundle = basename(loc.url); }
    const map = join(assets, `${bundle}.map`);
    if (!existsSync(map)) return fallback;
    try {
      if (cachedName !== map) {
        consumer = null; cachedName = map;
        const { SourceMapConsumer } = createRequire(import.meta.url)('source-map-js');
        consumer = new SourceMapConsumer(JSON.parse(readFileSync(map, 'utf8')));
      }
      const p = consumer?.originalPositionFor({ line: loc.line + 1, column: loc.column });
      const src = p?.source?.replaceAll('\\', '/');
      const m = src?.match(/(?:^|\/)(src\/.*)$/);
      return m && p.line ? `${p.name || loc.functionName || '(anonymous)'} app/${m[1]}:${p.line}:${p.column + 1}` : fallback;
    } catch { return fallback; }
  };
}

export function formatSummary(s, map = sourceMapper()) {
  const f = n => Number(n).toFixed(1), lines = [`Pen Island performance (${s.events} trace events)`];
  const frames = s.frames;
  lines.push(`RenderThread frames: ${frames.draws} draws; gaps >33/50/100 ms: ${frames.over33}/${frames.over50}/${frames.over100}; worst ${f(frames.worstMs)} ms`,
    `Draw costs >33/50/100 ms: ${frames.drawCosts.over33}/${frames.drawCosts.over50}/${frames.drawCosts.over100}; worst ${f(frames.drawCosts.worstMs)} ms`);
  if (!frames.draws) lines.push('RenderThread draws unavailable (common on desktop traces); no frame measurement.');
  lines.push(`Long main-thread tasks >50 ms: ${s.longTaskCount} (largest ${s.longTasks.length} shown)`);
  for (const t of s.longTasks) {
    lines.push(`  ${f(t.ms)} ms at ${f(t.atMs)} ms: ${t.name}`);
    for (const c of t.callees) lines.push(`    ${f(c.ms)} ms inclusive: ${c.name} ${map(c.loc)}`);
  }
  lines.push(`Biggest style recalcs: ${s.styleRecalcs.length}`);
  for (const r of s.styleRecalcs) {
    lines.push(`  ${f(r.ms)} ms, elements ${r.elements ?? '?'}, at ${f(r.atMs)} ms: ${r.name}`);
    for (const c of r.causes) lines.push(`    ${c.count}x ${c.name}: ${c.reason} ${c.node} ${c.change} ${map(c.loc)}`);
    if (!r.causes.length) lines.push('    No invalidation causes captured.');
  }
  lines.push(`IndexedDB result reads >15 ms: ${s.idb.length}${s.hooksAvailable ? '' : ' (hooks unavailable in this trace)'}`);
  for (const r of s.idb) lines.push(`  ${f(r.ms)} ms ${r.store}.${r.method} (${r.n} results; waited ${f(r.waited)} ms)\n    ${mapStack(r.caller || r.stack || '', map)}`);
  lines.push(`Page sharp / marks visible: ${s.pageTiming.length} pages`);
  for (const p of s.pageTiming) lines.push(`  page ${p.page}: sharp ${p.sharpAtMs === null ? '?' : f(p.sharpAtMs)} ms; marks ${p.marksAtMs === null ? '?' : f(p.marksAtMs)} ms; delta ${p.marksAfterSharpMs === null ? '?' : f(p.marksAfterSharpMs)} ms${p.baseline ? ' (includes baseline)' : ''}`);
  lines.push(`JS errors: ${s.errors.length}`);
  for (const e of s.errors) lines.push(`  ${e.message || e}${e.source ? ` ${map({ url: e.source, line: (e.line || 1) - 1, column: (e.column || 1) - 1 })}` : ''}`);
  const gpu = x => x?.kb != null ? `${x.kb} KB` : `unavailable${x?.error ? ` (${x.error})` : ''}`;
  lines.push(`GPU GL mtrack: before ${gpu(s.gpu?.before)}; after ${gpu(s.gpu?.after)}`);
  if (s.droppedHookEntries) lines.push(`Hook log limit reached: ${s.droppedHookEntries} entries dropped.`);
  if (s.dataLoss) lines.push('WARNING: Chrome reported lost trace data; this summary is incomplete.');
  lines.push(...s.notes);
  return lines.join('\n');
}
function mapStack(stack, map) {
  return stack.replace(/((?:https?|tauri|asset):\/\/[^\s)]+):(\d+):(\d+)/g,
    (_, url, line, column) => map({ url, line: Number(line) - 1, column: Number(column) - 1 }));
}
export function parseGpu(text) {
  const m = /^\s*GL mtrack:\s*([\d,]+)/mi.exec(text);
  return m ? { kb: Number(m[1].replaceAll(',', '')) } : { kb: null, error: 'GL mtrack not reported by device' };
}
async function gpuSnapshot(serial) {
  if (!serial) return { kb: null, error: 'no adb tablet (desktop CDP is still supported)' };
  try { return parseGpu(await adb(['-s', serial, 'shell', 'dumpsys', 'meminfo', PACKAGE])); }
  catch (e) { return { kb: null, error: e.message }; }
}

async function record(opts) {
  const out = await outputDirectory(opts.out);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tracePath = join(out, `trace-${stamp}.json`), summaryPath = join(out, `summary-${stamp}.json`);
  let fd = openSync(tracePath, 'wx'), bytes = 0, first = true, complete = false, loss = false;
  const append = s => { bytes = guardTraceSize(bytes + Buffer.byteLength(s)); writeSync(fd, s); };
  const event = e => { append(`${first ? '' : ','}\n${JSON.stringify(e)}`); first = false; };
  append('{"traceEvents":[');
  let cdp, serial, installed = false, newDocument;
  try {
    const onEvent = m => {
      if (m.method === 'Tracing.dataCollected') for (const e of m.params.value) event(e);
      if (m.method === 'Tracing.tracingComplete') { complete = true; loss = !!m.params.dataLossOccurred; }
    };
    try { cdp = await openPage(opts.port, onEvent); }
    catch (e) {
      if (opts.port === 9222) throw e;
      await connect(opts.port);
      cdp = await openPage(opts.port, onEvent);
    }
    try { serial = await tablet(); } catch (e) { if (opts.port !== 9222) throw e; }
    await sleep(opts.delay * 1000);
    const before = await gpuSnapshot(serial);
    await cdp.call('Page.enable');
    const source = `(${pageHooks.toString()})()`;
    newDocument = (await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
    await cdp.evaluate(source); installed = true;
    await cdp.call('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
        'disabled-by-default-devtools.timeline.invalidationTracking', 'blink', 'cc', 'viz', 'gpu', 'v8.execute', 'input', 'benchmark', 'toplevel'] } });
    console.log(`Recording ${opts.secs}s on ${cdp.title}; output ${out}`);
    await sleep(opts.secs * 1000); cdp.check();
    const hooks = await cdp.evaluate('window.__penPerf?.stop()'); installed = false;
    await cdp.call('Tracing.end');
    const deadline = Date.now() + 30000;
    while (!complete) { cdp.check(); if (Date.now() > deadline) throw Error('Timed out waiting for Tracing.tracingComplete.'); await sleep(50); }
    const after = await gpuSnapshot(serial);
    event({ name: 'PenIslandCapture', ph: 'I', ts: 0, pid: 0, tid: 0,
      args: { hooks, gpu: { before, after }, dataLoss: loss, title: cdp.title } });
    append('\n]}'); closeSync(fd); fd = null;
    const summary = await summarizeFile(tracePath);
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`${formatSummary(summary)}\nRaw trace: ${tracePath}\nJSON summary: ${summaryPath}`);
  } finally {
    if (cdp) {
      try { if (installed) await cdp.evaluate('window.__penPerf?.stop()'); } catch { /* connection may be gone */ }
      try { if (newDocument) await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: newDocument }); } catch { /* bounded cleanup */ }
      cdp.close();
    }
    if (fd !== null) closeSync(fd);
  }
}

export function parsePerfArgs(args) {
  const [command, ...rest] = args, opts = { port: 9323, secs: 20, delay: 3 };
  if (!['connect', 'record', 'summarize', '--help', '-h'].includes(command)) throw Error('Use connect, record, summarize, or --help.');
  if (command === 'summarize') { if (rest.length !== 1) throw Error('Usage: summarize <trace.json>'); return { command, path: rest[0], ...opts }; }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, ''), value = rest[i + 1];
    if (!['port', ...(command === 'record' ? ['secs', 'delay', 'out'] : [])].includes(key) || value === undefined) throw Error(`Unknown or missing option: ${rest[i]}`);
    opts[key] = key === 'out' ? value : Number(value);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw Error('Port must be 1..65535.');
  if (!Number.isFinite(opts.secs) || opts.secs <= 0 || opts.secs > 3600 || !Number.isFinite(opts.delay) || opts.delay < 0 || opts.delay > 300) throw Error('Use --secs >0..3600 and --delay 0..300.');
  return { command, ...opts };
}

async function main() {
  const opts = parsePerfArgs(process.argv.slice(2));
  const timer = setTimeout(() => { console.error('FAIL: device-perf hard timeout; closing CDP sockets.'); process.exit(1); },
    (opts.command === 'record' ? opts.secs + opts.delay + 180 : 180) * 1000);
  const signal = () => process.exit(130);
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try {
    if (opts.command === 'connect') await connect(opts.port);
    else if (opts.command === 'record') await record(opts);
    else if (opts.command === 'summarize') console.log(formatSummary(await summarizeFile(resolve(opts.path))));
    else console.log('npm run device:perf -- connect [--port 9323]\nnpm run device:perf -- record [--secs 20] [--delay 3] [--port 9323|9222] [--out dir]\nnpm run device:perf -- summarize <trace.json>\nOpen the tablet app first. Record reconnects/forwards automatically if its CDP port is unavailable; desktop CDP uses 9222. Default output: a unique directory in OS temp. Node 22+ required.');
  } finally { clearTimeout(timer); process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`FAIL: ${e.message}`); process.exitCode = 1; });
}
