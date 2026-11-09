/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { assistantRunnerMessage, loadChatBotAnswerMode, loadChatBotClient, saveChatBotAnswerMode } from "./chatBotClient";

afterEach(() => localStorage.clear());
it("defaults to the app on this PC, keeps saved bot settings and round-trips all three answer modes", () => {
  expect(loadChatBotAnswerMode()).toBe("app");
  for (const mode of ["bot", "llm", "app"] as const) {
    saveChatBotAnswerMode(mode);
    expect(loadChatBotAnswerMode()).toBe(mode);
  }
  localStorage.setItem("whiteboard.chatBotAnswerMode.v1", "unknown");
  expect(loadChatBotAnswerMode()).toBe("app");
});
it("does not assume Grok Bot when no assistant is saved", () => {
  expect(loadChatBotClient()).toBe("other");
  localStorage.setItem("whiteboard.chatBotClient.v1", "grok");
  expect(loadChatBotClient()).toBe("grok");
});
it("uses plain runner failure guidance without exposing process output", () => {
  expect(assistantRunnerMessage({ app: "codex", state: "failed", started_at: 1, finished_at: 2, error: "private process output" }))
    .toBe("Codex couldn't finish. Open Settings → ChatBot → Test.");
  expect(assistantRunnerMessage({ app: "claude", state: "running", started_at: 1, finished_at: null })).toBe("Claude Code is writing…");
});
it("says plainly when the chosen app or every app is missing", () => {
  const failed = (app: "codex" | "claude", error: string) =>
    assistantRunnerMessage({ app, state: "failed", started_at: 1, finished_at: 2, error });
  for (const error of [
    "Codex is not installed on this PC. Claude Code is: choose it under App in Settings, ChatBot.",
    "Neither Codex nor Claude Code is installed on this PC, so no assistant app can answer. Install one and sign in, then try Test again.",
    "Codex version 0.170.2 has not been verified for automatic footnotes (verified: 0.162.1, 0.163.0). Choose Claude Code under App, or install a verified Codex version.",
    "Sign in to Claude Code on this PC, then try Test again.",
  ]) expect(failed("codex", error)).toBe(error);
  expect(failed("claude", "Codex is not installed on this PC. Claude Code is: choose it under App in Settings, ChatBot. token=abc"))
    .toBe("Claude Code couldn't finish. Open Settings → ChatBot → Test.");
  expect(failed("codex", "Codex version <b>x</b> has not been verified for automatic footnotes (verified: 0.163.0). Choose Claude Code under App, or install a verified Codex version."))
    .toBe("Codex couldn't finish. Open Settings → ChatBot → Test.");
});
