/** @vitest-environment jsdom */
import { act, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ColorRadial } from "./ColorRadial";
import { useInkPaletteAdvance } from "./useInkPaletteAdvance";
import { currentInkPalette, cycleInkPalettePrev, type InkPaletteHistory } from "../util/inkPaletteHistory";
import { HOLD_MS } from "../util/gesture";

const fetchPalette = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock("../util/colorHunt", () => ({ fetchNextColorHuntPalette: fetchPalette }));
const first = ["#112233", "#445566"], second = ["#778899", "#aabbcc"], fresh = ["#ff0033", "#0099ff"];
let host: HTMLDivElement, root: Root;
const onError = vi.fn();
const paper = () => "#ffffff";
function Palette() {
  const [history, setHistory] = useState<InkPaletteHistory>({ items: [first, second], index: 1 });
  const historyRef = useRef(history); historyRef.current = history;
  const apply = useCallback((next: InkPaletteHistory) => { historyRef.current = next; setHistory(next); }, []);
  const next = useInkPaletteAdvance(historyRef, apply, paper, onError);
  const colors = currentInkPalette(history);
  return <ColorRadial colors={colors} value={colors[0]!} onPick={() => {}} handedness="right"
    onCycleNext={next} onCyclePrev={() => apply(cycleInkPalettePrev(historyRef.current))} />;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); fetchPalette.mockResolvedValue(fresh);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Palette />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const dot = () => host.querySelector<HTMLButtonElement>(".lc-color-dot")!;
async function press(duration: number) {
  await act(async () => dot().dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(duration));
  await act(async () => {
    dot().dispatchEvent(new Event("pointerup", { bubbles: true }));
    dot().click();
  });
}
it("loads and applies a fresh palette on tap after the wheel revisits saved history", async () => {
  await press(HOLD_MS + 1);
  expect(dot().getAttribute("aria-expanded")).toBe("true");
  expect(fetchPalette).not.toHaveBeenCalled();
  const hub = document.querySelector<HTMLButtonElement>(".lc-color-wheel-hub")!;
  await act(async () => hub.click());
  expect(dot().querySelector("span")!.style.background).toBe("rgb(17, 34, 51)");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await press(50);
  expect(fetchPalette).toHaveBeenCalledOnce();
  expect(dot().querySelector("span")!.style.background).toBe("rgb(255, 0, 51)");
  expect(document.querySelector(".lc-color-wheel")).toBeNull();
});
it("coalesces pending taps, reports failure, and allows a retry", async () => {
  let reject!: (error: Error) => void;
  fetchPalette.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await press(50); await press(50);
  expect(fetchPalette).toHaveBeenCalledOnce();
  const error = new Error("No distinct, readable ink colors for this paper");
  await act(async () => reject(error));
  expect(onError).toHaveBeenCalledWith(error);
  expect(dot().querySelector("span")!.style.background).toBe("rgb(119, 136, 153)");
  await press(50);
  expect(fetchPalette).toHaveBeenCalledTimes(2);
  expect(dot().querySelector("span")!.style.background).toBe("rgb(255, 0, 51)");
});
it("cancels an interrupted press without fetching or opening the wheel", async () => {
  await act(async () => {
    dot().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    dot().dispatchEvent(new Event("pointercancel", { bubbles: true }));
    vi.advanceTimersByTime(HOLD_MS + 1);
    dot().dispatchEvent(new Event("pointerup", { bubbles: true }));
  });
  expect(fetchPalette).not.toHaveBeenCalled();
  expect(dot().getAttribute("aria-expanded")).toBe("false");
});
