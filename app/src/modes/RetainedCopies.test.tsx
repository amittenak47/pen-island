/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RetainedCopies } from "./RetainedCopies";
import { LIBRARY_HOLD_MS } from "../util/gesture";

const mocks = vi.hoisted(() => ({
  copies: vi.fn(async (): Promise<unknown[]> => [{ id: "recovery", type: "record", bookId: "removed", record: { meta: { name: "Removed parent" } } }]),
  restore: vi.fn(async (): Promise<{ kind?: string; id?: string; status: "queued" | "restored" | "stale" }> => ({ kind: "annotate", id: "removed", status: "queued" })),
  snapshot: vi.fn(async (_kind: string, _key: string, _tier: string, snapshotId?: string) => ({ snapshotId, artifactBundle: { retained: true } })),
  restoreSnapshot: vi.fn(async (): Promise<{ status: "queued" | "restored" | "stale" }> => ({ status: "queued" })),
  exported: vi.fn(async () => ({ original: new Uint8Array([1, 2]).buffer })),
}));
vi.mock("../util/syncRecovery", () => ({
  listRecoveryCopies: mocks.copies,
  exportRecoveryCopy: mocks.exported,
}));
vi.mock("../util/padSnapshotStore", () => ({
  listAllPadSnapshots: async () => ["first", "second"].map(snapshotId => ({ kind: "annotate", key: "removed", tier: "7d", writtenAt: 1, name: snapshotId, snapshotId })),
  getPadSnapshot: mocks.snapshot,
}));
vi.mock("../util/recoveryRestore", () => ({ restoreRetainedRecord: mocks.restore, recoveryExportValue: async (value: unknown) => value }));
vi.mock("../util/artifactSnapshotRestore", () => ({ restorePadSnapshotLocally: mocks.restoreSnapshot }));
beforeAll(() => {
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
let root: Root;
let host: HTMLDivElement;
const refreshed = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:retained"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<RetainedCopies kind="annotate" onRestored={refreshed} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
it("offers a removed parent for explicit local restoration while preserving its export path", async () => {
  const row = [...host.querySelectorAll<HTMLDivElement>(".lc-scratch-load-entry")].find(row => row.textContent?.includes("Removed parent"))!;
  await click(row.querySelectorAll("button")[0]!); expect(mocks.exported).toHaveBeenCalledWith("recovery");
  await click(row.querySelectorAll("button")[1]!); expect(mocks.restore).not.toHaveBeenCalled();
  await click(row.querySelectorAll("button")[1]!); expect(mocks.restore).toHaveBeenCalledWith("recovery");
  expect(refreshed).toHaveBeenCalledOnce(); expect(row.querySelectorAll("button")[0]!.textContent).toBe("Export copy");
});
it("reads and restores the selected immutable same-tier snapshot with its dependency bundle", async () => {
  const row = [...host.querySelectorAll<HTMLDivElement>(".lc-scratch-load-entry")].find(row => row.querySelector("strong")?.textContent === "second")!;
  await click(row.querySelectorAll("button")[0]!);
  expect(mocks.snapshot).toHaveBeenLastCalledWith("annotate", "removed", "7d", "second");
  await click(row.querySelectorAll("button")[1]!); await click(row.querySelectorAll("button")[1]!);
  expect(mocks.restoreSnapshot).toHaveBeenCalledWith({ kind: "annotate", id: "removed" }, { snapshotId: "second", artifactBundle: { retained: true } }, { retained: true });
  expect(host.querySelectorAll(".lc-scratch-load-entry")).toHaveLength(3);
});
it("keeps retained entries reachable and displays a refused restoration", async () => {
  mocks.restore.mockRejectedValueOnce(new Error("Missing handwriting; both copies kept"));
  const buttons = host.querySelectorAll<HTMLButtonElement>(".lc-scratch-load-entry button");
  await click(buttons[1]!); await click(buttons[1]!);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Missing handwriting; both copies kept");
  expect(refreshed).not.toHaveBeenCalled(); expect(host.querySelectorAll(".lc-scratch-load-entry")).toHaveLength(3);
});
async function holdButton(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === `Hold to confirm: ${label}`);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, LIBRARY_HOLD_MS + 50)); });
}
const staleRow = (type: "record" | "snapshot") => type === "record" ? host.querySelector<HTMLDivElement>(".lc-scratch-load-entry")!
  : [...host.querySelectorAll<HTMLDivElement>(".lc-scratch-load-entry")].find(entry => entry.querySelector("strong")?.textContent === "first")!;
it.each(["record", "snapshot"] as const)("asks before a %s restore over a version changed elsewhere; Restore anyway forces it", async type => {
  // Another device changed the book -> restore reports stale -> the reader is asked -> Restore anyway forces it.
  const row = staleRow(type), mock = type === "record" ? mocks.restore : mocks.restoreSnapshot;
  mock.mockResolvedValueOnce({ status: "stale" });
  await click(row.querySelectorAll("button")[1]!); await click(row.querySelectorAll("button")[1]!);
  expect(document.body.textContent).toContain("Changed on another device");
  expect(document.body.textContent).toContain("It changed since your last sync. Restore anyway? Their version is kept as a snapshot.");
  expect(refreshed).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')).toBeNull();
  await holdButton("Restore anyway");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls[1]!.at(-1)).toEqual({ force: true });
  expect(refreshed).toHaveBeenCalledOnce();
  expect(document.querySelector('[aria-label="Changed on another device"]:not([inert])')).toBeNull();
});
it.each(["record", "snapshot"] as const)("Cancel on the %s restore prompt changes nothing", async type => {
  const row = staleRow(type), mock = type === "record" ? mocks.restore : mocks.restoreSnapshot;
  mock.mockResolvedValueOnce({ status: "stale" });
  await click(row.querySelectorAll("button")[1]!); await click(row.querySelectorAll("button")[1]!);
  expect(document.body.textContent).toContain("It changed since your last sync. Restore anyway?");
  const cancel = [...document.querySelectorAll<HTMLButtonElement>(".lc-confirm-dialog button")].find(button => button.textContent?.trim() === "Cancel")!;
  await click(cancel);
  expect(mock).toHaveBeenCalledTimes(1); expect(refreshed).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="Changed on another device"]:not([inert])')).toBeNull();
});
it("offers a complete pre-restore retained alternative for undo", async () => {
  // Snapshot restore retains the replaced complete book -> its library row remains explicitly restorable.
  mocks.copies.mockResolvedValueOnce([{ id: "undo", type: "conflict", kind: "annotate", bookId: "removed",
    provenance: { source: "snapshot-restore" }, content: { metadata: { kind: "annotate", id: "removed", name: "Previous" }, payload: { board: {} }, children: {}, ink: [] } }]);
  await act(async () => root.render(<RetainedCopies key="undo" kind="annotate" onRestored={refreshed} />));
  const row = host.querySelector<HTMLDivElement>(".lc-scratch-load-entry")!;
  expect(row.querySelectorAll("button")).toHaveLength(2);
  await click(row.querySelectorAll("button")[1]!); await click(row.querySelectorAll("button")[1]!);
  expect(mocks.restore).toHaveBeenCalledWith("undo");
});
