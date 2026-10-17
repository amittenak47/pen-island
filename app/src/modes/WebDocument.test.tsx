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
