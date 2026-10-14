/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { bytesToB64 } from "../api/nativeHttp";
import { encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { conflictPdfFrames } from "./conflictDocumentLayout";
import { HubConflictSplit } from "./HubConflictSplit";
import type { HubPadConflict } from "../util/hubConflictStash";
import { localizeHubInkDto } from "../util/pdfInkLayout";
import { desktopLayout, pdfBoard, pdfSizes, pdfStroke, tabletLayout } from "../util/testPdfInk";

const preview = vi.hoisted(() => vi.fn<(props: Parameters<typeof import("./ConflictPagePreview").ConflictPagePreview>[0]) => null>(() => null));
vi.mock("./ConflictPagePreview", () => ({ ConflictPagePreview: preview }));

it.each([desktopLayout, tabletLayout])("draws both conflict panes at local width $w and split mode $spread", async layout => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); preview.mockClear();
  const source = layout === desktopLayout ? tabletLayout : desktopLayout;
  const body = (reading: typeof layout) => ({ id: "pdf-preview", name: "Book", hash: "preview-source", doc_type: "pdf" as const,
    source: "", updated_at: 1, footnotes: [], agent: [], board: pdfBoard(reading) });
  const dto = (reading: typeof layout, half: "left" | "right", id: number) => ({ kind: "annotate" as const, key: "pdf-preview", page_id: 45, updated_at: id,
    gz: bytesToB64(packEncodedInk({ ...encodeInkOps([pdfStroke(pdfSizes, reading, 45, half, id)]), layout: reading })) });
  const conflict: HubPadConflict = { kind: "annotate", id: "pdf-preview", stage: "ink", detail: "Both edited sheet 45",
    local: body(layout), server: body(source), localInk: [dto(layout, "left", 101)],
    serverInk: [await localizeHubInkDto(null, dto(source, "right", 102), { layout, sizes: pdfSizes })],
    localInkPageIds: [45], hubInkPageIds: [45], localInkStamps: [{ pageId: 45, updatedAt: 101 }], hubInkStamps: [{ pageId: 45, updatedAt: 102 }] };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<HubConflictSplit conflict={conflict} onResolve={() => {}}
      pageFrames={conflictPdfFrames(pdfSizes, layout.w, layout.spread)} />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const panes = preview.mock.calls.slice(-2).map(([props]) => props);
    expect(panes).toHaveLength(2);
    panes.forEach((props, i) => {
      expect(props.sceneWidth).toBe(layout.w);
      expect(props.inkSpread).toBe(layout.spread);
      const ops = props.decodedInk!.flatMap(shard => shard.ops);
      expect(ops.map(op => op.id)).toEqual([101 + i]);
      ops[0].points.forEach((point, j) => {
        const expected = pdfStroke(pdfSizes, layout, 45, i ? "right" : "left", 101 + i).points[j];
        expect(point.x).toBeCloseTo(expected.x, 1); expect(point.y).toBeCloseTo(expected.y, 1);
      });
      // The merge list encloses both halves in one frame for each sheet.
      const frames = conflictPdfFrames(pdfSizes, layout.w, layout.spread).filter(frame => frame.pageId === 45);
      expect(props.pageFrames!.find(frame => frame.pageId === 45)).toEqual({ pageId: 45,
        minY: frames[0].minY, maxY: frames.at(-1)!.maxY });
    });
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
