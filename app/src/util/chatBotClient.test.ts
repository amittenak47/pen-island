/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { assistantRunnerMessage, loadChatBotAnswerMode, saveChatBotAnswerMode } from "./chatBotClient";

afterEach(() => localStorage.clear());
it("keeps existing bot settings and round-trips all three answer modes", () => {
  expect(loadChatBotAnswerMode()).toBe("bot");
  for (const mode of ["bot", "llm", "app"] as const) {
    saveChatBotAnswerMode(mode);
    expect(loadChatBotAnswerMode()).toBe(mode);
  }
  localStorage.setItem("whiteboard.chatBotAnswerMode.v1", "unknown");
  expect(loadChatBotAnswerMode()).toBe("bot");
});
it("uses plain runner failure guidance without exposing process output", () => {
  expect(assistantRunnerMessage({ app: "codex", state: "failed", started_at: 1, finished_at: 2, error: "private process output" }))
    .toBe("Codex couldn't finish. Open Settings → ChatBot → Test.");
  expect(assistantRunnerMessage({ app: "claude", state: "running", started_at: 1, finished_at: null })).toBe("Claude Code is writing…");
});
