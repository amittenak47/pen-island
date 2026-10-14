import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LcClient } from "../api/client";

// The link store as rows: a live edge, or a tombstone `{ id, goneAt }`.
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("./noteLinks", () => ({
  deleteEdge: async (id: string) => { rows.set(id, { id, goneAt: 100 }); },
  edgeCreatedAt: async (id: string) => {
    const row = rows.get(id);
    return row && typeof row.createdAt === "number" ? row.createdAt : null;
  },
  edgeIsGone: async (id: string, createdAt?: number) => {
    const row = rows.get(id);
    if (!row || typeof row.goneAt !== "number") return false;
    return typeof createdAt !== "number" || createdAt <= row.goneAt;
  },
  listEdges: async () => [...rows.values()].filter((row) => typeof row.createdAt === "number"),
  listGoneEdgeIds: async () => [...rows.values()].filter((row) => typeof row.goneAt === "number").map((row) => row.id),
  putEdge: async (edge: { id: string }) => { rows.set(edge.id, edge); },
}));
vi.mock("./padHub", async (original) => ({ ...await original<typeof import("./padHub")>(), loadPadHub: () => "http://hub" }));

import { syncEdges } from "./inkSync";

const EDGE = {
  id: "picker|annotate:a|whiteboard:w",
  from: { type: "annotate", id: "a" },
  to: { type: "whiteboard", id: "w" },
  kind: "picker",
};

function hub() {
  const pushed: string[] = [];
  return {
    pushed,
    client: {
      putEdges: async (edges: { id: string }[]) => { pushed.push(...edges.map((edge) => edge.id)); },
      tombstoneEdge: async () => {},
    } as unknown as LcClient,
  };
}

beforeEach(() => rows.clear());

describe("edge tombstones", () => {
  it("drops a stale copy the hub says is gone", async () => {
    rows.set(EDGE.id, { ...EDGE, createdAt: 10 });
    const { client, pushed } = hub();
    await syncEdges(client, [], [EDGE.id], [{ kind: "edge", id: EDGE.id, seq: 50, gone_at: 50 }]);
    expect(rows.get(EDGE.id)).toMatchObject({ goneAt: 100 });
    expect(pushed).toEqual([]);
  });

  it("keeps and pushes an edge made after the delete (linked again, or undone)", async () => {
    rows.set(EDGE.id, { ...EDGE, createdAt: 80 });
    const { client, pushed } = hub();
    await syncEdges(client, [], [EDGE.id], [{ kind: "edge", id: EDGE.id, seq: 50, gone_at: 50 }]);
    expect(rows.get(EDGE.id)).toMatchObject({ createdAt: 80 });
    expect(pushed).toEqual([EDGE.id]);
  });

  it("takes in a revived edge over this device's older tombstone", async () => {
    rows.set(EDGE.id, { id: EDGE.id, goneAt: 50 });
    const { client } = hub();
    await syncEdges(client, [{
      id: EDGE.id, from_type: "annotate", from_id: "a", to_type: "whiteboard", to_id: "w",
      kind: "picker", created_at: 80, payload: { ...EDGE, createdAt: 80 },
    } as never], []);
    expect(rows.get(EDGE.id)).toMatchObject({ createdAt: 80 });
  });
});
