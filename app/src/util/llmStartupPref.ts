/**
 * Device-local preferences for the startup question about an AI model.
 *
 * Pen Island works without one (ink, reading, sync, Practice tests), so
 * someone who has chosen not to set one up should not be asked on every
 * launch. The first launch asks once; after that the "model is offline"
 * prompt shows only while `ask` is on (Settings → LLM).
 */

const ASK_KEY = "whiteboard.llm.askAtStartup.v1";
const FIRST_RUN_KEY = "whiteboard.llm.firstRunAsked.v1";

export function loadLlmAskAtStartup(): boolean {
  try {
    return localStorage.getItem(ASK_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveLlmAskAtStartup(ask: boolean): void {
  try {
    localStorage.setItem(ASK_KEY, ask ? "1" : "0");
  } catch {
    /* private browsing */
  }
}

/** Whether this device has answered the first-launch question. */
export function llmFirstRunAsked(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markLlmFirstRunAsked(): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch {
    /* private browsing */
  }
}
