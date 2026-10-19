/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDocSource, getDocSource, listDocSources, setDocSource, type DocSourceRef } from "./docSourceStore";

const ref: DocSourceRef = { kind: "path", location: "C:/private/notes.md", name: "notes.md", size: 8, modified: null, hash: "old", checkedAt: 1 };
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("device document sources", () => {
  it("round trips each set separately and clears just one", () => {
    setDocSource("one", ref); setDocSource("two", { ...ref, kind: "uri", location: "content://notes" });
    expect(getDocSource("one")).toEqual(ref);
    expect(Object.keys(listDocSources())).toEqual(["one", "two"]);
    clearDocSource("one");
    expect(getDocSource("one")).toBeNull(); expect(getDocSource("two")?.kind).toBe("uri");
  });
  it.each(["broken", "null", "[]", '{"bad":{"location":"secret"}}'])("tolerates corrupt storage %s", value => {
    localStorage.setItem("pen.docSources.v1", value);
    expect(listDocSources()).toEqual({}); expect(getDocSource("bad")).toBeNull();
    setDocSource("one", ref); expect(getDocSource("one")).toEqual(ref);
  });
  it("guards reads and writes when storage is denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(listDocSources()).toEqual({}); expect(getDocSource("one")).toBeNull();
    expect(() => setDocSource("one", ref)).not.toThrow(); expect(() => clearDocSource("one")).not.toThrow();
  });
});
