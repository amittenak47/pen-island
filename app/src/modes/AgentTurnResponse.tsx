import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CoachProcessEvent } from "../api/types";
import { ProcessBlock, isReasoningEvent, isThoughtProcessEvent, reasoningBodyForTurn } from "./ProcessBlock";
import { ReasoningBlock } from "./ReasoningBlock";
import { AgentRichText } from "./AgentRichText";
import { ThinkingDots } from "./ThinkingDots";
import { DEFAULT_AGENT_DISPLAY_PREFS, type AgentDisplayPrefs } from "../util/agentDisplayPrefs";
import { newThinkingDisclosure, type ThinkingDisclosureState } from "./thinkingDisplay";
import { agentRunProvider } from "./processEvents";
import { AgentRunProgress } from "./AgentRunProgress";

/** Presentation state only. The canonical reply/events remain in the transcript. */
export function AgentTurnResponse({ pending, events = [], reasoning, text, assistant, children, afterText, showProcess = true,
  displayPrefs = DEFAULT_AGENT_DISPLAY_PREFS, disclosure }: {
  displayPrefs?: AgentDisplayPrefs; disclosure?: ThinkingDisclosureState;
  showProcess?: boolean;
  pending: boolean; events?: CoachProcessEvent[]; reasoning?: string;
  text: string; assistant: boolean; children?: ReactNode; afterText?: ReactNode;
}) {
  const [phase, setPhase] = useState<"working" | "collapsing" | "answer">(pending ? "working" : "answer");
  const wasLive = useRef(pending);
  const localDisclosure = useRef(newThinkingDisclosure());
  const displayState = disclosure ?? localDisclosure.current;
  const provider = agentRunProvider(events);
  const hasThoughts = !provider && showProcess && events.some(isThoughtProcessEvent);
  const waitingOnPipeline = !provider && pending && showProcess && events.some(
    (event) => event.label !== "done" && !isReasoningEvent(event),
  );
  const hasSteps = hasThoughts || waitingOnPipeline;
  const body = provider ? "" : reasoningBodyForTurn(reasoning, events);
  const finishCollapse = useCallback(() => setPhase(current => current === "collapsing" ? "answer" : current), []);
  useEffect(() => {
    if (pending) { wasLive.current = true; setPhase("working"); return; }
    if (phase === "working") {
      const instant = document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      setPhase(hasSteps && displayPrefs.autoCollapseThinking && displayState.sectionOpen === undefined && !instant ? "collapsing" : "answer");
    }
  }, [pending, phase, hasSteps, displayPrefs.autoCollapseThinking, displayState]);
  useEffect(() => {
    if ((!hasSteps || !displayPrefs.autoCollapseThinking) && phase === "collapsing") finishCollapse();
    if (phase !== "collapsing") return;
    // Backgrounding can suspend motion's RAF. Never strand a completed reply.
    const onHidden = () => { if (document.hidden) finishCollapse(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [phase, finishCollapse, hasSteps, displayPrefs.autoCollapseThinking]);
  const showAnswer = !pending && (Boolean(provider) || phase === "answer");
  return <>
    {provider && <AgentRunProgress pending={pending} provider={provider} events={events} showSteps={showProcess} />}
    {(hasSteps || (body && showAnswer)) && <div className="lc-agent-think-stack">
      {hasSteps && <ProcessBlock events={events} running={pending || phase === "working"}
        displayPrefs={displayPrefs} disclosure={displayState} collapse={phase === "collapsing"}
        onCollapsed={finishCollapse} />}
      {body && showAnswer && <ReasoningBlock text={body} running={false} />}
    </div>}
    {pending && !provider && <ThinkingDots />}
    {children}
    {showAnswer && (afterText ? <div className="lc-agent-turn-body lc-agent-answer-with-action">
      <AgentRichText text={text} animate={assistant} animateInitial={assistant && wasLive.current} reveal={provider ? "paragraph" : "word"} />
      {afterText}
    </div> : <AgentRichText text={text} animate={assistant}
      reveal={provider ? "paragraph" : "word"}
      animateInitial={assistant && wasLive.current} className="lc-agent-turn-body" />)}
  </>;
}
