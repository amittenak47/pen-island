/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ apply: vi.fn(async () => {}) }));
vi.mock("./util/readingFullscreen", () => ({ applyReadingFullscreen: native.apply }));
import { useReadingFullscreen } from "./useReadingFullscreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let state: ReturnType<typeof useReadingFullscreen>;
function Probe({ available }: { available: boolean }) { state = useReadingFullscreen(available); return null; }
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("starts off and touches nothing native until toggled", () => {
  act(() => root.render(<Probe available />));
  expect(state.on).toBe(false); expect(native.apply).not.toHaveBeenCalled();
  act(() => state.toggle());
  expect(state.on).toBe(true); expect(native.apply).toHaveBeenLastCalledWith(true);
  act(() => state.toggle());
  expect(state.on).toBe(false); expect(native.apply).toHaveBeenLastCalledWith(false);
});

it("Escape leaves full screen", () => {
  act(() => root.render(<Probe available />));
  act(() => state.toggle());
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(state.on).toBe(false); expect(native.apply).toHaveBeenLastCalledWith(false);
});

it("leaving the view that offers it (e.g. going Home) brings the header back", () => {
  act(() => root.render(<Probe available />));
  act(() => state.toggle());
  act(() => root.render(<Probe available={false} />));
  expect(state.on).toBe(false); expect(native.apply).toHaveBeenLastCalledWith(false);
});
