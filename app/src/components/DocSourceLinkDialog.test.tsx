/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocSourceLinkDialog } from "./DocSourceLinkDialog";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.textContent = ""; vi.unstubAllGlobals(); });

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
