/** @vitest-environment jsdom */
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { FlickPredictHud, type FlickPredictHudHandle } from "./FlickPredictHud";

afterEach(() => {
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

it("writes nothing when told to hide while hidden: it is told so on every frame the page moves", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const ref = createRef<FlickPredictHudHandle>();
  const root = createRoot(host);
  act(() => root.render(<FlickPredictHud ref={ref} />));
  const node = host.querySelector(".lc-flick-predict-hud")!;
  const writes: MutationRecord[] = [];
  const watch = new MutationObserver((records) => writes.push(...records));
  watch.observe(node, { attributes: true, childList: true, characterData: true, subtree: true });
  for (let i = 0; i < 5; i += 1) ref.current!.hide();
  await Promise.resolve();
  expect(writes).toHaveLength(0);
  // Shown, then hidden: hidden once.
  ref.current!.show(3, 4, 1);
  expect((node as HTMLElement).hidden).toBe(false);
  ref.current!.hide();
  ref.current!.hide();
  expect((node as HTMLElement).hidden).toBe(true);
  expect(node.textContent).toBe("");
  watch.disconnect();
  act(() => root.unmount());
});
