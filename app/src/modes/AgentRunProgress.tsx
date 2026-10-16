import { useEffect, useState } from "react";
import type { CoachProcessEvent } from "../api/types";
import { CHATBOT_CLIENTS, loadChatBotClient } from "../util/chatBotClient";
import { agentStepChip } from "./processEvents";

export function AgentRunProgress({ pending, provider, events, showSteps = true }: {
  pending: boolean; provider: "app" | "bot"; events: CoachProcessEvent[]; showSteps?: boolean;
}) {
  const started = events[0]?.ts ?? Date.now();
  const [now, setNow] = useState(Date.now);
  // Capture the selected assistant for this turn, so Settings changes don't rename it mid-run.
  const [name] = useState(() => {
    const client = loadChatBotClient();
    return client === "grok" ? "Grok" : CHATBOT_CLIENTS.find(item => item.id === client)?.label ?? "the AI assistant";
  });
  useEffect(() => {
    if (!pending || provider !== "bot") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending, provider]);
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const chips = showSteps ? events.flatMap((event, index) => {
    const text = agentStepChip(event);
    return text ? [{ text, key: event.updateId ?? `${event.ts}-${index}` }] : [];
  }) : [];
  return <div className="lc-agent-run-progress">
    {pending && <div className="lc-agent-waiting" role="status">
      <span className="lc-agent-waiting-dance" aria-hidden="true"><i /><i /><i /></span>
      <span>{provider === "bot" ? `Waiting for ${name}` : "Waiting for the AI application"}</span>
      {provider === "bot" && <span className="lc-agent-waiting-time" aria-label="Time waited" aria-live="off"> · {elapsed}</span>}
    </div>}
    {chips.length > 0 && <ol className="lc-agent-step-chips" aria-label="Agent steps" aria-live="polite" aria-relevant="additions">
      {chips.map(chip => <li className="lc-agent-step-chip" key={chip.key}>{chip.text}</li>)}
    </ol>}
  </div>;
}
