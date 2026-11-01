/**
 * Video pads: a video, and the marks drawn over it.
 *
 * A mark is ink pinned to the video's clock. A frame mark shows only while the
 * player is paused on that frame; a range mark shows for the whole stretch,
 * playing or not. Stroke points are fractions of the video frame (0..1 on both
 * axes), never screen pixels, so a mark lands on the same spot of the picture
 * however big the player is drawn on this device or another one.
 *
 * Local files are copied into IndexedDB under the pad's id. A Blob put into
 * IndexedDB is written to disk by the WebView without being read into memory
 * first, which is what makes a multi-GB file affordable here. Web videos and
 * YouTube are kept as links: the page or the service owns the bytes.
 *
 * Pads live on this device only. Hub sync is a separate step.
 */

import { pickFromHiddenInput } from "./annotateFs";

export type VideoSource =
  | { kind: "file"; name: string; mime: string; size: number }
  | { kind: "url"; url: string }
  | { kind: "youtube"; url: string; videoId: string };

export type VideoTool = "pen" | "highlight";

export interface VideoStroke {
  tool: VideoTool;
  color: string;
  /** Fraction of the frame's width, so a line keeps its weight at any size. */
  width: number;
  /** Flattened x,y pairs in frame fractions. */
  points: number[];
}

export interface VideoMark {
  id: string;
  /** Seconds. */
  start: number;
  /** Seconds. Equal to `start` for a frame mark. */
  end: number;
  frame: boolean;
  strokes: VideoStroke[];
  note: string;
}

export interface VideoPad {
  id: string;
  title: string;
  source: VideoSource;
  marks: VideoMark[];
  /** Measured from decoded frames; null until the player has seen two. */
  frameRate: number | null;
  duration: number | null;
  createdAt: number;
  updatedAt: number;
}

export const VIDEO_LIBRARY_EVENT = "lc-video-library";
/** How long a new range mark holds, in seconds. */
export const RANGE_DEFAULT_SECONDS = 3;
/** Browsers do not report a frame rate; this is the guess until one is measured. */
export const FALLBACK_FRAME_RATE = 30;
export const VIDEO_ACCEPT = "video/*,.mp4,.m4v,.webm,.mov,.mkv,.ogv";

const DB_NAME = "lc-video";
const DB_VERSION = 1;
const PADS = "pads";
const FILES = "files";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PADS)) db.createObjectStore(PADS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const request = body(tx);
      let result: T | undefined;
      if (request) request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function announce(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VIDEO_LIBRARY_EVENT));
}

let idSeq = 0;
export function newVideoId(prefix = "vid"): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function listVideoPads(): Promise<VideoPad[]> {
  const rows = await run<VideoPad[]>([PADS], "readonly", tx => tx.objectStore(PADS).getAll());
  return (rows ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadVideoPad(id: string): Promise<VideoPad | null> {
  return (await run<VideoPad>([PADS], "readonly", tx => tx.objectStore(PADS).get(id))) ?? null;
}

export async function saveVideoPad(pad: VideoPad): Promise<void> {
  await run([PADS], "readwrite", tx => { tx.objectStore(PADS).put(pad); });
  announce();
}

export async function deleteVideoPad(id: string): Promise<void> {
  await run([PADS, FILES], "readwrite", tx => {
    tx.objectStore(PADS).delete(id);
    tx.objectStore(FILES).delete(id);
  });
  announce();
}

export async function loadVideoFile(id: string): Promise<Blob | null> {
  return (await run<Blob>([FILES], "readonly", tx => tx.objectStore(FILES).get(id))) ?? null;
}

function titleFromName(name: string): string {
  return name.replace(/\.[a-z0-9]{2,4}$/i, "") || "Video";
}

/** Copy a picked or dropped file (or fetched bytes) into the app and make a pad for it. */
export async function createFilePad(file: Blob, name: string, title?: string): Promise<VideoPad> {
  const now = Date.now();
  const pad: VideoPad = {
    id: newVideoId(),
    title: title?.trim() || titleFromName(name),
    source: { kind: "file", name, mime: file.type || "video/mp4", size: file.size },
    marks: [],
    frameRate: null,
    duration: null,
    createdAt: now,
    updatedAt: now,
  };
  await run([PADS, FILES], "readwrite", tx => {
    tx.objectStore(FILES).put(file, pad.id);
    tx.objectStore(PADS).put(pad);
  });
  announce();
  return pad;
}

/** A pad for a link: a direct video file or a YouTube page. Null when it is neither. */
export async function createLinkPad(raw: string, title?: string): Promise<VideoPad | null> {
  const source = videoSourceForUrl(raw);
  if (!source) return null;
  const now = Date.now();
  const pad: VideoPad = {
    id: newVideoId(),
    title: title?.trim() || linkTitle(source),
    source,
    marks: [],
    frameRate: null,
    duration: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveVideoPad(pad);
  return pad;
}

function linkTitle(source: VideoSource): string {
  if (source.kind === "youtube") return "YouTube video";
  if (source.kind !== "url") return "Video";
  try {
    const name = decodeURIComponent(new URL(source.url).pathname.split("/").pop() ?? "");
    return titleFromName(name) || new URL(source.url).hostname;
  } catch {
    return "Video";
  }
}

/** The 11-character id from any of YouTube's URL shapes, or null. */
export function youTubeIdFromUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
      id = match?.[1] ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function videoSourceForUrl(raw: string): VideoSource | null {
  const trimmed = raw.trim();
  const videoId = youTubeIdFromUrl(trimmed);
  if (videoId) return { kind: "youtube", url: trimmed, videoId };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { kind: "url", url: url.toString() };
  } catch {
    return null;
  }
}

export function pickVideoFile(): Promise<File | null> {
  return pickFromHiddenInput(VIDEO_ACCEPT, async (file) => file);
}

function rateOf(frameRate: number | null | undefined): number {
  return frameRate && frameRate > 0 ? frameRate : FALLBACK_FRAME_RATE;
}

/** The frame on screen at `time`: the one whose interval the time falls in. */
export function frameIndex(time: number, frameRate: number | null): number {
  return Math.floor(time * rateOf(frameRate) + 1e-4);
}

/** Where a frame starts. Marks store this, so they name the frame and not a moment inside it. */
export function frameStart(index: number, frameRate: number | null): number {
  return Math.max(0, index) / rateOf(frameRate);
}

/**
 * Where to seek to show a frame: a quarter of the way in, because a seek to
 * the exact boundary can land on the frame before it after float rounding.
 */
export function frameSeekTime(index: number, frameRate: number | null): number {
  return (Math.max(0, index) + 0.25) / rateOf(frameRate);
}

export function frameDuration(frameRate: number | null): number {
  return 1 / rateOf(frameRate);
}

/** Marks that show at `time`. Frame marks need the player paused on their frame. */
export function marksAt(marks: VideoMark[], time: number, paused: boolean, frameRate: number | null): VideoMark[] {
  const frame = frameIndex(time, frameRate);
  return marks.filter(mark => mark.frame
    ? paused && frame === Math.round(mark.start * rateOf(frameRate))
    : time >= mark.start && time < mark.end);
}

/** Common rates a measured one snaps to, since frame timings jitter. */
const KNOWN_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];

export function snapFrameRate(measured: number): number {
  const nearest = KNOWN_RATES.reduce((best, rate) => Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best);
  return Math.abs(nearest - measured) / nearest < 0.015 ? nearest : Math.round(measured * 100) / 100;
}

/** 83.4 → "1:23.40"; hours appear only when the video has them. */
export function formatVideoTime(seconds: number, precise = true): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const secs = precise ? rest.toFixed(2).padStart(5, "0") : String(Math.floor(rest)).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}
