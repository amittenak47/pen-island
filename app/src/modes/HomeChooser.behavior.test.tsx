/** @vitest-environment jsdom */
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {HomeChooser,type HomeChooserProps} from './HomeChooser';
import {initialTabState,type TabRecord} from '../util/tabs';
import {LIBRARY_HOLD_MS} from '../util/gesture';
import {loadRecentWorkspaces,rememberRecentWorkspace,RECENT_WORKSPACES_EVENT} from '../util/recentWorkspaces';
let root:ReturnType<typeof createRoot>,host:HTMLDivElement;
beforeEach(()=>{
  const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const entry:TabRecord={id:'old-pdf',kind:'annotate',title:'Earlier PDF',docId:null,docType:'pdf',hash:'earlier',source:null,indexed:'idle',dirty:false,lastActive:1};
function props():HomeChooserProps{return {onPractice:vi.fn(),onWhiteboard:vi.fn(),onAnnotate:vi.fn(),onBrowse:vi.fn(),onExplore:vi.fn(),onOpenRecent:vi.fn(),tabsRef:{current:initialTabState()}};}
it('opens a recent item through its callback, and removes it when it becomes an open tab',async()=>{
  rememberRecentWorkspace(entry);const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  const recent=host.querySelector<HTMLButtonElement>('.lc-home-recent')!;
  await act(async()=>recent.click());expect(p.onOpenRecent).toHaveBeenCalledWith(expect.objectContaining({hash:'earlier',title:'Earlier PDF'}));
  p.tabsRef!.current.tabs.push({...entry,id:'new-tab'});
  await act(async()=>window.dispatchEvent(new Event(RECENT_WORKSPACES_EVENT)));
  expect(host.querySelector('.lc-home-recents')).toBeNull();
  expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(0);
});
it('leaves no Recently opened section, and gives Start the full height, when nothing was opened',async()=>{
  const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  expect(host.querySelector('.lc-home-recents')).toBeNull();
  expect(host.querySelector('nav')?.getAttribute('data-recents')).toBe('none');
  expect(host.textContent).not.toContain('Recently opened');
  expect(host.textContent).not.toContain('Start');
});
it('folds Recently opened to its heading, and remembers the choice',async()=>{
  rememberRecentWorkspace(entry);const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  const toggle=host.querySelector<HTMLButtonElement>('.lc-home-recents-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(toggle.textContent).toContain('1');
  expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(1);
  expect([...host.querySelectorAll('h2')].map(h=>h.textContent)).toContain('Start');
  await act(async()=>toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(0);
  expect(host.querySelector('nav')?.getAttribute('data-recents')).toBe('collapsed');
  await act(async()=>root.unmount());root=createRoot(host);
  await act(async()=>root.render(<HomeChooser {...props()}/>));
  expect(host.querySelector('.lc-home-recents-toggle')?.getAttribute('aria-expanded')).toBe('false');
});
it('preserves all entry callbacks, including active WIP cards',async()=>{
  const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  for(const [mode,handler] of [['practice',p.onPractice],['whiteboard',p.onWhiteboard],['annotate',p.onAnnotate],['browse',p.onBrowse],['explore',p.onExplore]] as const){
    const b=host.querySelector<HTMLButtonElement>(`.lc-home-card[data-mode="${mode}"]`);
    if(b){await act(async()=>b.click());expect(handler).toHaveBeenCalledOnce();}
  }
});
it('locks entry and recent buttons while busy and enables them when ready',async()=>{
  rememberRecentWorkspace(entry);const p=props();await act(async()=>root.render(<HomeChooser {...p} busy/>));
  expect([...host.querySelectorAll('button')].every(b=>b.disabled)).toBe(true);
  await act(async()=>root.render(<HomeChooser {...p}/>));
  expect([...host.querySelectorAll('button')].every(b=>!b.disabled)).toBe(true);
  expect(p.onAnnotate).not.toHaveBeenCalled();
  expect(host.querySelector('.lc-home-recent')).not.toBeNull();
});
it('stops the live illustration loops while Home is inactive',async()=>{
  const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));expect(host.querySelectorAll('.lc-home-live-svg')).toHaveLength(2);
  await act(async()=>root.render(<HomeChooser {...p} active={false}/>));expect(host.querySelectorAll('.lc-home-live-svg')).toHaveLength(0);
});
describe('display-paced graph animation',()=>{
  let hidden:boolean,nextId:number,pending:Map<number,FrameRequestCallback>;
  let request:ReturnType<typeof vi.fn>;
  beforeEach(()=>{
    hidden=false;nextId=0;pending=new Map();
    vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
    vi.spyOn(Math,'random').mockReturnValue(.5);
    vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
    request=vi.fn((callback:FrameRequestCallback)=>{const id=++nextId;pending.set(id,callback);return id;});
    vi.stubGlobal('requestAnimationFrame',request);
    vi.stubGlobal('cancelAnimationFrame',vi.fn((id:number)=>pending.delete(id)));
  });
  afterEach(()=>vi.restoreAllMocks());
  const node=()=>host.querySelector<SVGCircleElement>('.lc-home-card[data-mode="explore"] .lc-home-graph-node')!;
  const frame=async(timestamp:number)=>act(async()=>{
    const callbacks=[...pending.values()];pending.clear();callbacks.forEach(callback=>callback(timestamp));
  });
  const visibility=async(value:boolean)=>act(async()=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));});
  const card=(mode='explore')=>host.querySelector<HTMLButtonElement>(`.lc-home-card[data-mode="${mode}"]`)!;
  const pointer=async(el:Element,type:string,pointerType='mouse')=>act(async()=>{
    const event=new MouseEvent(type,{bubbles:true,relatedTarget:document.body});
    Object.defineProperty(event,'pointerType',{value:pointerType});el.dispatchEvent(event);
  });
  it.each([60,90,120,144])('advances at the same speed while rendering every %i Hz frame',async(hz)=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));
    expect(pending.size).toBe(1);
    await frame(0);const start=Number(node().getAttribute('cx'));
    for(let i=1;i<=hz;i++) await frame(i*1000/hz);
    expect(Number(node().getAttribute('cx'))-start).toBeCloseTo(6,2);
    // One new RAF per rendered frame: no fixed 60 Hz timer or skipped high-Hz frames.
    expect(request).toHaveBeenCalledTimes(hz+2);
    expect(pending.size).toBe(1);
  });
  it.each([60,90,120,144])('moves vertices at their normal speed while boosted on a %i Hz display',async(hz)=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));
    await frame(0);const start=Number(node().getAttribute('cx'));
    await pointer(card(),'pointerover');
    for(let i=1;i<=hz;i++) await frame(i*1000/hz);
    // Hover speeds up the links, not the drift: one second moves a vertex its
    // unboosted distance, independent of the display's refresh rate.
    expect(Number(node().getAttribute('cx'))-start).toBeCloseTo(6,2);
    expect(request).toHaveBeenCalledTimes(hz+2);expect(pending.size).toBe(1);
  });
  it('does not allocate or schedule a live graph with reduced motion enabled',async()=>{
    vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
    await act(async()=>root.render(<HomeChooser {...props()}/>));
    await pointer(card(),'pointerover');
    expect(host.querySelector('.lc-home-graph')).toBeNull();expect(pending.size).toBe(0);
  });
  it('suspends hidden work and resumes one loop without aging or jumping the graph',async()=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));
    await frame(0);await frame(10);
    const circle=node(),x=circle.getAttribute('cx'),y=circle.getAttribute('cy');
    const staleCallback=[...pending.values()][0]!;
    await visibility(true);
    expect(pending.size).toBe(0);
    expect(host.querySelector('nav')?.getAttribute('data-page-visible')).toBe('false');
    staleCallback(10000);expect(pending.size).toBe(0);
    expect(circle.getAttribute('cx')).toBe(x);expect(circle.getAttribute('cy')).toBe(y);
    await visibility(false);await visibility(false);
    expect(pending.size).toBe(1);
    await frame(10000);
    expect(node()).toBe(circle);expect(circle.getAttribute('cx')).toBe(x);
    expect(host.querySelector('nav')?.getAttribute('data-page-visible')).toBe('true');
    await frame(10010);
    expect(Number(circle.getAttribute('cx'))-Number(x)).toBeCloseTo(.06,2);
  });
  it('cancels its frame and removes its graph while Home is covered or inactive',async()=>{
    const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));expect(pending.size).toBe(1);
    await act(async()=>root.render(<HomeChooser {...p} covered/>));
    expect(pending.size).toBe(0);expect(host.querySelector('.lc-home-graph')).toBeNull();
    await act(async()=>root.render(<HomeChooser {...p}/>));expect(pending.size).toBe(1);
    await act(async()=>root.render(<HomeChooser {...p} active={false}/>));
    expect(pending.size).toBe(0);expect(host.querySelector('.lc-home-graph')).toBeNull();
  });
  it('starts no graph loop when mounted hidden and cleans visibility listeners on unmount',async()=>{
    hidden=true;await act(async()=>root.render(<HomeChooser {...props()}/>));
    expect(pending.size).toBe(0);expect(request).not.toHaveBeenCalled();
    await visibility(false);expect(pending.size).toBe(1);
    await act(async()=>root.unmount());root=createRoot(host);
    expect(pending.size).toBe(0);
    const calls=request.mock.calls.length;
    await visibility(true);await visibility(false);
    expect(request).toHaveBeenCalledTimes(calls);expect(pending.size).toBe(0);
  });
  it('supercharges the live graph into connected neighbourhoods without replacing its nodes',async()=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));await frame(0);
    const layer=host.querySelector('.lc-home-graph'),circle=node();
    expect(card().dataset.boosted).toBe('false');
    await pointer(card(),'pointerover');expect(card().dataset.boosted).toBe('true');
    for(let i=1;i<=150;i++) await frame(i*1000/60);
    expect(host.querySelector('.lc-home-graph')).toBe(layer);expect(node()).toBe(circle);
    const circles=host.querySelectorAll('.lc-home-graph-node');
    const edges=[...host.querySelectorAll<SVGLineElement>('.lc-home-graph-edge')];
    expect(circles.length).toBeGreaterThan(6);expect(circles.length).toBeLessThanOrEqual(40);
    expect(edges.length).toBeGreaterThanOrEqual(10);expect(edges.length).toBeLessThanOrEqual(96);
    const neighbours=new Map<string,Set<string>>();
    for(const edge of edges){
      const a=edge.dataset.nodeA!,b=edge.dataset.nodeB!;
      if(!neighbours.has(a)) neighbours.set(a,new Set());if(!neighbours.has(b)) neighbours.set(b,new Set());
      neighbours.get(a)!.add(b);neighbours.get(b)!.add(a);
    }
    // At least one whole triangle and several multi-vertex neighbourhoods,
    // rather than many isolated two-vertex edges. Neighbourhoods are local, so
    // their size depends on how many vertices sit within each one's reach.
    expect([...neighbours].some(([,adjacent])=>[...adjacent].some(a=>
      [...adjacent].some(b=>a!==b&&neighbours.get(a)?.has(b))))).toBe(true);
    const visited=new Set<string>(),components:number[]=[];
    for(const start of neighbours.keys()){
      if(visited.has(start))continue;let size=0;const queue=[start];
      while(queue.length){const id=queue.shift()!;if(visited.has(id))continue;visited.add(id);size++;queue.push(...neighbours.get(id)??[]);}
      components.push(size);
    }
    expect(components.filter(size=>size>=3).length).toBeGreaterThanOrEqual(2);
    await pointer(card(),'pointerout');expect(card().dataset.boosted).toBe('false');
    expect(host.querySelector('.lc-home-graph')).toBe(layer);expect(pending.size).toBe(1);
  });
  it('draws boosted links one by one rather than connecting a whole neighbourhood on entry',async()=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));await frame(0);
    await pointer(card(),'pointerover');
    const known=new Set<Element>(),births:number[]=[];let first:Element|null=null;
    for(let i=1;i<=48;i++){
      await frame(i*1000/60);
      const added=[...host.querySelectorAll('.lc-home-graph-edge')].filter(edge=>!known.has(edge));
      expect(added.length).toBeLessThanOrEqual(1);
      for(const edge of added){known.add(edge);births.push(i*1000/60);first??=edge;
        expect(Number(edge.getAttribute('stroke-dashoffset'))).toBe(1);expect(Number(edge.getAttribute('opacity'))).toBe(0);}
    }
    expect(births.length).toBeGreaterThanOrEqual(4);expect(births[0]).toBeGreaterThanOrEqual(90);
    // Links still arrive one at a time, just quicker on hover.
    expect(births.slice(1).every((time,i)=>time-births[i]!>=40)).toBe(true);
    expect(Number(first!.getAttribute('stroke-dashoffset'))).toBe(0);
    expect(Number(first!.getAttribute('opacity'))).toBeGreaterThan(.8);
  });
  it('retracts individual links smoothly and preserves a partially detached link across a hidden pause',async()=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));await frame(0);await pointer(card(),'pointerover');
    for(let i=1;i<=130;i++)await frame(i*1000/60);
    const live=[...host.querySelectorAll('.lc-home-graph-edge')].filter(edge=>edge.getAttribute('stroke-dashoffset')==='0.000');
    expect(live.length).toBeGreaterThan(3);
    for(let i=131;i<=137;i++)await frame(i*1000/60);
    const retracting=live.find(edge=>edge.isConnected&&Number(edge.getAttribute('stroke-dashoffset'))>.05)!;
    expect(retracting).toBeDefined();
    const offset=retracting.getAttribute('stroke-dashoffset'),opacity=retracting.getAttribute('opacity');
    expect(Number(offset)).toBeLessThan(1);expect(Number(opacity)).toBeGreaterThan(0);
    await visibility(true);expect(pending.size).toBe(0);
    await visibility(false);await frame(20000);
    expect(retracting.getAttribute('stroke-dashoffset')).toBe(offset);expect(retracting.getAttribute('opacity')).toBe(opacity);
    await frame(20000+1000/60);expect(Number(retracting.getAttribute('stroke-dashoffset'))).toBeGreaterThan(Number(offset));
    for(let i=2;i<=30;i++)await frame(20000+i*1000/60);
    expect(retracting.isConnected).toBe(false);expect(host.querySelectorAll('.lc-home-graph-edge').length).toBeGreaterThan(0);
  });
  it('keeps separate cohorts and replaces drifting components while respecting its bounds',async()=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));await frame(0);await pointer(card(),'pointerover');
    const initial=[...host.querySelectorAll('.lc-home-graph-node')];
    for(let i=1;i<=150;i++)await frame(i*1000/60);
    const sizes=()=>{
      const adjacent=new Map<string,Set<string>>();
      for(const edge of host.querySelectorAll<SVGLineElement>('.lc-home-graph-edge')){
        if(Number(edge.getAttribute('opacity'))<.12)continue;
        const a=edge.dataset.nodeA!,b=edge.dataset.nodeB!;
        if(!adjacent.has(a))adjacent.set(a,new Set());if(!adjacent.has(b))adjacent.set(b,new Set());
        adjacent.get(a)!.add(b);adjacent.get(b)!.add(a);
      }
      const seen=new Set<string>(),result:number[]=[];
      for(const id of adjacent.keys()){
        if(seen.has(id))continue;let count=0;const queue=[id];
        while(queue.length){const next=queue.pop()!;if(seen.has(next))continue;seen.add(next);count++;queue.push(...adjacent.get(next)!);}
        result.push(count);
      }
      return result;
    };
    expect(sizes().filter(size=>size>=3).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...sizes())).toBeLessThanOrEqual(5);
    // Hover adds many vertices, so track the boosted population for departures.
    const boostedPopulation=[...host.querySelectorAll('.lc-home-graph-node')];
    for(let i=151;i<=480;i++){
      await frame(i*1000/60);
      if(i%30===0){expect(host.querySelectorAll('.lc-home-graph-node').length).toBeLessThanOrEqual(40);
        expect(host.querySelectorAll('.lc-home-graph-edge').length).toBeLessThanOrEqual(96);}
    }
    expect(boostedPopulation.some(circle=>!circle.isConnected)).toBe(true);
    expect(initial.length).toBeGreaterThan(0);
    expect([...host.querySelectorAll<SVGCircleElement>('.lc-home-graph-node')].some(circle=>Number(circle.dataset.nodeId)>10)).toBe(true);
    expect(Math.max(...sizes())).toBeLessThanOrEqual(6);
  });
  it('eases back to quiet links on leave instead of removing the whole network',async()=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));await frame(0);await pointer(card(),'pointerover');
    for(let i=1;i<=150;i++)await frame(i*1000/60);
    const layer=host.querySelector('.lc-home-graph'),before=[...host.querySelectorAll('.lc-home-graph-edge')];
    expect(before.length).toBeGreaterThan(9);await pointer(card(),'pointerout');
    expect(before.every(edge=>edge.isConnected)).toBe(true);
    await frame(2516.667);expect(before.some(edge=>edge.isConnected)).toBe(true);
    for(let i=152;i<=240;i++)await frame(i*1000/60);
    expect(host.querySelector('.lc-home-graph')).toBe(layer);expect(card().dataset.boosted).toBe('false');
    expect(host.querySelectorAll('.lc-home-graph-edge').length).toBeLessThanOrEqual(9);
    expect(host.querySelectorAll('.lc-home-graph-edge').length).toBeGreaterThan(0);expect(pending.size).toBe(1);
  });
  it('keeps the Web routes alive while adding steady and fast traffic on focus or touch',async()=>{
    await act(async()=>root.render(<HomeChooser {...props()}/>));
    const web=card('browse'),route=web.querySelector('.lc-home-net-flow');
    expect(web.dataset.boosted).toBe('false');
    await act(async()=>web.focus());expect(web.dataset.boosted).toBe('true');
    expect(web.querySelector('.lc-home-net-flow')).toBe(route);
    expect(web.querySelectorAll('.lc-home-net-stream')).toHaveLength(10);
    expect(web.querySelectorAll('.lc-home-net-burst')).toHaveLength(10);
    await act(async()=>web.blur());expect(web.dataset.boosted).toBe('false');
    // A touch does not become a sticky hover, but pressing still gives feedback.
    await pointer(web,'pointerover','touch');expect(web.dataset.boosted).toBe('false');
    await pointer(web,'pointerdown','touch');expect(web.dataset.boosted).toBe('true');
    await pointer(web,'pointercancel','touch');expect(web.dataset.boosted).toBe('false');
  });
});
it('rewinds Practice typing on a quick re-entry so the old block cannot appear inside closing brackets',async()=>{
  await act(async()=>root.render(<HomeChooser {...props()}/>));
  const practice=host.querySelector<HTMLButtonElement>('.lc-home-card[data-mode="practice"]');if(!practice)return;
  const animations=[{currentTime:1900},{currentTime:2400}],getAnimations=vi.fn(()=>animations);
  Object.defineProperty(practice.querySelector('.lc-home-live-code')!,'getAnimations',{value:getAnimations});
  await act(async()=>practice.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body})));
  expect(practice.dataset.scene).toBe('in');expect(getAnimations).not.toHaveBeenCalled();
  await act(async()=>practice.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body})));
  expect(practice.dataset.scene).toBe('out');
  await act(async()=>practice.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body})));
  expect(practice.dataset.scene).toBe('in');expect(getAnimations).toHaveBeenCalledWith({subtree:true});
  expect(animations.map(animation=>animation.currentTime)).toEqual([0,0]);
});
describe('hold to edit Recently opened',()=>{
  const second:TabRecord={...entry,id:'other-pdf',title:'Other PDF',hash:'other'};
  const press=(el:Element,type:string,x=10,y=10)=>el.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y}));
  async function mountWithTwo(){
    rememberRecentWorkspace(entry);rememberRecentWorkspace(second);
    const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
    return p;
  }
  beforeEach(()=>vi.useFakeTimers());
  afterEach(()=>vi.useRealTimers());
  it('enters edit mode on a hold, and the release that ends it does not open the item',async()=>{
    const p=await mountWithTwo();
    const item=host.querySelector('.lc-home-recent')!;
    await act(async()=>{press(item,'pointerdown');vi.advanceTimersByTime(LIBRARY_HOLD_MS + 20);});
    expect(host.querySelector('.lc-home-recents')?.hasAttribute('data-editing')).toBe(true);
    expect(host.querySelectorAll('.lc-home-recent-remove')).toHaveLength(2);
    await act(async()=>{press(item,'pointerup');(item as HTMLButtonElement).click();});
    expect(p.onOpenRecent).not.toHaveBeenCalled();
    // While editing, a tap does not open either.
    await act(async()=>(item as HTMLButtonElement).click());
    expect(p.onOpenRecent).not.toHaveBeenCalled();
  });
  it('removes only from the list, and leaves the rest',async()=>{
    await mountWithTwo();
    await act(async()=>{press(host.querySelector('.lc-home-recent')!,'pointerdown');vi.advanceTimersByTime(LIBRARY_HOLD_MS + 20);});
    const remove=host.querySelector<HTMLButtonElement>('.lc-home-recent-remove')!;
    expect(remove.getAttribute('aria-label')).toMatch(/^Remove .+ from Recently opened$/);
    await act(async()=>remove.click());
    expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(1);
    expect(loadRecentWorkspaces()).toHaveLength(1);
    // Still editing until told otherwise; removing the last one ends it.
    await act(async()=>host.querySelector<HTMLButtonElement>('.lc-home-recent-remove')!.click());
    expect(host.querySelector('.lc-home-recents')).toBeNull();
    expect(loadRecentWorkspaces()).toHaveLength(0);
  });
  it('treats a drag as scrolling the list, not a hold',async()=>{
    const p=await mountWithTwo();
    const item=host.querySelector('.lc-home-recent')!;
    await act(async()=>{press(item,'pointerdown',10,10);press(item,'pointermove',10,40);vi.advanceTimersByTime(600);});
    expect(host.querySelector('.lc-home-recents')?.hasAttribute('data-editing')).toBe(false);
    await act(async()=>{press(item,'pointerup',10,40);(item as HTMLButtonElement).click();});
    expect(p.onOpenRecent).toHaveBeenCalledOnce();
  });
  it('leaves edit mode with Done, Escape, or a tap outside the list',async()=>{
    await mountWithTwo();
    const hold=async()=>act(async()=>{press(host.querySelector('.lc-home-recent')!,'pointerdown');vi.advanceTimersByTime(LIBRARY_HOLD_MS + 20);press(host.querySelector('.lc-home-recent')!,'pointerup');});
    const editing=()=>host.querySelector('.lc-home-recents')?.hasAttribute('data-editing');
    await hold();expect(editing()).toBe(true);
    await act(async()=>host.querySelector<HTMLButtonElement>('.lc-home-recents-done')!.click());
    expect(editing()).toBe(false);
    await hold();expect(editing()).toBe(true);
    await act(async()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));});
    expect(editing()).toBe(false);
    await hold();expect(editing()).toBe(true);
    await act(async()=>press(host.querySelector('.lc-home-card')!,'pointerdown'));
    expect(editing()).toBe(false);
  });
  it('enters edit mode from the keyboard with Delete',async()=>{
    await mountWithTwo();
    const item=host.querySelector<HTMLButtonElement>('.lc-home-recent')!;
    await act(async()=>{item.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));});
    expect(host.querySelectorAll('.lc-home-recent-remove')).toHaveLength(2);
  });
});
