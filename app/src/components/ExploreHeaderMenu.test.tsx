/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExploreHeaderMenu } from "./ExploreHeaderMenu";
import { saveDocumentExport } from "../util/saveDocumentExport";
import type { ExploreGraphExport } from "../util/exploreGraphExport";
vi.mock("../util/saveDocumentExport", () => ({ saveDocumentExport:vi.fn() }));
// Gesture timing is covered by HoldButton tests; exercise each menu operation here.
vi.mock("./HoldButton", () => ({ HoldButton:({label,ariaLabel,onTap,onConfirm,disabled,children}:any) =>
  <button aria-label={ariaLabel ?? label} disabled={disabled} onClick={onTap ?? onConfirm} onContextMenu={onConfirm}>{children ?? label}</button> }));
let root:Root, host:HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true); host=document.createElement("div"); document.body.append(host); root=createRoot(host); vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const graph:ExploreGraphExport = {format:"pen-island-graph",version:1,exportedAt:"2026-10-07T00:00:00.000Z",nodes:[],edges:[]};
const button = (label:string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function show(getGraph=vi.fn(async () => graph),onOpen=vi.fn()) {
  await act(async () => root.render(<ExploreHeaderMenu active disabled={false} onOpen={onOpen} getGraph={getGraph}/>));
  const header=button("Explore: tap to open the graph, hold for menu");
  act(() => header.click()); expect(onOpen).toHaveBeenCalledOnce();
  expect(document.querySelector('[aria-label="Explore menu"]')).toBeNull();
  act(() => header.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true})));
}
it("offers no Pull (Sync all and the tab's Sync cover it) and prevents closing a pending export", async () => {
  let finish!:(value:string)=>void;
  vi.mocked(saveDocumentExport).mockImplementationOnce(() => new Promise<string>(resolve => {finish=resolve;}));
  await show();
  expect(button("Pull")).toBeNull();
  expect(document.querySelector('[aria-label="Explore menu"] .lc-dialog-foot')?.textContent).toBe("Cancel");
  await act(async () => button("Export graph").click());
  act(() => window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"})));
  expect(document.querySelector('[aria-label="Explore menu"]')).not.toBeNull();
  expect(button("Export graph").disabled).toBe(true);
  await act(async () => finish("Saved graph"));
  expect(button("Export graph").disabled).toBe(false);
});
it("exports JSON through the file saver and can retry after a save failure", async () => {
  vi.mocked(saveDocumentExport).mockRejectedValueOnce(new Error("Save unavailable")).mockResolvedValueOnce("Saved graph");
  await show();
  await act(async () => button("Export graph").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Save unavailable");
  expect(button("Export graph").disabled).toBe(false);
  await act(async () => button("Export graph").click());
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[aria-label="Explore menu"]')?.textContent).toContain("Saved graph");
  expect(saveDocumentExport).toHaveBeenCalledWith(expect.objectContaining({name:"pen-island-graph-2026-10-07.json",blob:expect.any(Blob)}),expect.any(AbortSignal),expect.any(Function));
});
