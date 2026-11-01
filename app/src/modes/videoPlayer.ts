/**
 * One small interface over the two players a video pad can sit on.
 *
 * A `<video>` element is frame-accurate and measures its own frame rate. A
 * YouTube embed only reports time, through its iframe API, and needs the
 * network: frame steps there are an estimate at the fallback rate. The pad's
 * controls, timeline and ink never know which one they are driving.
 */

import { snapFrameRate } from "../util/videoStore";

export interface VideoPlayer {
  readonly kind: "html" | "youtube";
  time(): number;
  /** NaN until known. */
  duration(): number;
  paused(): boolean;
  play(): void;
  pause(): void;
  seek(time: number): void;
  setRate(rate: number): void;
  setMuted(muted: boolean): void;
  /** The picture's own size, for fitting ink to it. Null until known. */
  size(): { width: number; height: number } | null;
  destroy(): void;
}

export function htmlPlayer(video: HTMLVideoElement): VideoPlayer {
  return {
    kind: "html",
    time: () => video.currentTime,
    duration: () => video.duration,
    paused: () => video.paused || video.ended,
    play: () => { void video.play().catch(() => { /* autoplay refusal: the button still shows Play */ }); },
    pause: () => video.pause(),
    seek: (time) => {
      const end = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(Math.max(0, time), end);
    },
    setRate: (rate) => { video.playbackRate = rate; },
    setMuted: (muted) => { video.muted = muted; },
    size: () => video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null,
    destroy: () => { /* React owns the element */ },
  };
}

/**
 * Measure a `<video>`'s frame rate from the frames it actually presents.
 *
 * Browsers do not report one. `requestVideoFrameCallback` hands over each
 * presented frame's media time, so the gap between neighbours is the frame
 * length. A dropped frame makes a gap twice as long, never shorter, so gaps
 * more than half again the shortest are thrown out and the median of the rest
 * is the frame length. Only runs while the video plays.
 */
export function measureFrameRate(video: HTMLVideoElement, report: (rate: number) => void): () => void {
  type FrameVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  const frames = video as FrameVideo;
  if (!frames.requestVideoFrameCallback) return () => {};
  let last = -1;
  let handle = 0;
  let done = false;
  const gaps: number[] = [];
  const onFrame = (_now: number, meta: { mediaTime: number }) => {
    if (done) return;
    if (last >= 0) {
      const gap = meta.mediaTime - last;
      if (gap > 0.002 && gap < 0.2) gaps.push(gap);
    }
    last = meta.mediaTime;
    if (gaps.length >= 16) {
      done = true;
      gaps.sort((a, b) => a - b);
      const steady = gaps.filter(gap => gap <= gaps[0] * 1.5);
      report(snapFrameRate(1 / steady[Math.floor(steady.length / 2)]));
      return;
    }
    handle = frames.requestVideoFrameCallback!(onFrame);
  };
  handle = frames.requestVideoFrameCallback(onFrame);
  return () => {
    done = true;
    frames.cancelVideoFrameCallback?.(handle);
  };
}

/* ---------------------------------------------------------------- YouTube */

interface YouTubePlayerApi {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
}

interface YouTubeNamespace {
  Player: new (host: HTMLElement, options: Record<string, unknown>) => YouTubePlayerApi;
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youTubeApi: Promise<YouTubeNamespace> | null = null;

function loadYouTubeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youTubeApi) {
    youTubeApi = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT) resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        youTubeApi = null;
        script.remove();
        reject(new Error("YouTube could not be reached. Check the connection and try again."));
      };
      document.head.appendChild(script);
    });
  }
  return youTubeApi;
}

const YT_PLAYING = 1;
const YT_BUFFERING = 3;

/** YouTube's own error codes, in words. */
function youTubeError(code: number): string {
  if (code === 2) return "YouTube didn't accept that video id.";
  if (code === 5) return "This video can't play in an embedded player.";
  if (code === 100) return "That video was removed or made private.";
  if (code === 101 || code === 150) return "The owner doesn't allow this video to play outside YouTube.";
  return `YouTube couldn't play this video (error ${code}).`;
}

/**
 * Mount a YouTube player into `host`. Its own controls are off: the pad's
 * controls drive it, so a YouTube pad and a file pad work the same way.
 */
export async function youTubePlayer(
  host: HTMLElement,
  videoId: string,
  events: { onReady: () => void; onError: (message: string) => void },
): Promise<VideoPlayer> {
  const YT = await loadYouTubeApi();
  const mount = document.createElement("div");
  host.appendChild(mount);
  let ready = false;
  const api = new YT.Player(mount, {
    videoId,
    width: "100%",
    height: "100%",
    playerVars: {
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      iv_load_policy: 3,
      origin: window.location.origin,
    },
    events: {
      onReady: () => { ready = true; events.onReady(); },
      onError: (event: { data: number }) => events.onError(youTubeError(event.data)),
    },
  });
  const state = () => (ready ? api.getPlayerState() : -1);
  return {
    kind: "youtube",
    time: () => (ready ? api.getCurrentTime() : 0),
    duration: () => (ready ? api.getDuration() || NaN : NaN),
    paused: () => state() !== YT_PLAYING && state() !== YT_BUFFERING,
    play: () => { if (ready) api.playVideo(); },
    pause: () => { if (ready) api.pauseVideo(); },
    seek: (time) => { if (ready) api.seekTo(Math.max(0, time), true); },
    setRate: (rate) => { if (ready) api.setPlaybackRate(rate); },
    setMuted: (muted) => { if (ready) { if (muted) api.mute(); else api.unMute(); } },
    // The embed letterboxes inside its own frame; 16:9 is the frame.
    size: () => ({ width: 16, height: 9 }),
    destroy: () => {
      try { api.destroy(); } catch { /* already gone */ }
      mount.remove();
    },
  };
}
