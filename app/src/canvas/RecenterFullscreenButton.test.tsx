/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import { RecenterFullscreenButton } from "./RecenterFullscreenButton";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    Element.prototype.hasPointerCapture = function () { return true; };
  }
  if (typeof PointerEvent === "undefined") {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
    }
    // @ts-expect-error jsdom lacks PointerEvent
    globalThis.PointerEvent = FakePointerEvent;
  }
});
let root: Root, host: HTMLDivElement;
const onRecenter = vi.fn(), onToggle = vi.fn();
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (fullscreen: boolean) => act(() => root.render(<RecenterFullscreenButton fullscreen={fullscreen} onRecenter={onRecenter} onToggleFullscreen={onToggle} />));
const button = () => host.querySelector("button")!;
async function press(ms: number) {
  await act(async () => { button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  await act(async () => { button().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 })); });
}

it("a tap recenters; it does not change full screen", async () => {
  render(false);
  expect(button().getAttribute("aria-label")).toBe("Recenter and refresh the view. Hold for full screen");
  expect(button().querySelector("[data-icon=recenter]")).not.toBeNull();
  await press(10);
  expect(onRecenter).toHaveBeenCalledOnce(); expect(onToggle).not.toHaveBeenCalled();
});

it("a hold toggles full screen instead of recentering", async () => {
  render(false);
  await press(LIBRARY_HOLD_MS + 80);
  expect(onToggle).toHaveBeenCalledOnce(); expect(onRecenter).not.toHaveBeenCalled();
});

it("in full screen it shows the exit icon and says how to leave", async () => {
  render(true);
  expect(button().getAttribute("aria-pressed")).toBe("true");
  expect(button().getAttribute("aria-label")).toBe("Hold to exit full screen. Tap to recenter");
  expect(button().querySelector("[data-icon=exit-fullscreen]")).not.toBeNull();
  await press(LIBRARY_HOLD_MS + 80);
  expect(onToggle).toHaveBeenCalledOnce();
});
