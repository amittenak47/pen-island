/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationStack, NOTIFICATION_FOLD_MS, NOTIFICATION_HOLD_MS } from "./NotificationStack";
import { dismissNotificationDeck, notificationSnapshot, setNotificationReducedMotion, showNotification } from "../util/notifications";

vi.mock("motion/react", async importOriginal => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => true,
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setNotificationReducedMotion(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<NotificationStack />));
  act(() => { showNotification("Annotation"); showNotification("Saved"); showNotification("Scroll mode"); });
});
afterEach(() => {
  act(() => root.unmount());
  act(() => { dismissNotificationDeck(); vi.advanceTimersByTime(0); });
  host.remove();
  vi.useRealTimers();
});
const stack = () => document.querySelector<HTMLElement>(".lc-notification-stack")!;
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".lc-notification"));
const top = () => cards()[0].querySelector<HTMLButtonElement>(".lc-notification-message")!;

it("starts folded, unfolds on tap, and pauses expiration while reading", () => {
  expect(stack().classList.contains("is-folded")).toBe(true);
  expect(cards()[1].hasAttribute("inert")).toBe(true);
  act(() => top().click());
  expect(stack().classList.contains("is-expanded")).toBe(true);
  expect(cards()[1].hasAttribute("inert")).toBe(false);
  act(() => vi.advanceTimersByTime(3000));
  expect(notificationSnapshot()).toHaveLength(3);
});

it("dismisses one unfolded card and leaves the remaining messages in order", () => {
  act(() => top().click());
  act(() => { cards()[1].querySelector<HTMLButtonElement>(".lc-notification-dismiss")!.click(); vi.advanceTimersByTime(0); });
  expect(cards().map(card => card.querySelector(".lc-notification-message span")?.textContent)).toEqual(["Annotation", "Scroll mode"]);
  expect(stack().classList.contains("is-expanded")).toBe(true);
});

it("folds after inactivity and then dismisses the whole deck", () => {
  act(() => top().click());
  act(() => vi.advanceTimersByTime(NOTIFICATION_FOLD_MS));
  expect(stack().classList.contains("is-folded")).toBe(true);
  act(() => { cards()[0].querySelector<HTMLButtonElement>(".lc-notification-dismiss")!.click(); vi.advanceTimersByTime(0); });
  expect(cards()).toHaveLength(0);
});

it("long pressing the top card folds it without the release tap reopening it", () => {
  act(() => top().click());
  act(() => top().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  act(() => vi.advanceTimersByTime(NOTIFICATION_HOLD_MS));
  act(() => { top().dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); top().click(); });
  expect(stack().classList.contains("is-folded")).toBe(true);
});

it("cancels long press when the pointer moves and folds with Escape", () => {
  act(() => top().click());
  act(() => {
    top().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
    top().dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 80 }));
  });
  act(() => vi.advanceTimersByTime(NOTIFICATION_HOLD_MS));
  expect(stack().classList.contains("is-expanded")).toBe(true);
  act(() => top().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
  expect(stack().classList.contains("is-folded")).toBe(true);
});

it("re-measures the header when a notification arrives, so a shifted page can't strand it", () => {
  act(() => root.unmount());
  act(() => { dismissNotificationDeck(); vi.advanceTimersByTime(0); });
  const header = document.createElement("header");
  header.className = "lc-header";
  let bottom = 400;
  header.getBoundingClientRect = () => ({ top: bottom - 60, bottom, left: 0, right: 700, width: 700, height: 60, x: 0, y: bottom - 60, toJSON: () => ({}) });
  document.body.append(header);
  root = createRoot(host);
  act(() => root.render(<NotificationStack />));
  act(() => { showNotification("Saved"); });
  expect(stack().style.top).toBe("408px");
  // The keyboard closed and the page settled: the header is back at the top.
  bottom = 63;
  act(() => { showNotification("Closed"); });
  expect(stack().style.top).toBe("71px");
  header.remove();
});
