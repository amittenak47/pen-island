/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { clampMiniNoteRect, defaultMiniNoteRect, loadMiniNotePlacements, saveMiniNotePlacements,
  requestMiniNoteRestore, takeMiniNoteRestore } from "./miniNoteWindows";

describe("mini note positions across workspace eviction", () => {
  it("restores a recreated workspace's geometry without sharing mutable state", () => {
    const rect = { left: 118, top: 641, width: 360, height: 330 };
    const firstWorkspace = { "f1:n1": { ...rect } };
    saveMiniNotePlacements("placement-scratch-a", firstWorkspace);
    firstWorkspace["f1:n1"].left = 900;
    const recreatedWorkspace = loadMiniNotePlacements("placement-scratch-a");
    expect(recreatedWorkspace).toEqual({ "f1:n1": rect });
    recreatedWorkspace["f1:n1"]!.width = 600;
    delete recreatedWorkspace["f1:n1"];
    expect(loadMiniNotePlacements("placement-scratch-a")).toEqual({ "f1:n1": rect });
  });
  it("keeps document positions separate even when note identifiers match", () => {
    const rectA = { left: 20, top: 30, width: 200, height: 150 };
    const rectB = { left: 120, top: 130, width: 300, height: 250 };
    saveMiniNotePlacements("placement-scratch-b", { "f1:n1": rectA });
    saveMiniNotePlacements("placement-scratch-c", { "f1:n1": rectB });
    expect(loadMiniNotePlacements("placement-scratch-b")).toEqual({ "f1:n1": rectA });
    expect(loadMiniNotePlacements("placement-scratch-c")).toEqual({ "f1:n1": rectB });
    expect(loadMiniNotePlacements("placement-scratch-missing")).toEqual({});
    saveMiniNotePlacements(null, { "f1:n1": rectA });
    expect(loadMiniNotePlacements(null)).toEqual({});
  });
});

describe("mini note window bounds", () => {
  const canvas = { left: 100, top: 50, width: 700, height: 600 };
  it("keeps dragged and resized notes inside the canvas with a reachable header", () => {
    expect(clampMiniNoteRect({ left: -500, top: -500, width: 280, height: 220 }, canvas))
      .toEqual({ left: 108, top: 58, width: 280, height: 220 });
    expect(clampMiniNoteRect({ left: 900, top: 900, width: 1000, height: 800 }, canvas))
      .toEqual({ left: 108, top: 58, width: 684, height: 584 });
    expect(clampMiniNoteRect({ left: 110, top: 60, width: 10, height: 10 }, canvas))
      .toEqual({ left: 110, top: 60, width: 180, height: 120 });
  });
  it("fits three initial windows without overlap on a tablet canvas", () => {
    const boxes = [0, 1, 2].map(index => defaultMiniNoteRect(index, 3, canvas));
    expect(boxes[0]!.left + boxes[0]!.width).toBeLessThan(boxes[1]!.left);
    expect(boxes[1]!.left + boxes[1]!.width).toBeLessThan(boxes[2]!.left);
    expect(boxes[2]!.left + boxes[2]!.width).toBeLessThanOrEqual(792);
  });
  it("reclamps a remembered window after the viewport shrinks", () => {
    const box = clampMiniNoteRect({ left: 500, top: 400, width: 350, height: 400 }, { left: 0, top: 38, width: 388, height: 562 });
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.top).toBeGreaterThanOrEqual(46);
    expect(box.left + box.width).toBeLessThanOrEqual(380);
    expect(box.top + box.height).toBeLessThanOrEqual(592);
  });
});

describe("restoring a full note into its original document", () => {
  it("waits for the intended document and delivers only once", () => {
    const ref = { docId: "scratch-a", footnoteId: "f1", noteId: "n1" };
    requestMiniNoteRestore(ref);
    expect(takeMiniNoteRestore("scratch-b")).toBeUndefined();
    expect(takeMiniNoteRestore("scratch-a")).toEqual(ref);
    expect(takeMiniNoteRestore("scratch-a")).toBeUndefined();
  });
});
