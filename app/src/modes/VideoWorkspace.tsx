/**
 * The Video tab: a video, and ink pinned to its clock.
 *
 * Opened empty, it asks for a video (a file, a link, or one of the pads already
 * on this device). Once it has one, it is a player with an ink layer over the
 * picture, a timeline carrying the marks, and a list of them beside it.
 *
 * Drawing pauses the video first: ink lands on the frame that is on screen.
 * In Frame mode the new mark belongs to that one frame and shows only while
 * the player is paused on it. In Range mode it holds for a few seconds, which
 * the timeline's handles stretch or shrink. With "Stop at marks" on, playback
 * halts on each frame mark it reaches, so a review can be played through.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DialogPresence } from "../components/DialogMotion";
import type { TabPatch, VideoTab } from "../util/tabs";
import {
  FALLBACK_FRAME_RATE,
  RANGE_DEFAULT_SECONDS,
  VIDEO_LIBRARY_EVENT,
  createFilePad,
  createLinkPad,
  deleteVideoPad,
  formatVideoTime,
  frameIndex,
  frameSeekTime,
  frameStart,
  listVideoPads,
  loadVideoFile,
  loadVideoPad,
  marksAt,
  newVideoId,
  pickVideoFile,
  saveVideoPad,
  type VideoMark,
  type VideoPad,
  type VideoStroke,
} from "../util/videoStore";
import { htmlPlayer, measureFrameRate, youTubePlayer, type VideoPlayer } from "./videoPlayer";
import { VideoInkLayer, type VideoInkTool } from "./VideoInkLayer";
import { VideoTimeline } from "./VideoTimeline";
import "./videoWorkspace.css";

/** Ask the active Video tab (or a new one) to open this. See `requestVideoOpen`. */
export const OPEN_VIDEO_EVENT = "lc-open-video";

export interface OpenVideoRequest {
  /** A file already in hand, copied into the app. */
  blob?: Blob;
  name?: string;
  /** Or a link, kept as a link. */
  url?: string;
  title?: string;
  /** Seconds to start at. */
  start?: number;
}

/** Hand a video to the shell from anywhere (the Web tab's player, say). */
export function requestVideoOpen(request: OpenVideoRequest): void {
  window.dispatchEvent(new CustomEvent<OpenVideoRequest>(OPEN_VIDEO_EVENT, { detail: request }));
}

/** Where a just-opened pad should start playing from, taken once by its view. */
const pendingStarts = new Map<string, number>();

/** Turn a request into a stored pad. Null when a link is not a video we can play. */
export async function padForRequest(request: OpenVideoRequest): Promise<VideoPad | null> {
  const pad = request.blob ? await createFilePad(request.blob, request.name || "video", request.title)
    : request.url ? await createLinkPad(request.url, request.title)
    : null;
  if (pad && request.start && request.start > 0) pendingStarts.set(pad.id, request.start);
  return pad;
}

const INK_COLORS = ["#fb923c", "#ef4444", "#facc15", "#22c55e", "#3b82f6", "#ffffff"];
const RATES = [0.25, 0.5, 1, 1.5, 2];

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

const ICONS = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M8 5v14M16 5v14",
  stepBack: "M15 6l-6 6 6 6",
  stepForward: "M9 6l6 6-6 6",
  prevMark: "M6 5v14M18 6l-8 6 8 6z",
  nextMark: "M18 5v14M6 6l8 6-8 6z",
  pointer: "M5 3l13 8-6 1.6L9.2 19z",
  pen: "M15.5 4.5l4 4L8 20H4v-4z",
  highlight: "M9 15l6-11 4 2.4-6.2 10.6M9 15l-1 4 4-1.6M4 21h16",
  eraser: "M7 20h12M5.6 15.6l8-8.6a2 2 0 0 1 2.8 0l2.6 2.6a2 2 0 0 1 0 2.8L13 18.6a2 2 0 0 1-1.4.6H9.3a2 2 0 0 1-1.4-.6z",
  note: "M5 4h14v12H9l-4 4z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  sound: "M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7",
  muted: "M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6",
  file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M10 11.5v5l4-2.5z",
  link: "M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1",
  swap: "M4 8h13l-3-3M20 16H7l3 3",
} as const;

function sourceLabel(pad: VideoPad): string {
  if (pad.source.kind === "file") return "File";
  if (pad.source.kind === "youtube") return "YouTube";
  return "Link";
}

function markLabel(mark: VideoMark, frameRate: number | null): string {
  if (mark.frame) return `${formatVideoTime(mark.start)} · frame ${frameIndex(mark.start + 1e-6, frameRate).toLocaleString()}`;
  return `${formatVideoTime(mark.start)} to ${formatVideoTime(mark.end)}`;
}

/* -------------------------------------------------------------- open panel */

function VideoOpenPanel({ onOpened, startUrl }: { onOpened: (pad: VideoPad) => void; startUrl?: string }) {
  const reduced = useReducedMotion();
  const [pads, setPads] = useState<VideoPad[]>([]);
  const [url, setUrl] = useState(startUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<VideoPad | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => void listVideoPads().then(rows => { if (live) setPads(rows); }).catch(() => {});
    refresh();
    window.addEventListener(VIDEO_LIBRARY_EVENT, refresh);
    return () => { live = false; window.removeEventListener(VIDEO_LIBRARY_EVENT, refresh); };
  }, []);

  const fromFile = async (file: File | null) => {
    if (!file) return;
    if (file.type && !file.type.startsWith("video/")) { setError(`“${file.name}” isn't a video file.`); return; }
    setBusy(true);
    setError(null);
    try { onOpened(await createFilePad(file, file.name)); }
    catch { setError("The video couldn't be copied into the app. The device may be out of space."); }
    finally { setBusy(false); }
  };

  const fromUrl = async () => {
    if (!url.trim()) { setError("Paste a link to a video file or a YouTube video."); return; }
    setBusy(true);
    setError(null);
    try {
      const pad = await createLinkPad(url);
      if (pad) onOpened(pad);
      else setError("That isn't a web link. Paste one that starts with https://.");
    } finally { setBusy(false); }
  };

  return (
    <div className="lc-video-open" data-dragging={dragging || undefined}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void fromFile(event.dataTransfer.files[0] ?? null);
      }}>
      <motion.div className="lc-video-open-card"
        initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
        <h2 className="lc-video-open-title">Which video do you want to mark up?</h2>
        <p className="lc-video-open-hint">Draw on a paused frame, or across a stretch of time. Marks stay on this device.</p>
        <button type="button" className="lc-video-drop" disabled={busy} onClick={() => void pickVideoFile().then(fromFile)}>
          <Icon d={ICONS.file} size={28} />
          <span className="lc-video-drop-main">Choose a video file</span>
          <span className="lc-video-drop-sub">or drop one here · MP4, WebM, MOV</span>
        </button>
        <form className="lc-video-url" onSubmit={(event) => { event.preventDefault(); void fromUrl(); }}>
          <label htmlFor="lc-video-url-input" className="lc-video-url-label">Or paste a link</label>
          <div className="lc-video-url-row">
            <input id="lc-video-url-input" type="url" inputMode="url" placeholder="https://youtu.be/… or https://…/clip.mp4"
              value={url} disabled={busy} onChange={(event) => { setUrl(event.target.value); setError(null); }} />
            <button type="submit" className="lc-secondary" disabled={busy}>Open link</button>
          </div>
        </form>
        <AnimatePresence initial={false}>
          {error && <motion.p key="error" className="lc-video-error" role="alert"
            initial={reduced ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}>{error}</motion.p>}
        </AnimatePresence>
        {pads.length > 0 && <section className="lc-video-library" aria-labelledby="lc-video-library-title">
          <h3 id="lc-video-library-title" className="lc-video-library-title">Your videos</h3>
          <ul>
            <AnimatePresence initial={false}>
              {pads.map(pad => (
                <motion.li key={pad.id} layout={!reduced}
                  initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: -12 }}>
                  <button type="button" className="lc-video-library-row" disabled={busy} onClick={() => onOpened(pad)}>
                    <span className="lc-video-library-name">{pad.title}</span>
                    <span className="lc-video-library-meta">
                      {sourceLabel(pad)} · {pad.marks.length === 1 ? "1 mark" : `${pad.marks.length} marks`}
                      {pad.duration ? ` · ${formatVideoTime(pad.duration, false)}` : ""}
                    </span>
                  </button>
                  <button type="button" className="lc-icon lc-video-library-remove" aria-label={`Delete ${pad.title}`}
                    disabled={busy} onClick={() => setDeleting(pad)}><Icon d={ICONS.trash} size={16} /></button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>}
      </motion.div>
      <DialogPresence>{deleting && (
        <ConfirmDialog
          title="Delete this video?"
          message={`“${deleting.title}” and its ${deleting.marks.length === 1 ? "mark" : `${deleting.marks.length} marks`} leave this device.`}
          detail={deleting.source.kind === "file" ? "The app's copy of the file is deleted too. The original file isn't touched." : undefined}
          confirmLabel="Delete"
          onConfirm={() => { const doomed = deleting; setDeleting(null); void deleteVideoPad(doomed.id); }}
          onCancel={() => setDeleting(null)}
        />
      )}</DialogPresence>
    </div>
  );
}

/* --------------------------------------------------------------- pad view */

type Status = "loading" | "ready" | "gone";

function VideoPadView({ videoId, active, onPatch, onOpenAnother }: {
  videoId: string;
  active: boolean;
  onPatch: (patch: TabPatch) => void;
  onOpenAnother: () => void;
}) {
  const reduced = useReducedMotion();
  const [status, setStatus] = useState<Status>("loading");
  const [pad, setPad] = useState<VideoPad | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [player, setPlayer] = useState<VideoPlayer | null>(null);
  const [time, setTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [duration, setDuration] = useState(NaN);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [tool, setTool] = useState<VideoInkTool>("pen");
  const [color, setColor] = useState(INK_COLORS[0]);
  const [anchor, setAnchor] = useState<"frame" | "range">("frame");
  const [stopAtMarks, setStopAtMarks] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [intrinsic, setIntrinsic] = useState<{ width: number; height: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const youTubeHostRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef<{ resume: boolean } | null>(null);
  const lastTime = useRef(0);
  /** A frame mark playback just stopped on; it must not stop us again on Play. */
  const leftMark = useRef<string | null>(null);
  const loadedPad = useRef<VideoPad | null>(null);

  // Load the pad, and the file behind it when it is a copied file.
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    void (async () => {
      const found = await loadVideoPad(videoId).catch(() => null);
      if (!live) return;
      if (!found) { setStatus("gone"); return; }
      if (found.source.kind === "file") {
        const blob = await loadVideoFile(found.id).catch(() => null);
        if (!live) return;
        if (!blob) { setStatus("gone"); return; }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } else if (found.source.kind === "url") {
        setSrc(found.source.url);
      }
      loadedPad.current = found;
      setPad(found);
      setStatus("ready");
      onPatch({ title: found.title });
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // onPatch is a fresh closure each render; the pad only loads once per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Save after edits settle. The first value is what was loaded: nothing to write.
  useEffect(() => {
    if (!pad || pad === loadedPad.current) return;
    const timer = window.setTimeout(() => void saveVideoPad(pad).catch(() => {}), 350);
    return () => window.clearTimeout(timer);
  }, [pad]);

  const update = useCallback((change: (pad: VideoPad) => VideoPad) => {
    setPad(current => (current ? { ...change(current), updatedAt: Date.now() } : current));
  }, []);

  // The HTML player wraps the element React renders.
  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    setPlayer(video ? htmlPlayer(video) : null);
  }, []);

  // YouTube mounts its own iframe into a host div.
  const youTubeId = pad?.source.kind === "youtube" ? pad.source.videoId : null;
  useEffect(() => {
    const host = youTubeHostRef.current;
    if (!youTubeId || !host) return;
    let made: VideoPlayer | null = null;
    let live = true;
    void youTubePlayer(host, youTubeId, {
      onReady: () => { if (live && made) { setPlayer(made); setIntrinsic(made.size()); } },
      onError: (message) => { if (live) setPlayerError(message); },
    }).then(p => { made = p; if (!live) p.destroy(); })
      .catch((error: unknown) => { if (live) setPlayerError(error instanceof Error ? error.message : "YouTube could not be reached."); });
    return () => { live = false; made?.destroy(); setPlayer(null); };
  }, [youTubeId]);

  // A pad handed over mid-video starts where the viewer was.
  useEffect(() => {
    const start = pendingStarts.get(videoId);
    if (!player || start === undefined) return;
    pendingStarts.delete(videoId);
    player.seek(start);
  }, [player, videoId]);

  const frameRate = pad?.frameRate ?? null;
  const rateForFrames = frameRate ?? FALLBACK_FRAME_RATE;

  // Measure the frame rate once per pad, the first time it plays.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !pad || pad.frameRate || player?.kind !== "html" || paused) return;
    return measureFrameRate(video, measured => update(p => ({ ...p, frameRate: measured })));
  }, [pad, player, paused, update]);

  // Track the stage so the ink sits over the picture, not its letterbox.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setStage({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [status]);

  // The clock. One read per animation frame while this tab is on screen.
  useEffect(() => {
    if (!player || !active) return;
    let raf = 0;
    const tick = () => {
      const now = player.time();
      const isPaused = player.paused();
      const marks = pad?.marks ?? [];
      // Stop on a frame mark that playback just crossed.
      if (stopAtMarks && !isPaused && !scrubbing.current && now > lastTime.current) {
        const crossed = marks.find(mark => mark.frame && mark.id !== leftMark.current
          && mark.start > lastTime.current && mark.start <= now);
        if (crossed) {
          player.pause();
          const at = frameSeekTime(Math.round(crossed.start * rateForFrames), frameRate);
          player.seek(at);
          leftMark.current = crossed.id;
          setSelectedId(crossed.id);
          lastTime.current = at;
          setTime(at);
          setPaused(true);
          raf = requestAnimationFrame(tick);
          return;
        }
      }
      if (leftMark.current && !isPaused) {
        const left = marks.find(mark => mark.id === leftMark.current);
        if (!left || Math.abs(now - left.start) > 1 / rateForFrames) leftMark.current = null;
      }
      lastTime.current = now;
      setTime(prev => (Math.abs(prev - now) > 0.0005 ? now : prev));
      setPaused(isPaused);
      const total = player.duration();
      setDuration(prev => (prev === total || (Number.isNaN(prev) && Number.isNaN(total)) ? prev : total));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player, active, pad?.marks, stopAtMarks, frameRate, rateForFrames]);

  // Remember the duration once it is known, for the library list.
  useEffect(() => {
    if (Number.isFinite(duration) && duration > 0 && pad && pad.duration !== duration) {
      update(p => ({ ...p, duration }));
    }
  }, [duration, pad, update]);

  // Leaving the tab pauses: a video playing out of sight helps nobody.
  useEffect(() => {
    if (!active) player?.pause();
  }, [active, player]);

  const marks = useMemo(() => [...(pad?.marks ?? [])].sort((a, b) => a.start - b.start), [pad?.marks]);
  const showing = useMemo(() => marksAt(marks, time, paused, frameRate), [marks, time, paused, frameRate]);
  const currentFrame = frameIndex(time, frameRate);

  const seek = useCallback((at: number) => {
    if (!player) return;
    player.seek(at);
    lastTime.current = at;
    setTime(at);
  }, [player]);

  const togglePlay = useCallback(() => {
    if (!player) return;
    if (player.paused()) {
      const total = player.duration();
      if (Number.isFinite(total) && player.time() >= total - 0.05) seek(0);
      player.play();
    } else player.pause();
  }, [player, seek]);

  const stepFrame = useCallback((delta: number) => {
    if (!player) return;
    player.pause();
    seek(frameSeekTime(frameIndex(player.time(), frameRate) + delta, frameRate));
  }, [player, frameRate, seek]);

  const goToMark = useCallback((mark: VideoMark) => {
    if (!player) return;
    player.pause();
    setSelectedId(mark.id);
    leftMark.current = mark.id;
    seek(mark.frame ? frameSeekTime(Math.round(mark.start * rateForFrames), frameRate) : mark.start);
  }, [player, frameRate, rateForFrames, seek]);

  const jumpMark = useCallback((direction: 1 | -1) => {
    const now = player?.time() ?? time;
    const epsilon = 0.5 / rateForFrames;
    const target = direction > 0
      ? marks.find(mark => mark.start > now + epsilon)
      : [...marks].reverse().find(mark => mark.start < now - epsilon);
    if (target) goToMark(target);
  }, [player, time, marks, rateForFrames, goToMark]);

  /** The mark new ink joins: the selected one if it is showing, otherwise a new one here. */
  const addStroke = useCallback((stroke: VideoStroke) => {
    const visible = showing.find(mark => mark.id === selectedId)
      ?? (showing.length === 1 && showing[0].frame === (anchor === "frame") ? showing[0] : undefined);
    if (visible) {
      update(p => ({ ...p, marks: p.marks.map(mark => mark.id === visible.id ? { ...mark, strokes: [...mark.strokes, stroke] } : mark) }));
      setSelectedId(visible.id);
      return;
    }
    const start = anchor === "frame" ? frameStart(currentFrame, frameRate) : time;
    const total = Number.isFinite(duration) ? duration : Infinity;
    const mark: VideoMark = {
      id: newVideoId("mark"),
      start,
      end: anchor === "frame" ? start : Math.min(total, start + RANGE_DEFAULT_SECONDS),
      frame: anchor === "frame",
      strokes: [stroke],
      note: "",
    };
    update(p => ({ ...p, marks: [...p.marks, mark] }));
    setSelectedId(mark.id);
    leftMark.current = mark.id;
  }, [showing, selectedId, anchor, currentFrame, frameRate, time, duration, update]);

  const eraseStroke = useCallback((markId: string, index: number) => {
    update(p => ({
      ...p,
      // A mark left with no ink and no note is nothing; it goes too.
      marks: p.marks.flatMap(mark => {
        if (mark.id !== markId) return [mark];
        const strokes = mark.strokes.filter((_, i) => i !== index);
        return strokes.length === 0 && !mark.note.trim() ? [] : [{ ...mark, strokes }];
      }),
    }));
  }, [update]);

  const addNote = useCallback(() => {
    player?.pause();
    const start = anchor === "frame" ? frameStart(currentFrame, frameRate) : time;
    const total = Number.isFinite(duration) ? duration : Infinity;
    const mark: VideoMark = {
      id: newVideoId("mark"), start,
      end: anchor === "frame" ? start : Math.min(total, start + RANGE_DEFAULT_SECONDS),
      frame: anchor === "frame", strokes: [], note: "",
    };
    update(p => ({ ...p, marks: [...p.marks, mark] }));
    setSelectedId(mark.id);
    leftMark.current = mark.id;
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(`[data-note-for="${mark.id}"]`)?.focus(), 60);
  }, [player, anchor, currentFrame, frameRate, time, duration, update]);

  const removeMark = useCallback((markId: string) => {
    update(p => ({ ...p, marks: p.marks.filter(mark => mark.id !== markId) }));
    setSelectedId(current => (current === markId ? null : current));
  }, [update]);

  const toggleMarkKind = useCallback((markId: string) => {
    const total = Number.isFinite(duration) ? duration : Infinity;
    update(p => ({
      ...p,
      marks: p.marks.map(mark => mark.id !== markId ? mark : mark.frame
        ? { ...mark, frame: false, end: Math.min(total, mark.start + RANGE_DEFAULT_SECONDS) }
        : { ...mark, frame: true, start: frameStart(Math.round(mark.start * rateForFrames), frameRate), end: frameStart(Math.round(mark.start * rateForFrames), frameRate) }),
    }));
  }, [duration, rateForFrames, frameRate, update]);

  // Keys, while this tab is on screen and nobody is typing.
  useEffect(() => {
    if (!active || !player) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']") || event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.querySelector(".lc-modal-backdrop")) return;
      const keys: Record<string, () => void> = {
        " ": togglePlay, k: togglePlay,
        ",": () => stepFrame(-1), ".": () => stepFrame(1),
        ArrowLeft: () => seek(Math.max(0, player.time() - 5)), ArrowRight: () => seek(player.time() + 5),
        "[": () => jumpMark(-1), "]": () => jumpMark(1),
        v: () => setTool(null), p: () => setTool("pen"), h: () => setTool("highlight"), e: () => setTool("eraser"),
        f: () => setAnchor("frame"), r: () => setAnchor("range"), n: addNote,
        Escape: () => setSelectedId(null),
        Delete: () => { if (selectedId) removeMark(selectedId); },
      };
      const run = keys[event.key];
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, player, togglePlay, stepFrame, seek, jumpMark, addNote, removeMark, selectedId]);

  if (status === "loading") return <div className="lc-video-pad lc-video-pad-status" aria-busy="true"><p>Opening the video…</p></div>;
  if (status === "gone" || !pad) {
    return (
      <div className="lc-video-pad lc-video-pad-status">
        <h2>This video isn't on this device any more</h2>
        <p>It was deleted, or its copy couldn't be read.</p>
        <button type="button" className="lc-secondary" onClick={onOpenAnother}>Open another video</button>
      </div>
    );
  }

  // Fit the picture inside the stage, the way `object-fit: contain` does.
  const size = intrinsic ?? player?.size() ?? null;
  const aspect = size ? size.width / size.height : 16 / 9;
  let box = { left: 0, top: 0, width: stage.width, height: stage.height };
  if (stage.width > 0 && stage.height > 0) {
    const fitWidth = Math.min(stage.width, stage.height * aspect);
    const fitHeight = fitWidth / aspect;
    box = { left: (stage.width - fitWidth) / 2, top: (stage.height - fitHeight) / 2, width: fitWidth, height: fitHeight };
  }
  const youTube = pad.source.kind === "youtube";
  const selected = marks.find(mark => mark.id === selectedId) ?? null;

  return (
    <div className="lc-video-pad" style={{ "--lc-video-ink": color } as CSSProperties}>
      <div className="lc-video-head">
        <input className="lc-video-title" aria-label="Video name" value={pad.title}
          onChange={(event) => update(p => ({ ...p, title: event.target.value }))}
          onBlur={() => {
            const title = pad.title.trim() || "Video";
            if (title !== pad.title) update(p => ({ ...p, title }));
            onPatch({ title });
          }} />
        <span className="lc-video-source" data-source={pad.source.kind}>{sourceLabel(pad)}</span>
        <span className="lc-video-head-spacer" />
        <button type="button" className="lc-secondary lc-video-another" onClick={onOpenAnother}>
          <Icon d={ICONS.swap} size={16} /> Open another
        </button>
      </div>

      <div className="lc-video-body">
        <div className="lc-video-main">
          <div ref={stageRef} className="lc-video-stage" data-tool={tool ?? "none"}>
            {youTube
              ? <div ref={youTubeHostRef} className="lc-video-youtube" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
              : src && <video ref={attachVideo} className="lc-video-element" src={src} playsInline preload="auto"
                  onLoadedMetadata={(event) => setIntrinsic({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
                  onError={() => setPlayerError(pad.source.kind === "url"
                    ? "This link didn't play. It may not point straight at a video file, or the site may block it."
                    : "This file didn't play. The app can play MP4 (H.264) and WebM; try converting it.")}
                  onClick={() => { if (!tool) togglePlay(); }} />}
            {player && box.width > 0 && (
              <VideoInkLayer marks={showing} box={box} aspect={aspect} tool={tool} color={color}
                onBegin={() => { player.pause(); }} onStroke={addStroke} onErase={eraseStroke} />
            )}
            <div className="lc-video-badge" aria-live="off">
              {paused ? "Paused" : "Playing"} · frame {currentFrame.toLocaleString()} · {formatVideoTime(time)}
              {frameRate ? ` · ${frameRate} fps` : " · about 30 fps"}
            </div>
            <div className="lc-video-tools" role="toolbar" aria-label="Ink tools">
              {([[null, "Pointer (V)", ICONS.pointer], ["pen", "Pen (P)", ICONS.pen], ["highlight", "Highlighter (H)", ICONS.highlight], ["eraser", "Eraser (E)", ICONS.eraser]] as const).map(([value, label, d]) => (
                <button key={label} type="button" className="lc-video-tool" aria-label={label} title={label}
                  aria-pressed={tool === value} onClick={() => setTool(value)}><Icon d={d} size={17} /></button>
              ))}
              <AnimatePresence initial={false}>
                {(tool === "pen" || tool === "highlight") && (
                  <motion.span key="colors" className="lc-video-colors"
                    initial={reduced ? false : { opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }}
                    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, width: 0 }}
                    transition={{ duration: 0.18 }}>
                    {INK_COLORS.map(swatch => (
                      <button key={swatch} type="button" className="lc-video-swatch" aria-label={`Ink colour ${swatch}`}
                        aria-pressed={color === swatch} style={{ background: swatch }} onClick={() => setColor(swatch)} />
                    ))}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <AnimatePresence>
              {playerError && <motion.div key="err" className="lc-video-stage-error" role="alert"
                initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <p>{playerError}</p>
                <button type="button" className="lc-secondary" onClick={onOpenAnother}>Open another video</button>
              </motion.div>}
            </AnimatePresence>
          </div>

          <div className="lc-video-controls">
            <button type="button" className="lc-icon" aria-label="Previous mark ([)" title="Previous mark ([)" disabled={!player} onClick={() => jumpMark(-1)}><Icon d={ICONS.prevMark} /></button>
            <button type="button" className="lc-icon" aria-label="Back one frame (,)" title="Back one frame (,)" disabled={!player} onClick={() => stepFrame(-1)}><Icon d={ICONS.stepBack} /></button>
            <button type="button" className="lc-icon lc-video-play" aria-label={paused ? "Play (Space)" : "Pause (Space)"} disabled={!player} onClick={togglePlay}>
              <Icon d={paused ? ICONS.play : ICONS.pause} size={22} />
            </button>
            <button type="button" className="lc-icon" aria-label="Forward one frame (.)" title="Forward one frame (.)" disabled={!player} onClick={() => stepFrame(1)}><Icon d={ICONS.stepForward} /></button>
            <button type="button" className="lc-icon" aria-label="Next mark (])" title="Next mark (])" disabled={!player} onClick={() => jumpMark(1)}><Icon d={ICONS.nextMark} /></button>
            <span className="lc-video-clock">{formatVideoTime(time)} / {Number.isFinite(duration) ? formatVideoTime(duration) : "--:--"}</span>
            <span className="lc-video-head-spacer" />
            <button type="button" className="lc-icon" aria-label={muted ? "Unmute" : "Mute"} disabled={!player}
              onClick={() => { const next = !muted; setMuted(next); player?.setMuted(next); }}><Icon d={muted ? ICONS.muted : ICONS.sound} /></button>
            <label className="lc-video-rate">
              <span className="lc-video-sr">Speed</span>
              <select value={rate} disabled={!player} onChange={(event) => { const next = Number(event.target.value); setRate(next); player?.setRate(next); }}>
                {RATES.map(r => <option key={r} value={r}>{r}x</option>)}
              </select>
            </label>
          </div>

          <VideoTimeline duration={duration} time={time} marks={marks} selectedId={selectedId} frameRate={frameRate}
            onSeek={seek}
            onScrub={(on) => {
              if (on) { scrubbing.current = { resume: !(player?.paused() ?? true) }; player?.pause(); }
              else { if (scrubbing.current?.resume) player?.play(); scrubbing.current = null; }
            }}
            onSelect={(id) => { const mark = marks.find(m => m.id === id); if (mark) goToMark(mark); }}
            onRange={(id, start, end) => update(p => ({ ...p, marks: p.marks.map(mark => mark.id === id ? { ...mark, start, end } : mark) }))} />

          <div className="lc-video-anchor">
            <span className="lc-video-anchor-label">New marks stick to</span>
            <span className="lc-video-segmented" role="radiogroup" aria-label="New marks stick to">
              <button type="button" role="radio" aria-checked={anchor === "frame"} onClick={() => setAnchor("frame")}>This frame</button>
              <button type="button" role="radio" aria-checked={anchor === "range"} onClick={() => setAnchor("range")}>A stretch of time</button>
            </span>
            <label className="lc-video-check">
              <input type="checkbox" checked={stopAtMarks} onChange={(event) => setStopAtMarks(event.target.checked)} />
              Stop at frame marks while playing
            </label>
            {youTube && <span className="lc-video-anchor-note">YouTube frame steps are estimates.</span>}
          </div>
        </div>

        <aside className="lc-video-rail" aria-label="Marks">
          <div className="lc-video-rail-head">
            <h3>Marks <span className="lc-video-rail-count">{marks.length}</span></h3>
            <button type="button" className="lc-secondary lc-video-add-note" disabled={!player} onClick={addNote}>
              <Icon d={ICONS.note} size={15} /> Add a note here
            </button>
          </div>
          {marks.length === 0 && <p className="lc-video-rail-empty">Pause where something happens and draw on the picture, or add a note. Each mark shows up here and on the timeline.</p>}
          <ul className="lc-video-marks">
            <AnimatePresence initial={false}>
              {marks.map(mark => {
                const isSelected = mark.id === selected?.id;
                const isShowing = showing.some(m => m.id === mark.id);
                return (
                  <motion.li key={mark.id} layout={!reduced} className="lc-video-mark"
                    data-selected={isSelected || undefined} data-showing={isShowing || undefined} data-kind={mark.frame ? "frame" : "range"}
                    initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 16 }}
                    transition={{ duration: 0.18 }}>
                    <button type="button" className="lc-video-mark-time" onClick={() => goToMark(mark)}>
                      {markLabel(mark, frameRate)}
                      {mark.strokes.length > 0 && <span className="lc-video-mark-ink">{mark.strokes.length === 1 ? "1 stroke" : `${mark.strokes.length} strokes`}</span>}
                    </button>
                    <textarea data-note-for={mark.id} className="lc-video-mark-note" rows={1} placeholder="Add a note"
                      value={mark.note} onFocus={() => setSelectedId(mark.id)}
                      onChange={(event) => { const note = event.target.value; update(p => ({ ...p, marks: p.marks.map(m => m.id === mark.id ? { ...m, note } : m) })); }} />
                    <AnimatePresence initial={false}>
                      {isSelected && <motion.div key="actions" className="lc-video-mark-actions"
                        initial={reduced ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0 }}>
                        <button type="button" className="lc-video-link" onClick={() => toggleMarkKind(mark.id)}>
                          {mark.frame ? "Hold for a stretch of time" : "Pin to one frame"}
                        </button>
                        <button type="button" className="lc-video-link is-danger" onClick={() => removeMark(mark.id)}>Delete mark</button>
                      </motion.div>}
                    </AnimatePresence>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

export function VideoWorkspace({ tab, active, onPatch }: {
  tab: VideoTab;
  active: boolean;
  onPatch: (patch: TabPatch) => void;
}) {
  if (!tab.videoId) {
    return <VideoOpenPanel onOpened={(pad) => onPatch({ videoId: pad.id, title: pad.title })} />;
  }
  return <VideoPadView key={tab.videoId} videoId={tab.videoId} active={active} onPatch={onPatch}
    onOpenAnother={() => onPatch({ videoId: null, title: "Video" })} />;
}
