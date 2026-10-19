import { describe, expect, it } from "vitest";
import { canonicalAgentMessages, canonicalFootnotes } from "./agentMessageFormat";
import { mergeAgentMessages } from "../modes/coachSessions";

const msg = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, role: "user", content: id, at, ...extra });

describe("canonicalAgentMessages", () => {
  it("writes empty optional strings, including a legacy null bridge error", () => {
    const input = msg("m", 1, { bridgeError: null });
    const [row] = canonicalAgentMessages([input]);
    expect(row).toMatchObject({ requestNote: "", reasoning: "", bridgeError: "" });
    expect(input).toHaveProperty("bridgeError", null);
    const [populated] = canonicalAgentMessages([msg("n", 2, { requestNote: "request", reasoning: "thought", bridgeError: "failed" })]);
    expect(populated).toMatchObject({ requestNote: "request", reasoning: "thought", bridgeError: "failed" });
  });
  it("orders by time, then id, and writes every on/off flag", () => {
    const out = canonicalAgentMessages([msg("b", 2), msg("a", 2, { pending: true }), msg("c", 1, { queued: true })]);
    expect(out.map((row) => (row as { id: string }).id)).toEqual(["c", "a", "b"]);
    expect(out[0]).toMatchObject({ pending: false, queued: true, bridgePending: false });
    expect(out[1]).toMatchObject({ pending: true, queued: false, bridgePending: false });
  });

  it("is stable and leaves non-message rows where they sort", () => {
    const rows = [msg("x", 5), "stray", msg("y", 5)];
    expect(canonicalAgentMessages(rows)).toEqual(canonicalAgentMessages(canonicalAgentMessages(rows)));
  });

  it("two devices merging the same messages in opposite orders store the same transcript", () => {
    const tablet = [msg("q1", 1), msg("a1", 2, { role: "assistant" }), msg("q3", 5)];
    const desktop = [msg("q1", 1, { pending: false }), msg("q2", 3), msg("a1", 2, { role: "assistant", pending: false })];
    const here = mergeAgentMessages(tablet, desktop);
    const there = mergeAgentMessages(desktop, tablet);
    expect(JSON.stringify(here)).toBe(JSON.stringify(there));
    expect(here.map((row) => (row as { id: string }).id)).toEqual(["q1", "a1", "q2", "q3"]);
  });
});

it("canonicalizes empty footnote text without inventing presence-sensitive fields", () => {
  const input = [{ id: "n", anchor: { kind: "text", start: 0, end: 1 },
    notes: [{ text: "note" }], userLinks: [{ url: "https://example.com" }], whiteboards: [{ id: "w" }],
    subMarks: [{ anchor: { kind: "text", start: 0, end: 1 } }] }];
  const [row] = canonicalFootnotes(input);
  expect(row).toMatchObject({ title: "", anchor: { prefix: "", suffix: "" }, notes: [{ field: "", images: [] }],
    userLinks: [{ title: "" }], whiteboards: [{ title: "" }], subMarks: [{ anchor: { prefix: "", suffix: "" }, bands: [] }] });
  for (const key of ["color", "palette", "pending", "by", "blockText", "query", "url"]) expect(row).not.toHaveProperty(key);
  expect(canonicalFootnotes([row])).toEqual([row]);
  expect(input[0]).not.toHaveProperty("title");
});
