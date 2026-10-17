import type { CoachProcessEvent } from "../api/types";

/** The hub's waiting handshake identifies agent runs without consulting mutable Settings. */
export function agentRunProvider(events: readonly CoachProcessEvent[]): "app" | "bot" | undefined {
  for (const event of events) {
    if (event.kind !== "stage") continue;
    if (event.detail === "Waiting for the AI application") return "app";
    if (event.detail === "Waiting for the AI assistant") return "bot";
  }
  return undefined;
}

/** Accepted tools describe effects; proposed/rejected calls never claim an effect. */
export function agentStepChip(event: CoachProcessEvent): string | undefined {
  const detail = event.detail?.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  let text: string;
  if (event.kind === "stage" && event.label === "agent_step") text = detail;
  else if (event.kind === "tool" && event.status === "accepted") {
    const verbs: Record<string, string> = {
      draw_structure: "Drew", animate_trace: "Animated", annotate_region: "Annotated",
      cite_test_case: "Cited", highlight_student_work: "Highlighted", create_attachment: "Prepared attachment",
    };
    const verb = verbs[event.label];
    // Some tools already supply a human-readable sentence as their summary.
    text = /^(drew|animated|annotated|cited|highlighted|prepared|reading)\b/i.test(detail)
      ? detail : verb ? `${verb} ${detail || "on your board"}` : detail || "Used a tool";
  } else return undefined;
  if (!text) return undefined;
  const short = text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text;
  return short[0]!.toLocaleUpperCase() + short.slice(1);
}

/** Streaming snapshots replace one row; ordinary stages/tools still append. */
export function mergeProcessEvent(events: CoachProcessEvent[], next: CoachProcessEvent): CoachProcessEvent[] {
  if (!next.updateId) return [...events, next];
  const index = events.findIndex(event => event.updateId === next.updateId);
  if (!next.detail?.trim()) return events.filter(event => event.updateId !== next.updateId);
  if (index < 0) return [...events, next];
  const result = [...events];
  result[index] = { ...next, ts: events[index]!.ts };
  return result;
}

const LIST_ITEM = /^(?:\d+[.)]|[-*])\s/;

function looksLikeEmbeddedListItem(detail: string | undefined): boolean {
  const line = (detail ?? "").trimStart().split("\n")[0]?.trim() ?? "";
  return LIST_ITEM.test(line);
}

/** Keep `1.` / `-` lines inside the thought that introduced them. */
export function coalesceReasonListItems(events: CoachProcessEvent[]): CoachProcessEvent[] {
  const out: CoachProcessEvent[] = [];
  for (const event of events) {
    const prev = out.at(-1);
    if (
      event.kind === "stage" &&
      event.label === "reason" &&
      prev?.kind === "stage" &&
      prev.label === "reason" &&
      looksLikeEmbeddedListItem(event.detail)
    ) {
      out[out.length - 1] = {
        ...prev,
        detail: [prev.detail, event.detail].filter((part) => part?.trim()).join("\n"),
      };
      continue;
    }
    out.push(event);
  }
  return out;
}
