/** @vitest-environment jsdom */
import { beforeEach, expect, it } from "vitest";
import { isLivePageStorage, LIVE_PAGE_STORAGE_LIMIT, readLivePageStorage, writeLivePageStorage } from "./livePageStorage";

beforeEach(() => localStorage.clear());

it("keeps each document's page storage apart and across reads", () => {
  expect(readLivePageStorage("doc-a")).toEqual({});
  expect(writeLivePageStorage("doc-a", { "bbt-page": "tracer", "bbt-last": '{"k":"dfs","ex":0,"i":3}' })).toBe(true);
  expect(writeLivePageStorage("doc-b", { "bbt-page": "problems" })).toBe(true);
  expect(readLivePageStorage("doc-a")).toEqual({ "bbt-page": "tracer", "bbt-last": '{"k":"dfs","ex":0,"i":3}' });
  expect(readLivePageStorage("doc-b")).toEqual({ "bbt-page": "problems" });
});

it("drops the entry when the page clears its storage", () => {
  writeLivePageStorage("doc-a", { a: "1" });
  writeLivePageStorage("doc-a", {});
  expect(localStorage.length).toBe(0);
});

it("refuses anything but a bounded map of strings", () => {
  for (const bad of [null, "x", [], { a: 1 }, { a: null }, new Map([["a", "1"]]), { a: "x".repeat(LIVE_PAGE_STORAGE_LIMIT) }]) {
    expect(isLivePageStorage(bad)).toBe(false);
    expect(writeLivePageStorage("doc-a", bad)).toBe(false);
  }
  expect(readLivePageStorage("doc-a")).toEqual({});
  localStorage.setItem("lc-live-page-storage:doc-a", "not json");
  expect(readLivePageStorage("doc-a")).toEqual({});
});
