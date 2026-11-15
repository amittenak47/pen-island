/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardHandle } from "../BoardHandle";
import { markBootSettled } from "../../util/bootSettled";
import { glide, glideSlope, inTab, launchFor, PageTurn, rollMs, takeShot, turnPaperColor } from "./PageTurn";
import { flatSheet, paintTurn } from "./paintTurn";
import { touchPointersIn } from "../touchPointers";

// Gesture tests inspect the frame submitted to the renderer. Actual canvas
// shading is checked separately in the browser, not by jsdom's missing canvas.
vi.mock("./paintTurn", () => ({
  paintTurn: vi.fn(),
  flatSheet: vi.fn(() => [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 600 }, { x: 0, y: 600 }]),
}));

const gesture = vi.hoisted(() => ({ release: vi.fn(), protect: vi.fn() }));

// The note's kept page pictures: none unless a test hands some out, and none written.
const thumbs = vi.hoisted(() => ({
  picture: vi.fn((_key: string | null, _index: number): HTMLCanvasElement | null => null),
  keep: vi.fn(async (_key: string, _index: number, _picture: HTMLCanvasElement, _ink: string, _near?: boolean) => {}),
}));
vi.mock("./pageThumbs", async (importOriginal) => ({
  ...await importOriginal<typeof import("./pageThumbs")>(),
  thumbPicture: thumbs.picture,
  keepThumb: thumbs.keep,
}));
/** A kept picture that says which page it is of. */
const keptPicture = (key: string | null, index: number) => {
  if (!key) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 100;
  canvas.height = 150;
  canvas.dataset.page = String(index);
  return canvas;
};
vi.mock("../../util/gestureExclusion", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../util/gestureExclusion")>(),
  protectGestureSurface: gesture.protect,
}));

// Three 600-unit pages stacked; the view shows the middle one at scale 1.
const FRAMES = [
  { pageId: 1, minY: 0, maxY: 600 },
  { pageId: 2, minY: 620, maxY: 1220 },
  { pageId: 3, minY: 1240, maxY: 1840 },
];

let root: Root;
let host: HTMLDivElement;
let view = { x: 0, y: 620, width: 400, height: 600, zoom: 1 };
let pageBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
const board = {
  readingPageBox: vi.fn(() => pageBox),
  setPageFit: vi.fn(),
  zoomedIntoPage: vi.fn(() => false),
  setPageSpread: vi.fn(),
  getViewportBounds: vi.fn(() => view),
  readingPageFrames: vi.fn(() => FRAMES),
  setPageLock: vi.fn(),
  jumpToPageFrame: vi.fn((_frame: { pageId: number; minY: number; maxY: number }) => true),
  // Scene y maps straight to client y minus the view's top.
  sceneToClient: vi.fn((x: number, y: number) => ({ x, y: y - view.y })),
  captureSceneFrame: vi.fn(async () => document.createElement("canvas")),
  captureSceneMarks: vi.fn(async (): Promise<HTMLCanvasElement | null> => null),
  captureSceneQuick: vi.fn(async () => document.createElement("canvas")),
  livePageCopy: vi.fn((): HTMLElement | null => null),
  getInkRevision: vi.fn(() => 1),
  getActiveTool: vi.fn((): string => "hand"),
};

/** jsdom has no PointerEvent. */
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeEach(() => {
  markBootSettled();
  vi.mocked(paintTurn).mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  gesture.release.mockClear();
  thumbs.picture.mockReset().mockReturnValue(null);
  thumbs.keep.mockReset().mockResolvedValue(undefined);
  gesture.protect.mockReset().mockReturnValue(gesture.release);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now() + 1000), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  view = { x: 0, y: 620, width: 400, height: 600, zoom: 1 };
  pageBox = null;
  for (const fn of Object.values(board)) fn.mockClear();
  board.getActiveTool.mockReturnValue("hand");
  // A test that fails part-way must not leave its board behind for the next.
  board.readingPageFrames.mockImplementation(() => FRAMES);
  board.jumpToPageFrame.mockImplementation(() => true);
  board.captureSceneFrame.mockImplementation(async () => document.createElement("canvas"));
  board.captureSceneQuick.mockImplementation(async () => document.createElement("canvas"));
  host = document.createElement("div");
  host.dataset.lcTab = "t1";
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.textContent = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stops a pending page prefetch when focus leaves the pane", async () => {
  vi.useFakeTimers();
  let finish!: (canvas: HTMLCanvasElement) => void;
  board.captureSceneQuick.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const ref = { current: board as unknown as BoardHandle };
  const render = (enabled: boolean) => act(() => root.render(
    <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]'
      lockActive turnEnabled={enabled} spread={false} paged fit={null} />));
  render(true);
  await act(async () => vi.advanceTimersByTimeAsync(2200));
  expect(board.captureSceneQuick).toHaveBeenCalledTimes(1);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  // Several rechecks must join this job, not start another neighbour chain.
  await act(async () => vi.advanceTimersByTimeAsync(4500));
  render(false);
  await act(async () => { finish(document.createElement("canvas")); await Promise.resolve(); });
  expect(board.captureSceneQuick).toHaveBeenCalledTimes(1);
});

function mount(turnEnabled = true, fit: number | null = null, paged = true, docKey: string | null = null) {
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled={turnEnabled} spread={paged} paged={paged} fit={fit} docKey={docKey} />,
    ),
  );
  // A PDF's pages, painted: a turn to an unpainted page holds back.
  if (paged && !host.querySelector("[data-pdf-page]")) {
    for (const f of FRAMES) {
      const slot = document.createElement("div");
      slot.dataset.pdfPage = String(f.pageId);
      slot.dataset.painted = "";
      const canvas = document.createElement("canvas");
      canvas.className = "lc-pdf-canvas";
      canvas.width = 100;
      canvas.height = 150;
      slot.append(canvas);
      host.append(slot);
    }
  }
  if (!host.querySelector(".lc-page-mask-hole")) {
    const mask = document.createElement("div"); mask.className = "lc-page-mask";
    const hole = document.createElement("div"); hole.className = "lc-page-mask-hole";
    hole.getBoundingClientRect = host.getBoundingClientRect;
    mask.append(hole); host.append(mask);
  }
}

function pointer(type: string, x: number, y: number, pointerType = "touch", timeStamp?: number) {
  const event = new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType, isPrimary: true, button: 0, bubbles: true, cancelable: true });
  if (timeStamp != null) Object.defineProperty(event, "timeStamp", { value: timeStamp });
  act(() => {
    host.dispatchEvent(event);
  });
}

/** Let a turn's pictures land: a few promise turns, not a frame. */
async function pictures() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

it("holds the camera on the page in view", () => {
  mount();
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[1]);
});

it("turns to the next page when dragged past a third of the way, and lands on it", async () => {
  mount();
  const boardDown = vi.fn();
  host.addEventListener("pointerdown", boardDown);
  pointer("pointerdown", 380, 580);
  expect(boardDown).not.toHaveBeenCalled(); // the corner is the turn's, not the board's
  pointer("pointermove", 340, 585);
  pointer("pointermove", 240, 585);
  await settle();
  // The hand stops before it lets go: decided by where it is, not a throw.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  pointer("pointerup", 240, 585);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[2]);
});

it("leaves the hand to move about a page zoomed into, turning nothing", async () => {
  board.zoomedIntoPage.mockReturnValue(true);
  try {
    mount();
    const boardDown = vi.fn();
    host.addEventListener("pointerdown", boardDown);
    // At the corner, then a quick sideways throw across the page.
    pointer("pointerdown", 380, 580);
    expect(boardDown).toHaveBeenCalled();
    pointer("pointermove", 300, 582);
    pointer("pointermove", 150, 584);
    pointer("pointerup", 150, 584);
    await settle();
    expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  } finally {
    board.zoomedIntoPage.mockReturnValue(false);
  }
});

it("takes hold of the corner on touch, before the finger moves", async () => {
  const frame = manualFrames();
  mount();
  pointer("pointerdown", 380, 580);
  await act(async () => { await Promise.resolve(); });
  frame();
  const held = vi.mocked(paintTurn).mock.calls.at(-1)?.[1];
  expect(held).toBeDefined();
  expect(held!.corner.x).toBeLessThan(400);
  expect(held!.corner.x).toBeGreaterThan(360);
  pointer("pointerup", 380, 580);
  for (let i = 0; i < 4; i += 1) frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("keeps a turn taken at the corner even when the drag starts out steep", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 376, 540); // mostly upward at first
  pointer("pointermove", 200, 520);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  pointer("pointerup", 200, 520);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
});

it("turns on a flick whose moves a busy frame merged away", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  await settle();
  pointer("pointerup", 200, 580); // no pointermove reached us: only the lift
  await settle();
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
});

it("unravels back without moving when let go short of 35%", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 340, 585);
  pointer("pointermove", 270, 585);
  await settle();
  // The hand stops before it lets go: no throw.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  pointer("pointerup", 270, 585);
  await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("leaves an up-and-down drag to the board", () => {
  mount();
  const cancelled = vi.fn();
  host.addEventListener("pointercancel", cancelled);
  pointer("pointerdown", 200, 300);
  pointer("pointermove", 205, 200);
  pointer("pointermove", 150, 190);
  expect(cancelled).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("never turns under the stylus with a pen up away from a corner, nor with turning off", () => {
  board.getActiveTool.mockReturnValue("freedraw");
  mount();
  pointer("pointerdown", 390, 300, "pen");
  pointer("pointermove", 100, 305, "pen");
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  mount(false);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 100, 585);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("has nothing to turn back to on the first page", () => {
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 20, 580);
  pointer("pointermove", 200, 585);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("turns with the arrow keys", async () => {
  mount();
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  });
  await settle();
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[0], minY: FRAMES[0].minY });
});

it("fits the page while pages are held, and gives the width back after", () => {
  mount(true, 0.9);
  expect(board.setPageFit).toHaveBeenLastCalledWith(0.9);
  mount(true, 1);
  expect(board.setPageFit).toHaveBeenLastCalledWith(1);
  act(() => root.render(<></>));
  expect(board.setPageFit).toHaveBeenLastCalledWith(null);
});

it("turns only the page, not the board around it", async () => {
  // A fitted page in the middle of a wider view.
  view = { x: -200, y: 600, width: 800, height: 640, zoom: 1 };
  pageBox = { minX: 0, maxX: 400, minY: 620, maxY: 1220 };
  mount(true, 1);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 340, 585);
  await settle();
  const scene = (board.captureSceneQuick.mock.calls[0] as unknown[] | undefined)?.[0];
  expect(scene).toEqual({ x: 0, y: 620, width: 400, height: 600 });
  pointer("pointerup", 340, 585);
  await settle();
});

it("hides what lies past a text page's cut in the picture of it", async () => {
  // A text page cut at 1000 in a box a screenful high: below the cut is the
  // next page's text, which the view masks and the picture must too.
  const fills: number[][] = [];
  board.captureSceneFrame.mockImplementation(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 600;
    (canvas as unknown as { getContext: () => unknown }).getContext = () => ({
      fillStyle: "",
      fillRect: (...rect: number[]) => fills.push(rect),
    });
    return canvas;
  });
  await takeShot(new Map(), board as unknown as BoardHandle, { x: 0, y: 620, width: 400, height: 600 }, 1, 1000, "");
  // Blank from just under its cut (380 of 600 down) to the bottom, so a
  // table's line on the cut stays with the page above it.
  expect(fills).toContainEqual([0, 381, 400, 219]);
  board.captureSceneFrame.mockImplementation(async () => document.createElement("canvas"));
});

it("leaves a pinch alone: a second finger calls the turn off", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  act(() => {
    host.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, clientY: 500, pointerId: 8, pointerType: "touch", isPrimary: false, button: 0, bubbles: true }));
  });
  pointer("pointermove", 300, 585);
  pointer("pointermove", 150, 585);
  pointer("pointerup", 150, 585);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(document.querySelector(".lc-page-turn")).toBeNull();
});

it("flicks through pages: a corner touched while one lands takes hold of the next", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 }; // on the first of three pages
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  pointer("pointerup", 150, 580);
  // Back at the corner before the first sheet has finished going over.
  pointer("pointerdown", 380, 580);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  pointer("pointerup", 150, 580);
  await pictures();
  for (let i = 0; i < 4; i += 1) frame(1000);
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  expect(landed).toEqual([2, 3]);
});

it("keeps each departing page's pictures and animation alive under rapid turns", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  const first = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  pointer("pointerup", 150, 580);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame(20);
  expect(host.querySelectorAll(".lc-page-turn")).toHaveLength(2);
  const older = vi.mocked(paintTurn).mock.calls.filter(([, f]) => f.from === first.from).at(-1)![1];
  expect(older.to).toBe(first.to);
  expect(older.sheetOnly).toBe(true);
  expect(older.corner.x).toBeLessThan(first.corner.x);
  const newer = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(newer.from).toBe(first.to);
  expect(newer.to).not.toBe(first.to);
  expect(newer.sheetOnly).toBe(false);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  pointer("pointerup", 150, 580);
  for (let i = 0; i < 4; i++) frame(1000);
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => (f as { pageId: number }).pageId)).toEqual([2, 3]);
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[2]);
  expect(host.querySelectorAll(".lc-page-turn")).toHaveLength(0);
});

it("retains a released turn and the following swipe until its PDF preview paints", async () => {
  vi.useFakeTimers();
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  const destination = host.querySelector<HTMLElement>('[data-pdf-page="2"]')!;
  delete destination.dataset.painted;
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 150, 580, "touch", 1050);
  pointer("pointerup", 150, 580, "touch", 1060);
  pointer("pointerdown", 380, 580, "touch", 1100);
  pointer("pointermove", 150, 580, "touch", 1150);
  pointer("pointerup", 150, 580, "touch", 1160);
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  await act(async () => { destination.dataset.painted = ""; await Promise.resolve(); });
  for (let i = 0; i < 8; i++) {
    frame(1000);
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => (f as { pageId: number }).pageId)).toEqual([2, 3]);
});

it("keeps an entire swipe burst while its first preview is pending", async () => {
  vi.useFakeTimers();
  const frame = manualFrames();
  view = { ...view, y: 0 };
  const frames = [...FRAMES, { pageId: 4, minY: 1860, maxY: 2460 }, { pageId: 5, minY: 2480, maxY: 3080 }];
  board.readingPageFrames.mockReturnValue(frames);
  mount();
  const template = host.querySelector<HTMLElement>('[data-pdf-page="3"]')!;
  for (const pageId of [4, 5]) {
    const slot = template.cloneNode(true) as HTMLElement;
    slot.dataset.pdfPage = String(pageId);
    host.append(slot);
  }
  const destination = host.querySelector<HTMLElement>('[data-pdf-page="2"]')!;
  delete destination.dataset.painted;
  for (let i = 0; i < 4; i++) {
    pointer("pointerdown", 380, 580, "touch", 1000 + i * 100);
    pointer("pointermove", 150, 580, "touch", 1050 + i * 100);
    pointer("pointerup", 150, 580, "touch", 1060 + i * 100);
  }
  await act(async () => { destination.dataset.painted = ""; await vi.advanceTimersByTimeAsync(1); });
  for (let i = 0; i < 20; i++) {
    frame(1000);
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 3, 4, 5]);
});

it("keeps a flick that touched down while a preview was coming and moved once the sheet had set off", async () => {
  vi.useFakeTimers();
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  const destination = host.querySelector<HTMLElement>('[data-pdf-page="2"]')!;
  delete destination.dataset.painted;
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 150, 580, "touch", 1050);
  pointer("pointerup", 150, 580, "touch", 1060);
  // The next flick touches the page while that turn waits for its preview.
  pointer("pointerdown", 300, 400, "touch", 1100);
  // The preview paints; the sheet has its pictures and sets off.
  await act(async () => { destination.dataset.painted = ""; await vi.advanceTimersByTimeAsync(1); });
  frame(10);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(host.querySelector(".lc-page-turn")).not.toBeNull();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  // Only now does the flick move, and lift.
  pointer("pointermove", 150, 402, "touch", 1140);
  pointer("pointerup", 100, 402, "touch", 1160);
  for (let i = 0; i < 12; i++) {
    frame(1000);
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 3]);
});

it("continues backward sheets underneath the next returning sheet", async () => {
  const frame = manualFrames();
  view = { ...view, y: 1240 };
  mount();
  pointer("pointerdown", 20, 580, "touch", 1000);
  pointer("pointermove", 250, 580, "touch", 1100);
  await pictures();
  frame();
  const first = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  const olderCanvas = host.querySelector(".lc-page-turn")!;
  pointer("pointerup", 250, 580, "touch", 1110);
  pointer("pointerdown", 20, 580, "touch", 1200);
  pointer("pointermove", 250, 580, "touch", 1300);
  await pictures();
  frame(20);
  const newer = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(host.querySelectorAll(".lc-page-turn")[0]).toBe(olderCanvas);
  expect(newer.to).toBe(first.from);
  expect(newer.sheetOnly).toBe(true);
  expect(vi.mocked(paintTurn).mock.calls.some(([, f]) => f.from === first.from && f.corner.x > first.corner.x)).toBe(true);
  pointer("pointerup", 250, 580, "touch", 1310);
  for (let i = 0; i < 6; i++) frame(1000);
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 1]);
});

it("turns the next sheet for a caught body flick whose move events were merged", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 150, 580, "touch", 1080);
  await pictures();
  frame();
  pointer("pointerup", 150, 580, "touch", 1090);
  pointer("pointerdown", 300, 400, "touch", 1150);
  pointer("pointerup", 100, 400, "touch", 1230);
  await pictures();
  for (let i = 0; i < 6; i++) frame(1000);
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 3]);
});

it("turns the next sheet for a caught flick whose moves were merged into the one that pushed it on", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 150, 580, "touch", 1080);
  await pictures();
  frame();
  pointer("pointerup", 150, 580, "touch", 1090);
  // A busy frame: the flick comes as its touch, one move most of the way, and
  // the lift right after it, no farther along.
  pointer("pointerdown", 300, 400, "touch", 1150);
  pointer("pointermove", 90, 400, "touch", 1230);
  pointer("pointerup", 90, 400, "touch", 1231);
  await pictures();
  for (let i = 0; i < 6; i++) frame(1000);
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 3]);
});

it("cancels a pending preview when the page-turn surface leaves", async () => {
  mount();
  const destination = host.querySelector<HTMLElement>('[data-pdf-page="3"]')!;
  delete destination.dataset.painted;
  pointer("pointerdown", 380, 580);
  pointer("pointerup", 150, 580);
  mount(false);
  const captures = board.captureSceneQuick.mock.calls.length;
  await act(async () => { destination.dataset.painted = ""; await Promise.resolve(); });
  await pictures();
  expect(board.captureSceneQuick).toHaveBeenCalledTimes(captures);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(host.querySelector(".lc-page-turn")).toBeNull();
});

it("recognizes a body flick even when input only delivered its down and up", async () => {
  mount();
  pointer("pointerdown", 240, 300, "touch", 1000);
  pointer("pointerup", 120, 302, "touch", 1080);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 3 }));
});

it("preserves a consumed first touch for pinch recognition and returns the held sheet", async () => {
  const frame = manualFrames();
  mount();
  const pairs: ReturnType<typeof touchPointersIn>[] = [];
  host.addEventListener("pointerdown", () => pairs.push(touchPointersIn(host)));
  pointer("pointerdown", 380, 580);
  expect(pairs).toHaveLength(0);
  await pictures();
  act(() => host.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 8, pointerType: "touch", isPrimary: false, button: 0,
    clientX: 100, clientY: 300, bubbles: true,
  })));
  expect(pairs[0]?.size).toBe(2);
  expect(pairs[0]?.get(7)).toEqual({ x: 380, y: 580 });
  expect(host.querySelector(".lc-page-turn")).toBeNull();
  pointer("pointermove", 100, 580);
  for (let i = 0; i < 4; i++) frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("blur")));
});

it("retains the body-flick finger after cancelling one-finger handlers, ready for pinch", async () => {
  mount();
  pointer("pointerdown", 240, 300, "touch", 1000);
  pointer("pointermove", 180, 300, "touch", 1040);
  expect(touchPointersIn(host).get(7)).toEqual({ x: 180, y: 300 });
  act(() => host.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 8, pointerType: "touch", isPrimary: false, button: 0,
    clientX: 100, clientY: 300, bubbles: true,
  })));
  expect(touchPointersIn(host).size).toBe(2);
  await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("blur")));
});

it("flicks through pages: a sheet caught going over and pushed on lands, and the next one turns", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 }; // on the first of three pages
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  pointer("pointerup", 150, 580);
  // The thumb comes back inside the page, onto the rolling sheet, not the strip.
  pointer("pointerdown", 300, 400);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  pointer("pointermove", 280, 400);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  pointer("pointermove", 60, 400);
  await pictures();
  frame();
  // The new sheet starts from rest and moves with the hand: no jump to the finger.
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].corner.x).toBeCloseTo(400 - 220, 5);
  pointer("pointerup", 60, 400);
  await pictures();
  for (let i = 0; i < 4; i += 1) frame(1000);
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  expect(landed).toEqual([2, 3]);
});

it("rolls a flicked sheet over quickly, and a let-go one at an easy pace", () => {
  expect(rollMs(560, 0)).toBe(400); // 1.4 px/ms, as before
  expect(rollMs(100, 0)).toBe(240); // still seen going over
  expect(rollMs(2000, 0)).toBe(520);
  // A flick keeps its pace: far quicker than a sheet let go from a stop.
  expect(rollMs(880, 3.6)).toBeCloseTo(880 / (3.6 * 1.2), 5);
  expect(rollMs(100, 6)).toBe(120);
  for (let speed = 0; speed < 8; speed += 0.25) {
    // Faster hands never roll slower.
    expect(rollMs(600, speed + 0.25)).toBeLessThanOrEqual(rollMs(600, speed));
  }
});

it("turns on a quick flick short of halfway, and still plays the turn", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 340, 585);
  await settle(); // the pictures are in
  pointer("pointermove", 300, 585);
  pointer("pointerup", 300, 585);
  await settle();
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
});

it("lines up another turn when a key is pressed during one", async () => {
  // The board lands where it is told, as the real one does.
  board.jumpToPageFrame.mockImplementation(((frame: { minY: number }) => {
    view = { ...view, y: frame.minY };
    return true;
  }) as never);
  const key = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
  view = { ...view, y: 1240 }; // on the last page, two to go back
  mount();
  key();
  await settle();
  key();
  for (let i = 0; i < 12; i += 1) await settle();
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  board.jumpToPageFrame.mockImplementation(() => true);
  expect(landed.slice(0, 2)).toEqual([2, 1]);
});

it("shows text pages two to a spread, and turns them two at a time", async () => {
  // Four text pages; the spread (1, 2) is open, drawn in the mask's hole.
  const textFrames = [
    { pageId: 1, minY: 0, maxY: 600 },
    { pageId: 2, minY: 600, maxY: 1200 },
    { pageId: 3, minY: 1200, maxY: 1800 },
    { pageId: 4, minY: 1800, maxY: 2400 },
  ];
  board.readingPageFrames.mockReturnValue(textFrames);
  view = { x: 0, y: 0, width: 400, height: 600, zoom: 1 };
  pageBox = { minX: 0, maxX: 200, minY: 0, maxY: 600 };
  const hole = document.createElement("div");
  hole.className = "lc-page-mask-hole";
  hole.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  const mask = document.createElement("div");
  mask.className = "lc-page-mask";
  mask.append(hole);
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={1} />,
    ),
  );
  // After the first render: React empties its container when it mounts.
  host.append(mask);
  expect(board.setPageSpread).toHaveBeenLastCalledWith(true);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 6; i += 1) await settle();
  // Past the facing page: the next spread opens on page 3.
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...textFrames[2], minY: textFrames[2].minY });
  board.readingPageFrames.mockReturnValue(FRAMES);
});

it("turns a text spread at once without pictures: the next right page live under the sheet", async () => {
  const textFrames = [
    { pageId: 1, minY: 0, maxY: 600 },
    { pageId: 2, minY: 600, maxY: 1200 },
    { pageId: 3, minY: 1200, maxY: 1800 },
    { pageId: 4, minY: 1800, maxY: 2400 },
  ];
  board.readingPageFrames.mockReturnValue(textFrames);
  view = { x: 0, y: 0, width: 400, height: 600, zoom: 1 };
  pageBox = { minX: 0, maxX: 200, minY: 0, maxY: 600 };
  const copy = document.createElement("div");
  board.livePageCopy.mockReturnValue(copy);
  const hole = document.createElement("div");
  hole.className = "lc-page-mask-hole";
  hole.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  const facing = document.createElement("div");
  facing.className = "lc-page-mask-facing";
  hole.append(facing);
  const mask = document.createElement("div");
  mask.className = "lc-page-mask";
  mask.append(hole);
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={1} />,
    ),
  );
  host.append(mask);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 300, 585);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  // No page cloned and styled into a picture: that was the second's wait.
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  const under = host.querySelector<HTMLElement>(".lc-page-turn-under");
  expect(under?.contains(copy)).toBe(true);
  // The next spread's right page, in the right half.
  expect((copy.parentElement as HTMLElement).style.left).toBe("200px");
  pointer("pointermove", 20, 585);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  pointer("pointerup", 20, 585);
  for (let i = 0; i < 6; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...textFrames[2], minY: textFrames[2].minY });
  expect(host.querySelector(".lc-page-turn-under")).toBeNull();
  // The landed spread's facing page is the copy the turn showed, not a
  // picture taken on landing.
  expect(facing.contains(copy)).toBe(true);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  board.readingPageFrames.mockReturnValue(FRAMES);
  board.livePageCopy.mockReturnValue(null);
});

describe("a text spread turned live, with the facing page on the right", () => {
  const textFrames = [
    { pageId: 1, minY: 0, maxY: 600 },
    { pageId: 2, minY: 600, maxY: 1200 },
    { pageId: 3, minY: 1200, maxY: 1800 },
    { pageId: 4, minY: 1800, maxY: 2400 },
  ];
  const setUp = () => {
    board.readingPageFrames.mockReturnValue(textFrames);
    view = { x: 0, y: 0, width: 400, height: 600, zoom: 1 };
    pageBox = { minX: 0, maxX: 200, minY: 0, maxY: 600 };
    const copy = document.createElement("div");
    board.livePageCopy.mockReturnValue(copy);
    const hole = document.createElement("div");
    hole.className = "lc-page-mask-hole";
    hole.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
    const facing = document.createElement("div");
    facing.className = "lc-page-mask-facing";
    // Where the board puts it while the left page is held.
    facing.style.left = "50%";
    const shown = document.createElement("canvas");
    facing.append(shown);
    hole.append(facing);
    const mask = document.createElement("div");
    mask.className = "lc-page-mask";
    mask.append(hole);
    const ref = { current: board as unknown as BoardHandle };
    act(() =>
      root.render(
        <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={1} />,
      ),
    );
    host.append(mask);
    const added: Node[] = [];
    new MutationObserver((records) => records.forEach((r) => added.push(...r.addedNodes))).observe(facing, { childList: true });
    return { copy, facing, shown, added };
  };
  afterEach(() => {
    board.readingPageFrames.mockReturnValue(FRAMES);
    board.livePageCopy.mockReturnValue(null);
  });

  it("builds the next right page in the facing slot, and keeps it there as laid out when the spread lands", async () => {
    const { copy, facing, shown, added } = setUp();
    pointer("pointerdown", 380, 580);
    pointer("pointermove", 300, 585);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const holder = copy.parentElement as HTMLElement;
    expect(holder.parentElement).toBe(facing);
    expect(holder.style.left).toBe("0px");
    expect(host.querySelector(".lc-page-turn-under")?.contains(copy)).toBe(false);
    // Above what the slot showed, which stays for where the sheet still lies.
    expect(facing.lastElementChild).toBe(holder);
    expect(facing.contains(shown)).toBe(true);
    pointer("pointermove", 20, 585);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    pointer("pointerup", 20, 585);
    for (let i = 0; i < 6; i += 1) await settle();
    expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...textFrames[2], minY: textFrames[2].minY });
    // Landed: the same copy, never taken out and put back; the old page gone.
    expect(facing.contains(copy)).toBe(true);
    expect(facing.contains(shown)).toBe(false);
    expect(added.filter((node) => node === holder)).toHaveLength(1);
    expect(holder.style.clipPath).toBe("none");
  });

  it("takes its right page out of the facing slot when the sheet falls back", async () => {
    const { copy, facing, shown } = setUp();
    pointer("pointerdown", 380, 580);
    pointer("pointermove", 360, 582);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(facing.contains(copy)).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    pointer("pointerup", 360, 582);
    for (let i = 0; i < 8; i += 1) await settle();
    expect(board.jumpToPageFrame).not.toHaveBeenCalled();
    expect(facing.contains(copy)).toBe(false);
    expect(facing.contains(shown)).toBe(true);
  });
});

describe("flicking through a text spread", () => {
  const textFrames = Array.from({ length: 8 }, (_, i) => ({ pageId: i + 1, minY: i * 600, maxY: (i + 1) * 600 }));
  const setUp = (docKey: string | null = null) => {
    board.readingPageFrames.mockReturnValue(textFrames);
    view = { x: 0, y: 0, width: 400, height: 600, zoom: 1 };
    pageBox = { minX: 0, maxX: 200, minY: 0, maxY: 600 };
    // The camera goes where the turn lands.
    board.jumpToPageFrame.mockImplementation((frame) => { view = { ...view, y: frame.minY }; return true; });
    const copies: HTMLElement[] = [];
    board.livePageCopy.mockImplementation(() => {
      const copy = document.createElement("div");
      copies.push(copy);
      return copy;
    });
    const hole = document.createElement("div");
    hole.className = "lc-page-mask-hole";
    hole.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
    const facing = document.createElement("div");
    facing.className = "lc-page-mask-facing";
    facing.style.left = "50%";
    hole.append(facing);
    const mask = document.createElement("div");
    mask.className = "lc-page-mask";
    mask.append(hole);
    const ref = { current: board as unknown as BoardHandle };
    act(() =>
      root.render(
        <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={1} docKey={docKey} />,
      ),
    );
    host.append(mask);
    return { copies, facing };
  };
  const flick = async () => {
    pointer("pointerdown", 380, 580);
    pointer("pointermove", 300, 585);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    pointer("pointermove", 20, 585);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    pointer("pointerup", 20, 585);
    for (let i = 0; i < 4; i += 1) await settle();
  };
  const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  afterEach(() => {
    board.readingPageFrames.mockReturnValue(FRAMES);
    board.livePageCopy.mockReset().mockReturnValue(null);
  });

  it("turns the pages it goes past over plain paper, and draws only the page it stops on", async () => {
    const { copies, facing } = setUp();
    // The first turn of a run shows its page: one flick reads as it always did.
    await flick();
    expect(board.jumpToPageFrame).toHaveBeenLastCalledWith({ ...textFrames[2], minY: textFrames[2].minY });
    expect(copies).toHaveLength(1);
    expect(facing.contains(copies[0])).toBe(true);
    // Flicked on at once: no page copied and laid out for a page gone past.
    await flick();
    expect(board.jumpToPageFrame).toHaveBeenLastCalledWith({ ...textFrames[4], minY: textFrames[4].minY });
    expect(copies).toHaveLength(1);
    const passed = facing.lastElementChild as HTMLElement;
    expect(passed.childElementCount).toBe(0);
    await flick();
    expect(board.jumpToPageFrame).toHaveBeenLastCalledWith({ ...textFrames[6], minY: textFrames[6].minY });
    expect(copies).toHaveLength(1);
    expect(passed.isConnected).toBe(false);
    // The hand has stopped: the facing page it stopped on is drawn, once.
    const stopped = facing.lastElementChild as HTMLElement;
    expect(facing.childElementCount).toBe(1);
    expect(stopped.childElementCount).toBe(0);
    await wait(450);
    expect(copies).toHaveLength(2);
    expect(stopped.contains(copies[1])).toBe(true);
    await wait(400);
    expect(copies).toHaveLength(2);
  });

  it("turns the pages it goes past over their kept pictures, the sheet's back too, and draws the page it stops on in place of its picture", async () => {
    thumbs.picture.mockImplementation(keptPicture);
    const { copies, facing } = setUp("doc");
    await flick();
    expect(copies).toHaveLength(1);
    vi.mocked(paintTurn).mockClear();
    thumbs.picture.mockClear();
    // Flicked on at once: the right page coming into view is its kept picture.
    await flick();
    expect(copies).toHaveLength(1);
    const passed = facing.lastElementChild as HTMLElement;
    expect(passed.querySelector("canvas.lc-page-turn-thumb")).not.toBeNull();
    expect(thumbs.picture).toHaveBeenCalledWith(expect.any(String), 5);
    // The back of the lifting sheet is the page that lands on the left: the
    // turn's own copy of its picture.
    const back = vi.mocked(paintTurn).mock.calls.at(-1)![1].back as HTMLCanvasElement;
    expect(thumbs.picture).toHaveBeenCalledWith(expect.any(String), 4);
    expect([back.width, back.height]).toEqual([100, 150]);
    // Stopped: the page is drawn, and its picture goes from under it.
    await wait(450);
    expect(copies).toHaveLength(2);
    expect(passed.contains(copies[1])).toBe(true);
    expect(passed.querySelector("canvas.lc-page-turn-thumb")).toBeNull();
  });

  it("pictures the note's pages small while the reader rests, from here outward, and only once", async () => {
    // A picture the size it was asked for.
    const sized = async (scene: { width: number; height: number }, scale: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(scene.width * scale);
      canvas.height = Math.round(scene.height * scale);
      return canvas;
    };
    board.captureSceneFrame.mockImplementation(sized as unknown as () => Promise<HTMLCanvasElement>);
    setUp("doc");
    await vi.waitFor(() => expect(thumbs.keep).toHaveBeenCalledTimes(8), { timeout: 5000, interval: 50 });
    expect(thumbs.keep.mock.calls.map(([, index]) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The open spread and the next were pictured for turning already, and
    // are shrunk; the four pages further on are taken at thumb size, in one
    // picture of them all.
    const thumbScale = board.captureSceneFrame.mock.calls.filter((call) => (call as unknown[])[1] === 0.5);
    expect(thumbScale.map((call) => (call as unknown[])[0])).toEqual([{ x: 0, y: 2400, width: 200, height: 2400 }]);
    expect(thumbs.keep.mock.calls.every(([, , picture]) => picture.width === 100 && picture.height === 300)).toBe(true);
    // Every page pictured and no ink since: the next rest takes none.
    await wait(1700);
    expect(thumbs.keep).toHaveBeenCalledTimes(8);
  });

  it("waits for the finger to leave the glass before drawing the page it stopped on", async () => {
    const { copies, facing } = setUp();
    await flick();
    await flick();
    const stopped = facing.lastElementChild as HTMLElement;
    expect(copies).toHaveLength(1);
    // A finger resting on the page body, not turning.
    pointer("pointerdown", 100, 300);
    await wait(500);
    expect(copies).toHaveLength(1);
    pointer("pointerup", 100, 300);
    await wait(150);
    expect(copies).toHaveLength(1);
    await wait(300);
    expect(copies).toHaveLength(2);
    expect(stopped.contains(copies[1])).toBe(true);
  });

  it("lays glass over the page text while flicking through, off soon after it lands and for a press that turns nothing", async () => {
    setUp();
    // The board, with the note's text in its slot.
    const surface = document.createElement("div");
    surface.className = "lc-board";
    const text = document.createElement("div");
    text.className = "lc-page-content-slot";
    surface.append(text);
    host.prepend(surface);
    text.classList.add("lc-page-content-selectable");
    // Text being marked takes its own touches: never under glass.
    surface.classList.add("lc-board-highlighting");
    await flick();
    expect(surface.dataset.turnGlass).toBeUndefined();
    surface.classList.remove("lc-board-highlighting");
    await flick();
    // Landed: the next touch ends on the board at once.
    expect(surface.dataset.turnGlass).toBe("on");
    // A tap turns nothing: off, so whatever handles it finds the text.
    pointer("pointerdown", 100, 300);
    expect(surface.dataset.turnGlass).toBe("on");
    pointer("pointerup", 100, 300);
    expect(surface.dataset.turnGlass).toBe("");
    await flick();
    expect(surface.dataset.turnGlass).toBe("on");
    // Flicked back, and the hand rests.
    pointer("pointerdown", 20, 580);
    pointer("pointermove", 100, 585);
    await wait(50);
    pointer("pointermove", 380, 585);
    await wait(60);
    pointer("pointerup", 380, 585);
    for (let i = 0; i < 4; i += 1) await settle();
    expect(board.jumpToPageFrame).toHaveBeenLastCalledWith({ ...textFrames[4], minY: textFrames[4].minY });
    expect(surface.dataset.turnGlass).toBe("on");
    await wait(100);
    expect(surface.dataset.turnGlass).toBe("on");
    await wait(250);
    expect(surface.dataset.turnGlass).toBe("");
    await flick();
    expect(surface.dataset.turnGlass).toBe("on");
    // Turning off goes with it.
    const ref = { current: board as unknown as BoardHandle };
    act(() =>
      root.render(
        <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled={false} spread paged={false} fit={1} />,
      ),
    );
    expect(surface.dataset.turnGlass).toBeUndefined();
  });
});

it("turns single text pages flicked through over plain paper: the board shows the page once it lands", async () => {
  board.readingPageFrames.mockReturnValue([...FRAMES, { pageId: 4, minY: 1860, maxY: 2460 }]);
  board.jumpToPageFrame.mockImplementation((frame) => { view = { ...view, y: frame.minY }; return true; });
  board.livePageCopy.mockImplementation(() => document.createElement("div"));
  mount(true, null, false);
  const flick = async () => {
    pointer("pointerdown", 380, 300);
    pointer("pointermove", 300, 300);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    pointer("pointermove", 20, 300);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    pointer("pointerup", 20, 300);
    for (let i = 0; i < 6; i += 1) await settle();
  };
  await flick();
  expect(board.jumpToPageFrame).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 3 }));
  expect(board.livePageCopy).toHaveBeenCalledTimes(1);
  await flick();
  expect(board.jumpToPageFrame).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 4 }));
  expect(board.livePageCopy).toHaveBeenCalledTimes(1);
  board.livePageCopy.mockReset().mockReturnValue(null);
});

it("turns a single text page flicked past over the part of its kept picture the view shows", async () => {
  board.readingPageFrames.mockReturnValue([...FRAMES, { pageId: 4, minY: 1860, maxY: 2460 }]);
  board.jumpToPageFrame.mockImplementation((frame) => { view = { ...view, y: frame.minY }; return true; });
  board.livePageCopy.mockImplementation(() => document.createElement("div"));
  pageBox = { minX: 0, maxX: 400, minY: 620, maxY: 1220 };
  thumbs.picture.mockImplementation(keptPicture);
  mount(true, null, false, "doc");
  const flick = async () => {
    pointer("pointerdown", 380, 300);
    pointer("pointermove", 300, 300);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    pointer("pointermove", 20, 300);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    pointer("pointerup", 20, 300);
    for (let i = 0; i < 6; i += 1) await settle();
  };
  await flick();
  vi.mocked(paintTurn).mockClear();
  await flick();
  expect(board.jumpToPageFrame).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 4 }));
  expect(board.livePageCopy).toHaveBeenCalledTimes(1);
  // Page 4's picture, 100 by 150 for its 400 by 600 box, not a full-size sheet of paper.
  const to = vi.mocked(paintTurn).mock.calls.at(-1)![1].to as HTMLCanvasElement;
  expect([to.width, to.height]).toEqual([100, 150]);
  expect(thumbs.picture).toHaveBeenCalledWith(expect.any(String), 3);
  board.livePageCopy.mockReset().mockReturnValue(null);
});

it("keeps the canvas frame protected when annotation takes over in Pages mode", () => {
  mount(true);
  expect(gesture.protect).toHaveBeenCalledWith(host, expect.any(Function));
  mount(false);
  expect(gesture.release).not.toHaveBeenCalled();
  expect(gesture.protect).toHaveBeenCalledTimes(1);
  expect(gesture.protect.mock.calls[0][1]()).toHaveLength(4);
  expect(host.hasAttribute("data-reading-pages")).toBe(true);
});


it("keeps PDF backs light in dark palettes, preserving text and light palettes", () => {
  expect(turnPaperColor("#101820", true)).toBe("#ffffff");
  expect(turnPaperColor("rgb(32, 36, 40)", true)).toBe("#ffffff");
  expect(turnPaperColor("#f5f0e8", true)).toBe("#f5f0e8");
  expect(turnPaperColor("#101820", false)).toBe("#101820");
});

it("turns from the middle of either side strip", async () => {
  mount();
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 160, 300);
  pointer("pointerup", 160, 300);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalled();
});

it("holds a sheet taken by its side where the finger took it, and a corner by its corner", async () => {
  mount();
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 300, 300);
  await settle();
  const side = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(side.restY).toBe(300);
  expect(side.corner.y).toBeCloseTo(300, 5);
  pointer("pointerup", 380, 300);
  await settle();
  vi.mocked(paintTurn).mockClear();
  pointer("pointerdown", 392, 592);
  pointer("pointermove", 300, 592);
  await settle();
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].restY).toBe(600);
  pointer("pointerup", 392, 592);
  await settle();
});

it("keeps a sheet held by its side from tilting with every wobble of the hand", async () => {
  mount();
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 200, 360);
  await settle();
  const frame = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  // 60 px of drift moves the held point 12: the fold stays near upright.
  expect(frame.corner.y).toBeCloseTo(312, 5);
  pointer("pointerup", 200, 360);
  await settle();
});

it("takes no pictures of a text page on the grab: the sheet lifts at once over the live page", async () => {
  mount(true, null, false);
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 300, 300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  // Taking them is cloning and styling the page: most of a second on the tablet.
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].from).toBeNull();
  pointer("pointerup", 300, 300);
  await settle();
});


it("turns a text page over its live copy while the next page has no picture", async () => {
  const copy = document.createElement("div");
  const marks = document.createElement("canvas");
  board.livePageCopy.mockReturnValueOnce(copy);
  board.captureSceneMarks.mockResolvedValueOnce(marks);
  board.captureSceneFrame
    .mockImplementationOnce(async () => document.createElement("canvas"))
    .mockImplementationOnce(() => new Promise(() => {}));
  mount(true, null, false);
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 300, 300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  const under = host.querySelector<HTMLElement>(".lc-page-turn-under");
  expect(under?.contains(copy)).toBe(true);
  expect(under?.contains(marks)).toBe(true);
  // Nothing painted where the next page shows: the live copy is that page.
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].to).toBeNull();
  expect(vi.mocked(flatSheet)).toHaveBeenCalled();
  pointer("pointerup", 300, 300);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(document.querySelector(".lc-page-turn")).toBeNull();
  expect(host.querySelector(".lc-page-turn-under")).toBeNull();
});

it("holds a PDF on its page when the next one has nothing painted yet", async () => {
  mount();
  host.querySelector<HTMLElement>('[data-pdf-page="3"]')!.removeAttribute("data-painted");
  pointer("pointerdown", 390, 300, "touch", 1000);
  pointer("pointermove", 300, 300, "touch", 1030);
  pointer("pointermove", 150, 300, "touch", 1060);
  pointer("pointerup", 150, 300, "touch", 1070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("leaves the page body to a slow drag and to a swipe up or down", async () => {
  mount();
  // Sideways, but slowly: a selection or a pan.
  pointer("pointerdown", 250, 300, "touch", 1000);
  pointer("pointermove", 140, 305, "touch", 1600);
  pointer("pointerup", 140, 305, "touch", 1650);
  // Quick, but mostly up the page.
  pointer("pointerdown", 200, 400, "touch", 3000);
  pointer("pointermove", 170, 300, "touch", 3060);
  pointer("pointerup", 170, 300, "touch", 3080);
  await settle();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("takes hold for a slow drag inward from within a strip's reach", async () => {
  mount();
  // Slower than any flick, and starting a little short of the strip.
  pointer("pointerdown", 330, 300, "touch", 1000);
  pointer("pointermove", 326, 301, "touch", 1300);
  pointer("pointermove", 318, 302, "touch", 1600);
  pointer("pointermove", 100, 305, "touch", 2400);
  pointer("pointerup", 100, 305, "touch", 2600);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 3 }));
});

it("leaves a drag up or down within a strip's reach to the page", async () => {
  mount();
  pointer("pointerdown", 330, 300, "touch", 1000);
  pointer("pointermove", 328, 330, "touch", 1200);
  pointer("pointermove", 300, 340, "touch", 1600);
  pointer("pointerup", 300, 340, "touch", 1650);
  await settle();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("keeps a turn under way when the hand holding the tablet touches the glass", async () => {
  mount();
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 300, 585, "touch", 1100);
  const heel = new PointerEvent("pointerdown", { clientX: 390, clientY: 700, pointerId: 8, pointerType: "touch", isPrimary: false, button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(heel, "timeStamp", { value: 1150 });
  const reached = vi.fn();
  host.addEventListener("pointerdown", reached);
  act(() => { host.dispatchEvent(heel); });
  host.removeEventListener("pointerdown", reached);
  // Nothing under the page (a pinch, a pan) hears of it.
  expect(reached).not.toHaveBeenCalled();
  expect(heel.defaultPrevented).toBe(true);
  pointer("pointermove", 150, 585, "touch", 1200);
  pointer("pointerup", 150, 585, "touch", 1250);
  act(() => { host.dispatchEvent(new PointerEvent("pointerup", { clientX: 390, clientY: 700, pointerId: 8, pointerType: "touch", isPrimary: false, button: 0, bubbles: true })); });
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
});

it("turns the page for a quick sideways flick from anywhere on it", async () => {
  mount();
  pointer("pointerdown", 220, 300, "touch", 1000);
  pointer("pointermove", 180, 302, "touch", 1030);
  pointer("pointermove", 120, 304, "touch", 1060);
  pointer("pointerup", 120, 304, "touch", 1070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 3 }));
});

it("leaves a flick on a wide equation to it, without searching the note for one each time", async () => {
  mount();
  const surface = document.createElement("div");
  surface.className = "lc-board";
  const doc = document.createElement("div");
  doc.className = "lc-md-ink-doc";
  const wide = document.createElement("span");
  wide.className = "katex-display";
  wide.style.overflowX = "auto";
  Object.defineProperty(wide, "scrollWidth", { value: 600 });
  Object.defineProperty(wide, "clientWidth", { value: 300 });
  wide.getBoundingClientRect = () => ({ left: 100, right: 400, top: 250, bottom: 350, width: 300, height: 100, x: 100, y: 250, toJSON() {} }) as DOMRect;
  doc.append(wide);
  surface.append(doc);
  host.append(surface);
  const search = vi.spyOn(doc, "querySelectorAll");
  const flick = (y: number, at: number) => {
    pointer("pointerdown", 220, y, "touch", at);
    pointer("pointermove", 180, y + 2, "touch", at + 30);
    pointer("pointermove", 120, y + 4, "touch", at + 60);
    pointer("pointerup", 120, y + 4, "touch", at + 70);
  };
  // On the equation, twice: it scrolls sideways, and the page stays.
  flick(300, 1000);
  flick(300, 2000);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  // The board's list of boxes that scroll is used, not a search of the note per flick.
  expect(search.mock.calls.length).toBeLessThanOrEqual(1);
  // Off it, the page turns.
  flick(500, 3000);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 3 }));
});

it("keeps an element found in the tab while it stays there and matches", () => {
  const find = inTab('[data-lc-tab="t1"]', ".lc-page-mask-facing");
  const first = document.createElement("div");
  first.className = "lc-page-mask-facing";
  host.append(first);
  const search = vi.spyOn(host, "querySelector");
  expect(find()).toBe(first);
  expect(find()).toBe(first);
  expect(search).toHaveBeenCalledTimes(1);
  first.remove();
  const second = document.createElement("div");
  second.className = "lc-page-mask-facing";
  host.append(second);
  expect(find()).toBe(second);
  second.className = "lc-page-mask-hole";
  expect(find()).toBeNull();
});

it("turns back for a quick flick to the right from the middle of the page", async () => {
  mount();
  pointer("pointerdown", 160, 300, "touch", 1000);
  pointer("pointermove", 200, 302, "touch", 1030);
  pointer("pointermove", 260, 304, "touch", 1060);
  pointer("pointerup", 260, 304, "touch", 1070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 1 }));
});

it("goes over for a short quick flick at the edge, and back for the same distance slowly", async () => {
  mount();
  pointer("pointerdown", 390, 300, "touch", 1000);
  pointer("pointermove", 370, 300, "touch", 1020);
  pointer("pointermove", 350, 300, "touch", 1040);
  pointer("pointerup", 350, 300, "touch", 1045);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  board.jumpToPageFrame.mockClear();
  pointer("pointerdown", 390, 300, "touch", 5000);
  pointer("pointermove", 370, 300, "touch", 5200);
  pointer("pointermove", 350, 300, "touch", 5400);
  pointer("pointerup", 350, 300, "touch", 5600);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("turns with a stylus while no pen is up, and leaves it to write with one", async () => {
  mount();
  board.getActiveTool.mockReturnValue("freedraw");
  pointer("pointerdown", 390, 300, "pen");
  pointer("pointermove", 100, 300, "pen");
  pointer("pointerup", 100, 300, "pen");
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  board.getActiveTool.mockReturnValue("hand");
  pointer("pointerdown", 390, 300, "pen");
  pointer("pointermove", 100, 300, "pen");
  pointer("pointerup", 100, 300, "pen");
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
});

it.each(["freedraw", "highlighter", "eraser", "rectangle"])("lets the stylus peel a corner with %s up", async (tool) => {
  board.getActiveTool.mockReturnValue(tool);
  mount();
  const boardDown = vi.fn();
  host.addEventListener("pointerdown", boardDown);
  pointer("pointerdown", 380, 580, "pen");
  expect(boardDown).not.toHaveBeenCalled(); // the corner is the turn's, not the ink's
  pointer("pointermove", 340, 585, "pen");
  pointer("pointermove", 240, 585, "pen");
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  pointer("pointerup", 240, 585, "pen");
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
});

it("leaves the side strip outside the corner and a flick on the body to a stylus writing", async () => {
  board.getActiveTool.mockReturnValue("freedraw");
  mount();
  const boardDown = vi.fn();
  host.addEventListener("pointerdown", boardDown);
  // In the right strip, well clear of either corner: a note in the margin.
  pointer("pointerdown", 390, 300, "pen", 1000);
  pointer("pointermove", 300, 302, "pen", 1030);
  pointer("pointermove", 100, 304, "pen", 1060);
  pointer("pointerup", 100, 304, "pen", 1070);
  // A quick sideways stroke from the body, which a finger would turn with.
  pointer("pointerdown", 220, 300, "pen", 3000);
  pointer("pointermove", 180, 302, "pen", 3030);
  pointer("pointermove", 120, 304, "pen", 3060);
  pointer("pointerup", 120, 304, "pen", 3070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(boardDown).toHaveBeenCalledTimes(2);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("keeps the stylus turning from the strip and the body with the hand up", async () => {
  board.getActiveTool.mockReturnValue("hand");
  mount();
  pointer("pointerdown", 220, 300, "pen", 1000);
  pointer("pointermove", 180, 302, "pen", 1030);
  pointer("pointermove", 120, 304, "pen", 1060);
  pointer("pointerup", 120, 304, "pen", 1070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 3 }));
});

it.each([
  ["freedraw", 395, 300, true],
  ["freedraw", 390, 590, false],
  ["hand", 395, 300, false],
] as const)("with %s up, a stylus at (%i, %i) on the facing page takes it: %s", (tool, x, y, takes) => {
  board.getActiveTool.mockReturnValue(tool);
  const hole = document.createElement("div");
  hole.className = "lc-page-mask-hole";
  hole.getBoundingClientRect = host.getBoundingClientRect;
  const facing = document.createElement("div");
  facing.className = "lc-page-mask-facing";
  facing.getBoundingClientRect = () => ({ left: 200, top: 0, width: 200, height: 600, right: 400, bottom: 600, x: 200, y: 0, toJSON() {} });
  hole.append(facing);
  const mask = document.createElement("div");
  mask.className = "lc-page-mask";
  mask.append(hole);
  const ref = { current: board as unknown as BoardHandle };
  act(() => root.render(
    <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={null} />,
  ));
  host.append(mask);
  board.setPageLock.mockClear();
  pointer("pointerdown", x, y, "pen");
  if (takes) expect(board.setPageLock).toHaveBeenCalledWith(FRAMES[0]);
  else expect(board.setPageLock).not.toHaveBeenCalledWith(FRAMES[0]);
});

it("shows a hovering stylus the edge it can take hold of", () => {
  const hole = () => host.querySelector<HTMLElement>(".lc-page-mask-hole")!;
  const hover = (x: number, y: number, pointerType: string) => pointer("pointermove", x, y, pointerType);
  mount();
  hover(390, 300, "mouse");
  expect(hole().dataset.turnHover).toBe("right");
  hover(200, 300, "pen");
  expect(hole().dataset.turnHover).toBeUndefined();
  hover(390, 300, "pen");
  expect(hole().dataset.turnHover).toBe("right");
  // With a pen up, the strip is for writing and only the corner lights.
  board.getActiveTool.mockReturnValue("freedraw");
  hover(390, 300, "pen");
  expect(hole().dataset.turnHover).toBeUndefined();
  hover(10, 590, "pen");
  expect(hole().dataset.turnHover).toBe("left");
  // Lifted out of range, nothing stays lit.
  act(() => { host.dispatchEvent(new PointerEvent("pointerout", { pointerType: "pen", bubbles: true })); });
  expect(hole().dataset.turnHover).toBeUndefined();
});

function manualFrames() {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    callbacks.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
  return (ahead = 0) => act(() => {
    const batch = [...callbacks.values()];
    callbacks.clear();
    for (const cb of batch) cb(performance.now() + ahead);
  });
}

it.each(["next", "prev"] as const)("catches a settling %s turn without a jump, then pulls it back", async (direction) => {
  const frame = manualFrames();
  mount();
  const start = direction === "next" ? 380 : 20;
  const dragged = direction === "next" ? 150 : 250;
  pointer("pointerdown", start, 580);
  pointer("pointermove", dragged, 580);
  await act(async () => { await Promise.resolve(); });
  frame();
  const before = { ...vi.mocked(paintTurn).mock.calls.at(-1)![1].corner };
  const captures = board.captureSceneFrame.mock.calls.length;
  pointer("pointerup", dragged, 580);
  pointer("pointerdown", 200, 300);
  // The previous animation callback must not land while the sheet is held.
  frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  pointer("pointermove", 200, 300);
  frame();
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].corner).toEqual(before);
  const back = direction === "next" ? 380 : 20;
  pointer("pointermove", back, 300);
  pointer("pointerup", back, 300);
  frame(1000);
  frame(1000);
  frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).toHaveBeenCalledTimes(captures);
  expect(document.querySelector(".lc-page-turn")).toBeNull();
});

it("reverses the settling direction with the opposite arrow and can finish again", async () => {
  const frame = manualFrames();
  mount();
  const key = (key: string) => act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  key("ArrowRight");
  await act(async () => { await Promise.resolve(); });
  frame(60);
  key("ArrowLeft");
  // Both callbacks are pending: only the latest animation may land.
  frame(20);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  key("ArrowRight");
  frame(1000);
  frame(1000);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[2]);
});

it("keeps toolbar clicks and pen input available while a sheet settles", async () => {
  const frame = manualFrames();
  board.getActiveTool.mockReturnValue("freedraw");
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await act(async () => { await Promise.resolve(); });
  pointer("pointerup", 150, 580);
  const button = document.createElement("button");
  const click = vi.fn();
  button.addEventListener("click", click);
  host.append(button);
  button.click();
  expect(click).toHaveBeenCalledOnce();
  pointer("pointerdown", 200, 300, "pen");
  frame(1000);
  expect(board.jumpToPageFrame).toHaveBeenCalledOnce();
});

it("cancels the newest caught sheet while the earlier turn finishes", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  const key = () => act(() => window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
  ));
  key();
  await act(async () => { await Promise.resolve(); });
  frame(60);
  key(); // the first sheet continues while the next becomes catchable
  await pictures();
  pointer("pointerdown", 200, 300);
  pointer("pointercancel", 200, 300);
  for (let i = 0; i < 5; i++) frame(1000);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  expect(board.jumpToPageFrame).toHaveBeenLastCalledWith(FRAMES[1]);
  expect(document.querySelector(".lc-page-turn")).toBeNull();
});

it("rolls a released sheet smoothly from the hand's pace to rest", () => {
  for (const launch of [0, 1, 2.5]) {
    expect(glide(0, launch)).toBe(0);
    expect(glide(1, launch)).toBeCloseTo(1, 10);
    let last = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const k = glide(t, launch);
      expect(k).toBeGreaterThanOrEqual(last - 1e-9); // never runs backwards
      expect(k).toBeLessThanOrEqual(1 + 1e-9); // never overshoots
      last = k;
    }
    // Leaves at the given multiple of its average pace, and arrives at rest.
    expect(glide(0.001, launch) / 0.001).toBeCloseTo(launch, 1);
    expect((1 - glide(0.999, launch)) / 0.001).toBeLessThan(0.05);
  }
});

it("hands a hurried sheet on at the pace it had", () => {
  // A roll leaves at its launch and comes to rest at the end.
  expect(glideSlope(0, 1.5)).toBeCloseTo(1.5, 5);
  expect(glideSlope(1, 1.5)).toBeCloseTo(0, 5);
  // 200 px to go at 2 px/ms, re-timed to 110 ms: 1.1 times the new average pace.
  expect(launchFor(-2, -200, 110)).toBeCloseTo(1.1, 5);
  // Moving the other way, it leaves from a stop; far faster is capped.
  expect(launchFor(2, -200, 110)).toBe(0);
  expect(launchFor(-20, -200, 110)).toBe(2.5);
});

it("forgets a picture that was called off, and takes it again the next time", async () => {
  const shots = new Map<string, Promise<HTMLCanvasElement | null>>();
  const stop = new AbortController();
  board.captureSceneFrame.mockImplementationOnce(async () => {
    stop.abort();
    throw new DOMException("called off", "AbortError");
  });
  const scene = { x: 0, y: 0, width: 200, height: 600 };
  const b = board as unknown as BoardHandle;
  expect(await takeShot(shots, b, scene, 1, Infinity, "", false, false, stop.signal)).toBeNull();
  expect((board.captureSceneFrame.mock.calls[0] as unknown[])[2]).toEqual({ signal: stop.signal });
  expect(shots.size).toBe(0);
  expect(await takeShot(shots, b, scene, 1, Infinity, "")).not.toBeNull();
  expect(board.captureSceneFrame).toHaveBeenCalledTimes(2);
});

it("hurries a live spread's sheet to land when the next flick comes, then turns the next one", async () => {
  const frame = manualFrames();
  const textFrames = [1, 2, 3, 4, 5, 6].map((pageId, i) => ({ pageId, minY: i * 600, maxY: i * 600 + 600 }));
  board.readingPageFrames.mockReturnValue(textFrames);
  view = { x: 0, y: 0, width: 400, height: 600, zoom: 1 };
  pageBox = { minX: 0, maxX: 200, minY: 0, maxY: 600 };
  board.livePageCopy.mockImplementation(() => document.createElement("div"));
  const hole = document.createElement("div");
  hole.className = "lc-page-mask-hole";
  hole.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  const mask = document.createElement("div");
  mask.className = "lc-page-mask";
  mask.append(hole);
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={1} />,
    ),
  );
  host.append(mask);
  // Peeled from the corner and let go a quarter of the way over: it rolls on.
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 340, 585, "touch", 1040);
  await pictures();
  frame();
  pointer("pointermove", 300, 585, "touch", 1080);
  pointer("pointerup", 300, 585, "touch", 1090);
  frame();
  expect(host.querySelector(".lc-page-turn")).not.toBeNull();
  // The next flick, from the middle of the page, while that sheet is still going over.
  pointer("pointerdown", 300, 300, "touch", 1100);
  // Not put down at once: that was the jump.
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  pointer("pointermove", 200, 302, "touch", 1130);
  pointer("pointerup", 120, 302, "touch", 1160);
  // Still going over, and seen to: halfway through its hurry it is between where it was let go and the spine's far side.
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  vi.mocked(paintTurn).mockClear();
  frame(60);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  const between = vi.mocked(paintTurn).mock.calls.at(-1)![1].corner.x;
  expect(between).toBeLessThan(100);
  expect(between).toBeGreaterThan(-200);
  // A quarter-turn left took 240 ms; hurried, it is down well inside 150.
  frame(150);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  expect(board.jumpToPageFrame).toHaveBeenLastCalledWith({ ...textFrames[2], minY: textFrames[2].minY });
  // The flick's turn plays from the spread it landed on.
  for (let i = 0; i < 6; i += 1) {
    await pictures();
    frame(1000);
  }
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  expect(landed).toEqual([3, 5]);
  board.readingPageFrames.mockReturnValue(FRAMES);
  board.livePageCopy.mockReset().mockReturnValue(null);
});

it("keeps a flick from the strip that comes while a lined-up turn is still being set up", async () => {
  const frame = manualFrames();
  const textFrames = [1, 2, 3, 4, 5, 6, 7, 8].map((pageId, i) => ({ pageId, minY: i * 600, maxY: i * 600 + 600 }));
  board.readingPageFrames.mockReturnValue(textFrames);
  view = { x: 0, y: 0, width: 400, height: 600, zoom: 1 };
  pageBox = { minX: 0, maxX: 200, minY: 0, maxY: 600 };
  board.livePageCopy.mockImplementation(() => document.createElement("div"));
  const hole = document.createElement("div");
  hole.className = "lc-page-mask-hole";
  hole.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  const mask = document.createElement("div");
  mask.className = "lc-page-mask";
  mask.append(hole);
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={1} />,
    ),
  );
  host.append(mask);
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 340, 585, "touch", 1040);
  await pictures();
  frame();
  pointer("pointermove", 300, 585, "touch", 1080);
  pointer("pointerup", 300, 585, "touch", 1090);
  frame();
  // A flick on the page while that sheet goes over: lined up.
  pointer("pointerdown", 300, 300, "touch", 1100);
  pointer("pointermove", 200, 302, "touch", 1120);
  pointer("pointerup", 150, 302, "touch", 1140);
  // A thumb on the strip, before the sheet is down.
  pointer("pointerdown", 392, 300, "touch", 1200);
  // The sheet lands, and the lined-up turn is set up: not yet holding its pages.
  frame(150);
  frame();
  // The thumb's flick comes now. It used to be dropped here.
  pointer("pointermove", 300, 300, "touch", 1230);
  pointer("pointerup", 200, 300, "touch", 1250);
  for (let i = 0; i < 10; i += 1) {
    await pictures();
    frame(1000);
  }
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  expect(landed).toEqual([3, 5, 7]);
  board.readingPageFrames.mockReturnValue(FRAMES);
  board.livePageCopy.mockReset().mockReturnValue(null);
});

describe("switching a text document from scroll reading to Pages", () => {
  // A long note cut into 14 text pages of 600 units: spread 6 is pages 11 and 12.
  const textFrames = Array.from({ length: 14 }, (_, i) => ({ pageId: i + 1, minY: i * 600, maxY: (i + 1) * 600 }));
  const ref = { current: board as unknown as BoardHandle };
  const render = (lockActive: boolean) => act(() => root.render(
    <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive={lockActive} turnEnabled={lockActive} spread paged={false} fit={1} />,
  ));

  beforeEach(() => {
    vi.useFakeTimers();
    board.readingPageFrames.mockReturnValue(textFrames);
  });

  it("holds the first page when scroll reading is at the very top", () => {
    view = { x: 0, y: -5, width: 400, height: 600, zoom: 1 };
    render(false);
    render(true);
    expect(board.setPageLock).toHaveBeenLastCalledWith(textFrames[0]);
  });

  it("holds the page in the middle of the view further down", () => {
    view = { x: 0, y: 3100, width: 400, height: 600, zoom: 1 };
    render(false);
    render(true);
    expect(board.setPageLock).toHaveBeenLastCalledWith(textFrames[5]);
  });

  it("does not go back to the page held before scroll reading", async () => {
    // Pages reading on spread 6: page 11 fitted in the middle of the view.
    view = { x: 0, y: 6300 - 600, width: 800, height: 1200, zoom: 0.5 };
    render(true);
    expect(board.setPageLock).toHaveBeenLastCalledWith(textFrames[10]);
    // Scroll reading, back at the very top.
    render(false);
    expect(board.setPageLock).toHaveBeenLastCalledWith(null);
    view = { x: 0, y: -5, width: 400, height: 600, zoom: 1 };
    board.setPageLock.mockClear();
    render(true);
    expect(board.setPageLock).toHaveBeenLastCalledWith(textFrames[0]);
    // The hold is checked again every 400 ms: it stays on the first page.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(board.setPageLock).not.toHaveBeenCalledWith(textFrames[10]);
    expect(board.setPageLock).toHaveBeenLastCalledWith(textFrames[0]);
  });
});
