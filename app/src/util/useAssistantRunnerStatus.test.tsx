/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistantRunnerStatus, LcClient } from "../api/client";
import { assistantPendingMessage, useAssistantRunnerStatus } from "./useAssistantRunnerStatus";

const status: AssistantRunnerStatus = { app: "codex", state: "failed", started_at: 1, finished_at: 2 };
let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; vi.useRealTimers(); });

it("keeps bot work and unrelated jobs separate from app failures", () => {
  expect(assistantPendingMessage(status, { pending: "req-1", answerMode: "app" })).toContain("couldn't finish");
  expect(assistantPendingMessage(status, { pending: "req-1", answerMode: "bot" })).toBeUndefined();
  expect(assistantPendingMessage(status, { pending: "req-new", answerMode: "app", createdAt: 3 })).toBeUndefined();
  expect(assistantPendingMessage(status, { answerMode: "app" })).toBeUndefined();
  expect(assistantPendingMessage({ ...status, job_id: "job-other" }, { pending: "req-1", answerMode: "app", jobId: "job-1" })).toBeUndefined();
  expect(assistantPendingMessage({ ...status, state: "done" }, { pending: "req-1", answerMode: "app" })).toBeUndefined();
});

it("ignores a previous document's reply and stops polling after unmount", async () => {
  vi.useFakeTimers();
  let finishOld!: (value: AssistantRunnerStatus) => void;
  const poll = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue({ ...status, state: "running" });
  const client = { assistantRunnerStatus: poll } as unknown as LcClient;
  const node = document.createElement("div");
  const root = createRoot(node);
  function Probe({ scope }: { scope: string }) {
    const value = useAssistantRunnerStatus(client, true, scope);
    return <span>{value?.state ?? "waiting"}</span>;
  }
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(<Probe scope="old" />));
  await act(async () => root.render(<Probe scope="new" />));
  expect(node.textContent).toBe("running");
  await act(async () => finishOld(status));
  expect(node.textContent).toBe("running");
  unmount(); unmount = undefined;
  await vi.advanceTimersByTimeAsync(5000);
  expect(poll).toHaveBeenCalledTimes(2);
});
