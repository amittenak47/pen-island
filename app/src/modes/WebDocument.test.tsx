/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WebDocument } from "./WebDocument";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each([true, false])("fragment clicks never navigate or change the app URL (local file: %s)", async localFile => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const navigate = vi.fn();
  await act(async () => root.render(<WebDocument html='<a href="#table">Map</a><p id="table">Table</p>' url="guide.html" localFile={localFile} onNavigate={navigate} />));
  const before = window.location.href;
  for (const type of ["click", "auxclick"]) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    host.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(navigate).not.toHaveBeenCalled();
  expect(window.location.href).toBe(before);
  act(() => root.unmount());
});

it.each([true, false])("external links browse only address documents (local file: %s)", async localFile => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const navigate = vi.fn();
  await act(async () => root.render(<WebDocument html='<a href="https://example.com/next">Next</a>' url="https://example.com" localFile={localFile} onNavigate={navigate} />));
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  host.querySelector("a")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  if (localFile) expect(navigate).not.toHaveBeenCalled();
  else expect(navigate).toHaveBeenCalledWith("https://example.com/next");
  act(() => root.unmount());
});

it("a middle click on a link opens nothing new: no window, no navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const navigate = vi.fn();
  await act(async () => root.render(<WebDocument html='<a href="https://example.com/next">Next</a>' url="https://example.com" onNavigate={navigate} />));
  const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  host.querySelector("a")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("waits for a real column before reporting its height", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resized: (() => void) | null = null;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() {} });
  let width = 32;
  let height = 58848;
  const proto = HTMLElement.prototype;
  const saved = { cw: Object.getOwnPropertyDescriptor(proto, "clientWidth"), sh: Object.getOwnPropertyDescriptor(proto, "scrollHeight") };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return width; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return height; } });
  try {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const measure = vi.fn();
    // Mounted in a slot with no width yet: one glyph per line, absurdly tall.
    await act(async () => root.render(<WebDocument html="<p>guide</p>" url="guide.html" localFile onMeasure={measure} />));
    expect(measure).not.toHaveBeenCalled();
    // The column arrives and the observer fires: now the height is real.
    width = 920;
    height = 20914;
    act(() => resized?.());
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith(20914);
    act(() => root.unmount());
  } finally {
    if (saved.cw) Object.defineProperty(proto, "clientWidth", saved.cw); else delete (proto as { clientWidth?: number }).clientWidth;
    if (saved.sh) Object.defineProperty(proto, "scrollHeight", saved.sh); else delete (proto as { scrollHeight?: number }).scrollHeight;
  }
});
