/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setDocSource } from "../util/docSourceStore";
import { DocSourceRefresh, type DocSourceRefreshProps } from "./DocSourceRefresh";

let root: Root, host: HTMLDivElement;
const onCheck = vi.fn();
function render(props: Partial<DocSourceRefreshProps> = {}) {
  act(() => root.render(<DocSourceRefresh docId="book" onCheck={onCheck} {...props} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); onCheck.mockReset(); document.documentElement.removeAttribute("data-ui-handedness");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.textContent = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("renders only for a set with a source on this device", () => {
  render(); expect(host.querySelector("button")).toBeNull();
  setDocSource("book", { kind: "path", location: "/course.pdf", name: "course.pdf", size: 1, modified: 1, hash: "old", checkedAt: 1 });
  render(); expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Check for a newer version of this file");
  act(() => host.querySelector("button")!.click()); expect(onCheck).toHaveBeenCalledOnce();
  render({ docId: null }); expect(host.querySelector("button")).toBeNull();
});

it("tracks the UI hand and uses Home's refresh icon and working ring", async () => {
  setDocSource("book", { kind: "uri", location: "content://course", name: "course.pdf", size: null, modified: null, hash: "old", checkedAt: 1 });
  render(); expect(host.querySelector("button")?.classList.contains("is-right")).toBe(true);
  expect(host.querySelector("path")?.getAttribute("d")).toBe("M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6");
  await act(async () => { document.documentElement.setAttribute("data-ui-handedness", "left"); });
  expect(host.querySelector("button")?.classList.contains("is-left")).toBe(true);
  render({ checking: true }); expect(host.querySelector(".lc-doc-index-ring")).not.toBeNull();
  expect(host.querySelector("button")?.disabled).toBe(true);
});

it("keeps a dot for an unapplied newer result and removes it after the update", async () => {
  setDocSource("book", { kind: "path", location: "/course.md", name: "course.md", size: 1, modified: 1, hash: "old", checkedAt: 1 });
  render(); expect(host.querySelector(".lc-library-sync-dot")).toBeNull();
  render({ newer: true }); expect(host.querySelector(".lc-library-sync-dot")).not.toBeNull();
  await act(async () => { root.render(<DocSourceRefresh docId="book" onCheck={onCheck} newer={false} />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(host.querySelector(".lc-library-sync-dot")).toBeNull();
});

it("moves just inward of the menu stack when the top corner overlaps it", () => {
  setDocSource("book", { kind: "path", location: "/course.pdf", name: "course.pdf", size: 1, modified: 1, hash: "old", checkedAt: 1 });
  const stack = document.createElement("div"); stack.className = "lc-map-chrome-right"; document.body.append(stack);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this === stack
      ? { x: 950, y: 0, left: 950, right: 1000, top: 0, bottom: 500, width: 50, height: 500, toJSON() {} }
      : { x: 968, y: 12, left: 968, right: 1000, top: 12, bottom: 44, width: 32, height: 32, toJSON() {} };
  });
  render(); expect(host.querySelector("button")?.style.getPropertyValue("--lc-doc-source-shift")).toBe("62px");
});
