import { describe, expect, it } from "vitest";
import {
  formatVideoTime,
  frameIndex,
  frameSeekTime,
  frameStart,
  marksAt,
  snapFrameRate,
  videoSourceForUrl,
  youTubeIdFromUrl,
  type VideoMark,
} from "./videoStore";
import { strokeHit, strokePath } from "../modes/VideoInkLayer";
import { parseTabState, serializeTabState } from "./tabPersist";
import { HOME_TAB_ID, homeTab, sameEntity, type VideoTab } from "./tabs";

const mark = (over: Partial<VideoMark>): VideoMark => ({ id: "m", start: 0, end: 0, frame: true, strokes: [], note: "", ...over });

describe("youTubeIdFromUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("reads %s", (url, id) => expect(youTubeIdFromUrl(url)).toBe(id));

  it("refuses look-alikes and other sites", () => {
    expect(youTubeIdFromUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youTubeIdFromUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youTubeIdFromUrl("not a url")).toBeNull();
  });
});

describe("videoSourceForUrl", () => {
  it("keeps web links as links and refuses other schemes", () => {
    expect(videoSourceForUrl("https://example.com/clip.mp4")).toEqual({ kind: "url", url: "https://example.com/clip.mp4" });
    expect(videoSourceForUrl("javascript:alert(1)")).toBeNull();
    expect(videoSourceForUrl("file:///C:/clip.mp4")).toBeNull();
  });
});

describe("frames", () => {
  it("names the frame a time falls in, and seeks inside it", () => {
    expect(frameIndex(1, 30)).toBe(30);
    expect(frameIndex(1.0333, 30)).toBe(30);
    expect(frameIndex(frameSeekTime(42, 25), 25)).toBe(42);
    expect(frameStart(30, 30)).toBe(1);
  });

  it("falls back to 30 fps before a rate is measured", () => {
    expect(frameIndex(2, null)).toBe(60);
  });

  it("snaps measured rates to the common ones", () => {
    expect(snapFrameRate(29.95)).toBe(29.97);
    expect(snapFrameRate(1 / 0.04166)).toBe(24);
    expect(snapFrameRate(23.97)).toBe(23.976);
    expect(snapFrameRate(37.2)).toBe(37.2);
  });
});

describe("marksAt", () => {
  const frame = mark({ id: "f", start: frameStart(30, 30), end: frameStart(30, 30) });
  const range = mark({ id: "r", start: 2, end: 5, frame: false });

  it("shows a frame mark only while paused on its frame", () => {
    expect(marksAt([frame], frameSeekTime(30, 30), true, 30).map(m => m.id)).toEqual(["f"]);
    expect(marksAt([frame], frameSeekTime(30, 30), false, 30)).toEqual([]);
    expect(marksAt([frame], frameSeekTime(31, 30), true, 30)).toEqual([]);
  });

  it("shows a range mark across its stretch, playing or not", () => {
    expect(marksAt([range], 3, false, 30).map(m => m.id)).toEqual(["r"]);
    expect(marksAt([range], 5.01, true, 30)).toEqual([]);
  });
});

describe("formatVideoTime", () => {
  it("formats minutes, and hours only when there are some", () => {
    expect(formatVideoTime(83.4)).toBe("1:23.40");
    expect(formatVideoTime(3725, false)).toBe("1:02:05");
    expect(formatVideoTime(Number.NaN)).toBe("0:00.00");
  });
});

describe("video ink", () => {
  it("draws a single tap as a dot and hits strokes near their line", () => {
    expect(strokePath([0.5, 0.5], 1)).toMatch(/^M0\.50000 0\.50000l/);
    const stroke = { tool: "pen" as const, color: "#fff", width: 0.004, points: [0.1, 0.1, 0.9, 0.1] };
    expect(strokeHit(stroke, 0.5, 0.11, 1)).toBe(true);
    expect(strokeHit(stroke, 0.5, 0.5, 1)).toBe(false);
  });
});

describe("video tabs", () => {
  const tab: VideoTab = { id: "video-3", kind: "video", title: "Swing", dirty: false, lastActive: 1, videoId: "vid-1" };

  it("survive a restart while they name a pad", () => {
    const state = serializeTabState({ tabs: [homeTab(0), tab], activeId: tab.id, groups: [] });
    const back = parseTabState(JSON.parse(JSON.stringify({ v: 1, ...state })));
    expect(back?.tabs.find(t => t.id === tab.id)).toMatchObject({ kind: "video", videoId: "vid-1", title: "Swing" });
  });

  it("drop on restart while still asking which video", () => {
    const state = serializeTabState({ tabs: [homeTab(0), { ...tab, videoId: null }], activeId: HOME_TAB_ID, groups: [] });
    expect(state.tabs.some(t => t.kind === "video")).toBe(false);
  });

  it("are the same workspace only for the same pad", () => {
    expect(sameEntity(tab, { ...tab, id: "video-4" })).toBe(true);
    expect(sameEntity(tab, { ...tab, videoId: "vid-2" })).toBe(false);
    expect(sameEntity({ ...tab, videoId: null }, { ...tab, videoId: null })).toBe(false);
  });
});
