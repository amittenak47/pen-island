/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setDocSource } from "../util/docSourceStore";
import { HOLD_FILL_MS } from "../util/gesture";
import { DocSourceLinkDialog, DocSourceRefresh, type DocSourceRefreshProps } from "./DocSourceRefresh";

const native = vi.hoisted(() => ({ available: vi.fn() }));
vi.mock("../util/docSourceNative", () => ({ nativeSourcePickerAvailable: native.available }));

let root: Root, host: HTMLDivElement;
const onCheck = vi.fn();
const onLink = vi.fn();
const onUnlink = vi.fn();
function render(props: Partial<DocSourceRefreshProps> = {}) {
  act(() => root.render(<DocSourceRefresh docId="book" onCheck={onCheck} onLink={onLink} onUnlink={onUnlink} {...props} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); onCheck.mockReset(); onLink.mockReset(); onUnlink.mockReset(); native.available.mockReset().mockReturnValue(true);
  document.documentElement.removeAttribute("data-ui-handedness");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.textContent = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("offers linking for unlinked sets with the dimmed icon, chain badge and label", () => {
  render();
  const unlinked = host.querySelector("button")!;
  expect(unlinked.getAttribute("aria-label")).toBe("Link this document to its file");
  expect(unlinked.classList.contains("is-unlinked")).toBe(true);
  expect(unlinked.querySelector(".lc-icon-svg")).not.toBeNull();
  expect(unlinked.querySelector(".lc-doc-source-link-badge")?.getAttribute("width")).toBe("9");
  act(() => unlinked.click()); expect(onLink).toHaveBeenCalledOnce(); expect(onCheck).not.toHaveBeenCalled();
  setDocSource("book", { kind: "path", location: "/course.pdf", name: "course.pdf", size: 1, modified: 1, hash: "old", checkedAt: 1 });
  render(); expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Check for a newer version of this file. Hold for more");
  act(() => host.querySelector("button")!.click()); expect(onCheck).toHaveBeenCalledOnce();
  render({ docId: null }); expect(host.querySelector("button")).toBeNull();
  native.available.mockReturnValue(false); render(); expect(host.querySelector("button")).toBeNull();
});

it("opens the linked file hold menu and runs each action", async () => {
  setDocSource("book", { kind: "path", location: "/course.pdf", name: "course.pdf", size: 1, modified: 1, hash: "old", checkedAt: 1 });
  render();
  const hold = async () => {
    const trigger = host.querySelector("button")!;
    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLD_FILL_MS + 50); });
    act(() => trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })));
  };
  for (const [label, callback] of [["Check now", onCheck], ["Link to a different file…", onLink], ["Unlink", onUnlink]] as const) {
    await hold();
    const menu = document.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Check now", "Link to a different file…", "Unlink"]);
    act(() => [...menu.querySelectorAll("button")].find(button => button.textContent === label)!.click());
    expect(callback).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  }
});

it("shows the missing file dialog and offers finding its replacement", () => {
  const find = vi.fn(), cancel = vi.fn();
  act(() => root.render(<DocSourceLinkDialog mode="missing" fileName="course.pdf" onFind={find} onCancel={cancel} />));
  const dialog = host.querySelector('[role="dialog"][aria-label="Linked file not found"]')!;
  expect(dialog.textContent).toContain("“course.pdf” isn't where it was. Find it to keep this document up to date.");
  act(() => [...dialog.querySelectorAll("button")].find(button => button.textContent === "Find the file…")!.click());
  expect(find).toHaveBeenCalledOnce();
  act(() => [...dialog.querySelectorAll("button")].find(button => button.textContent === "Not now")!.click());
  expect(cancel).toHaveBeenCalledOnce();
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
  render({ newer: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
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
