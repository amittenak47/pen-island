/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTurnResponse } from "./AgentTurnResponse";
import { AgentSidePanel } from "./AgentSidePanel";
import { AmbientCoach, type WebSocketLike } from "../api/coachSocket";
import type { CoachProcessEvent, ServerFrame } from "../api/types";
import { agentStepChip, mergeProcessEvent } from "./processEvents";
import { saveChatBotClient } from "../util/chatBotClient";

vi.mock("../util/mobile", () => ({ useIsMobile: () => false }));
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); localStorage.clear();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function script() {
  const sent: string[] = [];
  const socket: WebSocketLike = { send: data => { sent.push(data); }, close() {},
    onopen: null, onclose: null, onerror: null, onmessage: null };
  const coach = new AmbientCoach({ baseUrl: "http://fixture", token: null }, { onFrame() {} }, () => socket);
  coach.connect("board"); socket.onopen?.({});
  return { coach, sent, frame(frame: ServerFrame) { act(() => socket.onmessage?.({ data: JSON.stringify(frame) })); } };
}
const waiting = (provider: "app" | "bot"): CoachProcessEvent => ({ kind: "stage", label: "ask",
  detail: `Waiting for the AI ${provider === "app" ? "application" : "assistant"}`, ts: Date.now() });

it.each(["app", "bot"] as const)("renders %s waiting and chips live from the socket, then reveals complete paragraphs", async provider => {
  const wire = script();
  let events: CoachProcessEvent[] = [];
  const render = (pending: boolean, text = "") => root.render(<AgentTurnResponse pending={pending} events={events}
    text={text} assistant reasoning="Private reasoning must stay hidden." />);
  act(() => render(true));
  const result = wire.coach.run<{ answer: string }>("ask", { question: "Why?" }, {
    onProcess: event => { events = mergeProcessEvent(events, event); render(true); },
  });
  const request_id = JSON.parse(wire.sent.at(-1)!).request_id as string;
  wire.frame({ type: "stage", request_id, stage: "received", detail: "got question" });
  wire.frame({ type: "stage", request_id, stage: "ask", detail: waiting(provider).detail! });
  expect(host.querySelector('.lc-agent-waiting-dance')).not.toBeNull();
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.textContent).toContain(provider === "bot" ? "Waiting for Grok" : "Waiting for the AI application");
  expect(host.querySelector('.lc-agent-process')).toBeNull();
  act(() => vi.advanceTimersByTime(42_000));
  if (provider === "bot") expect(host.querySelector('.lc-agent-waiting-time')?.textContent).toBe(" · 0:42");
  else expect(host.querySelector('.lc-agent-waiting-time')).toBeNull();
  wire.frame({ type: "stage", request_id, stage: "agent_step", detail: "Reading your board" });
  expect(host.querySelectorAll('.lc-agent-step-chip')).toHaveLength(1);
  wire.frame({ type: "tool_event", request_id, name: "draw_structure", status: "proposed", summary: "drawing a structure" });
  wire.frame({ type: "tool_event", request_id, name: "draw_structure", status: "accepted", summary: "a tree" });
  wire.frame({ type: "tool_event", request_id, name: "draw_structure", status: "rejected", summary: "invalid", reason: "empty" });
  wire.frame({ type: "tool_event", request_id, name: "highlight_student_work", status: "accepted", summary: "line 4" });
  expect([...host.querySelectorAll('.lc-agent-step-chip')].map(node => node.textContent)).toEqual([
    "Reading your board", "Drew a tree", "Highlighted line 4",
  ]);
  wire.frame({ type: "result", request_id, action: "ask", body: { answer: "First paragraph.\n\nSecond paragraph." } });
  const body = await result;
  await act(async () => render(false, body.answer));
  expect(host.querySelector('.lc-agent-waiting')).toBeNull();
  expect(host.querySelector('.lc-agent-reasoning')).toBeNull();
  expect(host.querySelector('.lc-agent-process')).toBeNull();
  const paragraphs = [...host.querySelectorAll<HTMLElement>('.lc-agent-paragraph-reveal')];
  expect(paragraphs.map(node => node.textContent)).toEqual(["First paragraph.", "Second paragraph."]);
  expect(paragraphs.map(node => node.style.animationDelay)).toEqual(["0ms", "180ms"]);
  expect(host.querySelector('.lc-agent-word-reveal')).toBeNull();
  expect(host.querySelectorAll('.lc-agent-step-chip')).toHaveLength(3);
  wire.coach.stop();
  act(() => root.render(null)); expect(vi.getTimerCount()).toBe(0);
});

it("uses the assistant chosen for ChatBot and freezes its name during a turn", () => {
  saveChatBotClient("dots");
  const events = [waiting("bot")];
  act(() => root.render(<AgentTurnResponse pending events={events} text="" assistant />));
  expect(host.textContent).toContain("Waiting for OpenAI Dots");
  saveChatBotClient("grok");
  act(() => vi.advanceTimersByTime(1000));
  expect(host.textContent).toContain("Waiting for OpenAI Dots");
});

it("keeps agent waiting and paragraph reveal when process steps are hidden and an answer has an action", () => {
  const events = [waiting("app"), { kind: "stage" as const, label: "agent_step", detail: "Reading your board", ts: Date.now() }];
  const render = (pending: boolean) => act(() => root.render(<AgentTurnResponse pending={pending} events={events}
    showProcess={false} text={pending ? "" : "One.\n\nTwo."} assistant reasoning="Hidden."
    afterText={<button>Draw this</button>} />));
  render(true);
  expect(host.querySelector('.lc-agent-waiting')).not.toBeNull();
  expect(host.querySelector('.lc-agent-step-chip')).toBeNull();
  render(false);
  expect(host.querySelectorAll('.lc-agent-paragraph-reveal')).toHaveLength(2);
  expect(host.querySelector('.lc-agent-answer-with-action button')?.textContent).toBe("Draw this");
  expect(host.querySelector('.lc-agent-reasoning')).toBeNull();
});

it("reveals the whole reply instantly with reduced motion and does not animate restored history", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const events = [waiting("bot")];
  const render = (pending: boolean, key = "live") => act(() => root.render(<AgentTurnResponse key={key}
    pending={pending} events={events} text={pending ? "" : "One.\n\nTwo."} assistant reasoning="Hidden." />));
  render(true); render(false);
  expect(host.querySelector('.lc-agent-turn-body')?.textContent).toContain("One.");
  expect(host.querySelector('.lc-agent-turn-body')?.textContent).toContain("Two.");
  expect(host.querySelector('.lc-agent-paragraph-reveal')).toBeNull();
  expect(host.querySelector('.lc-agent-reasoning')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  render(false, "restored");
  expect(host.querySelectorAll('.lc-agent-turn-body p')).toHaveLength(2);
  expect(host.querySelector('.lc-agent-paragraph-reveal')).toBeNull();
});

it.each(["cancelled", "The AI assistant did not reply before the deadline.", "The AI application exited without a reply."])(
  "keeps the hub error in the panel's existing alert: %s", async message => {
    const wire = script(); let events: CoachProcessEvent[] = []; let error: string | null = null; let done = false;
    const render = () => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} onSend={() => {}}
      busy={!done} error={error} messages={done ? [] : [{ id: "run", role: "assistant", content: "", at: Date.now(), pending: true, processEvents: events }]} />);
    act(render);
    const result = wire.coach.run("ask", { question: "Why?" }, {
      onProcess: event => { events = mergeProcessEvent(events, event); render(); },
    }).catch(cause => { error = (cause as Error).message; done = true; render(); });
    const request_id = JSON.parse(wire.sent.at(-1)!).request_id as string;
    wire.frame({ type: "stage", request_id, stage: "ask", detail: waiting("bot").detail! });
    expect(host.querySelector('.lc-agent-waiting')).not.toBeNull();
    wire.frame({ type: "error", request_id, message });
    await act(async () => { await result; });
    expect(host.querySelector('.lc-agent-panel-error[role="alert"]')?.textContent?.trim()).toBe(message);
    expect(host.querySelector('.lc-agent-waiting')).toBeNull();
    wire.coach.stop();
  },
);

it("keeps API pipeline/tools and reasoning in their existing folds without agent chips or waiting animation", () => {
  const events: CoachProcessEvent[] = [
    { kind: "stage", label: "ask", detail: "Answering", ts: 1 },
    { kind: "stage", label: "reason", detail: "Checking the cases.", ts: 2 },
    { kind: "tool", label: "draw_structure", detail: "a tree", status: "accepted", ts: 3 },
  ];
  act(() => root.render(<AgentTurnResponse pending events={events} text="" assistant reasoning="API reasoning." />));
  expect(host.querySelector('.lc-agent-process')).not.toBeNull();
  expect(host.querySelectorAll('.lc-agent-process-step')).toHaveLength(2);
  expect(host.querySelector('.lc-agent-waiting')).toBeNull();
  expect(host.querySelector('.lc-agent-step-chip')).toBeNull();
  act(() => root.render(<AgentTurnResponse pending={false} events={events} text="API answer." assistant reasoning="API reasoning." />));
  expect(host.querySelector('.lc-agent-reasoning-toggle')?.getAttribute('aria-expanded')).toBe("false");
  expect(host.querySelector('.lc-agent-paragraph-reveal')).toBeNull();
  expect(host.querySelector('.lc-agent-word-reveal')).not.toBeNull();
});

it("keeps accepted tool summaries short and avoids doubling an existing action verb", () => {
  expect(agentStepChip({ kind: "tool", label: "highlight_student_work", status: "accepted", detail: "Highlighted line 4", ts: 1 })).toBe("Highlighted line 4");
  expect(agentStepChip({ kind: "stage", label: "agent_step", detail: "x".repeat(200), ts: 1 })).toHaveLength(90);
});
