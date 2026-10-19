/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOLD_FILL_MS } from "../util/gesture";
import { DocSyncLinkPair, type DocSyncLinkPairProps } from "./DocSyncLinkPair";

const hub = vi.hoisted(() => ({ status: "online" as "online" | "offline" | "unknown" }));
vi.mock("../util/padHubStatus", () => ({ usePadHubStatus: () => ({ hub: { url: "http://hub.test" }, status: hub.status }) }));

let root: Root, host: HTMLDivElement;
const onSync = vi.fn(), onCheck = vi.fn(), onLink = vi.fn(), onUnlink = vi.fn();
const link = (over: Partial<NonNullable<DocSyncLinkPairProps["link"]>> = {}) =>
  ({ name: "course.pdf", checking: false, newer: false, onCheck, onLink, onUnlink, ...over });
function render(props: Partial<DocSyncLinkPairProps> = {}) {
  act(() => root.render(<DocSyncLinkPair syncLine="Not synced" syncing={false} onSync={onSync} link={link()} {...props} />));
}
const halves = () => [...host.querySelectorAll<HTMLButtonElement>(".lc-sync-link-pair button")];
const kinds = () => halves().map(b => b.className.match(/lc-sync-link-(sync|link)/)?.[1]);
const tip = () => document.querySelector<HTMLElement>(".lc-sync-link-tip");

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  hub.status = "online";
  for (const fn of [onSync, onCheck, onLink, onUnlink]) fn.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.textContent = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("is one [● | 🔗] pair of icons; Sync runs the tab's Sync and Link checks the linked file", () => {
  render();
  expect(kinds()).toEqual(["sync", "link"]);
  // Icons only: the words are in the labels and the notifications.
  expect(halves().map(b => b.textContent)).toEqual(["", ""]);
  expect(halves()[0].querySelector(".lc-sync-link-dot")).not.toBeNull();
  expect(halves()[0].getAttribute("aria-label")).toBe("Sync. Not synced");
  act(() => halves()[0].click());
  expect(onSync).toHaveBeenCalledOnce();
  act(() => halves()[1].click());
  expect(onCheck).toHaveBeenCalledOnce();
  expect(onLink).not.toHaveBeenCalled();
});

it("links an unlinked document on tap", () => {
  render({ link: link({ name: null }) });
  expect(halves()[1].classList.contains("is-unlinked")).toBe(true);
  act(() => halves()[1].click());
  expect(onLink).toHaveBeenCalledOnce();
  expect(onCheck).not.toHaveBeenCalled();
});

it("shows each half's status directly under it: Sync's left-aligned, Link's right-aligned", () => {
  render();
  const [sync, linkHalf] = [...host.querySelectorAll<HTMLElement>(".lc-sync-link-half")];
  act(() => sync.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  expect(tip()?.textContent).toBe("Not synced");
  expect(tip()?.classList.contains("is-left")).toBe(true);
  act(() => linkHalf.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  expect(tip()?.textContent).toBe("Linked to “course.pdf”. Tap to check for a newer version, hold for more.");
  expect(tip()?.classList.contains("is-right")).toBe(true);
});

it("says the desktop app is offline under Sync when the hub is", () => {
  hub.status = "offline";
  render();
  act(() => host.querySelector(".lc-sync-link-half")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  expect(tip()?.textContent).toBe("Desktop app is offline. Try again when it's back.");
});

it("does not start a second walk while one runs", () => {
  render({ syncing: true, syncLine: "Pad…" });
  expect(halves()[0].getAttribute("aria-busy")).toBe("true");
  act(() => halves()[0].click());
  expect(onSync).not.toHaveBeenCalled();
});

it("opens the linked file hold menu and runs each action", async () => {
  render();
  const hold = async () => {
    const trigger = halves()[1];
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
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  }
});

it("colours Sync green when synced, yellow while syncing, red when not synced, failed or offline", () => {
  const dot = () => halves()[0].querySelector(".lc-sync-link-dot")?.getAttribute("data-state");
  render({ synced: true }); expect(dot()).toBe("synced");
  render({ syncing: true }); expect(dot()).toBe("syncing");
  render({ synced: false }); expect(dot()).toBe("unsynced");
  render({ synced: true, syncFailed: true }); expect(dot()).toBe("unsynced");
  hub.status = "offline";
  render({ synced: true }); expect(dot()).toBe("unsynced");
});

it("colours Link green when linked, yellow for a newer version or a check, red when not linked", () => {
  const state = () => ["linked", "attention", "unlinked"].find(name => halves()[1].classList.contains(`is-${name}`));
  render(); expect(state()).toBe("linked");
  render({ link: link({ newer: true }) }); expect(state()).toBe("attention");
  render({ link: link({ checking: true }) }); expect(state()).toBe("attention");
  expect(halves()[1].disabled).toBe(true);
  render({ link: link({ name: null }) }); expect(state()).toBe("unlinked");
});

it("is Sync alone for a kind with no file", () => {
  render({ link: null });
  expect(kinds()).toEqual(["sync"]);
  expect(host.querySelector(".lc-sync-link-pair")?.classList.contains("is-sync-only")).toBe(true);
});
