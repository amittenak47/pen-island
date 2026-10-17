/** @vitest-environment jsdom */
import { act, createElement, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useLatest } from "./useLatest";

it("holds each render's value in the same ref, starting with the first render", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const renders: { ref: MutableRefObject<unknown>; value: unknown }[] = [];
  function Probe({ value }: { value: unknown }) {
    const ref = useLatest(value);
    renders.push({ ref, value: ref.current });
    return null;
  }
  const first = { label: "first" };
  const second = { label: "second" };
  try {
    act(() => root.render(createElement(Probe, { value: first })));
    expect(renders[0].value).toBe(first);
    const ref = renders[0].ref;
    for (const value of [second, null, 0, undefined]) {
      act(() => root.render(createElement(Probe, { value })));
      expect(renders.at(-1)!.value).toBe(value);
      expect(renders.at(-1)!.ref).toBe(ref);
      expect(ref.current).toBe(value);
    }
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
