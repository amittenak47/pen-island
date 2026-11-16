/**
 * Pages reading: hold the view on one page, and turn it like paper.
 *
 * Nothing about the document's layout changes. The pages still sit in one
 * long stack in board scene space, with the ink where it was written; this
 * only narrows how far the camera may scroll (`setPageLock`) and moves it a
 * page at a time. The turn itself is a picture: the page being left and the
 * page being turned to are captured once when the drag starts, and a canvas
 * over the view curls one over the other while the finger moves. When it lets
 * go, past a third of the way the camera lands on the new page and the
 * picture goes; short of that the sheet unravels back and nothing moved.
 *
 * Turning is a finger's (or a mouse's) drag from one of the page's corners,
 * which takes hold of the sheet the moment it touches — the body of the page
 * stays the board's own pan. With a drawing tool up the stylus writes, and
 * turns from the corner peels only; the arrow and Page keys turn too.
 */

import { useEffect, useRef, type RefObject } from "react";

import type { BoardHandle, ToolName } from "../BoardHandle";
import type { PageFrame } from "../inkPageIndex";
import { peekPdfFilmCurrent, publishPdfReadAhead, publishPdfPreloadPages, peekPdfPreloadPages, subscribePdfFilmCurrent, wakePdfPaintPump } from "../../modes/pdfFilm";
import { waitForPdfTurnPreview } from "./pdfTurnPreview";
import { constrainCorner, cornerForCrease, cornerForGrip, curlGeometry, sheetPart, turnCommits, type Point } from "./curl";
import type { TurnEdge } from "./paintTurn";
import { bookFlap, flatSheet, paintTurn, type TurnLayout } from "./paintTurn";
import { PAGE_LAYER_WILL_CHANGE } from "../pageLayerHint";
import { boardResizeDeferred } from "../../util/splitResize";
import { afterBootSettled, isBootSettled } from "../../util/bootSettled";
import { isCameraBusy } from "../../util/cameraBusy";
import { notePageTurn } from "../../util/pageTurnBusy";
import { keepResumePicture } from "../../util/resumePicture";
import { canvasGestureFrame, protectGestureSurface } from "../../util/gestureExclusion";
import { turnCornerAt, turnEdgeAt, turnCornerSize, turnReachAt } from "./corners";
import { cssColorLuminance } from "../../util/webPagePaper";
import { hasSideScrollRoom, hitBoardScrollHostAtPoint, invalidateBoardScrollHostLayout, nestedScrollHost } from "../scrollHost";
import { touchPointersIn } from "../touchPointers";
import {
  decodeThumbsAround, keepThumb, openThumbBook, shrinkPicture, THUMB_PX_PER_CSS, thumbBookKey, thumbInk, thumbOrder,
  thumbPicture, thumbWindow,
} from "./pageThumbs";

/** In Pages reading the side stacks sit this much further up, as a share of their gap from the bottom. */
const CHROME_LIFT = 0.5;
/** A full turn played without a finger (keys), in ms. */
const AUTO_TURN_MS = 460;
/** A released sheet rolls on for at least this long, in ms: long enough to be seen turning… */
const GLIDE_MIN_MS = 240;
/** …and at most this long, however far it has to go. */
const GLIDE_MAX_MS = 520;
/** The pace a released sheet rolls at when the hand gave it none, in px per ms. */
const GLIDE_PX_PER_MS = 1.4;
/**
 * How much of a hand's up-and-down a sheet held by its side follows. Held
 * mid-edge, paper curls from the finger and barely tilts; at full follow a
 * wobble early in a drag swung the fold toward one corner or the other.
 */
const SIDE_TILT = 0.2;
/** A flick this fast (px per ms) or faster rolls the sheet on at full pace… */
const GLIDE_FLICK_PX_PER_MS = 3;
/** …in as little as this: quick, and still seen going over. */
const GLIDE_FLICK_MIN_MS = 120;
/** Steepest start a throw may give the roll, as a multiple of its average pace (3 would overshoot). */
const GLIDE_MAX_LAUNCH = 2.5;
/** Pages pictured small at once while the reader rests (see `thumbPass`): each picture walks the whole note. */
const THUMB_RUN = 6;
/** A text spread's facing picture is taken again once writing has rested this long. */
const FACING_SETTLE_MS = 1200;

/**
 * A stylus with a drawing tool up writes, in the margins as well: only the
 * corner peels turn under it. With the hand or selection up it turns as a
 * finger does.
 */
const penWrites = (pointerType: string, tool: ToolName | undefined) =>
  pointerType === "pen" && tool !== "hand" && tool !== "selection";

/** Which side of the page a press here may take hold of, if any. */
function turnGripAt(rect: DOMRect, x: number, y: number, pointerType: string, tool: ToolName | undefined) {
  return penWrites(pointerType, tool) ? turnCornerAt(rect, x, y) : turnEdgeAt(rect, x, y);
}
/** Pictures kept for turns: this page and its neighbours — in a spread, three spreads' worth. */
const SHOT_CACHE = 8;
/** How long the view must sit still before the next turn's pictures are taken. */
const PREFETCH_IDLE_MS = 600;
/**
 * And how long the hand must have been off the screen. Pictures are a few
 * hundred ms of the main thread each; taken while the reader was opening
 * the toolbar or a menu just after launch, they were why the first taps of
 * a session answered slowly. A turn does not need them to start.
 */
const PREFETCH_QUIET_MS = 1200;

/** When the reader last touched or typed — see `PREFETCH_QUIET_MS`. */
let lastInputAt = -Infinity;
/** When a finger, key or wheel last went down, or a finger came up: a hover does not count. */
let lastPressAt = -Infinity;
/**
 * Pictures taken while the reader rests stop at the next touch, key or
 * wheel. One is up to a second and a half of the main thread on a tablet,
 * and a turn started while one ran waited for all of it. A hover does not
 * stop them: a mouse or a stylus near the glass moves all the time.
 */
let restingPictures: AbortController | null = null;
function restingPictureSignal(): AbortSignal {
  if (!restingPictures || restingPictures.signal.aborted) restingPictures = new AbortController();
  return restingPictures.signal;
}
if (typeof window !== "undefined") {
  const note = () => { lastInputAt = performance.now(); };
  const stop = () => {
    note();
    lastPressAt = lastInputAt;
    restingPictures?.abort();
  };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel"]) {
    window.addEventListener(type, type === "pointermove" ? note : stop, { capture: true, passive: true });
  }
  window.addEventListener("pointerup", () => { lastPressAt = performance.now(); }, { capture: true, passive: true });
}
const inputQuiet = () => performance.now() - lastInputAt >= PREFETCH_QUIET_MS;
/** How often a still page checks whether its pictures went stale (a sharper paint landed). */
const PREFETCH_RECHECK_MS = 1500;
/** Thrown back toward where it started faster than this, the sheet settles back: px per ms. */
const FLICK_PX_PER_MS = 0.45;
/**
 * A release this soon after the last movement is a throw; later, the hand
 * had stopped. A hand that stops to let go pauses well past this; a busy
 * frame can hold a flick's lift back nearly 100 ms.
 */
const FLICK_FRESH_MS = 100;
/** A throw carries the crease on for this long at the speed it left the hand. */
const THROW_MS = 120;
/** After landing, how soon the next page's pictures are taken: the camera's jump first. */
const LANDED_PREFETCH_MS = 90;
/** A sheet caught while going over, pushed on its way this far (px): put it down and turn the next. */
const FLICK_ON_PX = 12;
/** A turn this soon after the last landing is flicking through: no new pictures, see `flicking`. */
const FLICK_THROUGH_MS = 800;
/**
 * The glass over the page text stays this long after the last landing (see
 * `raiseGlass`): long enough for the next flick of a hand going through,
 * too soon for a press on the new page that means to select.
 */
const GLASS_REST_MS = 250;
/**
 * A facing page left as plain paper by a turn flicked through is drawn this
 * long after the last landing or touch, with no hand on the glass: the hand
 * has stopped there. See `fillPaperFacing`.
 */
const PAPER_FILL_MS = 300;
/**
 * On a touch screen, longer: a hand flicking back through pages came back
 * for the next one about a quarter of a second after each landing, just as
 * the page was drawn, and that flick's first frames carried the copy (40 ms
 * cloning it, its layout forced by the touch, 30 ms painting it). Stopped to
 * read, the page is drawn a third of a second later than it was.
 */
const PAPER_FILL_TOUCH_MS = 650;
/**
 * A hand that has held the sheet this still (`HELD_STILL_PX`) this long is
 * reading under it: the pages the turn shows as kept pictures or paper are
 * copied in sharp, one a frame (see `sharpenHeld`). A flick has let go long
 * before.
 */
const HELD_STILL_MS = 180;
/** Moved no more than this (CSS px) since then: still, the finger's tremor included. */
const HELD_STILL_PX = 8;
/** A page left for the facing slot shows its soft kept picture this long, unless a turn takes it first, then its sharp copy. See `standIn`. */
const STAND_IN_SHARPEN_MS = 300;
/** How long a turn waits for the next page's picture before turning over plain paper. */
const TO_PICTURE_GRACE_MS = 80;
/** Let go before the pictures were taken: how long to wait for them before simply going. */
const PICTURE_WAIT_MS = 1200;
/**
 * The widest sliver, in view pixels, that windows may leave at the spread's
 * top or bottom edge while they cut the pages above a lent page (see
 * `cutAbove`). Paper shows there, where those pages' margins would.
 */
const WINDOW_SLIVER_PX = 3;
/**
 * What moves with a lent page, told so: each of `rotate`, `translate` and
 * `transform` turned into a layer of its own, so a frame that changes only
 * them is handed to the compositor without laying out the board's layers
 * again (13 ms a frame on the tablet, for a note of 60,000 elements).
 */
const LENT_WILL_CHANGE = PAGE_LAYER_WILL_CHANGE;

/**
 * Whether the board's page layers stay ready for a turn back between turns
 * (`BoardHandle.pageLayers`): on a touch screen, where a hand flicks back
 * right after a page lands. Made ready only when a turn starts, a flick back
 * spent most of its quarter second painting and rastering them; it ran at
 * 20 to 30 frames a second on the tablet. Kept ready, its layers cost about
 * 30 MB of the GPU's memory. A desktop's pointer turns pages less, and its
 * text, on a layer of its own, loses the subpixel smoothing it has on the page.
 */
function keepPageLayersReady(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** How long a facing page a flick left waits to be drawn (see `fillPaperFacing`). */
function paperFillMs(): number {
  return keepPageLayersReady() ? PAPER_FILL_TOUCH_MS : PAPER_FILL_MS;
}

/** Input on its way to the page and not yet handled, moves included, where the browser can tell. */
function inputPending(): boolean {
  const scheduling = (navigator as Navigator & { scheduling?: { isInputPending?: (o?: { includeContinuous?: boolean }) => boolean } }).scheduling;
  return scheduling?.isInputPending?.({ includeContinuous: true }) === true;
}

/**
 * On a touch screen, the facing page's holder kept a window ready for the
 * next turn back, as the board's page layers are (see `keepPageLayersReady`):
 * the turn turns it about its top left and its children back (`cutAbove`),
 * and made ready only then, it was painted and rastered again at the turn's
 * start, a page of math in the frame the turn could least afford.
 */
function keepFacingReady(holder: HTMLElement): void {
  if (!keepPageLayersReady()) return;
  holder.style.transformOrigin = "0 0";
  holder.style.willChange = "transform";
  for (const kid of Array.from(holder.children)) if (kid instanceof HTMLElement) kid.style.willChange = "transform";
}
/**
 * A flick commits on its pace alone: let go at least this fast (px per ms)
 * along the turn, having carried the sheet at least `FLICK_COMMIT_MIN_PX`.
 * A short quick flick used to fall short of the distance a slow drag needs
 * and settle back, so a hand flicking through had to try twice.
 */
const FLICK_COMMIT_PX_PER_MS = 0.5;
const FLICK_COMMIT_MIN_PX = 24;
/** The hand's pace at release is measured over about this long. */
const RELEASE_SPEED_MS = 60;
/**
 * A swipe from the body of the page, not its edge, turns it when it is
 * plainly a flick: this far sideways (px)…
 */
const BODY_FLICK_PX = 28;
/** …at least this fast on average (px per ms)… */
const BODY_FLICK_PX_PER_MS = 0.35;
/** …within this long of touching down… */
const BODY_FLICK_WINDOW_MS = 280;
/** …and mostly sideways: at least this many times its rise or fall. */
const BODY_FLICK_SLOPE = 1.8;
/**
 * A drag from inside a strip's reach (`turnReachAt`) takes hold of the page
 * once it has gone this far inward, more sideways than up or down (px).
 */
const REACH_DRAG_PX = 10;
/**
 * Another touch is a pinch only while a turn is just starting: its second
 * finger lands with the first. Once the held finger has moved `REACH_DRAG_PX`
 * or held on this long, a touch that lands is the hand holding the tablet.
 */
const STRAY_AFTER_MS = 250;
/**
 * Paper below a text page's cut starts this far under it (scene units).
 *
 * Pages are cut on the top of the first block that does not fit, and in a
 * collapsed table that is the line between two rows: it straddles the cut.
 * The view showed its upper half; a picture blanked from the cut's own pixel
 * down took the whole line, so the table lost its last rule the moment a turn
 * was taken hold of. One unit keeps the line and shows nothing of the block
 * below it, which starts with the line itself or with its own spacing.
 */
const CUT_BLEED = 1;
/** Turns queued while a preview loads play at this pace. */
const QUICK_TURN_MS = 240;
/** Longest a live spread's sheet takes to land once the next flick has come (see `hurry`). */
const HURRY_MS = 110;
/** Most turns a held or hammered key may queue ahead. */
const KEY_QUEUE_MAX = 12;

/**
 * Pixels per scene unit for a turn's pictures: the view's own resolution,
 * capped at 1.5 device pixels — the sheet is moving, and four full-resolution
 * screenfuls held for it would cost more memory than the turn is worth.
 */
function shotScale(clientWidth: number, sceneWidth: number): number {
  const dpr = typeof window !== "undefined" ? Math.min(1.5, window.devicePixelRatio || 1) : 1;
  return sceneWidth > 0 ? dpr * (clientWidth / sceneWidth) : dpr;
}

/**
 * Find `selector` in the tab, and keep it while it stays there and matches.
 *
 * The page mask and the marks layers come after the document in the tab, so
 * a search for one walked every element of the note first: on a chapter of
 * math, 60,000 of them, several times each turn.
 */
export function inTab<T extends HTMLElement = HTMLElement>(hostSelector: string, selector: string): () => T | null {
  let found: T | null = null;
  return () => {
    if (found?.isConnected && found.matches(selector) && found.closest(hostSelector)) return found;
    found = document.querySelector(hostSelector)?.querySelector<T>(selector) ?? null;
    return found;
  };
}

type Direction = "next" | "prev";

interface Scene {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageTurnProps {
  boardRef: RefObject<BoardHandle | null>;
  /** The PDF's film scope — the workspace's tab id. */
  filmScope: string;
  /** The element the board lives in; drags that start elsewhere are not ours. */
  hostSelector: string;
  /** Pages reading is on for an open PDF on screen: hold the camera to a page. */
  lockActive: boolean;
  /** …and turning is allowed: the pen is away and this tab has focus. */
  turnEnabled: boolean;
  /** The sheet is split into two reading slots. Off shows whole sheets. */
  spread: boolean;
  /**
   * The document brings its own pages (a PDF). Text, code, markdown and EPUB
   * are cut into view-high pages instead, and always turn as single sheets.
   */
  paged: boolean;
  /**
   * How much of the view the whole page fills on its limiting side — 1 edge
   * to edge — with everything around it hidden. Null reads at the width fit.
   */
  fit?: number | null;
  /**
   * The open document's content hash: what its pages' kept pictures are
   * filed under (see `pageThumbs`), the same in any tab and after a reopen.
   */
  docKey?: string | null;
}

function frameIndexAt(frames: readonly PageFrame[], y: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]!;
    if (y >= f.minY && y < f.maxY) return i;
    const dist = Math.min(Math.abs(y - f.minY), Math.abs(y - f.maxY));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Where in the view to look for the page it shows: the middle. A fitted page
 * sits centred with the board around it, so anywhere nearer an edge can be
 * off the page — a quarter down landed on the sheet above a wide page, and
 * every check then "followed" the view there, a page further back each time.
 */
function probeY(view: { y: number; height: number }): number {
  return view.y + view.height / 2;
}

/**
 * The view still shows the held page: its middle is inside the box the board
 * holds that page in (a text page's box runs past a short cut), or inside the
 * page itself when there is no box for it.
 */
function showsHeld(board: BoardHandle, held: PageFrame, y: number): boolean {
  const box = board.readingPageBox();
  const span = box && Math.abs(box.minY - held.minY) < 0.5 ? box : held;
  return y >= span.minY && y <= span.maxY;
}

/** The frame the lock holds, when it is still one of these; else the one in view. */
function currentIndex(
  frames: readonly PageFrame[],
  locked: PageFrame | null,
  view: { y: number; height: number },
): number {
  if (locked) {
    const i = frames.findIndex((f) => Math.abs(f.minY - locked.minY) < 0.5 && Math.abs(f.maxY - locked.maxY) < 0.5);
    if (i >= 0) return i;
  }
  return frameIndexAt(frames, probeY(view));
}

/**
 * How far along a roll is at time `t` (both 0 to 1), leaving at `launch`
 * times its average pace and coming to rest at the end.
 *
 * The cubic with those two slopes: a thrown sheet carries on at the hand's
 * speed and slows into place; one let go from a stop (`launch` 0) eases away
 * from rest and into place, with nothing sudden at either end.
 */
export function glide(t: number, launch: number): number {
  const a = Math.min(3, Math.max(0, launch));
  return a * t + (3 - 2 * a) * t * t + (a - 2) * t * t * t;
}

/** How fast `glide` is moving at `t`, in multiples of its average pace. */
export function glideSlope(t: number, launch: number): number {
  const a = Math.min(3, Math.max(0, launch));
  return a + 2 * (3 - 2 * a) * t + 3 * (a - 2) * t * t;
}

/**
 * The `launch` that has a roll of `left` px (signed) over `ms` leave at
 * `speed` px per ms (signed): a sheet re-timed mid-roll carries on at the
 * pace it had, with no jolt where the new timing takes over.
 */
export function launchFor(speed: number, left: number, ms: number): number {
  if (!(Math.abs(left) > 0.5) || !(ms > 0)) return 0;
  return Math.min(GLIDE_MAX_LAUNCH, Math.max(0, (speed * ms) / left));
}

/**
 * What a PDF page's picture was taken from: the size its bitmap is painted
 * at now. A picture taken while the page was still a preview goes stale the
 * moment the sharp paint lands, and is taken again.
 */
/**
 * How long a sheet let go by a hand rolls for, `px` from where it is going,
 * its corner last moving at `cornerSpeed` px per ms.
 *
 * A hand that had stopped lets it ease away at an unhurried pace. The faster
 * the flick, the more of the hand's pace the sheet keeps, and the shorter the
 * least it may take: a flick through the pages sends each one over quickly.
 */
export function rollMs(px: number, cornerSpeed: number): number {
  const flick = Math.min(1, Math.max(0, (cornerSpeed - GLIDE_PX_PER_MS) / (GLIDE_FLICK_PX_PER_MS - GLIDE_PX_PER_MS)));
  const least = GLIDE_MIN_MS - (GLIDE_MIN_MS - GLIDE_FLICK_MIN_MS) * flick;
  const pace = Math.max(GLIDE_PX_PER_MS, cornerSpeed * (0.6 + 0.6 * flick));
  return Math.min(GLIDE_MAX_MS, Math.max(least, px / pace));
}

/** Taken by its side strip rather than peeled from a corner. */
function heldBySide(turn: { restY: number; rect: { height: number } }): boolean {
  return turn.restY > 0 && turn.restY < turn.rect.height;
}

/** Where a sheet in `rect` is held: its corner, or the finger's height when taken by the side. */
function heldAt(rect: { top: number; height: number }, bottom: boolean, edgeClientY?: number): number {
  if (edgeClientY == null) return bottom ? rect.height : 0;
  return Math.min(rect.height, Math.max(0, edgeClientY - rect.top));
}

function pdfPaintSignature(hostSelector: string, pageId: number): string {
  if (!(pageId >= 1)) return "";
  const host = document.querySelector(hostSelector);
  const canvases = host?.querySelectorAll<HTMLCanvasElement>(`[data-pdf-page="${pageId}"] canvas.lc-pdf-canvas`);
  return canvases ? Array.from(canvases, (c) => c.width).join(",") : "";
}

/**
 * Whether a PDF page has pixels to turn to: a bitmap painted, however blurry
 * its preview. One that has none would turn over as blank paper — black in
 * a dark theme — so a hand flicking on past the painted pages waits there.
 */
function pdfPagePainted(hostSelector: string, pageId: number): boolean {
  if (!(pageId >= 1)) return false;
  const host = document.querySelector(hostSelector);
  const canvases = host?.querySelectorAll<HTMLCanvasElement>(`[data-pdf-page="${pageId}"][data-painted] canvas.lc-pdf-canvas`);
  return Boolean(canvases && Array.from(canvases).some((c) => c.width > 8 && c.height > 8));
}

type ShotCache = Map<string, Promise<HTMLCanvasElement | null>>;

/**
 * A picture of part of the document, taken once.
 *
 * Keyed on what it shows — where, at what scale, with which ink, from which
 * paint — so a stroke added since, a zoom or a sharper paint takes a fresh
 * one. At most a few kept: each is a screenful of pixels.
 */
export function takeShot(
  shots: ShotCache,
  b: BoardHandle,
  scene: Scene,
  scale: number,
  cutY: number,
  signature: string,
  onlyIfTaken = false,
  /** A PDF's quick picture, `captureSceneQuick`: kept apart from the full one. */
  quick = false,
  /** Calls a new picture off part-way: see `restingPictureSignal`. */
  signal?: AbortSignal,
): Promise<HTMLCanvasElement | null> {
  const key = [scene.x, scene.y, scene.width, scene.height, scale, b.getInkRevision(), Math.min(cutY, 1e9)]
    .map((n) => Math.round(n * 100) / 100)
    .join(":") + `@${signature}#${paletteSignature()}${quick ? "~quick" : ""}`;
  let taken = shots.get(key);
  if (!taken && onlyIfTaken) return Promise.resolve(null);
  if (!taken) {
    // Below a text page's cut is the next page's text, which the view
    // hides; the picture has to hide it too.
    const pending: Promise<HTMLCanvasElement | null> = (
      quick ? b.captureSceneQuick(scene, scale) : b.captureSceneFrame(scene, scale, signal ? { signal } : undefined)
    ).then((canvas) => {
      const cut = cutY - scene.y + CUT_BLEED;
      if (!canvas || !(cut < scene.height)) return canvas;
      const ctx = canvas.getContext("2d");
      if (!ctx) return canvas;
      const top = Math.max(0, Math.ceil((cut / scene.height) * canvas.height));
      ctx.fillStyle = paperColor();
      ctx.fillRect(0, top, canvas.width, canvas.height - top);
      return canvas;
    }).catch((error: unknown) => {
      // Called off by a touch, or overtaken by the page changing under it: a
      // picture of nothing, not kept, so the next rest takes it again. Any
      // other failure is kept, or a page that cannot be pictured would be
      // tried again at every rest.
      if ((error as { name?: unknown } | null)?.name === "AbortError" && shots.get(key) === pending) shots.delete(key);
      return null;
    });
    taken = pending;
    shots.set(key, taken);
    while (shots.size > SHOT_CACHE) shots.delete(shots.keys().next().value!);
  }
  return taken;
}

/** A text page's whole box in scene units — its column, one screenful high from its top. */
function pageBoxScene(b: BoardHandle, frame: PageFrame): Scene | null {
  const box = b.readingPageBox();
  if (!box) return null;
  return { x: box.minX, y: frame.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
}

/**
 * Page `frame`'s own HTML in `holder`, a `w` by `H` sheet of paper: its
 * text at once, its ink when that is ready, unless `kept` says the holder
 * has gone by then. False if there is no page there to copy.
 */
function fillPage(b: BoardHandle, holder: HTMLElement, frame: PageFrame, w: number, H: number, surface: HTMLElement, kept: () => boolean): boolean {
  const scene = pageBoxScene(b, frame);
  if (!scene || !(scene.width > 0)) return false;
  const copy = b.livePageCopy(scene, surface);
  if (!copy) return false;
  const paper = turnPaperColor(paperColor(), false);
  const k = w / scene.width;
  copy.style.transformOrigin = "0 0";
  copy.style.transform = `scale(${k})`;
  holder.appendChild(copy);
  const cut = (frame.maxY - scene.y + CUT_BLEED) * k;
  const blank = cut < H ? document.createElement("div") : null;
  if (blank) {
    Object.assign(blank.style, { position: "absolute", left: "0", right: "0", top: `${Math.max(0, cut)}px`, bottom: "0", background: paper });
    holder.appendChild(blank);
  }
  void b.captureSceneMarks(scene, shotScale(w, scene.width)).then((marks) => {
    if (!marks || !kept()) return;
    Object.assign(marks.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%" });
    holder.insertBefore(marks, blank);
  }, () => {});
  return true;
}

/** The book of kept pictures for this note as the board cuts it now (see `pageThumbs`). */
function thumbBookFor(doc: string | null | undefined, b: BoardHandle, frames: readonly PageFrame[]): string | null {
  return thumbBookKey(doc, frames, b.readingPageBox(), paletteSignature());
}

/**
 * A turn's own copy of a page's kept picture. The kept one can be let go of
 * (closed) when the reader moves on, and a turn still drawing it would throw.
 */
function thumbCopy(picture: (CanvasImageSource & { width: number; height: number }) | null): HTMLCanvasElement | null {
  if (!picture) return null;
  const canvas = document.createElement("canvas");
  canvas.width = picture.width;
  canvas.height = picture.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(picture, 0, 0);
  return canvas;
}

/** A page's kept picture as an element filling the page's holder: a page flicked past. */
function thumbElement(picture: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement | null {
  const canvas = thumbCopy(picture);
  if (!canvas) return null;
  canvas.className = "lc-page-turn-thumb";
  Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%" });
  return canvas;
}

/** Two page pictures side by side, one blank when the spread has only one page. */
function composeSpread(left: HTMLCanvasElement | null, right: HTMLCanvasElement | null): HTMLCanvasElement | null {
  const one = left ?? right;
  if (!one) return null;
  const canvas = document.createElement("canvas");
  canvas.width = one.width * 2;
  canvas.height = one.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = paperColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (left) ctx.drawImage(left, 0, 0, one.width, one.height);
  if (right) ctx.drawImage(right, one.width, 0, one.width, one.height);
  return canvas;
}

/** Plain paper the size of `like`: the page underneath until its picture arrives. */
function blankSheet(like: { width: number; height: number }): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = like.width;
  canvas.height = like.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = paperColor();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * The palette a picture was taken in. Switching palettes repaints the page
 * but not a picture of it, so a turn after the switch showed the old colours
 * under a flap already in the new ones.
 */
function paletteSignature(): string {
  if (typeof document === "undefined") return "";
  return [document.documentElement.dataset.theme ?? "", themeToken("--bg"), themeToken("--ink")].join(",");
}

function paperColor(): string {
  if (typeof document === "undefined") return "#ffffff";
  return themeToken("--bg") || "#ffffff";
}

/**
 * A palette colour as the theme set it on the root (`applyAppTheme`).
 * getComputedStyle restyles the whole document first, text layers and all:
 * 130–250 ms on the tablet, on every frame of every turn.
 */
function themeToken(name: string): string {
  const root = document.documentElement;
  return root.style.getPropertyValue(name).trim() || getComputedStyle(root).getPropertyValue(name).trim();
}

export function turnPaperColor(paper: string, pdf: boolean): string {
  return pdf && (cssColorLuminance(paper) ?? 1) < 0.5 ? "#ffffff" : paper;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/** A turn in flight: what is being turned, and the picture of it. */
/** The softened copy is this share of the picture's size: small is cheap, and scaling it back up softens it further. */
const SOFT_SCALE = 1 / 5;
/** Its blur, in the small copy's own pixels. */
const SOFT_RADIUS_PX = 2;
const softened = new WeakMap<HTMLCanvasElement, HTMLCanvasElement | null>();

/**
 * A softened copy of a page picture, for the page coming into view on a turn
 * (`TurnFrame.toBlur`). Made once per picture: a turn's pictures are never
 * redrawn in place, a sharper one replaces them, and gets its own.
 */
function softenedPicture(picture: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!picture || !(picture.width > 1) || !(picture.height > 1)) return null;
  const known = softened.get(picture);
  if (known !== undefined) return known;
  const copy = document.createElement("canvas");
  copy.width = Math.max(1, Math.round(picture.width * SOFT_SCALE));
  copy.height = Math.max(1, Math.round(picture.height * SOFT_SCALE));
  const ctx = copy.getContext("2d");
  if (!ctx) {
    softened.set(picture, null);
    return null;
  }
  ctx.filter = `blur(${SOFT_RADIUS_PX}px)`;
  ctx.drawImage(picture, 0, 0, copy.width, copy.height);
  softened.set(picture, copy);
  return copy;
}

interface Turn {
  direction: Direction;
  layout: TurnLayout;
  bottom: boolean;
  /**
   * Where on its free edge the sheet is held, from the top of `rect`: a
   * corner (0 or the height) for a corner peel or a key, and the finger's
   * height when it was taken by the side, so the fold starts there.
   */
  restY: number;
  from: PageFrame;
  to: PageFrame;
  /** Where the view sits relative to the page top, kept across the turn. */
  offsetInPage: number;
  /** View-space (CSS px) rectangle the overlay covers. */
  rect: { left: number; top: number; width: number; height: number };
  /** The part of the page being left that is pictured, in scene units — single pages only. */
  scene: Scene | null;
  /** Decided on release: over, or back. Null while a hand holds it. */
  commit: boolean | null;
  /** The hand holds the crease, not the corner — see `cornerForCrease`. */
  byFold: boolean;
  canvas: HTMLCanvasElement;
  /** Null on one side of a single sheet: that page is the live one under the canvas. */
  images: { from: HTMLCanvasElement | null; to: HTMLCanvasElement | null } | null;
  /** The page being turned to as live HTML under the canvas, when it had no picture — see `liveUnder`. */
  under: HTMLElement | null;
  /** A retained live copy belongs to the moving sheet, rather than its backdrop. */
  underSheet: boolean;
  /**
   * A text spread turned without pictures: the pages it shows that are not on
   * the board, as live copies inside `under` — see `planSpreadTurn`. The right
   * one may be in the facing page's slot instead (`liveSpread`).
   */
  spreadLive?: {
    left: HTMLElement | null;
    right: HTMLElement | null;
    back?: HTMLElement | null;
    /** Turning on, the next right page and the sheet's back, each shown through a window (see `slideOn`). */
    windows?: { right: HolderWindows | null; back: HolderWindows | null };
  };
  /** Flicked through: `spreadLive`'s pages are not copied, only kept pictures or paper (see `liveSpread`). */
  paper?: boolean;
  /**
   * The pages the turn shows as kept pictures or paper, nearest the fold
   * first, copied in sharp only while a hand holds the sheet still (see
   * `sharpenHeld`); `back` is the sheet's back turning on. `right` says the
   * right page, which lands as the facing page, is still soft; `sharpRight`
   * that it was copied so. `copyNext` copies the first, saying whether any
   * are left; `hand` is where the hand last moved, and when.
   */
  soft?: {
    pages: { into: HTMLElement | null; frame: PageFrame; picture: HTMLElement | null; side: "left" | "right" | "back" }[];
    right: boolean;
    sharpRight?: boolean;
    copyNext?: () => boolean;
    hand?: { x: number; y: number; at: number; timer: number; frame: number };
  };
  /** A live spread's stand-in for the back of its sheet: the kept picture of the page landing on the left. */
  back?: CanvasImageSource | null;
  /** Turning back, the board's own page is the back of the sheet, moved to it (see `borrowBoard`). */
  borrowed?: BorrowedBoard | null;
  /** Settles true once both pictures are in, false if they cannot be had. */
  ready: Promise<boolean>;
  corner: Point;
  /** The settle playing now, if any. */
  anim: {
    began: number;
    ms: number;
    start: Point;
    goal: Point;
    commit: boolean;
    /** How steeply the roll starts — see {@link glide}. */
    launch: number;
    /** How high the corner rises off the page mid-roll, in CSS px. */
    lift: number;
  } | null;
  frame: number;
  done: boolean;
  landed: boolean;
  detached: boolean;
  sheetOnly: boolean;
  abort: AbortController;
  /** This sheet hid the live booktabs and squares (its pictures carry them). */
  marksHidden?: boolean;
  /** Room around the page on the canvas, in CSS px, for booktabs sticking out (single sheets). */
  margin: number;
}

/** Room a single sheet's canvas keeps around the page for its booktabs. */
const EDGE_MARGIN = 40;

/**
 * The board's own page lent to a turn back as the back of its sheet (see
 * `borrowBoard`): what moves, and what it had, to put back.
 */
interface BorrowedBoard {
  /** The spread's top left, in the board's own pixels. */
  origin: Point;
  /** The board's layers, each with the point it turns about (board pixels). */
  layers: { el: HTMLElement; pivot: Point; rotate: string; translate: string; willChange: string }[];
  /** The paper below the page's cut, moved with it; its pivot in spread pixels. */
  blank: { el: HTMLElement; pivot: Point; rotate: string; translate: string; origin: string; clipPath: string; willChange: string } | null;
  /**
   * The facing page above the board, cut where the sheet crosses onto it.
   * `paper` is its own background colour, which its windows carry instead
   * while they are windows (see `cutAbove`).
   */
  facing: { el: HTMLElement; clipPath: string; background: string; paper: string } | null;
  /** What shows the facing page, each a window onto itself (see `cutAbove`). */
  shown: PageWindow[];
  /** The earlier spread's pages under the turn, built as windows (see `liveSpread`). */
  pages: { left: HolderWindows | null; right: HolderWindows | null };
  /**
   * The mask's hole, the spread, clipping what moves in it, and paper of
   * ours there above and below the lent page that moves with it: where a
   * window leaves a sliver at the spread's top or bottom edge, paper shows,
   * not the board's text beyond the page.
   */
  hole: { el: HTMLElement; overflow: string } | null;
  strips: HTMLElement[];
  /** Half a window's height: more than the spread's diagonal. */
  reach: number;
  /**
   * The spine's shadow, cut the same way by clip paths; `half` is half its
   * width, `look` its gradient. While windows cut, it is hidden and each
   * page shown through one carries its own half of it (`spineHalves`).
   */
  spine: { el: HTMLElement; clipPath: string; visibility: string; half: number; look: string } | null;
  spineHalves: HTMLElement[];
  /** The layers have been given their own compositor layers. */
  promoted: boolean;
  /** How the layers above are cut this frame: by windows, or by clip paths. */
  cuts: "windows" | "clip" | null;
}

/**
 * The facing page's element as a window onto itself, and what it had, to put
 * back. A picture, with nothing in it to turn back, is put in a box of ours
 * (`wrapped`), which is the window. An element with children (a copy) is its
 * own window: it turns, its children turn back about their pivots.
 */
interface PageWindow {
  el: HTMLElement;
  rotate: string;
  translate: string;
  origin: string;
  willChange: string;
  kids: { el: HTMLElement; pivot: Point; rotate: string; translate: string; willChange: string }[];
  wrapped: { picture: HTMLElement; style: string | null } | null;
  /** In a picture's box, the spine's shadow on the page's spine side, `dx` from its top left. */
  spineHalf: { el: HTMLElement; dx: number } | null;
}

/** One of the earlier spread's pages: a holder that stays put, windows in it that turn, the page in them. */
interface HolderWindows {
  holder: HTMLElement;
  windows: HTMLElement[];
  page: HTMLElement;
}

/** A 2D transform (a, b, c, d, e, f): x' = a x + c y + e, y' = b x + d y + f. */
type Affine = [number, number, number, number, number, number];

const affineThen = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

const affineInverse = ([a, b, c, d, e, f]: Affine): Affine => {
  const k = a * d - b * c;
  return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k];
};

const affineCss = (m: Affine): string => `matrix(${m.map((v, i) => Number(v.toFixed(i < 4 ? 6 : 3)) || 0).join(", ")})`;

/**
 * A window onto the side of a line that `n` (a unit normal) points to, the
 * line through `q`: its local x runs from the line along `n`, its local y
 * along the line, from `from` along it past `q`. A box with its top left at
 * its parent's, `transform-origin` 0 0, clipping to its own size.
 */
const halfPlane = (q: Point, n: Point, from: number): Affine => [n.x, n.y, -n.y, n.x, q.x - n.y * from, q.y + n.x * from];

/**
 * The spine's shadow as a page shown through a window carries it, `left`
 * from that page's top left: hidden until windows cut (see `cutAbove`).
 */
function spineHalf(spine: NonNullable<BorrowedBoard["spine"]>, halves: HTMLElement[], left: number, H: number): HTMLElement {
  const half = document.createElement("div");
  half.className = "lc-page-turn-spine";
  Object.assign(half.style, {
    position: "absolute", left: `${left}px`, top: "0", width: `${2 * spine.half}px`, height: `${H}px`,
    backgroundImage: spine.look, transformOrigin: "0 0", pointerEvents: "none", display: "none",
  });
  halves.push(half);
  return half;
}

/** A box of ours to be a window: clips, turns, its own compositor layer. */
function windowBox(reach: number): HTMLElement {
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "absolute", left: "0", top: "0", width: `${reach}px`, height: `${2 * reach}px`,
    overflow: "hidden", transformOrigin: "0 0", willChange: "transform",
  });
  return box;
}

/** Half a window's height for a turn over `rect`: more than its diagonal. */
function windowReach(rect: { width: number; height: number }): number {
  return Math.ceil(2 * (rect.width + rect.height));
}

/**
 * Half a window's height for a `w` by `H` page turning on (`slideOn`): as far
 * as any point of the page can be from the fold's point, which lies within a
 * sheet's width of the page, and no further.
 *
 * Bigger, it hangs past the margin Chromium keeps painted around a moving
 * layer: windows the size of `windowReach` were painted again on the
 * tablet in every frame that slid them.
 */
function onReach(w: number, H: number): number {
  return Math.ceil(Math.hypot(w, H) + w) + 1;
}

/** A `w` by `H` page on `paper` inside a window, turned back as it turns: its own compositor layer. */
function windowPage(w: number, H: number, paper: string): HTMLElement {
  const page = document.createElement("div");
  Object.assign(page.style, {
    position: "absolute", left: "0", top: "0", width: `${w}px`, height: `${H}px`,
    background: paper, transformOrigin: "0 0", willChange: "transform",
  });
  return page;
}

/** How long `slideTo` holds a transform: longer than any hand holds a sheet. Let go of with the turn. */
const SLIDE_HOLD_MS = 3_600_000;
/** The animation holding each element's transform (see `slideTo`). */
const slides = new WeakMap<HTMLElement, Animation>();

/**
 * Give `el` this transform for the frame, held by an animation of its own
 * rather than set in its style.
 *
 * On the tablet's WebView a transform set in style, layer or not, lays out
 * the board's layers for the compositor again in every frame it changes:
 * 4-9 ms on a note of math. One an animation holds goes to the compositor
 * as it is, as long as it stays level (turned at all, it is laid out again
 * too: see `slideOn`), and a new value is the same animation's keyframes
 * changed. Where nothing can animate (tests), its style.
 */
function slideTo(el: HTMLElement, transform: string): void {
  if (typeof el.animate !== "function") {
    el.style.transform = transform;
    return;
  }
  const keyframes = [{ transform }, { transform }];
  const held = slides.get(el);
  const effect = held?.effect;
  if (effect instanceof KeyframeEffect) effect.setKeyframes(keyframes);
  else slides.set(el, el.animate(keyframes, { duration: SLIDE_HOLD_MS, fill: "forwards" }));
}

/**
 * Let go of the transform `slideTo` held: the style's shows again. A held
 * animation keeps its element, and the page copy around it, alive.
 */
function stopSlide(el: HTMLElement): void {
  slides.get(el)?.cancel();
  slides.delete(el);
}

/**
 * Show a page held in one window only on the side of the line through `q`
 * that `n` (a unit normal) points to: the window set along the line, the
 * page in it turned back to where it was. Transforms only, held (`slideTo`)
 * once the turn moves; in style for where it starts.
 */
function slideWindow(shown: HolderWindows, q: Point, n: Point, reach: number, held = true): void {
  const t = halfPlane(q, n, -reach);
  const [win, back] = [affineCss(t), affineCss(affineInverse(t))];
  if (held) {
    slideTo(shown.windows[0]!, win);
    slideTo(shown.page, back);
  } else {
    shown.windows[0]!.style.transform = win;
    shown.page.style.transform = back;
  }
}

/** Let go of everything `slideOn` held for these windows. */
function stopSliding(windows: { right: HolderWindows | null; back: HolderWindows | null } | undefined): void {
  for (const shown of [windows?.right, windows?.back]) {
    if (shown) for (const el of [shown.holder, ...shown.windows, shown.page]) stopSlide(el);
  }
}

/**
 * Cut a live spread turning on where its sheet is now: the next right page
 * past the fold, where the sheet has come off it, and the sheet's back
 * moved to the flap and cut at the fold. `sheet` is in the right page's
 * own pixels, `width` half the spread.
 *
 * Both are windows (`slideWindow`), and the back's box moves as a whole,
 * every transform held by an animation (`slideTo`). They were clip paths
 * and a transform with no layer of its own, changed every frame: each frame
 * painted the next page again and laid out the board's layers for the
 * compositor again, 11-14 ms of the tablet's main thread for a note of math.
 *
 * The fold is a straight line through the page, so a window cuts exactly
 * where a clip path did, with no slivers at the page's edges (`cutAbove`
 * has those): the holders clip to the page.
 */
function slideOn(
  windows: { right: HolderWindows | null; back: HolderWindows | null },
  sheet: { width: number; height: number; corner: Point; bottom: boolean; restY: number },
  reach: number,
): void {
  const w = sheet.width;
  let at = sheet;
  let g = curlGeometry(at.corner, w, at.height, at.bottom, at.restY);
  // A fold leaning less than half a pixel over the page is cut upright. A
  // turned window is laid out for the compositor again in every frame that
  // moves it, however it is moved (see `slideTo`), and a sheet held mid-side
  // leans by that little as it rolls (see `step`): on the tablet, two frames
  // in three of a run of flicks. The sheet's shading keeps the true fold.
  if (g.foldNormal.y !== 0 && Math.abs(g.foldNormal.y) * at.height < 0.5) {
    at = { ...at, corner: { x: g.corner.x, y: g.rest.y } };
    g = curlGeometry(at.corner, w, at.height, at.bottom, at.restY);
  }
  const q = g.foldPoint;
  const n = g.foldNormal;
  // The fold's normal points to the flap's side: the page uncovered there.
  if (windows.right) slideWindow(windows.right, q, n, reach);
  const back = windows.back;
  if (!back) return;
  const flap = bookFlap(at);
  if (!flap) {
    // Nothing folded over.
    slideWindow(back, { x: w + 1, y: 0 }, { x: 1, y: 0 }, reach);
    return;
  }
  slideTo(back.holder, affineCss(flap.matrix as Affine));
  // The back is the sheet's page mirrored (x to w - x), its fold too.
  slideWindow(back, { x: w - q.x, y: q.y }, { x: -n.x, y: n.y }, reach);
}

/**
 * The point `el` turns about, in `surface`'s own pixels: its box by the
 * offsets up to `surface` (which leave its transform out), plus its
 * transform origin. Null when it is not laid out inside `surface`.
 */
function pivotIn(el: HTMLElement, surface: HTMLElement): Point | null {
  let x = 0;
  let y = 0;
  let node = el;
  for (;;) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (parent === surface) break;
    if (!parent || !surface.contains(parent)) return null;
    x += parent.clientLeft;
    y += parent.clientTop;
    node = parent;
  }
  const [ox = 0, oy = 0] = getComputedStyle(el).transformOrigin.split(" ").map((v) => parseFloat(v) || 0);
  return { x: x + ox, y: y + oy };
}

/** A polygon as path data, moved `dx` to the left. */
function pathOf(points: readonly Point[], dx = 0): string {
  return `M${points.map((p) => `${(p.x - dx).toFixed(1)} ${p.y.toFixed(1)}`).join("L")}Z`;
}

/** The colour and thickness of a bottom rule drawn as an inset shadow (an underline). */
function insetRule(shadow: string): { color: string; size: number } | null {
  if (!shadow || shadow === "none" || !shadow.includes("inset")) return null;
  const color = /^(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]+)/i.exec(shadow.trim())?.[1];
  const offsets = shadow.replace(/^(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]+)/i, "").match(/-?[\d.]+px/g);
  const y = offsets ? parseFloat(offsets[1] ?? "0") : 0;
  return color && y < 0 ? { color, size: -y } : null;
}

/**
 * A page mark painted onto a page's picture as it looks on the page: a
 * booktab or footnote square (box, fill, edge, number), a quote band or
 * highlight (a wash, multiplied into the paper like on screen), an underline
 * (its rule) or a caption (its words).
 */
function paintMark(ctx: CanvasRenderingContext2D, element: HTMLElement, box: DOMRect, blend = true): void {
  const style = getComputedStyle(element);
  if (element.classList.contains("lc-doc-footnote-caption")) {
    const text = element.textContent?.trim();
    if (!text) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left, box.top, box.width, box.height);
    ctx.clip();
    ctx.fillStyle = style.color;
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, box.left + (parseFloat(style.paddingLeft) || 0), box.top + box.height / 2);
    ctx.restore();
    return;
  }
  const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, box.width / 2, box.height / 2);
  ctx.save();
  if (blend && style.mixBlendMode === "multiply") ctx.globalCompositeOperation = "multiply";
  const rule = insetRule(style.boxShadow);
  if (rule) {
    ctx.fillStyle = rule.color;
    ctx.fillRect(box.left, box.bottom - rule.size, box.width, rule.size);
  }
  ctx.beginPath();
  ctx.roundRect(box.left, box.top, box.width, box.height, radius);
  const fill = style.backgroundColor;
  if (fill && fill !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(fill)) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  const edge = parseFloat(style.borderTopWidth) || 0;
  if (edge > 0 && style.borderTopStyle !== "none") {
    ctx.lineWidth = edge;
    ctx.strokeStyle = style.borderTopColor;
    ctx.stroke();
  }
  const text = element.textContent?.trim();
  if (text) {
    const label = element.querySelector<HTMLElement>(".lc-doc-footnote-tag") ?? element;
    const font = getComputedStyle(label);
    ctx.fillStyle = font.color;
    ctx.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, box.left + box.width / 2, box.top + box.height / 2);
  }
  ctx.restore();
}

export function PageTurn({ boardRef, filmScope, hostSelector, lockActive, turnEnabled, spread, paged, fit = null, docKey = null }: PageTurnProps) {
  const turnRef = useRef<Turn | null>(null);
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;
  /** The page the camera is held to. */
  const lockedRef = useRef<PageFrame | null>(null);
  /** Text pages two to a spread. A PDF's spread is its layout, not this. */
  const textSpread = spread && !paged;
  const textSpreadRef = useRef(textSpread);
  textSpreadRef.current = textSpread;
  const turnEnabledRef = useRef(turnEnabled);
  turnEnabledRef.current = turnEnabled;
  const spreadRef = useRef(spread);
  spreadRef.current = spread;
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  /**
   * The zoom a page rests at once landed or held, taken at the first prefetch
   * after. Pictures are for turning from there; zoomed away (a pinch) they
   * would be stale the moment the hand moves again, and taking them is what
   * made a following pinch stall.
   */
  const restZoomRef = useRef<number | null>(null);
  /** Pictures of pages taken ahead of a turn, keyed by what they show. */
  const shotsRef = useRef(new Map<string, Promise<HTMLCanvasElement | null>>());
  /**
   * The facing page a live spread turn landed with: its live copy, handed to
   * the facing slot instead of a picture taken on landing (half a second of
   * the main thread, which held the next grab back). The facing page's own
   * pictures wait until the hand has rested.
   */
  const facingHandoffRef = useRef<{ minY: number } | null>(null);
  /** When the last turn landed: within `FLICK_THROUGH_MS`, a hand is flicking through. */
  const landedAtRef = useRef(-Infinity);
  useEffect(() => () => shotsRef.current.clear(), []);

  // Lift the side stacks — the menu toolbar, the mode toggle and their
  // checkers — clear of the sheet's bottom corners, where a thumb turns
  // pages, even while annotation is on. The centred pen dock stays put.
  useEffect(() => {
    if (!lockActive) return;
    const host = document.querySelector<HTMLElement>(hostSelector);
    if (!host) return;
    host.dataset.readingPages = "";
    // A focused board paints its chrome into the app's shared slot, outside
    // this host; an embedded one keeps it inside.
    const slot = document.querySelector<HTMLElement>(".lc-board-chrome-slot");
    const findControls = () =>
      host.querySelector<HTMLElement>(".lc-map-controls") ??
      slot?.querySelector<HTMLElement>(".lc-map-controls") ??
      null;
    let controls: HTMLElement | null = null;
    let frame = 0;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    const position = () => {
      frame = 0;
      const found = findControls();
      if (found !== controls) {
        controls?.style.removeProperty("--lc-page-corner-clearance");
        if (controls) resize?.unobserve(controls);
        controls = found;
        if (controls) resize?.observe(controls);
      }
      if (!controls) return;
      // Half as high again as the stacks' own gap above the screen's foot,
      // measured as if the row had not been lowered (`--lc-map-drop`): the
      // row moves down as a group, and the stacks' lift with it, not twice.
      const base = controls.getBoundingClientRect().bottom;
      const drop = Number.parseFloat(getComputedStyle(controls).getPropertyValue("--lc-map-drop")) || 0;
      const lift = Math.max(0, window.innerHeight - base + drop) * CHROME_LIFT;
      controls.style.setProperty("--lc-page-corner-clearance", `${Math.ceil(lift)}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    resize?.observe(host);
    // The chrome mounts, remounts and moves between slots on its own schedule.
    const mounts = new MutationObserver(schedule);
    if (slot) mounts.observe(slot, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    position();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mounts.disconnect();
      window.removeEventListener("resize", schedule);
      controls?.style.removeProperty("--lc-page-corner-clearance");
      delete host.dataset.readingPages;
    };
  }, [hostSelector, lockActive]);

  // Register before the touch starts: claiming a small band on pointerdown
  // is too late once Android has already claimed an edge swipe as Back.
  useEffect(() => {
    if (!lockActive) return;
    const host = document.querySelector<HTMLElement>(hostSelector);
    const surface = host?.querySelector<HTMLElement>(".lc-board") ?? host;
    if (surface) return protectGestureSurface(surface, () => canvasGestureFrame(surface.getBoundingClientRect()));
  }, [hostSelector, lockActive]);

  /* Hold the camera on the page it is on, and follow jumps made elsewhere. */
  useEffect(() => {
    if (!lockActive) {
      boardRef.current?.setPageLock(null);
      return;
    }
    let lockedCount = -1;
    lockedRef.current = null;
    const relock = () => {
      const board = boardRef.current;
      if (!board || turnRef.current || boardResizeDeferred()) return;
      const view = board.getViewportBounds();
      const frames = board.readingPageFrames();
      if (!view || frames.length === 0) return;
      lockedCount = frames.length;
      // A jump made elsewhere moves the view off the held page: follow it.
      const held = lockedRef.current;
      const probe = probeY(view);
      const stays = held && showsHeld(board, held, probe);
      const locked = frames[stays ? currentIndex(frames, held, view) : pageInView(frames, view)]!;
      lockedRef.current = locked;
      restZoomRef.current = null;
      board.setPageLock(locked);
    };
    /*
     * The page to hold when none is: a PDF's current page — the one its
     * filmstrip and page count show, which scroll reading puts at the top of
     * the view — else whichever page is in the middle of it. Of a split sheet's
     * two halves, the one more on screen.
     */
    const pageInView = (frames: readonly PageFrame[], view: { y: number; height: number }) => {
      const current = pagedRef.current ? peekPdfFilmCurrent(filmScope) : 0;
      let best = -1;
      let bestOverlap = -Infinity;
      frames.forEach((f, i) => {
        if (f.pageId !== current) return;
        const overlap = Math.min(f.maxY, view.y + view.height) - Math.max(f.minY, view.y);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = i;
        }
      });
      // Only while it is on screen: before anything publishes it, it reads 1.
      return best >= 0 && bestOverlap > 0 ? best : frameIndexAt(frames, probeY(view));
    };
    const unsubscribe = subscribePdfFilmCurrent(filmScope, relock);
    /*
     * Layout arrives in batches on a first open, and some jumps (a footnote,
     * the filmstrip on a text document) move the camera without passing
     * through a page turn. Lock again when either happens, or the next pan
     * would drag the view back to the page it left.
     */
    /*
     * …and when the pages are cut again: content changes can re-cut the
     * document, while resizing fits the held page with its boundaries intact.
     */
    const poll = window.setInterval(() => {
      const board = boardRef.current;
      // Mid-pinch every read of the page frames is a fresh layout of the
      // document; the hold is checked again once the camera rests.
      if (!board || turnRef.current || boardResizeDeferred() || isCameraBusy()) return;
      const frames = board.readingPageFrames();
      const view = board.getViewportBounds();
      const held = lockedRef.current;
      const probe = view ? probeY(view) : null;
      const drifted = held && probe != null && !showsHeld(board, held, probe);
      const recut = held != null && frames.length > 0 &&
        !frames.some((f) => Math.abs(f.minY - held.minY) < 0.5 && Math.abs(f.maxY - held.maxY) < 0.5);
      if (frames.length !== lockedCount || drifted || recut) {
        // A re-cut page is found again by its top, not by where the view is.
        if (recut && held) lockedRef.current = frames[frameIndexAt(frames, held.minY + 1)] ?? null;
        relock();
      }
    }, 400);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
      lockedRef.current = null;
      boardRef.current?.setPageLock(null);
    };
  }, [boardRef, filmScope, lockActive]);

  /* The page fit, for as long as pages are held; the width fit after. */
  useEffect(() => {
    if (!lockActive) return;
    return () => boardRef.current?.setPageFit(null);
  }, [boardRef, lockActive]);
  useEffect(() => {
    if (!lockActive) return;
    boardRef.current?.setPageSpread(textSpread);
    return () => boardRef.current?.setPageSpread(false);
  }, [boardRef, lockActive, textSpread]);
  useEffect(() => {
    if (lockActive) boardRef.current?.setPageFit(fit);
  }, [boardRef, lockActive, fit]);

  /*
   * A text spread's facing page.
   *
   * Only one page of the document is on the board at a time — the one held —
   * so the page facing it is a picture of itself, kept current while the held
   * page is written on. Touching the facing page makes it the held one, on the
   * spot where its picture was and before the touch reaches the page, so a
   * stroke or a selection started there lands on the page itself; the page it
   * leaves becomes the picture.
   */
  useEffect(() => {
    if (!lockActive || !textSpread) return;
    const facingEl = inTab(hostSelector, ".lc-page-mask-facing");
    const same = (a: PageFrame, b: PageFrame) => Math.abs(a.minY - b.minY) < 0.5 && Math.abs(a.maxY - b.maxY) < 0.5;
    /** The held page's own picture, for when it becomes the facing one. */
    let live: { page: PageFrame; canvas: HTMLCanvasElement } | null = null;
    let lastRevision = -1;
    let revisionAt = 0;
    let shows: number | null = null;
    let disposed = false;
    let refreshing = false;
    let refreshFrame = 0;

    const refresh = () => {
      if (disposed || refreshing || boardResizeDeferred()) return;
      const b = boardRef.current;
      const el = facingEl();
      const held = lockedRef.current;
      if (!b || !el || el.hidden || !held || turnRef.current) return;
      // While a page is being written on, its facing picture waits for a pause.
      const revision = b.getInkRevision();
      const now = performance.now();
      if (revision !== lastRevision) {
        lastRevision = revision;
        revisionAt = now;
      }
      if (shows != null && now - revisionAt < FACING_SETTLE_MS) return;
      const frames = b.readingPageFrames();
      const i = frames.findIndex((f) => same(f, held));
      if (i < 0) return;
      const facing = frames[i % 2 === 0 ? i + 1 : i - 1];
      // A live copy from the turn that landed here shows this facing page
      // already: its pictures wait for the hand to rest, not the landing.
      const handoff = facingHandoffRef.current;
      if (handoff && facing && Math.abs(handoff.minY - facing.minY) < 0.5) {
        if (!inputQuiet()) return;
      } else if (handoff) {
        facingHandoffRef.current = null;
      }
      // So does a fresher picture of the facing page already shown: taken
      // between two quick turns, it held the second back by a second.
      if (facing && shows != null && Math.abs(shows - facing.minY) < 0.5 && !inputQuiet()) return;
      const hole = el.parentElement?.getBoundingClientRect();
      const heldScene = pageBoxScene(b, held);
      if (!hole || !heldScene) return;
      const scale = shotScale(hole.width / 2, heldScene.width);
      refreshing = true;
      const signal = restingPictureSignal();
      const liveShot = takeShot(shotsRef.current, b, heldScene, scale, held.maxY, "", false, false, signal).then((canvas) => {
        if (!disposed && canvas && lockedRef.current === held) live = { page: held, canvas };
      });
      if (!facing) {
        el.replaceChildren();
        shows = -1;
        void liveShot.finally(() => { refreshing = false; });
        return;
      }
      const scene = pageBoxScene(b, facing);
      if (!scene) { void liveShot.finally(() => { refreshing = false; }); return; }
      const facingShot = takeShot(shotsRef.current, b, scene, scale, facing.maxY, "", false, false, signal).then((canvas) => {
        // A turn under way may be building its right page in this slot.
        if (disposed || !canvas || lockedRef.current !== held || el.hidden || turnRef.current) return;
        if (el.firstElementChild !== canvas) el.replaceChildren(canvas);
        shows = facing.minY;
        facingHandoffRef.current = null;
      });
      void Promise.all([liveShot, facingShot]).finally(() => { refreshing = false; });
    };

    /*
     * The page just left, for the slot, when there is no picture of it yet.
     *
     * A turn flicked onto a page shows it live, and its picture waits for the
     * hand to rest (`refresh`). Left empty, the slot was plain paper there,
     * black in a dark palette: for the whole of the next turn when the hand
     * came back to turn on from the other page, or for the second or two the
     * picture took after a tap. Its kept picture (see `pageThumbs`) takes a
     * few milliseconds; a page with none yet is copied. A kept picture is
     * small and soft, so once no turn has taken the page over, it is copied
     * over the picture, sharp, until `refresh` has a picture of it.
     */
    let sharpenTimer = 0;
    const standIn = (b: BoardHandle, frames: readonly PageFrame[], i: number, el: HTMLElement): HTMLElement[] => {
      const page = frames[i];
      const pane = document.querySelector<HTMLElement>(hostSelector);
      const surface = pane?.querySelector<HTMLElement>(".lc-board") ?? pane;
      const w = el.offsetWidth;
      const H = el.offsetHeight;
      if (!page || !surface || !(w > 0) || !(H > 0)) return [];
      const holder = document.createElement("div");
      Object.assign(holder.style, { position: "absolute", inset: "0", overflow: "hidden", background: turnPaperColor(paperColor(), false) });
      const kept = thumbPicture(thumbBookFor(docKeyRef.current, b, frames), i);
      const shown = kept ? thumbElement(kept) : null;
      const copy = () => fillPage(b, holder, page, w, H, surface, () => holder.isConnected);
      window.clearTimeout(sharpenTimer);
      sharpenTimer = 0;
      if (!shown) {
        copy();
        return [holder];
      }
      holder.appendChild(shown);
      const sharpen = () => {
        sharpenTimer = 0;
        // Gone: turned over, pictured, or swapped back.
        if (disposed || holder.parentNode !== el) return;
        // A turn under way covers it or carries it off; one that falls back leaves it.
        if (turnRef.current) {
          sharpenTimer = window.setTimeout(sharpen, STAND_IN_SHARPEN_MS);
          return;
        }
        holder.replaceChildren();
        if (!copy()) holder.appendChild(shown);
      };
      sharpenTimer = window.setTimeout(sharpen, STAND_IN_SHARPEN_MS);
      return [holder];
    };

    /** Make the facing page the held one. */
    const swap = (b: BoardHandle, el: HTMLElement, held: PageFrame) => {
      const frames = b.readingPageFrames();
      const i = frames.findIndex((f) => same(f, held));
      const facing = i >= 0 ? frames[i % 2 === 0 ? i + 1 : i - 1] : undefined;
      if (!facing) return;
      el.replaceChildren(...(live && same(live.page, held) ? [live.canvas] : standIn(b, frames, i, el)));
      shows = held.minY;
      lockedRef.current = facing;
      b.setPageLock(facing);
    };

    /*
     * A finger on the facing page while flicking through is the next flick,
     * nearly always, and a flick needs the board where it is. Going over to
     * the facing page there cost the flick's first frame 60-90 ms on the
     * tablet (the camera's move laid out and pre-painted on the touch, its
     * repaint the frame after) and the landing as much again to come back. So
     * the swap waits for the lift, and a press a turn took never swaps. A pen
     * with a drawing tool up writes, and swaps at once.
     */
    let swapOnLift: { id: number; held: PageFrame } | null = null;

    const onDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      swapOnLift = null;
      const b = boardRef.current;
      const el = facingEl();
      const held = lockedRef.current;
      if (!b || !el || el.hidden || !held || turnRef.current) return;
      const r = el.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) return;
      // The outer edge is the turn's, while turning is on.
      const hole = el.parentElement?.getBoundingClientRect();
      const tool = b.getActiveTool?.();
      if (hole && turnEnabledRef.current && turnGripAt(hole, event.clientX, event.clientY, event.pointerType, tool)) return;
      if (turnEnabledRef.current && !penWrites(event.pointerType, tool) &&
          performance.now() - landedAtRef.current < FLICK_THROUGH_MS) {
        swapOnLift = { id: event.pointerId, held };
        return;
      }
      swap(b, el, held);
    };
    const onLift = (event: PointerEvent) => {
      const wait = swapOnLift;
      // A turn ends the board's own gesture with a cancel of its own.
      if (!wait || wait.id !== event.pointerId || (event.type === "pointercancel" && !event.isTrusted)) return;
      swapOnLift = null;
      if (event.type !== "pointerup") return;
      const b = boardRef.current;
      const el = facingEl();
      // A turn took the press, or the page moved on under it.
      if (!b || !el || el.hidden || turnRef.current || lockedRef.current !== wait.held) return;
      swap(b, el, wait.held);
    };

    refresh();
    const unsubscribe = subscribePdfFilmCurrent(filmScope, () => {
      cancelAnimationFrame(refreshFrame);
      refreshFrame = requestAnimationFrame(refresh);
    });
    const timer = window.setInterval(refresh, 700);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onLift, true);
    window.addEventListener("pointercancel", onLift, true);
    return () => {
      disposed = true;
      cancelAnimationFrame(refreshFrame);
      window.clearTimeout(sharpenTimer);
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onLift, true);
      window.removeEventListener("pointercancel", onLift, true);
      facingEl()?.replaceChildren();
    };
  }, [boardRef, filmScope, hostSelector, lockActive, textSpread]);

  /*
   * The board's page layers, kept ready for a turn back between turns (see
   * `keepPageLayersReady`), are let go once turning, the page lock or the
   * spread ends.
   */
  useEffect(() => {
    if (!turnEnabled || !lockActive || !textSpread) return;
    const held = boardRef.current;
    return () => { (boardRef.current ?? held)?.pageLayers?.(false); };
  }, [boardRef, lockActive, textSpread, turnEnabled]);

  useEffect(() => {
    if (!turnEnabled) return;

    const board = () => boardRef.current;
    const maskHole = inTab(hostSelector, ".lc-page-mask-hole");
    const maskFacing = inTab(hostSelector, ".lc-page-mask-facing");
    const boardSurface = inTab(hostSelector, ".lc-board");

    /*
     * A picture of part of the document, taken once.
     *
     * Keyed on what it shows — where, at what scale, with which ink — so a
     * stroke added since, or a zoom, takes a fresh one. At most a few kept:
     * each is a screenful of pixels.
     */
    const shot = (
      b: BoardHandle,
      scene: Scene,
      scale: number,
      cutY = Infinity,
      pageId = 0,
      onlyIfTaken = pagedRef.current,
      /** A picture taken ahead, while the reader rests: stops at their next touch. */
      signal?: AbortSignal,
    ) => {
      const signature = pagedRef.current ? pdfPaintSignature(hostSelector, pageId) : "";
      const taken = takeShot(shotsRef.current, b, scene, scale, cutY, signature, onlyIfTaken, false, signal);
      if (!onlyIfTaken || !pagedRef.current) return taken;
      // A PDF page is a bitmap already: copying it is a few ms, so a page
      // flicked to always has a picture, however blurry its paint still is.
      return taken.then((full) => full ?? (disposed ? null : takeShot(shotsRef.current, b, scene, scale, cutY, signature, false, true)));
    };

    /*
     * Booktabs and footnote squares turn with their page, and so do its quote
     * bands, highlights, underlines and captions.
     *
     * They live on the layer above the page mask, not in the page's picture,
     * so a turn showed them staying put over the moving sheet (or vanishing
     * under it). Each picture a turn uses gets them painted on, read from the
     * layer as laid out (the pages either side of the view keep theirs there,
     * hidden), and the live layer is hidden while a sheet with them is up.
     */
    const marksLayer = inTab(hostSelector, ".lc-page-booktabs-slot");
    /** The page's own marks: quote bands, highlights, underlines, captions. */
    const pageMarksLayer = inTab(hostSelector, ".lc-page-marks-slot:not(.lc-page-booktabs-slot)");
    const withMarks = (b: BoardHandle, scene: Scene, picture: HTMLCanvasElement | null): HTMLCanvasElement | null => {
      const layer = picture ? marksLayer() : null;
      if (!picture || !layer) return picture;
      const tl = b.sceneToClient(scene.x, scene.y);
      const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
      if (!tl || !br || br.x - tl.x < 1) return picture;
      const marks = [
        // Washes and rules first, words over them, the tabs and squares on top.
        ...(pageMarksLayer()?.querySelectorAll<HTMLElement>(".lc-doc-footnote-band, .lc-doc-submark-paint") ?? []),
        ...(pageMarksLayer()?.querySelectorAll<HTMLElement>(".lc-doc-footnote-caption") ?? []),
        ...layer.querySelectorAll<HTMLElement>(".lc-doc-footnote-tab, .lc-doc-footnote-bookmark"),
      ]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.right > tl.x && box.left < br.x && box.bottom > tl.y && box.top < br.y);
      if (marks.length === 0) return picture;
      const copy = document.createElement("canvas");
      copy.width = picture.width;
      copy.height = picture.height;
      const ctx = copy.getContext("2d");
      if (!ctx) return picture;
      ctx.drawImage(picture, 0, 0);
      const k = picture.width / (br.x - tl.x);
      ctx.setTransform(k, 0, 0, k, -tl.x * k, -tl.y * k);
      for (const { element, box } of marks) paintMark(ctx, element, box);
      // The marks alone, for the back of the sheet (see MARKS_THROUGH).
      const alone = document.createElement("canvas");
      alone.width = copy.width;
      alone.height = copy.height;
      const actx = alone.getContext("2d");
      if (actx) {
        actx.setTransform(k, 0, 0, k, -tl.x * k, -tl.y * k);
        for (const { element, box } of marks) paintMark(actx, element, box, false);
        marksAlone.set(copy, alone);
      }
      // Booktabs sticking out past the page: their own picture, a margin wider.
      const tabs = marks.filter(({ element }) => !element.closest(".lc-page-marks-slot:not(.lc-page-booktabs-slot)"));
      const out = Math.max(0, ...tabs.map(({ box }) => Math.max(tl.x - box.left, box.right - br.x, tl.y - box.top, box.bottom - br.y)));
      if (out > 0.5) {
        const pad = Math.min(EDGE_MARGIN, Math.ceil(out) + 2);
        const edge = document.createElement("canvas");
        edge.width = Math.round(copy.width + 2 * pad * k);
        edge.height = Math.round(copy.height + 2 * pad * k);
        const ectx = edge.getContext("2d");
        if (ectx) {
          ectx.setTransform(k, 0, 0, k, (pad - tl.x) * k, (pad - tl.y) * k);
          for (const { element, box } of tabs) paintMark(ectx, element, box);
          edges.set(copy, { image: edge, pad });
        }
      }
      return copy;
    };
    /** A marked picture's booktabs that stick out past its page. */
    const edges = new WeakMap<CanvasImageSource, TurnEdge>();
    /** A marked picture's marks on their own. */
    const marksAlone = new WeakMap<CanvasImageSource, HTMLCanvasElement>();
    let marksHidden = 0;
    const hideMarks = (on: boolean) => {
      marksHidden = Math.max(0, marksHidden + (on ? 1 : -1));
      const layer = marksLayer();
      if (layer) layer.style.visibility = marksHidden > 0 ? "hidden" : "";
    };

    /*
     * Flicking through: a turn taken soon after the last one landed.
     *
     * Each new picture is a few hundred milliseconds of the main thread, and a
     * hand going page after page asks for one per page; taken then, they held
     * every frame and touch behind them and whole turns went by undrawn. While
     * flicking, turns use only pictures already taken (the page being left
     * shows live, the page underneath is paper), and taking more waits until
     * the hand rests.
     */
    let lastLandAt = -Infinity;
    const flicking = () => performance.now() - lastLandAt < FLICK_THROUGH_MS;
    const liveTurns = new Set<Turn>();
    const layers = new Set<Turn>();

    const requestPreview = (pageId: number) => {
      notePageTurn(filmScope);
      publishPdfPreloadPages(filmScope, [...new Set([pageId, ...peekPdfPreloadPages(filmScope)])].slice(0, KEY_QUEUE_MAX));
      wakePdfPaintPump(filmScope);
    };

    // Keep the fold inside its board's stacking context. A body-level overlay
    // can cover inline PDF controls even though shared/portalled controls win.
    const mountTurnCanvas = (turn: Turn) => {
      const pane = document.querySelector<HTMLElement>(hostSelector);
      if (!pane) return;
      const surface = pane.querySelector<HTMLElement>(".lc-board") ?? pane;
      const origin = surface.getBoundingClientRect();
      const left = `${turn.rect.left - origin.left + surface.scrollLeft - surface.clientLeft}px`;
      const top = `${turn.rect.top - origin.top + surface.scrollTop - surface.clientTop}px`;
      // The page being left is pictured, marks and all: the live ones would float over the sheet.
      const leaving = turn.images ? (turn.direction === "next" ? turn.images.from : turn.images.to) : null;
      if (leaving && !turn.marksHidden) {
        turn.marksHidden = true;
        hideMarks(true);
      }
      for (const layer of turn.under ? [turn.under, turn.canvas] : [turn.canvas]) {
        const inset = layer === turn.canvas ? turn.margin : 0;
        layer.style.left = `${parseFloat(left) - inset}px`;
        layer.style.top = `${parseFloat(top) - inset}px`;
        // Forward sheets peel above the next one; returning sheets arrive
        // on top, leaving the earlier return visible as their backdrop.
        const above = turn.direction === "next"
          ? [...liveTurns].reverse().find(other => other !== turn && other.detached && other.canvas.parentNode === surface)
          : undefined;
        if (layer === turn.under) layer.style.zIndex = "45";
        surface.insertBefore(layer, above?.under?.parentNode === surface ? above.under : above?.canvas ?? null);
      }
    };

    /*
     * The page being turned to, as live HTML under the canvas, when it has no
     * picture yet. A text page's picture is most of a second of a tablet's
     * main thread, and a hand flicking through outruns it: without one the
     * page underneath turned over blank. A copy of the page's own HTML is a
     * few milliseconds and shows its text at once; the canvas leaves clear the
     * part of the turn where that page shows. Its ink follows a moment later.
     */
    const liveUnder = (b: BoardHandle, turn: Turn, scene: Scene, scale: number, page: PageFrame): HTMLElement | null => {
      const pane = document.querySelector<HTMLElement>(hostSelector);
      const surface = pane?.querySelector<HTMLElement>(".lc-board") ?? pane;
      if (!surface || !(scene.width > 0)) return null;
      const copy = b.livePageCopy(scene, surface);
      if (!copy) return null;
      const k = turn.rect.width / scene.width;
      const paper = turnPaperColor(paperColor(), false);
      const under = document.createElement("div");
      under.className = "lc-page-turn-under";
      under.setAttribute("aria-hidden", "true");
      Object.assign(under.style, {
        width: `${turn.rect.width}px`,
        height: `${turn.rect.height}px`,
        background: paper,
        clipPath: "inset(100%)",
      });
      copy.style.transformOrigin = "0 0";
      copy.style.transform = `scale(${k})`;
      under.appendChild(copy);
      // A text page cut short is blank paper below its cut.
      const cut = (page.maxY - scene.y + CUT_BLEED) * k;
      const blank = cut < turn.rect.height ? document.createElement("div") : null;
      if (blank) {
        Object.assign(blank.style, { position: "absolute", left: "0", right: "0", top: `${Math.max(0, cut)}px`, bottom: "0", background: paper });
        under.appendChild(blank);
      }
      void b.captureSceneMarks(scene, scale).then((marks) => {
        if (!marks || turn.done) return;
        Object.assign(marks.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%" });
        under.insertBefore(marks, blank);
      }, () => {});
      return under;
    };

    /**
     * The pages a live spread turn shows that the board does not.
     *
     * Turning on, the next right page, where the sheet has come off it.
     * Turning back, the earlier spread: its left page whole, beneath the
     * returning sheet, and its right page where that sheet lies flat. The
     * board keeps showing the spread on screen everywhere else.
     *
     * Flicked through (`paper`), they are not copied. Copying a page of math
     * and laying it out was 40-55 ms of each turn's start on the tablet,
     * about half of it, for pages the hand went straight past. They show
     * their kept pictures instead (see `pageThumbs`), a few ms each, or
     * plain paper where a page has none yet. The page the hand stops on is
     * drawn once it rests (see `fillPaperFacing`); the board itself shows
     * the other one.
     *
     * The back of the sheet is the page landing on the left. Turning back
     * that is the left page on screen, and a sheet coming back starts with
     * all of its back lying on it: drawn as paper, the whole page went blank
     * at the touch, with no lip. So it is the board's own page when the
     * board holds it (`borrowBoard`), or the facing slot's picture of it
     * when the board holds the right one: either costs nothing, and is
     * sharp. Turning on, the page is not on screen: a turn that is not a
     * flick copies it when it has no kept picture (`back`, placed by
     * `slideOn`). Otherwise the back is the page's kept picture, or paper.
     */
    const liveSpread = (b: BoardHandle, turn: Turn, frames: readonly PageFrame[], other: number, paper = false): HTMLElement | null => {
      const pane = document.querySelector<HTMLElement>(hostSelector);
      const surface = pane?.querySelector<HTMLElement>(".lc-board") ?? pane;
      if (!surface) return null;
      const w = turn.rect.width / 2;
      const H = turn.rect.height;
      const background = turnPaperColor(paperColor(), false);
      const book = thumbBookFor(docKeyRef.current, b, frames);
      if (book) openThumbBook(book);
      // Lent, windows reach past the spread's edges; turning on, past the page's.
      const reach = turn.direction === "next" ? onReach(w, H) : windowReach(turn.rect);
      const onWindows: NonNullable<NonNullable<Turn["spreadLive"]>["windows"]> = { right: null, back: null };
      const page = (i: number, side: "left" | "right"): HTMLElement | null => {
        const frame = frames[i];
        const holder = document.createElement("div");
        Object.assign(holder.style, {
          position: "absolute", top: "0", left: side === "right" ? `${w}px` : "0",
          width: `${w}px`, height: `${H}px`, overflow: "hidden", background,
        });
        // Lent, the holder stays put and its page shows through windows in
        // it that turn (see `cutAbove`): past the sheet's edge, and for the
        // right page on the spine's side of the fold too. Turning on, the
        // right page shows through one, past the fold (`slideOn`). The paper
        // goes in with the page, or the holder would show it everywhere.
        let into: HTMLElement = holder;
        const lender = turn.borrowed;
        const on = !lender && turn.direction === "next" && side === "right";
        if (lender || on) {
          const windows = Array.from({ length: lender && side === "right" ? 2 : 1 }, () => windowBox(reach));
          windows.reduce<HTMLElement>((at, box) => { at.appendChild(box); return box; }, holder);
          into = windowPage(w, H, background);
          windows[windows.length - 1]!.appendChild(into);
          holder.style.background = "";
          const through = { holder, windows, page: into };
          if (lender) lender.pages[side] = through;
          else {
            onWindows.right = through;
            // Nothing past the fold yet.
            slideWindow(through, { x: w + 1, y: 0 }, { x: 1, y: 0 }, reach, false);
          }
        }
        // A spread's last page can be missing: plain paper, as the board shows it.
        // Lent on a touch screen, a page with a kept picture shows that for
        // now (see below). Either way it is copied only for a hand that holds
        // the sheet still (`sharpenHeld`).
        const softFirst = Boolean(lender) && !paper && keepPageLayersReady();
        const kept = frame && (paper || softFirst) ? thumbPicture(book, i) : null;
        const shown = kept ? thumbElement(kept) : null;
        if (shown) into.appendChild(shown);
        if (frame && (paper || (shown && softFirst))) {
          turn.soft ??= { pages: [], right: false };
          turn.soft.pages.push({ into, frame, picture: shown, side });
          if (side === "right") turn.soft.right = true;
        } else if (frame) fillPage(b, into, frame, w, H, surface, () => !turn.done);
        // Its half of the spine's shadow, over it, while windows cut (see `cutAbove`).
        if (lender?.spine) into.appendChild(spineHalf(lender.spine, lender.spineHalves, side === "left" ? w - lender.spine.half : -lender.spine.half, H));
        return holder;
      };
      turn.paper = paper;
      const backAt = turn.direction === "next" ? other : other + 2;
      // Before the copies below go in: it reads where the board's layers are.
      turn.borrowed = borrowBoard(b, turn, frames, backAt);
      const facingBack = turn.borrowed ? null : facingPicture(turn, frames, backAt);
      turn.back = turn.borrowed ? null : facingBack ?? thumbCopy(thumbPicture(book, backAt));
      /**
       * The sheet's back turning on, live: a page-size box moved to the flap,
       * with the page in a window in it cut at the fold (`slideOn`). Nothing
       * shows until it is placed.
       */
      const backBox = (): HolderWindows => {
        const box = document.createElement("div");
        Object.assign(box.style, {
          position: "absolute", top: "0", left: "0", width: `${w}px`, height: `${H}px`, overflow: "hidden",
          transformOrigin: "0 0", willChange: "transform",
        });
        const windows = [windowBox(reach)];
        const into = windowPage(w, H, background);
        box.appendChild(windows[0]!).appendChild(into);
        const through = { holder: box, windows, page: into };
        slideWindow(through, { x: w + 1, y: 0 }, { x: 1, y: 0 }, reach, false);
        return through;
      };
      let back: HolderWindows | null = null;
      const backSoft = !turn.borrowed && !facingBack && turn.direction === "next" && frames[backAt];
      if (backSoft && !turn.back && !paper) {
        back = backBox();
        if (!fillPage(b, back.page, frames[backAt]!, w, H, surface, () => !turn.done)) back = null;
      }
      onWindows.back = back;
      const under = document.createElement("div");
      under.className = "lc-page-turn-under";
      under.setAttribute("aria-hidden", "true");
      Object.assign(under.style, { width: `${turn.rect.width}px`, height: `${H}px` });
      // Its windows slide past the spread's edges: the desk stays the desk.
      if (turn.borrowed) under.style.overflow = "hidden";
      const left = turn.direction === "prev" ? page(other, "left") : null;
      const right = page(other + 1, "right");
      // Hidden until cut, unless it shows through a window.
      if (right && onWindows.right?.holder !== right) right.style.clipPath = "inset(100%)";
      /*
       * The right page becomes the facing page when the turn lands. Built in
       * the facing page's slot, above what it shows now, it stays there: moved
       * there at the landing, it was styled and laid out a second time, a
       * page of math in the frame the turn could least afford. Only with the
       * slot on the right, the board holding the left page.
       */
      const facing = maskFacing();
      if (right && facing && !facing.hidden && facing.style.left === "50%") {
        right.style.left = "0";
        facing.appendChild(right);
      }
      for (const holder of [left, right, back?.holder]) if (holder && !holder.parentNode) under.appendChild(holder);
      turn.spreadLive = { left, right, back: back?.holder ?? null, windows: turn.direction === "next" ? onWindows : undefined };
      /*
       * A turn back taken after a rest, on a touch screen, starts on the kept
       * pictures of the pages it uncovers. Copying them both first was about
       * 90 ms of script, 40 ms laying them out and 30 ms painting them before
       * its first frame on the tablet: a flick back from a page read for a
       * moment ran at 20 frames a second. A flicked turn shows kept pictures
       * or paper for the same reason. A flick lets go long before any of
       * them is wanted sharp; a hand holding the sheet still is reading under
       * it, and gets the pages themselves (`sharpenHeld`), the sheet's back
       * turning on last.
       */
      if (backSoft && !back) {
        turn.soft ??= { pages: [], right: false };
        turn.soft.pages.push({ into: null, frame: frames[backAt]!, picture: null, side: "back" });
      }
      const soft = turn.soft;
      if (soft?.pages.length) {
        soft.copyNext = () => {
          const next = soft.pages.shift();
          if (!next) return false;
          if (next.side === "back") {
            // As a turn that is not a flick shows it from the start (above).
            const box = backBox();
            if (turn.spreadLive && fillPage(b, box.page, next.frame, w, H, surface, () => !turn.done)) {
              under.appendChild(box.holder);
              turn.spreadLive.back = box.holder;
              onWindows.back = box;
              turn.back = null;
              draw(turn);
            }
          } else if (next.into && fillPage(b, next.into, next.frame, w, H, surface, () => !turn.done)) {
            next.picture?.remove();
            if (next.side === "right") {
              soft.right = false;
              soft.sharpRight = true;
            }
            // The spine's shadow stays over the page (see `spineHalf`).
            const half = next.into.querySelector(":scope > .lc-page-turn-spine");
            if (half) next.into.appendChild(half);
          }
          return soft.pages.length > 0;
        };
      }
      return under;
    };

    /** Called off: the hand moved on, let go, or the turn is gone. */
    const stopSharpening = (turn: Turn) => {
      const hand = turn.soft?.hand;
      if (!hand) return;
      window.clearTimeout(hand.timer);
      cancelAnimationFrame(hand.frame);
      hand.timer = 0;
      hand.frame = 0;
    };

    /**
     * The hand holding a sheet, for `sharpenHeld`: once it has moved past
     * `HELD_STILL_PX` from where it last did, it is moving, and the wait for
     * it to hold still starts over.
     */
    const noteHand = (turn: Turn, x: number, y: number) => {
      const soft = turn.soft;
      if (!soft?.pages.length || !soft.copyNext) return;
      const hand = soft.hand;
      if (hand && Math.abs(x - hand.x) <= HELD_STILL_PX && Math.abs(y - hand.y) <= HELD_STILL_PX) return;
      stopSharpening(turn);
      soft.hand = { x, y, at: performance.now(), timer: 0, frame: 0 };
      soft.hand.timer = window.setTimeout(() => sharpenHeld(turn), HELD_STILL_MS);
    };

    /**
     * A hand that holds the sheet still is reading under it: the pages the
     * turn shows as kept pictures or paper come in sharp, one a frame, the
     * one nearest the fold first (turning on, the next right page, then the
     * sheet's back; turning back, the left page, then the right).
     *
     * A copy is a block of 40-78 ms on the tablet, so each waits for the
     * frame before it, and none starts once the hand has moved on or let go:
     * a hand that starts to move during one gets one late frame. A hand that
     * holds still again picks up where it stopped.
     */
    const sharpenHeld = (turn: Turn) => {
      const soft = turn.soft;
      const hand = soft?.hand;
      if (!soft || !hand) return;
      hand.timer = 0;
      if (turn.done || active?.turn !== turn || !soft.copyNext) return;
      const quiet = performance.now() - hand.at;
      if (quiet < HELD_STILL_MS) {
        hand.timer = window.setTimeout(() => sharpenHeld(turn), HELD_STILL_MS - quiet);
        return;
      }
      const afterFrame = () => {
        hand.frame = requestAnimationFrame(() => {
          hand.frame = 0;
          hand.timer = window.setTimeout(() => sharpenHeld(turn), 0);
        });
      };
      // A move on its way and not yet handled goes first. Without this the
      // tablet started the next copy with the hand's move waiting behind it,
      // two late frames (78, 89 ms) where one was due.
      if (inputPending()) {
        afterFrame();
        return;
      }
      if (soft.copyNext()) afterFrame();
    };

    /**
     * Lend the board's own page to a turn back as the back of its sheet.
     *
     * The sheet coming back is the left page on screen, which the board holds
     * live: its layers (the text, the page's marks, the ink, the overlays)
     * move to where the sheet is folded over, each with `rotate` and
     * `translate` so its own transform is left alone (`placeBorrowed`). They
     * stay where they are in the stack, under the page mask. What lies above
     * them is ours, and is cut where the flap is: the earlier spread's pages
     * under the turn, the facing page and the spine's shadow. The paper
     * below the page's cut moves with it, over the next page's text.
     *
     * Nothing is copied or laid out, and the sheet is as sharp as the page,
     * ink and all. Only while the board holds that page, and for one turn at
     * a time: a turn that starts while another has it turns over the page's
     * kept picture, or paper.
     */
    let boardLender: Turn | null = null;
    const borrowBoard = (b: BoardHandle, turn: Turn, frames: readonly PageFrame[], at: number): BorrowedBoard | null => {
      const page = frames[at];
      const held = lockedRef.current;
      const pane = document.querySelector<HTMLElement>(hostSelector);
      const surface = boardSurface() ?? pane;
      if (turn.direction !== "prev" || pagedRef.current || boardLender || !page || !held || !surface || !b.pageLayers) return null;
      if (Math.abs(held.minY - page.minY) >= 0.5 || Math.abs(held.maxY - page.maxY) >= 0.5) return null;
      // Held on the left: the facing page is on the right.
      const facing = maskFacing();
      const facingShown = facing && !facing.hidden ? facing : null;
      if (facingShown && facingShown.style.left !== "50%") return null;
      const box = surface.getBoundingClientRect();
      const origin = {
        x: turn.rect.left - box.left + surface.scrollLeft - surface.clientLeft,
        y: turn.rect.top - box.top + surface.scrollTop - surface.clientTop,
      };
      const layers: BorrowedBoard["layers"] = [];
      for (const el of b.pageLayers()) {
        // Not drawn: nothing to move.
        if (!el.offsetParent) continue;
        const pivot = pivotIn(el, surface);
        if (!pivot) return null;
        layers.push({ el, pivot, rotate: el.style.rotate, translate: el.style.translate, willChange: el.style.willChange });
      }
      if (layers.length === 0) return null;
      const hole = maskHole();
      const blankEl = hole?.querySelector<HTMLElement>(":scope > .lc-page-mask-blank") ?? null;
      const spineEl = hole?.querySelector<HTMLElement>(":scope > .lc-page-mask-spine") ?? null;
      // Windows past the spread's edges: longer than its diagonal both ways.
      const reach = windowReach(turn.rect);
      const spine = spineEl && !spineEl.hidden ? {
        el: spineEl, clipPath: spineEl.style.clipPath, visibility: spineEl.style.visibility,
        half: spineEl.offsetWidth / 2, look: getComputedStyle(spineEl).backgroundImage,
      } : null;
      const spineHalves: HTMLElement[] = [];
      // The facing page's paper goes with what shows it, so that only the
      // part of it the sheet has not covered is drawn.
      const paper = facingShown ? getComputedStyle(facingShown).backgroundColor : "";
      const shown: PageWindow[] = [];
      for (const el of facingShown ? Array.from(facingShown.children) : []) {
        if (!(el instanceof HTMLElement)) continue;
        let win = el;
        let wrapped: PageWindow["wrapped"] = null;
        if (el.childElementCount === 0) {
          // A picture has nothing in it to turn back: a box of ours is the
          // window, and the picture in it turns back. Moving a canvas is not
          // laying out a page.
          win = windowBox(reach);
          wrapped = { picture: el, style: el.getAttribute("style") };
          el.before(win);
          win.appendChild(el);
          // Its size, as the slot gives its own picture (`.lc-page-mask-facing > canvas`), and paper behind it.
          Object.assign(el.style, {
            position: "absolute", left: "0", top: "0", display: "block", width: `${turn.rect.width / 2}px`, height: `${turn.rect.height}px`,
            background: paper, transformOrigin: "0 0", willChange: "transform",
          });
        }
        // Over a picture, the spine's shadow on its spine side, turned back
        // with it: a layer of its own, or each frame it turns paints it again.
        const half = wrapped && spine ? spineHalf(spine, spineHalves, 0, turn.rect.height) : null;
        if (half) {
          half.style.willChange = "transform";
          win.appendChild(half);
        }
        shown.push({
          el: win, rotate: win.style.rotate, translate: win.style.translate, origin: win.style.transformOrigin, willChange: win.style.willChange, wrapped,
          spineHalf: half && spine ? { el: half, dx: -spine.half } : null,
          kids: wrapped ? [] : Array.from(win.children).filter((kid): kid is HTMLElement => kid instanceof HTMLElement).map((kid) => ({
            el: kid,
            pivot: pivotIn(kid, win) ?? { x: 0, y: 0 },
            rotate: kid.style.rotate, translate: kid.style.translate, willChange: kid.style.willChange,
          })),
        });
      }
      // Paper above and below the lent page, moved with it (see `placeBorrowed`).
      // Last in the hole, which the board reads by place (blank, facing,
      // spine), and under what is in it: the hole stacks its own children.
      const stripPaper = blankEl ? getComputedStyle(blankEl).backgroundColor : paper;
      const strips = hole ? [-reach, turn.rect.height].map((top) => {
        const strip = document.createElement("div");
        strip.className = "lc-page-turn-strip";
        Object.assign(strip.style, {
          position: "absolute", left: "0", top: `${top}px`, width: `${turn.rect.width / 2}px`, height: `${reach}px`,
          background: stripPaper, transformOrigin: "0 0", willChange: "transform", pointerEvents: "none", zIndex: "-1",
        });
        hole.appendChild(strip);
        return strip;
      }) : [];
      const holeClip = hole ? { el: hole, overflow: hole.style.overflow } : null;
      if (hole) hole.style.overflow = "hidden";
      boardLender = turn;
      return {
        origin,
        layers,
        blank: blankEl ? {
          el: blankEl,
          pivot: { x: blankEl.style.left === "50%" ? turn.rect.width / 2 : 0, y: parseFloat(blankEl.style.top) || 0 },
          rotate: blankEl.style.rotate, translate: blankEl.style.translate, origin: blankEl.style.transformOrigin, clipPath: blankEl.style.clipPath,
          willChange: blankEl.style.willChange,
        } : null,
        facing: facingShown ? { el: facingShown, clipPath: facingShown.style.clipPath, background: facingShown.style.background, paper } : null,
        shown,
        pages: { left: null, right: null },
        hole: holeClip,
        strips,
        reach,
        spine,
        spineHalves,
        promoted: false,
        cuts: null,
      };
    };

    /**
     * Move the lent page to the flap, with the paper below its cut and the
     * paper of ours above and below it. Transforms only, on layers of their
     * own (`LENT_WILL_CHANGE`): no layout, nothing painted again. The pages
     * above are cut in `cutAbove`.
     */
    const placeBorrowed = (borrowed: BorrowedBoard, flap: ReturnType<typeof bookFlap>) => {
      // Nothing folded over: the turn has landed, and the page is under the
      // pages it lands on wherever it is.
      if (!flap) return;
      const [a, b, c, d, e, f] = flap.matrix as [number, number, number, number, number, number];
      // A turn about each layer's own pivot, and the shift that takes the
      // pivot where the flap takes it (pivots from the spread's top left).
      const rotate = `${((Math.atan2(b, a) * 180) / Math.PI).toFixed(4)}deg`;
      const shift = (x: number, y: number) => `${(a * x + c * y + e - x).toFixed(2)}px ${(b * x + d * y + f - y).toFixed(2)}px`;
      if (!borrowed.promoted) {
        borrowed.promoted = true;
        board()?.pageLayers?.(true);
        if (borrowed.blank) Object.assign(borrowed.blank.el.style, { transformOrigin: "0 0", willChange: LENT_WILL_CHANGE });
      }
      const { x: sx, y: sy } = borrowed.origin;
      for (const { el, pivot } of borrowed.layers) {
        // A camera settling mid-turn lets the board's layers go: keep them.
        if (el.style.willChange !== LENT_WILL_CHANGE) el.style.willChange = LENT_WILL_CHANGE;
        el.style.rotate = rotate;
        el.style.translate = shift(pivot.x - sx, pivot.y - sy);
      }
      if (borrowed.blank) {
        const { el, pivot } = borrowed.blank;
        el.style.rotate = rotate;
        el.style.translate = shift(pivot.x, pivot.y);
        // The hole clips it to the spread, and past the fold the facing page
        // covers it. Without one, clipped to the flap.
        if (!borrowed.facing) el.style.clipPath = `polygon(${flap.clip.map((p) => `${(p.x - pivot.x).toFixed(1)}px ${(p.y - pivot.y).toFixed(1)}px`).join(", ")})`;
      }
      // The paper above and below the page, with it.
      for (const strip of borrowed.strips) {
        const top = parseFloat(strip.style.top) || 0;
        strip.style.transform = affineCss([a, b, c, d, c * top + e, d * top + f - top]);
      }
    };

    /**
     * Cut the pages above the lent one where its flap lies: the earlier
     * spread's left page (under the turn), its right page where the sheet
     * lies flat, and the facing page.
     *
     * Each is a window onto its page that turns: a box clipping to itself,
     * set along a line, with the page in it turned back to where it was. The
     * earlier left page shows past the sheet's edge, its right page there too
     * but on the spine's side of the fold, the facing page beyond the fold.
     * The compositor moves them, and nothing is painted again: a clip path
     * changed every frame painted all three pages again, and a lent turn back
     * ran at 30 frames a second on the tablet, where a turn on ran at 84.
     *
     * The flap's top and bottom edges are not those lines. A hand drifting
     * up or down slants the sheet and carries it a little way with it, and
     * they stand off the spread's edges: slivers there, where those pages'
     * margins are, show paper (see `borrowBoard`'s strips). Once a sliver
     * would be wider than `WINDOW_SLIVER_PX` (a hand drifting far, a corner
     * peeled), clip paths cut them exactly, and the right page's is cut in
     * `clipUnder`.
     */
    const cutAbove = (turn: Turn, borrowed: BorrowedBoard, lent: ReturnType<typeof bookFlap>, w: number, H: number) => {
      const { left, right } = borrowed.pages;
      const facing = borrowed.facing;
      const g = curlGeometry(turn.corner, w, H, turn.bottom, turn.restY);
      // The fold, in the right page's own pixels, its normal toward the
      // page under it; and its direction.
      const n = g.foldNormal;
      const q = g.foldPoint;
      const along = { x: -n.y, y: n.x };
      let mode: "windows" | "clip" = "windows";
      // Where a facing element that is its own window starts along the fold.
      let from = 0;
      if (lent) {
        // How far the flap's top and bottom edges stand off the spread's, at
        // either end of the page: the sheet slants with a drifting hand, and
        // follows it up or down a fifth as far.
        const [, mb, , md, , mf] = lent.matrix as Affine;
        const top = Math.max(mf, mf + mb * w);
        const bottom = H - Math.min(mf + md * H, mf + md * H + mb * w);
        if (Math.max(top, bottom) > WINDOW_SLIVER_PX) mode = "clip";
        // Its own box must hold all of the page beyond the fold.
        const beyond = sheetPart(g, w, H, true);
        if (beyond.length > 0) {
          const offs = beyond.map((p) => (p.x - q.x) * along.x + (p.y - q.y) * along.y);
          const outs = beyond.map((p) => (p.x - q.x) * n.x + (p.y - q.y) * n.y);
          from = Math.min(...offs);
          if (borrowed.shown.some((s) => !s.wrapped) && (Math.max(...offs) - from > H + WINDOW_SLIVER_PX || Math.max(...outs) > w + WINDOW_SLIVER_PX)) mode = "clip";
        }
      }
      if (borrowed.cuts !== mode) {
        borrowed.cuts = mode;
        if (mode === "windows") {
          for (const page of [left, right]) if (page) page.holder.style.clipPath = "none";
          if (facing) {
            facing.el.style.clipPath = facing.clipPath;
            facing.el.style.background = "transparent";
          }
          for (const s of borrowed.shown) {
            if (s.wrapped) continue;
            s.el.style.transformOrigin = "0 0";
            s.el.style.willChange = "transform";
            for (const kid of s.kids) kid.el.style.willChange = "transform";
          }
          // The spine's shadow, cut every frame, was a frame's paint: each page
          // carries its own half of it instead.
          if (borrowed.spine) borrowed.spine.el.style.visibility = "hidden";
          for (const half of borrowed.spineHalves) half.style.display = "block";
        } else {
          for (const page of [left, right]) if (page) restWindows(page, false);
          for (const s of borrowed.shown) restWindow(s);
          if (facing) facing.el.style.background = facing.background;
          if (borrowed.spine) borrowed.spine.el.style.visibility = borrowed.spine.visibility;
          for (const half of borrowed.spineHalves) half.style.display = "none";
        }
      }
      if (mode === "windows") {
        // Nothing folded over, the sheet flat on the right: the earlier
        // spread whole, the facing page under it. A line past the facing
        // page's far side puts it out of its window.
        if (!lent) {
          for (const page of [left, right]) if (page) restWindows(page, false);
          for (const s of borrowed.shown) placeWindow(s, { x: w + 1, y: 0 }, { x: 1, y: 0 }, -borrowed.reach);
          return;
        }
        const [ma, mb, , , me, mf] = lent.matrix as Affine;
        // Past the sheet's edge: away from the page lent to it.
        const out = { x: -ma, y: -mb };
        const reach = borrowed.reach;
        if (left) {
          const t = halfPlane({ x: me, y: mf }, out, -reach);
          left.windows[0]!.style.transform = affineCss(t);
          left.page.style.transform = affineCss(affineInverse(t));
        }
        if (right) {
          const near = halfPlane(q, { x: -n.x, y: -n.y }, -reach);
          const past = halfPlane({ x: me - w, y: mf }, out, -reach);
          right.windows[0]!.style.transform = affineCss(near);
          right.windows[1]!.style.transform = affineCss(affineThen(affineInverse(near), past));
          right.page.style.transform = affineCss(affineInverse(past));
        }
        for (const s of borrowed.shown) placeWindow(s, q, n, s.wrapped ? -reach : from);
        return;
      }
      if (!lent) return;
      if (borrowed.spine) {
        const { el, clipPath, half } = borrowed.spine;
        el.style.clipPath = lent.flap.some((p) => p.x > w - half)
          ? `path(evenodd, "M0 0H${2 * half}V${H}H0Z${pathOf(lent.flap, w - half)}")`
          : clipPath;
      }
      if (left) left.holder.style.clipPath = `path(evenodd, "M0 0H${w}V${H}H0Z${pathOf(lent.flap)}")`;
      if (facing) {
        facing.el.style.clipPath = lent.flap.some((p) => p.x > w) ? `path(evenodd, "M0 0H${w}V${H}H0Z${pathOf(lent.flap, w)}")` : facing.clipPath;
      }
    };

    /** Set a facing page's window along the line through `q` facing `n`, its page turned back. */
    const placeWindow = (s: PageWindow, q: Point, n: Point, from: number) => {
      const t = halfPlane(q, n, from);
      if (s.wrapped) {
        s.el.style.transform = affineCss(t);
        s.wrapped.picture.style.transform = affineCss(affineInverse(t));
        if (s.spineHalf) s.spineHalf.el.style.transform = affineCss(affineThen(affineInverse(t), [1, 0, 0, 1, s.spineHalf.dx, 0]));
        return;
      }
      // Its own window: it turns about its top left, its children back about
      // their pivots, as the board's layers turn (see `placeBorrowed`).
      const back = affineInverse(t);
      const deg = (Math.atan2(n.y, n.x) * 180) / Math.PI;
      s.el.style.rotate = `${deg.toFixed(4)}deg`;
      s.el.style.translate = `${t[4].toFixed(2)}px ${t[5].toFixed(2)}px`;
      for (const kid of s.kids) {
        const { x, y } = kid.pivot;
        kid.el.style.rotate = `${(-deg).toFixed(4)}deg`;
        kid.el.style.translate = `${(back[0] * x + back[2] * y + back[4] - x).toFixed(2)}px ${(back[1] * x + back[3] * y + back[5] - y).toFixed(2)}px`;
      }
    };

    /** A facing page's window as it was. */
    const restWindow = (s: PageWindow) => {
      if (s.wrapped) {
        s.el.style.transform = "";
        s.wrapped.picture.style.transform = "";
        if (s.spineHalf) s.spineHalf.el.style.transform = "";
        return;
      }
      s.el.style.rotate = s.rotate;
      s.el.style.translate = s.translate;
      for (const kid of s.kids) {
        kid.el.style.rotate = kid.rotate;
        kid.el.style.translate = kid.translate;
      }
    };

    /**
     * One of the earlier spread's pages, whole through its windows. `done`:
     * it stays (the right page, as the facing page), so its windows let go
     * of their layers and its paper goes back to the holder.
     */
    const restWindows = (page: HolderWindows, done: boolean) => {
      // Staying as the facing page on a touch screen: still ready for the
      // next turn back (see `keepFacingReady`).
      const ready = done && keepPageLayersReady();
      for (const el of [...page.windows, page.page]) {
        stopSlide(el);
        el.style.transform = "";
        if (done && !ready) el.style.willChange = "";
      }
      if (done) page.holder.style.background = page.page.style.background;
      if (ready) keepFacingReady(page.holder);
    };

    /**
     * Give the board its page back: in the task that lands the turn, with the
     * camera's jump, or once a sheet let go has settled back flat. The cut in
     * the earlier spread's left page goes with the turn's layers.
     */
    const returnBoard = (turn: Turn) => {
      const borrowed = turn.borrowed;
      if (!borrowed) return;
      turn.borrowed = null;
      if (boardLender === turn) boardLender = null;
      for (const { el, rotate, translate, willChange } of borrowed.layers) {
        el.style.rotate = rotate;
        el.style.translate = translate;
        el.style.willChange = willChange;
      }
      // Kept ready for the next turn where hands flick back at once.
      board()?.pageLayers?.(keepPageLayersReady() && textSpreadRef.current);
      if (borrowed.blank) {
        const { el, rotate, translate, origin, clipPath, willChange } = borrowed.blank;
        el.style.rotate = rotate;
        el.style.translate = translate;
        el.style.transformOrigin = origin;
        el.style.clipPath = clipPath;
        el.style.willChange = willChange;
      }
      for (const s of borrowed.shown) {
        if (s.wrapped) {
          // The picture back where it was, as it was, and our box gone.
          const { picture, style } = s.wrapped;
          if (style === null) picture.removeAttribute("style");
          else picture.setAttribute("style", style);
          if (s.el.parentNode) s.el.replaceWith(picture);
          continue;
        }
        restWindow(s);
        s.el.style.transformOrigin = s.origin;
        s.el.style.willChange = s.willChange;
        for (const kid of s.kids) kid.el.style.willChange = kid.willChange;
      }
      if (borrowed.facing) {
        borrowed.facing.el.style.clipPath = borrowed.facing.clipPath;
        borrowed.facing.el.style.background = borrowed.facing.background;
      }
      for (const strip of borrowed.strips) strip.remove();
      if (borrowed.hole) borrowed.hole.el.style.overflow = borrowed.hole.overflow;
      if (borrowed.spine) {
        borrowed.spine.el.style.clipPath = borrowed.spine.clipPath;
        borrowed.spine.el.style.visibility = borrowed.spine.visibility;
      }
      // The board's spine shows its shadow again: the pages' halves go.
      for (const half of borrowed.spineHalves) half.remove();
      // The earlier spread's pages stay as they are: under the turn's layers
      // until those go, and the right one, landed, is the facing page (`land`).
    };

    /**
     * The facing slot's picture of page `at`, the left page on screen, while
     * the board holds the right one: a turn back's sheet, at no cost. A
     * stand-in there (a kept picture or a copy) is left to `liveSpread`.
     */
    const facingPicture = (turn: Turn, frames: readonly PageFrame[], at: number): HTMLCanvasElement | null => {
      const facing = maskFacing();
      const held = lockedRef.current;
      const beside = frames[at + 1];
      if (turn.direction !== "prev" || !facing || facing.hidden || facing.style.left === "50%" || !held || !beside) return null;
      if (Math.abs(held.minY - beside.minY) >= 0.5) return null;
      const shown = facing.firstElementChild;
      return shown instanceof HTMLCanvasElement && facing.childElementCount === 1 && shown.width > 0 ? shown : null;
    };

    /** Show the live page underneath only where that page shows: uncovered going on, laid down coming back. */
    const clipUnder = (turn: Turn) => {
      if (!turn.under) return;
      if (turn.spreadLive) {
        const { right, windows } = turn.spreadLive;
        const w = turn.rect.width / 2, H = turn.rect.height;
        const sheetAt = { width: w, height: H, corner: turn.corner, bottom: turn.bottom, restY: turn.restY };
        // Turning on: cut by windows, transforms only.
        if (windows) {
          slideOn(windows, sheetAt, onReach(w, H));
          return;
        }
        // The board's own page as the flap: moved there, and shown through
        // the pages above it, cut there.
        const lent = turn.borrowed ? bookFlap(sheetAt) : null;
        if (turn.borrowed) {
          placeBorrowed(turn.borrowed, lent);
          cutAbove(turn, turn.borrowed, lent, w, H);
        }
        // Shown through windows instead (see `cutAbove`).
        if (!right || turn.borrowed?.cuts === "windows") return;
        const flat = flatSheet({ layout: "book", ...sheetAt });
        const sheet = flat.length >= 3 ? pathOf(flat) : "";
        // The returning page where it lies flat, less the flap lying over it.
        right.style.clipPath = !sheet ? "inset(100%)"
          : lent ? `path(evenodd, "${sheet}${pathOf(lent.flap, w)}")`
          : `path("${sheet}")`;
        return;
      }
      const { width: W, height: H } = turn.rect;
      const flat = flatSheet({ layout: turn.layout, width: W, height: H, corner: turn.corner, bottom: turn.bottom, restY: turn.restY });
      const sheet = flat.length >= 3
        ? `M${flat.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("L")}Z`
        : "";
      if (turn.direction === "next" && !turn.underSheet) {
        turn.under.style.clipPath = sheet ? `path(evenodd, "M0 0H${W}V${H}H0Z${sheet}")` : "none";
      } else {
        turn.under.style.clipPath = sheet ? `path("${sheet}")` : "inset(100%)";
      }
    };

    /**
     * The part of the page at `at` in view, in scene units: its column, and
     * the box the board holds it in — for a text page, one screenful high
     * whether it was cut short or ran on with the space after it.
     */
    const pageScene = (b: BoardHandle, frames: readonly PageFrame[], at: number): Scene | null => {
      const view = b.getViewportBounds();
      const from = frames[at];
      if (!view || !from) return null;
      const box = b.readingPageBox();
      const held = box && Math.abs(box.minY - from.minY) < 0.5;
      const left = Math.max(view.x, box?.minX ?? view.x);
      const right = Math.min(view.x + view.width, box?.maxX ?? view.x + view.width);
      const top = Math.max(view.y, from.minY);
      const bottom = Math.min(view.y + view.height, held ? box.maxY : from.maxY);
      if (right - left < 8 || bottom - top < 8) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    };

    /** Take the pictures a turn from here would need, while nothing is moving. */
    let prefetchTimer = 0;
    let disposed = false;
    let prefetching = false;
    /** The way the last turn went: its side is taken first, two pages deep. */
    let heading: Direction = "next";
    /**
     * `delay` short after a landing: then only the page ahead is taken, since
     * each picture holds the main thread and a hand flicking through is
     * already on its way back. The rest follow once the view has rested.
     */
    const prefetch = (delay = PREFETCH_IDLE_MS) => {
      const quick = delay < PREFETCH_IDLE_MS;
      window.clearTimeout(prefetchTimer);
      prefetchTimer = window.setTimeout(() => {
        // Each picture holds the main thread, and the launch is still opening
        // the page: pictures wait for it, and a turn before then takes its own.
        if (!isBootSettled()) {
          void afterBootSettled().then(() => { if (!disposed) prefetch(); });
          return;
        }
        // The note's kept pictures, read in for a turn that comes before the rest.
        const warm = board();
        const held = lockedRef.current;
        if (warm && held && !pagedRef.current && !isCameraBusy()) warmThumbs(warm, held);
        /*
         * Each picture is a few hundred milliseconds of the main thread — the
         * page cloned, its styles inlined, serialized — and a zoom makes every
         * one stale. Taken while a hand is still pinching or panning, they were
         * the frames a pinch dropped. Wait for the camera to rest.
         */
        // A landing moves the camera too: the quick picture after one is the
        // page the hand is coming back for, so it does not wait for that.
        if ((isCameraBusy() || !inputQuiet()) && !quick) {
          prefetch(delay);
          return;
        }
        const b = board();
        if (!b || disposed || prefetching || turnRef.current || boardResizeDeferred()) return;
        const view = b.getViewportBounds();
        if (!view) return;
        // Zoomed away from where the page rests: a turn from here takes its own.
        const zoom = view.zoom ?? 1;
        const rest = restZoomRef.current ?? (restZoomRef.current = zoom);
        if (Math.abs(zoom / rest - 1) > 0.02) return;
        // At rest at the page's own zoom: its layers made ready for a turn back.
        if (textSpreadRef.current && !pagedRef.current && lockedRef.current && keepPageLayersReady()) b.pageLayers?.(true);
        const frames = b.readingPageFrames();
        if (frames.length === 0) return;
        const at = currentIndex(frames, lockedRef.current, view);
        const from = frames[at]!;
        const current = () => !disposed && !turnRef.current && !boardResizeDeferred() && (quick || (!isCameraBusy() && inputQuiet())) &&
          board() === b && b.getViewportBounds()?.y === view.y && b.getViewportBounds()?.zoom === view.zoom;
        const signal = restingPictureSignal();
        if (textSpreadRef.current) {
          // This spread, and the ones either side of it, page by page.
          const start = at - (at % 2);
          const pageShot = spreadPageShot(b, frames, signal);
          if (!pageShot) return;
          prefetching = true;
          void (async () => {
            try {
              for (const i of [start, start + 1, start + 2, start + 3, start - 2, start - 1]) {
                if (!current()) return;
                await pageShot(i);
              }
              await thumbPass(b, frames, at, current, signal);
            } finally { prefetching = false; }
          })();
          return;
        }
        const scene = pageScene(b, frames, at);
        if (!scene) return;
        const tl = b.sceneToClient(scene.x, scene.y);
        const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
        if (!tl || !br) return;
        const scale = shotScale(br.x - tl.x, scene.width);
        prefetching = true;
        void (async () => {
          try {
            const here = await shot(b, scene, scale, from.maxY, from.pageId, undefined, signal);
            // The page as it rests, for this tab to show at once if it is
            // reopened — see `resumePicture`.
            const tab = document.querySelector<HTMLElement>(hostSelector)?.getBoundingClientRect();
            if (here && tab && tab.width > 0 && current()) {
              keepResumePicture(filmScope, {
                canvas: here,
                left: tl.x - tab.left,
                top: tl.y - tab.top,
                width: br.x - tl.x,
                height: br.y - tl.y,
                tabWidth: tab.width,
                tabHeight: tab.height,
                paper: turnPaperColor(paperColor(), pagedRef.current),
              });
            }
            // Pages flicked through quickly: the next turn's picture, and the
            // one after it, are ready before the hand comes back for them.
            const ahead = heading === "next" ? 1 : -1;
            const neighbours = quick ? [frames[at + ahead]] : [frames[at + ahead], frames[at - ahead], frames[at + 2 * ahead]];
            for (const neighbour of neighbours) {
              if (!current()) return;
              if (!neighbour) continue;
              await shot(b, { ...scene, y: neighbour.minY + (scene.y - from.minY) }, scale, neighbour.maxY, neighbour.pageId, undefined, signal);
            }
            if (!quick) await thumbPass(b, frames, at, current, signal);
          } finally {
            prefetching = false;
            if (quick && !disposed) prefetch();
          }
        })();
      }, delay);
    };
    const unsubscribeFilm = subscribePdfFilmCurrent(filmScope, () => prefetch());
    // Sharp paints land after the first pictures were taken: look again while
    // the page sits still. Unchanged pictures are kept, not taken twice.
    const recheck = window.setInterval(() => {
      if (!turnRef.current) prefetch();
    }, PREFETCH_RECHECK_MS);

    /** The open spread on screen: both pages, as the board shows them. */
    const spreadRect = () => {
      const r = maskHole()?.getBoundingClientRect();
      return r && r.width > 16 && r.height > 8 ? r : null;
    };

    /** Take (or find) the picture of page `i` of a text spread, at the size it is shown. */
    const spreadPageShot = (b: BoardHandle, frames: readonly PageFrame[], signal?: AbortSignal) => {
      const r = spreadRect();
      const first = frames[0] ? pageBoxScene(b, frames[0]) : null;
      if (!r || !first) return null;
      const scale = shotScale(r.width / 2, first.width);
      return (i: number, onlyIfTaken = pagedRef.current): Promise<HTMLCanvasElement | null> => {
        const f = frames[i];
        const scene = f ? pageBoxScene(b, f) : null;
        return f && scene ? shot(b, scene, scale, f.maxY, f.pageId, onlyIfTaken, signal).then((picture) => withMarks(b, scene, picture)) : Promise.resolve(null);
      };
    };

    /** The kept pictures a turn from `page` will want, decoded ahead (see `pageThumbs`). */
    const warmThumbs = (b: BoardHandle, page: PageFrame, frames: readonly PageFrame[] = b.readingPageFrames()) => {
      const key = thumbBookFor(docKeyRef.current, b, frames);
      const at = frames.findIndex((f) => Math.abs(f.minY - page.minY) < 0.5);
      if (key && at >= 0) void decodeThumbsAround(key, at, heading === "next" ? 1 : -1);
    };

    /** The part `scene` of page `i`'s kept picture, for a single sheet flicked past. */
    const thumbStandIn = (b: BoardHandle, frames: readonly PageFrame[], i: number, scene: Scene): HTMLCanvasElement | null => {
      const picture = thumbPicture(thumbBookFor(docKeyRef.current, b, frames), i);
      const page = frames[i];
      const box = page ? pageBoxScene(b, page) : null;
      if (!picture || !box || !(box.width > 0) || !(box.height > 0)) return null;
      const kx = picture.width / box.width;
      const ky = picture.height / box.height;
      const sw = scene.width * kx;
      const sh = scene.height * ky;
      if (!(sw >= 1) || !(sh >= 1)) return null;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = paperColor();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(picture, (scene.x - box.x) * kx, (scene.y - box.y) * ky, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas;
    };

    /**
     * Pages `lo` to `hi` at thumb `scale`: one picture of them all, cut into
     * one per page, each paper below its own cut (the next page's text is
     * there in the note).
     */
    const thumbRun = async (b: BoardHandle, frames: readonly PageFrame[], lo: number, hi: number, scale: number, signal: AbortSignal) => {
      const first = pageBoxScene(b, frames[lo]!);
      const last = pageBoxScene(b, frames[hi]!);
      if (!first || !last) return null;
      const scene = { x: first.x, y: first.y, width: first.width, height: last.y + last.height - first.y };
      const picture = withMarks(b, scene, await takeShot(new Map(), b, scene, scale, Infinity, "", false, false, signal));
      if (!picture || !(scene.height > 0)) return null;
      const kx = picture.width / scene.width;
      const ky = picture.height / scene.height;
      const paper = paperColor();
      return frames.slice(lo, hi + 1).map((f): HTMLCanvasElement | null => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(first.width * scale));
        canvas.height = Math.max(1, Math.round(first.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = paper;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const shown = Math.min(first.height, f.maxY - f.minY + CUT_BLEED);
        ctx.drawImage(picture, 0, (f.minY - scene.y) * ky, first.width * kx, shown * ky, 0, 0, canvas.width, shown * (canvas.height / first.height));
        return canvas;
      });
    };

    /** Books whose every page was found pictured, with the ink revision then: nothing to look at again until it moves. */
    const thumbsSwept = new Map<string, number>();

    /**
     * Pictures of the note's pages, small and kept (see `pageThumbs`), for
     * the turns that flick past them. Taken while the reader rests, from
     * here outward, the way the reader last went first, until every page has
     * one that shows its ink. A page already pictured at full size for the
     * next turn is shrunk; the others are taken at thumb size, a few at a
     * time (`thumbRun`). Each stops at the next touch, as the other resting
     * pictures do, and the next rest carries on where it left off.
     */
    const thumbPass = async (b: BoardHandle, frames: readonly PageFrame[], at: number, current: () => boolean, signal: AbortSignal) => {
      if (pagedRef.current) return;
      const key = thumbBookFor(docKeyRef.current, b, frames);
      const box = b.readingPageBox();
      if (!key || !box) return;
      const dir = heading === "next" ? 1 : -1;
      void decodeThumbsAround(key, at, dir);
      await openThumbBook(key).loaded;
      const revision = b.getInkRevision();
      if (thumbsSwept.get(key) === revision || !current()) return;
      // Thumb pixels per scene unit: a share of the CSS px the page is shown at.
      const left = b.sceneToClient(box.minX, box.minY);
      const right = b.sceneToClient(box.maxX, box.minY);
      if (!left || !right || !(right.x - left.x > 8)) return;
      const scale = (THUMB_PX_PER_CSS * (right.x - left.x)) / (box.maxX - box.minX);
      const spread = textSpreadRef.current;
      const fullShot = spread ? spreadPageShot(b, frames) : null;
      const near = thumbWindow(at, dir);
      const inks = new Map<number, string>();
      const inkOf = (j: number) => {
        let ink = inks.get(j);
        if (ink === undefined) {
          const scene = pageBoxScene(b, frames[j]!);
          ink = scene ? b.inkSignatureIn?.(scene) ?? "" : "";
          inks.set(j, ink);
        }
        return ink;
      };
      const done = new Set<number>();
      const needs = (j: number) => j >= 0 && j < frames.length && !done.has(j) && thumbInk(key, j) !== inkOf(j);
      const keep = (j: number, small: HTMLCanvasElement) => keepThumb(key, j, small, inkOf(j), j >= near.lo && j <= near.hi);
      for (const i of thumbOrder(at, frames.length, dir, spread ? 2 : 1)) {
        if (!current() || signal.aborted) return;
        if (!needs(i)) {
          done.add(i);
          continue;
        }
        // Pictured at full size for the next turn already: shrunk, a few ms.
        const full = fullShot ? await fullShot(i, true) : null;
        const scene = pageBoxScene(b, frames[i]!);
        if (full && scene) {
          const small = shrinkPicture(full, scene.width * scale, scene.height * scale);
          done.add(i);
          if (small) await keep(i, small);
          continue;
        }
        /*
         * Any other is taken with the pages next to it that need one too, the
         * way the reader is heading first, in one picture. A picture copies
         * only its band of the note but walks the whole of it to keep the
         * band in place, and on a chapter of math that walk was most of its
         * cost: about a second a page on the tablet.
         */
        let lo = i;
        let hi = i;
        for (let j = i + dir; hi - lo + 1 < THUMB_RUN && needs(j); j += dir) {
          if (dir > 0) hi = j;
          else lo = j;
        }
        for (let j = (dir > 0 ? lo : hi) - dir; hi - lo + 1 < THUMB_RUN && needs(j); j -= dir) {
          if (dir > 0) lo = j;
          else hi = j;
        }
        const pictures = await thumbRun(b, frames, lo, hi, scale, signal);
        if (!pictures || !current() || signal.aborted) return;
        for (let j = lo; j <= hi; j += 1) {
          done.add(j);
          const small = pictures[j - lo];
          if (small) await keep(j, small);
        }
        // A touch between two pictures is answered before the next one starts.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      thumbsSwept.set(key, revision);
    };

    /**
     * A turn in a text spread: two pages at a time, like a book — the right
     * page lifts over the spine onto the left, showing the next spread.
     */
    const planSpreadTurn = (
      b: BoardHandle,
      frames: readonly PageFrame[],
      at: number,
      direction: Direction,
      bottom: boolean,
      edgeClientY?: number,
    ): Turn | null => {
      const start = at - (at % 2);
      const toStart = direction === "next" ? start + 2 : start - 2;
      const from = frames[start];
      const to = frames[toStart];
      // Nothing painted to turn to yet: hold here rather than turn over blank paper.
      if (to && pagedRef.current && !pdfPagePainted(hostSelector, to.pageId)) requestPreview(to.pageId);
      const r = spreadRect();
      const pageShot = spreadPageShot(b, frames);
      if (!from || !to || !r || !pageShot) return null;
      const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const canvas = document.createElement("canvas");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.className = "lc-page-turn";
      Object.assign(canvas.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      const w = rect.width / 2;
      const restY = heldAt(rect, bottom, edgeClientY);
      const turn: Turn = {
        direction,
        layout: "book",
        bottom,
        restY,
        from,
        to,
        offsetInPage: 0,
        rect,
        scene: null,
        commit: null,
        byFold: false,
        canvas,
        images: null,
        under: null,
        underSheet: false,
        corner: { x: direction === "next" ? w : -w, y: restY },
        anim: null,
        ready: Promise.resolve(false),
        frame: 0,
        done: false,
        landed: false,
        detached: false,
        sheetOnly: direction === "prev" && [...liveTurns].some(other => other.detached && other.direction === "prev"),
        abort: new AbortController(),
        margin: 0,
      };
      liveTurns.add(turn);
      layers.add(turn);
      /*
       * Pictures only if all four pages already have one. Taking them here
       * held the grab for about a second on the tablet, a third of a second a
       * page. Without them the turn is live, as a single page's is: the board
       * shows the spread being left, live copies show the pages it does not,
       * and the back of the lifting page is plain paper until a later turn
       * has its picture. The prefetch takes them once the hand rests.
       */
      const ids = [start, start + 1, toStart, toStart + 1];
      turn.ready = Promise.all(ids.map((i) => frames[i] ? pageShot(i, true) : Promise.resolve(null))).then(
        ([hereLeft, hereRight, thereLeft, thereRight]) => {
          if (disposed || turn.done) return false;
          const all = (left: HTMLCanvasElement | null, right: HTMLCanvasElement | null, i: number) =>
            (left || !frames[i]) && (right || !frames[i + 1]);
          if (all(hereLeft ?? null, hereRight ?? null, start) && all(thereLeft ?? null, thereRight ?? null, toStart)) {
            const here = composeSpread(hereLeft ?? null, hereRight ?? null);
            const there = composeSpread(thereLeft ?? null, thereRight ?? null);
            if (!here || !there) return false;
            turn.images = direction === "next" ? { from: here, to: there } : { from: there, to: here };
          } else {
            turn.images = { from: null, to: null };
            turn.under = liveSpread(b, turn, frames, toStart, flicking());
          }
          mountTurnCanvas(turn);
          draw(turn);
          return true;
        },
        () => false,
      );
      return turn;
    };

    /**
     * Plan a turn from the page in view — or, `after` a turn that has just
     * landed, from the page it landed on. That page is where the old picture
     * was, on the same spot of the screen, even before the camera's jump has
     * reached the board's reported view.
     */
    const planTurn = (direction: Direction, bottom: boolean, after?: Turn, edgeClientY?: number): Turn | null => {
      const b = board();
      if (!b) return null;
      const view = b.getViewportBounds();
      const frames = b.readingPageFrames();
      if (!view || frames.length === 0) return null;
      const landed = after ? frames.findIndex((f) => Math.abs(f.minY - after.to.minY) < 0.5) : -1;
      const at = landed >= 0 ? landed : currentIndex(frames, lockedRef.current, view);
      if (textSpreadRef.current) return planSpreadTurn(b, frames, at, direction, bottom, edgeClientY);
      const toIndex = direction === "next" ? at + 1 : at - 1;
      const from = frames[at];
      const to = frames[toIndex];
      if (!from || !to) return null;
      // Nothing painted to turn to yet: hold here rather than turn over blank paper.
      if (pagedRef.current && !pdfPagePainted(hostSelector, to.pageId)) requestPreview(to.pageId);
      // The visible part of this page — the page, not the view around it —
      // and where it is on screen.
      let scene: Scene | null;
      let rect: Turn["rect"];
      if (landed >= 0 && after?.scene) {
        scene = { ...after.scene, y: from.minY + (after.scene.y - after.from.minY) };
        rect = { ...after.rect };
      } else {
        scene = pageScene(b, frames, at);
        if (!scene) return null;
        const tl = b.sceneToClient(scene.x, scene.y);
        const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
        if (!tl || !br) return null;
        rect = { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y };
      }
      if (rect.width < 8 || rect.height < 8) return null;
      // A landscape sheet is two pages side by side: it turns about its spine.
      const columnWidth = (() => {
        const box = b.readingPageBox();
        return box ? box.maxX - box.minX : view.width;
      })();
      const layout: TurnLayout =
        pagedRef.current && !spreadRef.current && from.maxY - from.minY < columnWidth * 0.9 ? "book" : "sheet";
      // A single sheet's booktabs stick out past it: room for them around the page.
      const margin = layout === "sheet" ? EDGE_MARGIN : 0;
      const canvas = document.createElement("canvas");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round((rect.width + 2 * margin) * dpr);
      canvas.height = Math.round((rect.height + 2 * margin) * dpr);
      canvas.className = "lc-page-turn";
      Object.assign(canvas.style, {
        left: `${rect.left - margin}px`,
        top: `${rect.top - margin}px`,
        width: `${rect.width + 2 * margin}px`,
        height: `${rect.height + 2 * margin}px`,
      });
      const w = layout === "book" ? rect.width / 2 : rect.width;
      const restY = heldAt(rect, bottom, edgeClientY);
      const turn: Turn = {
        direction,
        layout,
        bottom,
        restY,
        from,
        to,
        // With the page fitted the view starts above it; land on the top.
        offsetInPage: after && landed >= 0 ? after.offsetInPage : Math.max(0, view.y - from.minY),
        rect,
        scene,
        commit: null,
        // One sheet coming back starts off the page, over the binding: the
        // hand can only hold its crease. Everything else, its corner.
        byFold: layout === "sheet" && direction === "prev",
        canvas,
        margin,
        images: null,
        under: null,
        underSheet: false,
        corner: { x: direction === "next" ? w : -w, y: restY },
        anim: null,
        ready: Promise.resolve(false),
        frame: 0,
        done: false,
        landed: false,
        detached: false,
        sheetOnly: direction === "prev" && [...liveTurns].some(other => other.detached && other.direction === "prev"),
        abort: new AbortController(),
      };
      liveTurns.add(turn);
      layers.add(turn);
      // Capture both pages at the size they are drawn. The page being turned to
      // is taken at the same place within it the view shows of this one.
      const scale = shotScale(rect.width, scene.width);
      const toScene = { ...scene, y: to.minY + (scene.y - from.minY) };
      /*
       * Never clone and style the document on input: only pictures already
       * taken. A PDF copies its bitmaps in a few ms. A text page has no
       * pixels to copy, and taking its two pictures here held the grab for
       * most of a second on the tablet before the sheet could lift. Without
       * them it turns as it does mid-flick: the live page where the sheet
       * still lies, a live copy of the next one under it, plain paper on the
       * back. The prefetch after the view rests takes the pictures for later.
       */
      const fast = true;
      const hereShot = shot(b, scene, scale, from.maxY, from.pageId, fast).then((picture) => withMarks(b, scene, picture));
      const thereShot = (pagedRef.current
        ? waitForPdfTurnPreview(document.querySelector(hostSelector), to.pageId, turn.abort.signal)
          .then(ready => ready && !disposed && !turn.done ? shot(b, toScene, scale, to.maxY, to.pageId, fast) : null)
        : shot(b, toScene, scale, to.maxY, to.pageId, fast)).then((picture) => withMarks(b, toScene, picture));
      // Turning back is turning forward from the previous page, reversed.
      const place = (here: HTMLCanvasElement | null, there: HTMLCanvasElement | null) => {
        turn.images = direction === "next" ? { from: here, to: there } : { from: there, to: here };
      };
      /*
       * The page being left is almost always pictured already: it was the
       * last turn's destination. The page being turned to may not be — a hand
       * flicking through outruns taking it (a few hundred ms of the main
       * thread a page), and a turn that waited for it played no animation at
       * all. So it turns at once over plain paper, and the page appears on
       * that paper the moment its picture lands, even mid-turn.
       */
      // The page this turn leaves is the one the last turn landed on, and that
      // turn already held a picture of it (real, or paper still filling in).
      const landedPicture = landed >= 0 && after?.images
        ? (after.direction === "next" ? after.images.to : after.images.from)
        : null;
      turn.ready = (async () => {
        // The caller makes this the current turn after planning returns.
        await Promise.resolve();
        const grace = () => new Promise<null>((resolve) => window.setTimeout(() => resolve(null), TO_PICTURE_GRACE_MS));
        /*
         * The page being left is the live page under the canvas: a single
         * sheet can turn without a picture of it, the page showing through
         * where it still lies. Hands flicking faster than pages can be
         * pictured get every turn, not every other one.
         */
        let here = landedPicture ?? (await Promise.race([hereShot, grace()]));
        if (!here && layout === "book") here = await hereShot;
        if (disposed || turn.done || (!here && layout === "book")) return false;
        // Hold on this page until the requested preview exists. The gesture
        // remains registered; sharp rendering is not required to turn it.
        let there = pagedRef.current ? await thereShot : await Promise.race([thereShot, grace()]);
        if (disposed || turn.done || (pagedRef.current && !there)) return false;
        // No picture of a text page in time: the page itself, live. Flicking
        // through, plain paper: the board shows the page once it lands.
        if (!there && !pagedRef.current && layout === "sheet" && !flicking()) turn.under = liveUnder(b, turn, toScene, scale, to);
        // Flicking through, its kept picture (see `pageThumbs`), if it has one.
        const stand = !there && !turn.under && !pagedRef.current ? thumbStandIn(b, frames, toIndex, toScene) : null;
        const blank = there || turn.under || stand
          ? null
          : blankSheet(here ?? { width: Math.max(1, Math.round(scene.width * scale)), height: Math.max(1, Math.round(scene.height * scale)) });
        place(here, there ?? stand ?? blank);
        // Whichever picture arrives late takes its place, even mid-turn.
        const arrive = (which: "here" | "there") => (picture: HTMLCanvasElement | null) => {
          if (!picture || disposed || turn.done || turn.detached) return;
          if (which === "here") {
            if (picture === here) return;
            here = picture;
          } else {
            if (picture === there) return;
            there = picture;
          }
          place(here, there ?? stand ?? blank);
          draw(turn);
        };
        void hereShot.then(arrive("here"));
        // The live page is the page itself: nothing to swap in.
        if (!there && !turn.under) void thereShot.then(arrive("there"));
        mountTurnCanvas(turn);
        draw(turn);
        return true;
      })().catch(() => false);
      return turn;
    };

    /** Paint the sheet where its corner is now. */
    const paint = (turn: Turn) => {
      const ctx = turn.canvas.getContext("2d");
      if (!ctx || !turn.images) return;
      const dpr = turn.canvas.width / (turn.rect.width + 2 * turn.margin);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (turn.margin) ctx.clearRect(0, 0, turn.canvas.width, turn.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, turn.margin * dpr, turn.margin * dpr);
      paintTurn(ctx, {
        layout: turn.layout,
        width: turn.rect.width,
        height: turn.rect.height,
        from: turn.images.from,
        to: turn.images.to,
        sourceWidth: (turn.images.from ?? turn.images.to)?.width ?? 1,
        sourceHeight: (turn.images.from ?? turn.images.to)?.height ?? 1,
        corner: turn.corner,
        bottom: turn.bottom,
        restY: turn.restY,
        paper: turnPaperColor(paperColor(), pagedRef.current),
        sheetOnly: turn.sheetOnly,
        toBlur: softenedPicture(turn.images.to),
        back: turn.back ?? null,
        liveBack: Boolean(turn.spreadLive?.back || turn.borrowed),
        fromEdge: turn.margin && turn.images.from ? edges.get(turn.images.from) ?? null : null,
        toEdge: turn.margin && turn.images.to ? edges.get(turn.images.to) ?? null : null,
        fromMarks: turn.images.from ? marksAlone.get(turn.images.from) ?? null : null,
      });
      clipUnder(turn);
    };

    /** Paint on the next frame — for a hand, whose moves come between frames. */
    const draw = (turn: Turn) => {
      if (!turn.images || turn.frame) return;
      turn.frame = requestAnimationFrame(() => {
        turn.frame = 0;
        paint(turn);
      });
    };

    const teardown = (turn: Turn) => {
      if (turn.done) return;
      turn.done = true;
      turn.abort.abort();
      stopSharpening(turn);
      // Settled back flat, or landed already: the board has its page back.
      returnBoard(turn);
      liveTurns.delete(turn);
      if (turnRef.current === turn) {
        turnRef.current = null;
      }
      if (!turnRef.current) setTurning(false);
      if (turn.frame) cancelAnimationFrame(turn.frame);
      // Two frames: the camera's jump has to reach the screen before the
      // picture of where it was going stops covering it.
      const removeLayers = () => {
        // A newer returning sheet can finish before the older one below it.
        // Keep its resting picture above that sheet until the latter lands.
        if (!disposed && turn.direction === "prev" && [...liveTurns].some(other => other.detached && other.direction === "prev")) {
          requestAnimationFrame(removeLayers);
          return;
        }
        turn.canvas.remove();
        turn.under?.remove();
        // Not landed: its right page, built in the facing slot, goes too.
        turn.spreadLive?.right?.remove();
        stopSliding(turn.spreadLive?.windows);
        layers.delete(turn);
        if (turn.marksHidden) {
          turn.marksHidden = false;
          hideMarks(false);
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(removeLayers));
    };

    const land = (turn: Turn) => {
      if (turn.landed) return;
      const b = board();
      if (!b) return;
      turn.landed = true;
      notePageTurn(filmScope);
      if (pagedRef.current) publishPdfReadAhead(filmScope, turn.direction === "next" ? 1 : -1);
      lockedRef.current = turn.to;
      restZoomRef.current = null;
      b.setPageLock(turn.to);
      b.jumpToPageFrame({ ...turn.to, minY: turn.to.minY + turn.offsetInPage });
      // With the camera's jump: no frame shows the lent page twice, or home.
      const lentPages = turn.borrowed?.pages ?? null;
      returnBoard(turn);
      heading = turn.direction;
      // The spread lands with its left page held: the right one, which the
      // turn already shows live, is the facing page.
      paperFacing = null;
      const facingCopy = turn.spreadLive?.right;
      const facingEl = maskFacing();
      const frames = turn.spreadLive ? b.readingPageFrames() : [];
      const facingPage = frames[frames.findIndex((f) => Math.abs(f.minY - turn.to.minY) < 0.5) + 1];
      if (facingCopy && facingEl && facingPage && !facingEl.hidden) {
        // Shown through windows while the board's page was lent, or past the
        // fold turning on: whole now.
        const through = lentPages?.right ?? turn.spreadLive?.windows?.right;
        if (through?.holder === facingCopy) restWindows(through, true);
        if (facingCopy.parentNode === facingEl) {
          // Built in the slot (see `liveSpread`): it stays as laid out.
          facingCopy.style.clipPath = "none";
          for (const child of Array.from(facingEl.children)) if (child !== facingCopy) child.remove();
        } else {
          Object.assign(facingCopy.style, { left: "0", clipPath: "none" });
          facingEl.replaceChildren(facingCopy);
        }
        facingHandoffRef.current = { minY: facingPage.minY };
        if (turn.spreadLive) turn.spreadLive.right = null;
        // Still soft: drawn once the hand stops. Copied while the hand held
        // the sheet: ready for a turn back, as one drawn then would be.
        paperFacing = turn.soft?.right ? { holder: facingCopy, w: turn.rect.width / 2, H: turn.rect.height } : null;
        if (turn.soft?.sharpRight && !lentPages?.right) keepFacingReady(facingCopy);
      }
      const flipping = flicking();
      lastLandAt = performance.now();
      landedAtRef.current = lastLandAt;
      if (paperFacing && !paperFillTimer) paperFillTimer = window.setTimeout(fillPaperFacing, paperFillMs());
      // The kept pictures the next turns this way will want, out of the landing's frame.
      if (!pagedRef.current) window.setTimeout(() => { if (!disposed) warmThumbs(b, turn.to, frames.length > 0 ? frames : undefined); }, 0);
      // Mid-flick, the next picture waits for the hand to rest. So does a
      // text page's, always: its pictures are about half a second of the
      // main thread each, and taken just after landing they held the next
      // grab back by a second. A grab needs none now (see `planTurn`).
      prefetch(flipping || !pagedRef.current ? PREFETCH_IDLE_MS : LANDED_PREFETCH_MS);
    };

    /**
     * The facing page a turn flicked through left as plain paper (see
     * `liveSpread`), drawn once the hand stops on it: no turn going, none
     * lined up, no finger down, and `paperFillMs` since the last landing or
     * touch. A hand still flicking turns it over first, and it is never drawn.
     * On a touch screen it is kept ready for a turn back (`keepFacingReady`).
     */
    let paperFacing: { holder: HTMLElement; w: number; H: number } | null = null;
    let paperFillTimer = 0;
    const fillPaperFacing = () => {
      paperFillTimer = 0;
      const p = paperFacing;
      const el = maskFacing();
      // Gone: turned over, swapped for the held page, or pictured.
      if (disposed || !p || !el || el.hidden || p.holder.parentNode !== el) {
        paperFacing = null;
        return;
      }
      const wait = paperFillMs() - (performance.now() - Math.max(lastLandAt, lastPressAt));
      const pane = document.querySelector<HTMLElement>(hostSelector);
      if (wait > 0 || turnRef.current || active || queued || (pane && touchPointersIn(pane).size > 0)) {
        paperFillTimer = window.setTimeout(fillPaperFacing, Math.max(50, wait));
        return;
      }
      paperFacing = null;
      // Still the page facing the one held, as the landing left it.
      const b = board();
      const held = lockedRef.current;
      const handoff = facingHandoffRef.current;
      const surface = boardSurface() ?? pane;
      if (!b || !held || !handoff || !surface) return;
      const frames = b.readingPageFrames();
      const i = frames.findIndex((f) => Math.abs(f.minY - held.minY) < 0.5);
      const frame = i >= 0 && i % 2 === 0 ? frames[i + 1] : undefined;
      if (frame && Math.abs(frame.minY - handoff.minY) < 0.5) {
        // Its kept picture goes: the copy's text over it would show double.
        p.holder.replaceChildren();
        fillPage(b, p.holder, frame, p.w, p.H, surface, () => p.holder.isConnected);
        keepFacingReady(p.holder);
      }
    };

    /** Move navigation on while this sheet finishes its own animation. */
    const continueTurn = (turn: Turn) => {
      if (turn.done) return;
      // A live spread's sheet is the board behind it: landing moves the board,
      // so the sheet goes with it rather than finishing over the next spread.
      if (turn.spreadLive) {
        turn.anim = null;
        if (turn.commit) land(turn);
        teardown(turn);
        return;
      }
      if (!turn.commit || !turn.images) {
        turn.anim = null;
        teardown(turn);
        return;
      }
      // A text snapshot can still be pending. Retain that page's HTML,
      // clipped to its own sheet, before the camera leaves it.
      if (turn.layout === "sheet" && !turn.images.from) {
        if (turn.direction === "next" && turn.scene) {
          turn.under?.remove();
          const b = board();
          turn.under = b ? liveUnder(b, turn, turn.scene, shotScale(turn.rect.width, turn.scene.width), turn.from) : null;
          if (turn.under && turn.canvas.parentNode) {
            // The page itself, not the canvas's room around it for booktabs.
            turn.under.style.left = `${parseFloat(turn.canvas.style.left) + turn.margin}px`;
            turn.under.style.top = `${parseFloat(turn.canvas.style.top) + turn.margin}px`;
            turn.under.style.zIndex = "45";
            turn.canvas.before(turn.under);
          }
        }
        turn.underSheet = true;
      } else {
        turn.under?.remove();
        turn.under = null;
      }
      land(turn);
      turn.detached = true;
      if (turn.direction === "next") turn.sheetOnly = true;
      if (turnRef.current === turn) turnRef.current = null;
      if (!turn.anim) settle(turn, true);
      draw(turn);
    };

    /** Turns queued by a key pressed while one was playing. */
    let queued: { direction: Direction; count: number } | null = null;

    /**
     * A sheet in motion, held or rolling: the PDF's sharp paint waits until it
     * has been still a moment (see `pageTurnBusy`). Said at most every 100 ms.
     */
    let turningNotedAt = -Infinity;
    const stillTurning = () => {
      const now = performance.now();
      if (now - turningNotedAt < 100) return;
      turningNotedAt = now;
      notePageTurn(filmScope);
    };

    const step = (turn: Turn, animation = turn.anim) => (now: number) => {
      const a = animation;
      // A caught or reversed sheet invalidates the old animation, including a
      // callback already queued before the new finger went down.
      if (turn.done || !a || turn.anim !== a) return;
      stillTurning();
      const t = Math.min(1, Math.max(0, (now - a.began) / a.ms));
      const k = glide(t, a.launch);
      // The corner rises off the page as it rolls and settles back down onto
      // it, rather than sliding across in a straight line.
      // A corner rises off the page as it rolls; a sheet held mid-side does
      // not lift its middle, so the rise fades toward the middle of the edge.
      const half = turn.rect.height / 2;
      const edge = half > 0 ? Math.min(1, Math.abs(turn.restY - half) / half) : 1;
      const rise = Math.sin(Math.PI * k) * a.lift * edge;
      turn.corner = {
        x: a.start.x + (a.goal.x - a.start.x) * k,
        y: a.start.y + (a.goal.y - a.start.y) * k + (turn.bottom ? -rise : rise),
      };
      // Already inside a frame: paint now, not a frame late.
      if (turn.frame) {
        cancelAnimationFrame(turn.frame);
        turn.frame = 0;
      }
      paint(turn);
      if (t < 1) {
        requestAnimationFrame(step(turn, a));
        return;
      }
      if (a.commit) land(turn);
      teardown(turn);
      if (!turnRef.current) nextQueued(turn);
    };

    /**
     * Play the corner from where it is to fully over, or back to rest.
     *
     * Let go by a hand (`fullMs` unset), the sheet leaves at the speed the
     * hand was moving (`speed`, px/ms), then slows into place — a flick rolls
     * on quickly, a hand that had stopped lets the page ease away from rest.
     * Either way it takes long enough to be seen rolling. Played for a key,
     * it takes `fullMs` for a whole turn. Without pictures yet, it waits a
     * moment for them — a fast turn still shows the page turning.
     */
    const settle = (turn: Turn, commit: boolean, { fullMs, speed = 0 }: { fullMs?: number; speed?: number } = {}) => {
      turn.commit = commit;
      if (!commit && !turn.images && pagedRef.current) {
        queued = null;
        teardown(turn);
        return;
      }
      const run = () => {
        if (turn.done) return;
        const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
        // Finishing means reaching the end the turn is headed for.
        const goal = {
          x: (turn.direction === "next") === commit ? -w : w,
          y: turn.restY,
        };
        const start = { ...turn.corner };
        const px = Math.max(1, Math.hypot(goal.x - start.x, goal.y - start.y));
        let ms: number;
        let launch = 0;
        if (fullMs != null) {
          ms = Math.max(80, fullMs * (Math.abs(goal.x - start.x) / (2 * w)));
        } else {
          // Held by the crease, the corner moves twice as fast as the hand.
          const corner = speed * (turn.byFold ? 2 : 1);
          ms = rollMs(px, corner);
          launch = Math.min(GLIDE_MAX_LAUNCH, (corner * ms) / px);
        }
        const lift = Math.min(turn.rect.height * 0.06, 44) * Math.min(1, Math.abs(goal.x - start.x) / (2 * w));
        turn.anim = { began: performance.now(), ms, start, goal, commit, launch, lift };
        requestAnimationFrame(step(turn));
      };
      if (turn.images) {
        run();
        return;
      }
      let decided = false;
      const giveUp = pagedRef.current ? 0 : window.setTimeout(() => {
        if (decided) return;
        decided = true;
        if (turn.done) return;
        if (commit) land(turn);
        teardown(turn);
        nextQueued();
      }, PICTURE_WAIT_MS);
      void turn.ready.then((ok) => {
        if (decided) return;
        decided = true;
        window.clearTimeout(giveUp);
        if (turn.done) return;
        if (ok) {
          run();
          return;
        }
        if (commit && !pagedRef.current) land(turn);
        if (pagedRef.current) queued = null;
        teardown(turn);
        nextQueued();
      });
    };

    /**
     * A live spread's sheet going over when the next flick comes.
     *
     * Its pages are the board itself (see `liveSpread`): it cannot finish
     * over the next spread the way a pictured sheet does, and putting it down
     * at once made each quick turn after the first a jump with no turn shown.
     * It hurries to land instead, and the next turn plays from there.
     */
    const chainsAfter = (turn: Turn | null): boolean =>
      Boolean(turn && turn.commit && turn.spreadLive && !turn.done);
    /**
     * A turn on its way over, that a flick already under way lines up
     * behind: a PDF page's preview still coming, a live spread landing, or a
     * pictured sheet going over. A flick that touched down before that
     * pictured sheet set off (a live spread or a preview still coming then)
     * used to be dropped when it moved: a pictured sheet is caught by a touch
     * that lands on it, and this one had landed before.
     */
    const waitsForTurn = (turn: Turn | null): boolean =>
      Boolean(turn?.commit && !turn.done);

    /** Finish a sheet going over within `HURRY_MS`, from where it is and at the pace it has. */
    const hurry = (turn: Turn) => {
      const a = turn.anim;
      if (!a || !a.commit || turn.done) return;
      const now = performance.now();
      const t = Math.min(1, Math.max(0, (now - a.began) / a.ms));
      if ((1 - t) * a.ms <= HURRY_MS) return;
      const speed = ((a.goal.x - a.start.x) * glideSlope(t, a.launch)) / a.ms;
      const left = a.goal.x - turn.corner.x;
      turn.anim = {
        began: now, ms: HURRY_MS, start: { ...turn.corner }, goal: a.goal, commit: true,
        launch: launchFor(speed, left, HURRY_MS), lift: 0,
      };
      requestAnimationFrame(step(turn));
    };

    /** Line up one more turn `direction`, behind any already lined up the same way. */
    const queueTurn = (direction: Direction) => {
      notePageTurn(filmScope);
      turnsTaken += 1;
      const count = queued?.direction === direction ? queued.count : 0;
      queued = { direction, count: Math.min(KEY_QUEUE_MAX, count + 1) };
    };

    const keyTurn = (direction: Direction, ms: number, after?: Turn): boolean => {
      const turn = planTurn(direction, true, after);
      if (!turn) return false;
      notePageTurn(filmScope);
      turnRef.current = turn;
      settle(turn, true, { fullMs: ms });
      return true;
    };

    const nextQueued = (after?: Turn) => {
      const q = queued;
      if (!q) return;
      // The next frame: the landing camera has to be in place to plan from.
      requestAnimationFrame(() => {
        if (disposed || turnRef.current || active || queued !== q) return;
        q.count -= 1;
        if (q.count <= 0) queued = null;
        const landed = after?.landed && lockedRef.current && Math.abs(lockedRef.current.minY - after.to.minY) < 0.5 ? after : undefined;
        if (!keyTurn(q.direction, QUICK_TURN_MS, landed)) queued = null;
      });
    };

    /* ---------------------------------------------------------- gesture */

    // Side strips and corner triangles own turning. The body keeps scrolling
    // and selection; a stylus with a drawing tool up keeps all but the corners.
    const host = () => document.querySelector<HTMLElement>(hostSelector);
    const holeEl = maskHole;
    const pageRect = (): DOMRect | null => {
      const hole = holeEl();
      if (!hole || (hole.parentElement as HTMLElement | null)?.hidden) return null;
      if (hole.dataset.turnEdges == null) hole.dataset.turnEdges = "";
      const rect = hole.getBoundingClientRect();
      hole.style.setProperty("--lc-turn-corner", `${turnCornerSize(rect)}px`);
      return rect.width > 8 && rect.height > 8 ? rect : null;
    };
    const edgeAt = (event: PointerEvent): "left" | "right" | null => {
      const r = pageRect();
      return r ? turnGripAt(r, event.clientX, event.clientY, event.pointerType, board()?.getActiveTool?.()) : null;
    };
    /*
     * Marks go on the page's hole, never the tab's host: a toggle there
     * restyled the whole document under it, 300-500 ms on a long PDF. A
     * mouse's cursor is set on the host; a finger has none to change.
     */
    let mouse = false;
    /*
     * The hover shows the turn's first moment where it would start: a corner
     * lifting as a small curled lip (the top or bottom one, as the turn picks
     * by half), or the side edge rising when the side strip is held. The
     * part stays set when the hover ends, so the lip shrinks back into the
     * same corner instead of jumping.
     */
    const setHover = (edge: "left" | "right" | null, at?: { clientX: number; clientY: number }) => {
      const hole = holeEl();
      if (hole) {
        if (edge) {
          const r = at ? hole.getBoundingClientRect() : null;
          const part = !r || !at ? "side"
            : turnCornerAt(r, at.clientX, at.clientY) === null ? "side"
            : at.clientY - r.top < r.height / 2 ? "top" : "bottom";
          const lip = `${edge}-${part}`;
          if (hole.dataset.turnLip !== lip) {
            hole.dataset.turnLip = lip;
            hole.style.setProperty("--lc-turn-paper", turnPaperColor(paperColor(), pagedRef.current));
          }
          if (hole.dataset.turnHover !== edge) hole.dataset.turnHover = edge;
        } else if (hole.dataset.turnHover != null) delete hole.dataset.turnHover;
      }
      const el = host();
      if (el && mouse && !turnRef.current) el.style.cursor = edge ? "grab" : "";
    };
    /*
     * Glass over the page text while flicking through.
     *
     * Every touch starts with the browser looking up what is under the
     * finger: three times on the way down (the touch's area, its point, the
     * pointer's target) and once on the way up. Over a text page that walked
     * every positioned box in the note, and a note of math has thousands of
     * KaTeX parts: 10-15 ms each time on the tablet, about 150 ms of a run of
     * eight flicks, to find a word or the board behind, which a flick has no
     * use for. While a sheet moves, and `GLASS_REST_MS` after it lands, the
     * board's own `::after` lies over the text (see `.lc-board[data-turn-glass]`
     * in styles.css): the lookup ends on it at once, on the board.
     *
     * Over the text, presses reach the board and not the text: a hold to
     * select is not taken. So the glass is not up for long after a landing,
     * comes off at once when a press turns nothing (a tap: what it tapped is
     * looked up again, under no glass), and is never up while the text is
     * being marked or edited.
     */
    let turnsTaken = 0;
    let glassTimer = 0;
    let glassPress: { id: number; taken: number; timer: number } | null = null;
    const glassUp = () => boardSurface()?.dataset.turnGlass === "on";
    const raiseGlass = () => {
      if (disposed) return;
      const surface = boardSurface();
      const text = surface?.querySelector(":scope > .lc-page-content-slot");
      if (!surface || !text) return;
      if (surface.classList.contains("lc-board-highlighting") || text.classList.contains("lc-page-content-editing")) return;
      window.clearTimeout(glassTimer);
      glassTimer = 0;
      if (surface.dataset.turnGlass !== "on") surface.dataset.turnGlass = "on";
    };
    const lowerGlass = () => {
      window.clearTimeout(glassTimer);
      glassTimer = 0;
      if (glassPress) window.clearTimeout(glassPress.timer);
      glassPress = null;
      const surface = boardSurface();
      // Left in place, off: raising it again is a style change, not a new box.
      if (surface?.dataset.turnGlass === "on") surface.dataset.turnGlass = "";
    };
    /** Off once no sheet is moving and `GLASS_REST_MS` have gone by since the last landing. */
    const lowerGlassAtRest = () => {
      window.clearTimeout(glassTimer);
      glassTimer = 0;
      if (disposed || !glassUp()) return;
      // A sheet still moving asks again when it is done (see `setTurning`).
      if (turnRef.current || active || liveTurns.size > 0) return;
      const wait = GLASS_REST_MS - (performance.now() - lastLandAt);
      if (wait > 0) glassTimer = window.setTimeout(lowerGlassAtRest, wait);
      else lowerGlass();
    };
    /** A press on the glass: off if it has turned no page by the time a flick would have. */
    const pressOnGlass = (event: PointerEvent, taken: number) => {
      if (!event.isPrimary || turnsTaken !== taken || !glassUp()) return;
      if (glassPress) window.clearTimeout(glassPress.timer);
      const id = event.pointerId;
      glassPress = {
        id,
        taken,
        timer: window.setTimeout(() => {
          if (glassPress?.id !== id) return;
          glassPress = null;
          if (turnsTaken === taken && active?.id !== id) lowerGlass();
        }, BODY_FLICK_WINDOW_MS),
      };
    };
    /** Let go: a press that turned nothing was a tap, and what handles it reads the text under it. */
    const liftOffGlass = (event: PointerEvent) => {
      const press = glassPress;
      if (!press || press.id !== event.pointerId) return;
      window.clearTimeout(press.timer);
      glassPress = null;
      if (turnsTaken === press.taken) lowerGlass();
    };
    const setTurning = (on: boolean) => {
      if (on) window.getSelection()?.removeAllRanges();
      const el = host();
      if (el && mouse) el.style.cursor = on ? "grabbing" : "";
      if (on) {
        turnsTaken += 1;
        raiseGlass();
      } else lowerGlassAtRest();
    };
    // While a page turns, nothing on it selects.
    const noSelect = (event: Event) => {
      if (turnRef.current || active) event.preventDefault();
    };
    document.addEventListener("selectstart", noSelect, true);
    const edgesHole = holeEl();
    if (edgesHole) edgesHole.dataset.turnEdges = "";

    let active: {
      id: number;
      x: number;
      y: number;
      turn: Turn;
      vx: number;
      lastX: number;
      lastT: number;
      /** Where the hand was last seen, sampled for speed or not. */
      atX: number;
      /** Where the hand has been lately, for its pace at release — see `releaseSpeed`. */
      trail: { x: number; t: number }[];
      /** Where along x the hand first took hold, for how far it carried the sheet. */
      fromX: number;
      caughtCorner?: Point;
      /**
       * Caught while going over. Pushed on its way it is put down and the
       * next page taken; a thumb flicking through lands on the rolling sheet
       * as often as on the strip, and that swipe must not just finish it.
       */
      goingOver?: boolean;
    } | null = null;

    /**
     * Where the sheet's corner is for a hand at this point of the screen.
     *
     * Held by its corner, the corner is under the fingertip — touched in
     * the corner's triangle, it peels to the finger at once, and stays with
     * it. Held by its crease (one sheet coming back), the crease is.
     */
    const cornerAt = (turn: Turn, clientX: number, clientY: number, fromY: number): Point => {
      const book = turn.layout === "book";
      const w = book ? turn.rect.width / 2 : turn.rect.width;
      const x = clientX - turn.rect.left - (book ? w : 0);
      const tilt = heldBySide(turn) ? SIDE_TILT : 1;
      if (turn.byFold) return cornerForCrease(x, (clientY - fromY) * tilt, w, turn.rect.height, turn.bottom, turn.restY);
      if (tilt < 1) return cornerForGrip({ x, y: turn.restY + (clientY - fromY) * tilt }, 0, 0, w, turn.rect.height, turn.bottom, turn.restY);
      return cornerForGrip({ x, y: clientY - turn.rect.top }, 0, 0, w, turn.rect.height, turn.bottom, turn.restY);
    };

    const inHost = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest(hostSelector)) &&
      !target.closest(
        "button, a, input, textarea, select, [role='menu'], [role='dialog'], .lc-board-chrome-slot, .lc-map-controls," +
          " .lc-doc-footnote, .lc-doc-footnote-pack, .lc-footnote-bubble, .lc-doc-select-overlay, .lc-doc-sheet, .lc-doc-confirm",
      );

    /**
     * Take hold of the page at a corner: the turn starts under the finger on
     * touch, before it has moved, so there is no dead distance between a
     * swipe and the page following it. The right corners turn forward and the
     * left ones back, whichever way the hand then goes.
     */
    const grip = (event: PointerEvent, side: "left" | "right", after?: Turn): boolean => {
      const r = pageRect();
      if (!r) return false;
      const direction: Direction = side === "right" ? "next" : "prev";
      const bottom = event.clientY > r.top + r.height / 2;
      // A corner peels from its corner; the side strip is held where it was taken.
      const byCorner = turnCornerAt(r, event.clientX, event.clientY) !== null;
      const turn = planTurn(direction, bottom, after, byCorner ? undefined : event.clientY);
      if (!turn) return false; // first or last page: nothing to turn to
      notePageTurn(filmScope);
      turnRef.current = turn;
      setTurning(true);
      turn.corner = cornerAt(turn, event.clientX, event.clientY, event.clientY);
      active = {
        id: event.pointerId, x: event.clientX, y: event.clientY, turn,
        vx: 0, lastX: event.clientX, lastT: event.timeStamp, atX: event.clientX,
        trail: [{ x: event.clientX, t: event.timeStamp }], fromX: event.clientX,
      };
      draw(turn);
      return true;
    };

    /**
     * The hand's pace when it let go, px per ms: how far it went over about
     * the last `RELEASE_SPEED_MS`. A running average lags behind a quick
     * flick's first moves, and a short flick is nothing but first moves.
     */
    const releaseSpeed = (trail: readonly { x: number; t: number }[]): number => {
      const last = trail[trail.length - 1];
      if (!last) return 0;
      let first = last;
      for (let i = trail.length - 2; i >= 0; i -= 1) {
        first = trail[i]!;
        if (last.t - first.t >= RELEASE_SPEED_MS) break;
      }
      const dt = last.t - first.t;
      return dt > 0 ? (last.x - first.x) / dt : 0;
    };

    /*
     * A flick that starts on the body of the page, not at its edge.
     *
     * The edge strips are where a page is taken hold of; a hand flicking
     * through does not aim for them, and the left one is where Android's own
     * Back swipe lives. A swipe from anywhere on the page that is quick and
     * mostly sideways turns it too: forward going left, back going right.
     * Until it is plainly that, the touch is the page's: scrolling, selecting,
     * a code block's own sideways scroll.
     */
    let pending: {
      id: number; x: number; y: number; t: number; target: EventTarget | null;
      /** Started inside a strip's reach: a slow sideways drag inward takes hold too. */
      reach?: "left" | "right" | null;
    } | null = null;
    /**
     * Other touches that landed while a turn was held: the heel of the hand
     * or a finger of the hand holding the tablet. Not a pinch — they would
     * have dropped the sheet the thumb was carrying — so nothing gets them.
     */
    const strays = new Set<number>();
    /** True while `startFlick` cancels the page's own handling of a touch it took. */
    let cancelling = false;

    /** Turn the page for a body flick that has just shown itself, from where it started. */
    const startFlick = (event: PointerEvent, start: NonNullable<typeof pending>): boolean => {
      const r = pageRect();
      if (!r) return false;
      // A code block or a wide equation scrolls sideways itself. The board
      // keeps the list of those, as its own sideways drag uses it: listing
      // them here matched a selector against every element of the note, a
      // sixth of the frame a turn started in.
      const surface = boardSurface();
      if (surface) invalidateBoardScrollHostLayout(surface);
      const scroller = (surface ? hitBoardScrollHostAtPoint(start.x, start.y, surface) : null) ?? nestedScrollHost(start.target);
      if (scroller && hasSideScrollRoom(scroller)) return false;
      const direction: Direction = event.clientX < start.x ? "next" : "prev";
      const heldY = Math.min(r.bottom - 1, Math.max(r.top + 1, start.y));
      const turn = planTurn(direction, heldY > r.top + r.height / 2, undefined, heldY);
      if (!turn) return false;
      notePageTurn(filmScope);
      turnRef.current = turn;
      setTurning(true);
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      const rest = { x: direction === "next" ? w : -w, y: turn.restY };
      turn.corner = rest;
      active = {
        id: event.pointerId, x: start.x, y: start.y, turn, caughtCorner: rest,
        vx: 0, lastX: start.x, lastT: start.t, atX: start.x,
        trail: [{ x: start.x, t: start.t }], fromX: start.x,
      };
      // Whatever the page started for this touch (a selection, a press) ends.
      cancelling = true;
      try {
        start.target?.dispatchEvent(new PointerEvent("pointercancel", {
          pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: true, bubbles: true,
        }));
      } finally {
        cancelling = false;
      }
      follow(event);
      return true;
    };

    const turnDown = (event: PointerEvent) => {
      const underWay = active != null && (
        Math.abs(active.atX - active.fromX) >= REACH_DRAG_PX ||
        event.timeStamp - active.trail[0]!.t >= STRAY_AFTER_MS);
      if (!event.isPrimary && event.pointerType === "touch" && underWay) {
        strays.add(event.pointerId);
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
      }
      // A second finger is a pinch, not a turn: a sheet still turning goes on.
      if (!event.isPrimary && event.pointerType === "touch") {
        pending = null;
        queued = null;
        active = null;
        // Fixed page-turn overlays must not hide the live pinch beneath
        // them. Keep committed navigation, then hand the surface to zoom.
        for (const turn of layers) {
          if (turn.commit && turn.images) land(turn);
          turn.anim = null;
          teardown(turn);
          turn.canvas.remove();
          turn.under?.remove();
          turn.spreadLive?.right?.remove();
          stopSliding(turn.spreadLive?.windows);
          layers.delete(turn);
        }
        return;
      }
      if (active) return;
      if (event.button !== 0 || !event.isPrimary) return;
      mouse = event.pointerType === "mouse";
      if (!inHost(event.target)) return;
      // Zoomed into the page, the hand moves about it; turning waits for the
      // zoom back out to the whole page.
      if (!turnRef.current && boardRef.current?.zoomedIntoPage()) return;
      // Touch and mouse can grip the side strips as well as the corner peels.
      const side = edgeAt(event);
      // Away from a corner peel, a stylus with a drawing tool up is writing.
      if (!side && penWrites(event.pointerType, board()?.getActiveTool?.())) return;
      const playing = turnRef.current;
      if (playing && chainsAfter(playing)) {
        // The sheet going over hurries to land; this touch, a flick or a
        // drag in from a strip, turns the next page once it has.
        hurry(playing);
        if (side) {
          event.stopImmediatePropagation();
          event.preventDefault();
        }
        if (side || event.pointerType !== "mouse") {
          const r = pageRect();
          pending = {
            id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, target: event.target,
            reach: side ?? (r ? turnReachAt(r, event.clientX, event.clientY) : null),
          };
        }
        return;
      }
      if (playing) {
        const r = playing.rect;
        const catchable = Boolean(playing.anim && playing.images) && !playing.done &&
          event.clientX >= r.left && event.clientX <= r.left + r.width &&
          event.clientY >= r.top && event.clientY <= r.top + r.height;
        if (side && (playing.commit || !catchable)) {
          // The previous sheet keeps its own pictures and finishes above
          // the next one. A pending preview instead queues the next swipe.
          event.stopImmediatePropagation();
          event.preventDefault();
          if (playing.commit && !playing.images) {
            pending = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, target: event.target };
            return;
          }
          if (queued && queued.direction !== (side === "right" ? "next" : "prev")) queued = null;
          const landed = playing.commit ? playing : undefined;
          continueTurn(playing);
          if (grip(event, side, landed) && event.pointerType === "touch") setHover(side, event);
          return;
        }
        if (!catchable) {
          if (playing.commit && !playing.images && event.pointerType === "touch") {
            pending = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, target: event.target };
          }
          return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        const goingOver = playing.anim?.commit === true;
        playing.anim = null;
        playing.commit = null;
        if (!goingOver) queued = null;
        const w = playing.layout === "book" ? r.width / 2 : r.width;
        // Anchor at the displayed fold, so catching it never snaps the page
        // back to its original corner or to the new finger's position.
        playing.corner = constrainCorner(playing.corner, w, r.height, playing.bottom, playing.restY);
        active = {
          id: event.pointerId, x: event.clientX, y: event.clientY,
          turn: playing, caughtCorner: { ...playing.corner }, goingOver,
          vx: 0, lastX: event.clientX, lastT: event.timeStamp, atX: event.clientX,
          trail: [{ x: event.clientX, t: event.timeStamp }], fromX: event.clientX,
        };
        setTurning(true);
        return;
      }
      if (!side) {
        if (event.pointerType !== "mouse") {
          const r = pageRect();
          pending = {
            id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, target: event.target,
            reach: r ? turnReachAt(r, event.clientX, event.clientY) : null,
          };
        }
        return;
      }
      if (!grip(event, side)) return;
      // The corner is the turn's: no text selection, no hold, no pan from it.
      event.stopImmediatePropagation();
      event.preventDefault();
      // A finger has no hover: show the edge it pressed.
      if (event.pointerType === "touch") setHover(side, event);
    };

    /**
     * Move the held corner to where the hand is now. A lift where the last
     * move already was is not movement: it leaves the throw as it stood.
     */
    const follow = (event: PointerEvent, release = false) => {
      if (!active) return;
      stillTurning();
      const dt = event.timeStamp - active.lastT;
      const moved = !(release && event.clientX === active.atX);
      active.atX = event.clientX;
      if (dt > 0 && moved) {
        active.vx = active.vx * 0.5 + ((event.clientX - active.lastX) / dt) * 0.5;
        active.lastX = event.clientX;
        active.lastT = event.timeStamp;
        active.trail.push({ x: event.clientX, t: event.timeStamp });
        if (active.trail.length > 12) active.trail.shift();
      }
      const turn = active.turn;
      if (!release) noteHand(turn, event.clientX, event.clientY);
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      // A caught sheet moves on from where it was caught, at the hand's pace:
      // one to one by its corner, twice that by its crease.
      const pace = turn.byFold ? 2 : 1;
      turn.corner = active.caughtCorner
        ? constrainCorner({
            x: Math.min(w, Math.max(-w, active.caughtCorner.x + pace * (event.clientX - active.x))),
            y: active.caughtCorner.y + (event.clientY - active.y) * (pace === 1 ? 1 : 0.5) * (heldBySide(turn) ? SIDE_TILT : 1),
          }, w, turn.rect.height, turn.bottom, turn.restY)
        : cornerAt(turn, event.clientX, event.clientY, active.y);
      draw(turn);
    };

    /** Land a caught sheet that was going over, and take hold of the next one from rest. */
    const flickOn = (event: PointerEvent, releaseStart?: { x: number; y: number; t: number }) => {
      if (!active) return;
      const { id, turn: caught, trail: caughtTrail, fromX: caughtFromX } = active;
      active = null;
      caught.commit = true;
      continueTurn(caught);
      // Held by the side, the next sheet is taken where the hand is now.
      const bySide = caught.restY > 0 && caught.restY < caught.rect.height;
      const turn = planTurn(caught.direction, caught.bottom, caught, bySide ? event.clientY : undefined);
      if (!turn) return; // landed on the last page
      turnRef.current = turn;
      setTurning(true);
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      const rest = { x: turn.direction === "next" ? w : -w, y: turn.restY };
      turn.corner = rest;
      if (releaseStart) {
        active = {
          id, x: releaseStart.x, y: releaseStart.y, turn, caughtCorner: rest,
          vx: 0, lastX: releaseStart.x, lastT: releaseStart.t, atX: releaseStart.x,
          trail: [{ x: releaseStart.x, t: releaseStart.t }], fromX: releaseStart.x,
        };
      } else {
        // Taken from where the hand is, so the sheet does not jump to it, but
        // judged on the whole flick when let go. A busy frame can merge a
        // flick's moves into the one that pushed the caught sheet on; the
        // lift then comes no farther along, and judged from here alone the
        // flick fell back.
        const at = { x: event.clientX, t: event.timeStamp };
        active = {
          id, x: at.x, y: event.clientY, turn, caughtCorner: rest,
          vx: 0, lastX: at.x, lastT: at.t, atX: at.x,
          trail: [...caughtTrail, at].slice(-12), fromX: caughtFromX,
        };
      }
      draw(turn);
    };

    const onMove = (event: PointerEvent) => {
      if (strays.has(event.pointerId)) {
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
      }
      if (pending?.reach && !active && event.pointerId === pending.id) {
        const start = pending;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const inward = start.reach === "right" ? -dx : dx;
        if (inward >= REACH_DRAG_PX && inward >= Math.abs(dy)) {
          // A turn on its way: a live spread landing, a pictured sheet going
          // over, or a lined-up one still setting up. The drag takes hold once
          // it has landed; let go first, it is lined up.
          if (waitsForTurn(turnRef.current)) {
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }
          pending = null;
          if (!turnRef.current && startFlick(event, start)) {
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }
        } else if (Math.abs(dy) >= REACH_DRAG_PX || -inward >= REACH_DRAG_PX) {
          // Up, down or outward: a scroll, or a flick back the flick test below can still take.
          start.reach = null;
        }
      }
      if (pending && !pending.reach && !active && event.pointerId === pending.id) {
        const start = pending;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const dt = event.timeStamp - start.t;
        if (dt > BODY_FLICK_WINDOW_MS || Math.abs(dy) > BODY_FLICK_PX) {
          pending = null;
        } else if (Math.abs(dx) >= BODY_FLICK_PX && Math.abs(dx) >= BODY_FLICK_SLOPE * Math.abs(dy) &&
          Math.abs(dx) / Math.max(1, dt) >= BODY_FLICK_PX_PER_MS) {
          if (waitsForTurn(turnRef.current) && turnRef.current?.images) {
            // Lined up now, not at the lift: the hand may stay down past the landing.
            pending = null;
            queueTurn(dx < 0 ? "next" : "prev");
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }
          if (turnRef.current?.commit && !turnRef.current.images) {
            notePageTurn(filmScope);
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }
          pending = null;
          if (!turnRef.current && startFlick(event, start)) {
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }
        }
      }
      if (active && event.pointerId === active.id) {
        event.stopImmediatePropagation();
        event.preventDefault();
        if (active.goingOver) {
          const dx = event.clientX - active.x;
          const along = active.turn.direction === "next" ? -dx : dx;
          if (along > FLICK_ON_PX) {
            flickOn(event);
            return;
          }
          // Pulled back first: it stays caught, to be turned back or let go.
          if (along < -FLICK_ON_PX) {
            active.goingOver = false;
            queued = null;
          }
        }
        follow(event);
        return;
      }
      // A hovering stylus is shown what it can take hold of, as a mouse is.
      if (!active && (event.pointerType === "mouse" || event.pointerType === "pen") && event.buttons === 0) {
        if (event.pointerType === "mouse") mouse = true;
        setHover(boardRef.current?.zoomedIntoPage() ? null : edgeAt(event), event);
      }
    };

    // A stylus lifted out of hover range leaves no edge lit behind it.
    const onOut = (event: PointerEvent) => {
      if (!active && event.pointerType === "pen" && !event.relatedTarget) setHover(null);
    };

    const turnUp = (event: PointerEvent) => {
      if (cancelling) return;
      if (strays.delete(event.pointerId)) {
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
      }
      if (pending?.id === event.pointerId) {
        const start = pending;
        pending = null;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        const dt = event.timeStamp - start.t;
        if (event.type === "pointerup" && dt <= BODY_FLICK_WINDOW_MS &&
          Math.abs(dx) >= BODY_FLICK_PX && Math.abs(dx) >= BODY_FLICK_SLOPE * Math.abs(dy) &&
          Math.abs(dx) / Math.max(1, dt) >= BODY_FLICK_PX_PER_MS) {
          if (waitsForTurn(turnRef.current)) {
            queueTurn(dx < 0 ? "next" : "prev");
            event.stopImmediatePropagation();
            event.preventDefault();
          } else if (!turnRef.current) startFlick(event, start);
        }
      }
      if (event.pointerType === "touch") setHover(null);
      if (!active || event.pointerId !== active.id) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      // Where the hand let go is where the sheet is. A busy frame can merge a
      // flick's moves away, leaving only the lift to say how far it went.
      if (event.type === "pointerup" && active.goingOver) {
        const along = (event.clientX - active.x) * (active.turn.direction === "next" ? -1 : 1);
        if (along > FLICK_ON_PX) {
          flickOn(event, { x: active.x, y: active.y, t: active.trail[0]!.t });
          if (!active) return;
        }
      }
      if (event.type === "pointerup") follow(event, true);
      const { turn, lastT, trail, fromX } = active;
      active = null;
      // Short of a proper turn the sheet unravels back. A throw counts for a
      // little of where it was going; thrown back, it always goes back. A
      // flick goes over on its pace, however short it was.
      const fresh = event.timeStamp - lastT < FLICK_FRESH_MS;
      const vx = fresh ? releaseSpeed(trail) : 0;
      const sign = turn.direction === "next" ? -1 : 1;
      const along = sign * vx;
      const carried = sign * (event.clientX - fromX);
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      const flicked = along >= FLICK_COMMIT_PX_PER_MS && carried >= FLICK_COMMIT_MIN_PX;
      const commit =
        event.type !== "pointercancel" &&
        along > -FLICK_PX_PER_MS &&
        (flicked || turnCommits(turn.direction, turn.corner.x, w, along * THROW_MS, turn.byFold));
      if (!commit) queued = null;
      settle(turn, commit, { speed: Math.abs(vx) });
    };

    const swallowClick = (event: MouseEvent) => {
      if (turnRef.current && inHost(event.target)) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (active || event.defaultPrevented || isTypingTarget(event.target)) return;
      // Shift+arrows extend a text selection; the others are shortcuts.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const direction: Direction | null =
        event.key === "ArrowRight" || event.key === "PageDown" ? "next"
          : event.key === "ArrowLeft" || event.key === "PageUp" ? "prev"
            : null;
      if (!direction) return;
      const playing = turnRef.current;
      if (playing) {
        // Each ready sheet keeps rolling while the next key takes a new one.
        event.preventDefault();
        if (!playing.anim) {
          if (playing.commit) queueTurn(direction);
          return;
        }
        const commit = playing.direction === direction;
        if (playing.anim.commit !== commit) {
          queued = null;
          settle(playing, commit, { fullMs: QUICK_TURN_MS });
          return;
        }
        if (!commit) return;
        if (chainsAfter(playing)) {
          hurry(playing);
          queueTurn(direction);
          return;
        }
        continueTurn(playing);
        keyTurn(direction, QUICK_TURN_MS, playing);
        return;
      }
      if (keyTurn(direction, queued ? QUICK_TURN_MS : AUTO_TURN_MS)) event.preventDefault();
    };

    const onDown = (event: PointerEvent) => {
      const taken = turnsTaken;
      turnDown(event);
      pressOnGlass(event, taken);
    };
    const onUp = (event: PointerEvent) => {
      if (cancelling) return;
      turnUp(event);
      liftOffGlass(event);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerout", onOut, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("click", swallowClick, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerout", onOut, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("click", swallowClick, true);
      window.removeEventListener("keydown", onKey);
      disposed = true;
      window.clearTimeout(prefetchTimer);
      window.clearTimeout(paperFillTimer);
      window.clearInterval(recheck);
      document.removeEventListener("selectstart", noSelect, true);
      const hole = holeEl();
      if (hole) {
        delete hole.dataset.turnEdges;
        delete hole.dataset.turnHover;
      }
      const el = host();
      if (el && mouse) el.style.cursor = "";
      unsubscribeFilm();
      queued = null;
      // Every sheet goes: the live booktabs and squares come back.
      marksHidden = 0;
      const marks = marksLayer();
      if (marks) marks.style.visibility = "";
      for (const turn of layers) {
        teardown(turn);
        turn.canvas.remove();
        turn.under?.remove();
        turn.spreadLive?.right?.remove();
        stopSliding(turn.spreadLive?.windows);
        layers.delete(turn);
      }
      // The glass goes with the turns: the board takes touches as it did.
      window.clearTimeout(glassTimer);
      if (glassPress) window.clearTimeout(glassPress.timer);
      const glassOn = boardSurface();
      if (glassOn) delete glassOn.dataset.turnGlass;
    };
  }, [boardRef, filmScope, hostSelector, turnEnabled]);

  return null;
}
