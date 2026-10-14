import { useEffect, useState } from "react";
import type { AssistantRunnerStatus, LcClient } from "../api/client";
import type { DocFootnote } from "./docFootnotes";
import { assistantRunnerMessage } from "./chatBotClient";

/** Poll only while this view has pending app work; stale replies cannot cross documents. */
export function useAssistantRunnerStatus(client: LcClient, enabled: boolean, scope = ""): AssistantRunnerStatus | null {
  const [status, setStatus] = useState<AssistantRunnerStatus | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null);
    if (!enabled) return;
    const poll = async () => {
      try {
        const next = await client.assistantRunnerStatus();
        if (!stopped) setStatus(next);
      } catch { /* An unpaired hub still uses the ordinary pending message. */ }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [client, enabled, scope]);
  return enabled ? status : null;
}

export function assistantPendingMessage(status: AssistantRunnerStatus | null,
  mark: Pick<DocFootnote, "pending" | "answerMode" | "jobId"> & { createdAt?: number }): string | undefined {
  if (!mark.pending || mark.answerMode !== "app" || !status) return undefined;
  if (status.state === "failed" && mark.createdAt != null && status.started_at != null && status.started_at < mark.createdAt) return undefined;
  if (status.job_id && mark.jobId && mark.jobId !== mark.pending && mark.jobId !== status.job_id) return undefined;
  return status.state === "running" || status.state === "failed" ? assistantRunnerMessage(status) : undefined;
}
