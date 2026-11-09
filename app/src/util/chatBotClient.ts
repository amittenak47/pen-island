/** Assistant-specific connection guidance. The MCP inbox stays provider-neutral. */
import type { AssistantRunnerStatus } from "../api/client";

export type ChatBotClient = "dots" | "muse" | "grok" | "local" | "other";
export type ChatBotAnswerMode = "bot" | "llm" | "app";
export const CHATBOT_CLIENTS: { id: ChatBotClient; label: string; help: string }[] = [
  { id: "dots", label: "OpenAI Dots", help: "Connect OpenAI Dots to your PC with a custom MCP plugin over OpenAI’s Secure MCP Tunnel, then ask it to answer your footnote requests." },
  { id: "muse", label: "Meta Muse AI", help: "Meta Muse AI needs a way to add custom MCP tools. It hasn’t been tested with Pen Island yet." },
  { id: "grok", label: "xAI Grok Bot", help: "Grok Bot connects through a GitHub sign-in and needs a few things running on your PC. Part 3 of the AI setup guide explains them." },
  { id: "local", label: "Codex or Cursor", help: "In your AI assistant, add a local MCP server with the command lc.exe and the argument mcp. Then ask it to answer your footnote requests." },
  { id: "other", label: "Other MCP AI assistant", help: "Any AI assistant that supports MCP tools can connect, using one of the connection commands below." },
];
const KEY = "whiteboard.chatBotClient.v1";
export function loadChatBotClient(): ChatBotClient {
  try {
    const value = localStorage.getItem(KEY);
    return CHATBOT_CLIENTS.find(client => client.id === value)?.id ?? "other";
  } catch { return "other"; }
}
export function saveChatBotClient(client: ChatBotClient): void {
  localStorage.setItem(KEY, client);
}

const MODE_KEY = "whiteboard.chatBotAnswerMode.v1";
/** With nothing saved, Codex or Claude Code on the PC writes the footnotes; no online bot is needed. */
export function loadChatBotAnswerMode(): ChatBotAnswerMode {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return mode === "llm" || mode === "bot" ? mode : "app";
  }
  catch { return "app"; }
}
export function saveChatBotAnswerMode(mode: ChatBotAnswerMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

/** Setup problems the hub words itself. Anything else may echo process output, so it stays hidden. */
const PLAIN_RUNNER_ERRORS = [
  /^(Codex|Claude Code) is not installed on this PC\. (Codex|Claude Code) is: choose it under App in Settings, ChatBot\.$/,
  /^Neither Codex nor Claude Code is installed on this PC, so no assistant app can answer\. Install one and sign in, then try Test again\.$/,
  /^Codex (version [\w.-]{1,40}|an unknown version) has not been verified for automatic footnotes \(verified: [\w., -]{1,200}\)\. Choose Claude Code under App, or install a verified Codex version\.$/,
  /^Sign in to Claude Code on this PC, then try Test again\.$/,
];

export function assistantRunnerMessage(status: AssistantRunnerStatus): string {
  const app = status.app === "claude" ? "Claude Code" : "Codex";
  if (status.state === "running") return `${app} is writing…`;
  if (status.state === "failed") {
    const error = status.error?.trim() ?? "";
    return PLAIN_RUNNER_ERRORS.some(pattern => pattern.test(error)) ? error : `${app} couldn't finish. Open Settings → ChatBot → Test.`;
  }
  return status.state === "done" ? `${app} finished.` : `${app} is ready.`;
}
