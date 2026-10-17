// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const baseline = process.argv.includes('--baseline');
const root = resolve('../.tmp-camera-parity');
const output = resolve(root, baseline ? 'baseline' : 'branch');
const profile = resolve(root, `profile-${process.pid}`);
await mkdir(output, { recursive: true });
await mkdir(profile, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = 1478, children = [];
let socket;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
});
children.push(server);
let errors = '';
server.stderr.on('data', data => errors += data);
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(errors || 'Isolated Vite exited');
    try { if ((await fetch(`http://127.0.0.1:${port}/scripts/camera-parity-review.html`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert(ready, 'Isolated server did not start');
  const chrome = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  children.push(chrome);
  let debugPort;
  for (let i = 0; i < 100; i++) {
    try { debugPort = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await sleep(100); }
  }
  assert(debugPort, 'Chrome did not start');
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map(), exceptions = [];
  let paused;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    if (message.method === 'Debugger.paused') paused?.(message.params);
    const task = pending.get(message.id);
    if (task) { pending.delete(message.id); message.error ? task.reject(message.error) : task.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Debugger.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('whiteboard.linedPaper.v1', 'wide');
    let seed = 0x2ca6e4;
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      // The flick-prediction HUD is a debug overlay whose numbers and edge
      // differ run to run on unchanged code (26 px on the PDF scroll states);
      // it is not part of the camera under test.
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.lc-flick-predict-hud{visibility:hidden!important}';
      document.head.append(style);
    });
  ` });
  const results = [];
  const capture = async (mode, state) => {
    const geometry = await evaluate(`({view:window.reviewBoard.getViewportBounds(),
      ink:document.querySelector('.lc-ink-lab-canvas')?.style.transform,
      content:document.querySelector('.lc-page-content-slot')?.style.transform,
      lined:!!document.querySelector('.lc-board-lined-overlay'),
      selection:document.querySelector('.lc-scene-select')?.getAttribute('style'),
      selected:window.parityScene.getAppState().selectedElementIds,
      pdf:document.querySelectorAll('.lc-pdf-page canvas').length})`);
    const stopped = new Promise(resolve => { paused = resolve; });
    const pause = send('Runtime.evaluate', { expression: 'debugger' });
    await stopped;
    const name = `${mode}-${state}.png`;
    await writeFile(resolve(output, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await send('Debugger.resume');
    await pause;
    let differingPixels = null;
    if (!baseline) {
      const images = await Promise.all([loadImage(resolve(root, 'baseline', name)), loadImage(resolve(output, name))]);
      assert.equal(images[0].width, images[1].width, name);
      assert.equal(images[0].height, images[1].height, name);
      const pixels = images.map(img => {
        const canvas = createCanvas(img.width, img.height), ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      });
      differingPixels = 0;
      for (let i = 0; i < pixels[0].length; i += 4) {
        if (pixels[0].subarray(i, i + 4).some((v, channel) => v !== pixels[1][i + channel])) differingPixels++;
      }
    }
    results.push({ mode, state, differingPixels, ...geometry });
    console.log(JSON.stringify(results.at(-1)));
  };
  for (const [mode, query] of [['notebook', 'whiteboard'], ['markdown', 'scroll'], ['pdf', 'pdf&scroll']]) {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/scripts/camera-parity-review.html?${query}` });
    ready = false;
    for (let i = 0; i < 400; i++) {
      if (await evaluate('Boolean(window.reviewReady)')) { ready = true; break; }
      if (exceptions.length) throw new Error(JSON.stringify(exceptions));
      await sleep(100);
    }
    assert(ready, `${mode}: harness did not start`);
    await evaluate(`(async()=>{
      const b=window.reviewBoard, root=document.querySelector('.lc-board');
      let fiber=root[Object.keys(root).find(k=>k.startsWith('__reactFiber'))];
      while(fiber && !window.parityScene){
        for(let hook=fiber.memoizedState;hook;hook=hook.next){
          const value=hook.memoizedState?.current;
          if(value?.getSceneElements && value?.updateScene){window.parityScene=value;break;}
        }
        fiber=fiber.return;
      }
      if(!window.parityScene)throw Error('No scene store');
      root.querySelector('button[aria-label="Show toolbar"]').click();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      b.setTool('selection');
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const view=b.getViewportBounds();
      const shapes=b.convert([{type:'rectangle',id:'camera-parity-selection',x:view.x+view.width*.35,y:view.y+view.height*.35,width:180,height:120,strokeColor:'#2073cc',backgroundColor:'transparent'}],{regenerateIds:false});
      b.setElements([...b.getElements(),...shapes]);
      window.parityScene.updateScene({appState:{selectedElementIds:{'camera-parity-selection':true}}});
      if(${JSON.stringify(mode)}==='notebook')b.setInkOps(Array.from({length:25},(_,i)=>({kind:'draw',color:'#e00000',baseWidth:8,pressureSensitive:false,points:[{x:300,y:300+i*500,pressure:.5},{x:1800,y:500+i*500,pressure:.5}]})));
      await b.primeInkSnap();
      await document.fonts.ready;
    })()`);
    await sleep(2500);
    await evaluate(`(async()=>{
      window.reviewBoard.setTool('selection');
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      window.parityScene.updateScene({appState:{selectedElementIds:{'camera-parity-selection':true}}});
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    })()`);
    assert.equal(await evaluate('window.reviewBoard.getActiveTool()'), 'selection', `${mode}: selection tool not active`);
    assert.equal(await evaluate("!!document.querySelector('.lc-scene-select-box')"), true, `${mode}: missing selection`);
    assert.equal(await evaluate('window.reviewBoard.getInkOpCount()>0'), true, `${mode}: missing ink`);
    if (mode === 'notebook') assert.equal(await evaluate("!!document.querySelector('.lc-board-lined-overlay')"), true, 'Missing lined paper');
    await capture(mode, 'rest');
    const wheel = async pixels => evaluate(`(async()=>{
      const root=document.querySelector('.lc-board');
      root.dispatchEvent(new WheelEvent('wheel',{deltaY:${pixels}/1.55,clientX:700,clientY:460,bubbles:true,cancelable:true}));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    })()`);
    await wheel(300);
    await capture(mode, 'scroll-300');
    await wheel(120);
    await capture(mode, 'mid-ride');
    await sleep(16500);
    assert.equal(await evaluate("document.querySelector('.lc-ink-lab-canvas').style.transform"), '', `${mode}: camera did not settle`);
    await capture(mode, 'settled');
    await evaluate(`(async()=>{
      const root=document.querySelector('.lc-board');
      for(let i=0;i<12;i++){
        const zoom=window.reviewBoard.getViewportBounds().zoom;
        if(Math.abs(zoom-1.5)<1e-12)break;
        root.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:Math.max(-30,Math.min(30,-Math.log(1.5/zoom)*100)),clientX:700,clientY:460,bubbles:true,cancelable:true}));
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      }
    })()`);
    await sleep(1800);
    assert(Math.abs(await evaluate('window.reviewBoard.getViewportBounds().zoom') - 1.5) < 1e-12, `${mode}: did not reach zoom 1.5`);
    await capture(mode, 'zoom-1.5');
    await wheel(900);
    await sleep(1800);
    await capture(mode, 'rebase');
    await evaluate('window.setReviewOpen(true)');
    await sleep(2200);
    await capture(mode, 'split-resize');
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ revision, results, exceptions }, null, 2));
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  if (!baseline) assert(results.every(result => result.differingPixels === 0), 'Camera pixels differ; stop the refactor');
} finally {
  socket?.close();
  for (const child of children.reverse()) child.kill();
}
