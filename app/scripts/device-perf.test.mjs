import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { summarizeEvents, summarizeFile, traceEvents, formatSummary, guardTraceSize,
  MAX_TRACE_BYTES, sourceMapper, parseGpu, parsePerfArgs, connectedDevices, guardOutputPath } from './device-perf.mjs';

const span = (name, ts, dur, args = {}, tid = 1) => ({ name, ts, dur, args, tid, pid: 1, ph: 'X' });
const named = (tid, name) => ({ name: 'thread_name', ph: 'M', pid: 1, tid, args: { name } });
const frame = { url: 'http://localhost/assets/app.js', lineNumber: 1, columnNumber: 9, functionName: 'changePage' };
function fixture() {
  return [
    span('RunTask', 1000, 120000),
    span('FunctionCall', 2000, 70000, { data: frame }),
    span('FunctionCall', 73000, 20000, { data: frame }),
    span('UpdateLayoutTree', 100000, 18000, { beginData: { elementCount: 2400, frame: 'A' } }),
    { name: 'StyleRecalcInvalidationTracking', ph: 'I', pid: 1, tid: 1, ts: 95000,
      args: { data: { reason: 'Class changed', nodeName: 'DIV', changedClass: 'sharp', frame: 'A', stackTrace: [frame] } } },
    { name: 'LayoutInvalidationTracking', ph: 'I', pid: 1, tid: 2, ts: 95000, args: { data: { reason: 'wrong thread' } } },
    ...[0, 34000, 85000, 186000].map((ts, i) => span('DrawFn_DrawGL', ts, [1000, 34000, 51000, 101000][i], {}, 3)),
    span('DrawFn_DrawGL', 1000000, 500000, {}, 2), // not RenderThread
    { name: 'PenIslandCapture', args: { hooks: {
      idb: [{ store: 'pages', method: 'getAll', ms: 19, waited: 23, n: 50, caller: 'at load (http://localhost/assets/app.js:1:9)' },
        { store: 'fast', method: 'get', ms: 15 }],
      errors: [{ message: 'example failure' }], dropped: 2,
      quality: [{ page: '2', kind: 'page', q: 'sharp', at: 250 }, { page: '2', kind: 'marks', visible: true, at: 275 },
        { page: '3', kind: 'page', q: 'preview', at: 280 }],
    }, gpu: { before: { kb: 100 }, after: { kb: 140 } } } },
    // Chrome metadata may arrive after events; events need not be timestamp ordered.
    named(1, 'CrRendererMain'), named(2, 'Compositor'), named(3, 'RenderThread'),
  ];
}

describe('pure trace summary', () => {
  it('counts draw gaps and draw costs independently on RenderThread only', async () => {
    const s = await summarizeEvents(fixture());
    expect(s.frames).toMatchObject({ draws: 4, gaps: 3, over33: 3, over50: 2, over100: 1, worstMs: 101,
      drawCosts: { over33: 3, over50: 2, over100: 1, worstMs: 101 } });
  });
  it('associates long tasks, top inclusive callees and same-thread/frame recalc causes', async () => {
    const s = await summarizeEvents(fixture());
    expect(s.longTaskCount).toBe(1);
    expect(s.longTasks[0]).toMatchObject({ ms: 120, callees: [{ name: 'FunctionCall', ms: 90, count: 2 }, { name: 'UpdateLayoutTree', ms: 18 }] });
    expect(s.styleRecalcs[0]).toMatchObject({ elements: 2400, ms: 18, causes: [{ reason: 'Class changed', node: 'DIV', change: 'sharp', count: 1 }] });
    expect(s.styleRecalcs[0].causes).toHaveLength(1);
  });
  it('reports slow IDB caller, page sharp vs visible delta, errors and GPU snapshots', async () => {
    const s = await summarizeEvents(fixture());
    expect(s.idb).toHaveLength(1);
    expect(s.idb[0].caller).toContain('load');
    expect(s.pageTiming).toEqual([
      { page: '2', sharpAtMs: 250, marksAtMs: 275, marksAfterSharpMs: 25, baseline: false },
      { page: '3', sharpAtMs: null, marksAtMs: null, marksAfterSharpMs: null, baseline: false },
    ]);
    const report = formatSummary(s, loc => loc ? 'app/src/pages.ts:10:2' : '');
    for (const text of ['19.0 ms pages.getAll', 'app/src/pages.ts:10:2', 'example failure', 'before 100 KB; after 140 KB', '2 entries dropped']) expect(report).toContain(text);
  });
  it('pairs B/E events around irrelevant nested scopes without inventing long tasks', async () => {
    const s = await summarizeEvents([
      named(1, 'CrRendererMain'),
      { ...span('RunTask', 0), ph: 'B' },
      { ...span('uninterestingScope', 1000), ph: 'B' },
      { ...span('', 2000), ph: 'E' },
      { ...span('FunctionCall', 3000, 0, { data: frame }), ph: 'B' },
      { ...span('', 70000), ph: 'E' },
      { ...span('', 80000), ph: 'E' },
    ]);
    expect(s.longTasks[0]).toMatchObject({ ms: 80, callees: [{ name: 'FunctionCall', ms: 67 }] });
  });
  it('marks absent hooks, desktop frame data and trace data loss clearly', async () => {
    const s = await summarizeEvents([{ name: 'PenIslandCapture', args: { dataLoss: true } }]);
    const report = formatSummary(s);
    expect(report).toContain('no frame measurement');
    expect(report).toContain('hooks unavailable');
    expect(report).toContain('lost trace data');
  });
});

describe('streaming trace input and limits', () => {
  it('parses arbitrarily split nested events, escapes and multibyte UTF-8', async () => {
    const events = [{ name: 'é島', args: { text: '}]\\"\n', nested: [1, { a: true }] } }, { name: 'two' }];
    const bytes = Buffer.from(JSON.stringify({ traceEvents: events, metadata: {} }));
    const chunks = Array.from(bytes, b => Buffer.from([b]));
    const got = [];
    for await (const e of traceEvents(chunks)) got.push(e);
    expect(got).toEqual(events);
  });
  it('rejects truncated event streams', async () => {
    await expect(summarizeEvents(traceEvents(['{"traceEvents":[{"name":"x"}']))).rejects.toThrow('Incomplete trace');
  });
  it('summarizes a file in one streaming read and rejects an oversized sparse file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pen-perf-test-'));
    try {
      const path = join(dir, 'trace.json');
      await writeFile(path, JSON.stringify({ traceEvents: fixture() }));
      expect(await summarizeFile(path)).toEqual(await summarizeEvents(fixture()));
      await truncate(path, MAX_TRACE_BYTES + 1);
      await expect(summarizeFile(path)).rejects.toThrow('400 MB');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('permits exactly 400 MB and rejects the next byte', () => {
    expect(guardTraceSize(MAX_TRACE_BYTES)).toBe(MAX_TRACE_BYTES);
    expect(() => guardTraceSize(MAX_TRACE_BYTES + 1)).toThrow('400 MB');
  });
  it('rejects repository output directories while allowing neighboring directories', () => {
    const repo = join(tmpdir(), 'example-repo');
    expect(() => guardOutputPath(repo, repo)).toThrow('outside the repository');
    expect(() => guardOutputPath(join(repo, 'captures'), repo)).toThrow('outside the repository');
    const outside = `${repo}-captures`;
    expect(guardOutputPath(outside, repo)).toBe(outside);
  });
});

describe('source locations and CLI parsing', () => {
  it('maps timeline and error-stack positions to app/src when matching maps exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pen-map-test-'));
    try {
      const { SourceMapGenerator } = createRequire(import.meta.url)('source-map-js');
      const generator = new SourceMapGenerator({ file: 'app.js' });
      generator.addMapping({ generated: { line: 1, column: 8 }, original: { line: 42, column: 3 }, source: '../../src/page.ts', name: 'showPage' });
      await writeFile(join(dir, 'app.js.map'), generator.toString());
      const report = formatSummary(await summarizeEvents(fixture()), sourceMapper(dir));
      expect(report).toContain('showPage app/src/page.ts:42:4');
      expect(sourceMapper(dir)({ url: 'http://localhost/missing.js', line: 0, column: 0 })).toContain('missing.js:1:1');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reads GL mtrack without confusing other GPU metrics', () => {
    expect(parseGpu(' EGL mtrack: 999\n GL mtrack: 12,345 0 0\n')).toEqual({ kb: 12345 });
    expect(parseGpu('Graphics: 321')).toMatchObject({ kb: null });
  });
  it('validates timing and port options without any device calls', () => {
    expect(parsePerfArgs(['record', '--secs', '5', '--port', '9222'])).toMatchObject({ secs: 5, delay: 3, port: 9222 });
    for (const args of [['record', '--secs', 'NaN'], ['record', '--delay', '-1'], ['connect', '--port', '0'], ['summarize']]) expect(() => parsePerfArgs(args)).toThrow();
    expect(connectedDevices('List of devices attached\na device\nb offline\nc unauthorized\n')).toEqual(['a']);
  });
});
