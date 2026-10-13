/** Assistant-specific connection guidance. The MCP inbox stays provider-neutral. */
export type ChatBotClient = "dots" | "muse" | "grok" | "local" | "other";
export type ChatBotAnswerMode = "bot" | "llm";
export const CHATBOT_CLIENTS: { id: ChatBotClient; label: string; help: string }[] = [
  { id: "dots", label: "OpenAI Dots", help: "Connect OpenAI Dots to your PC with a custom MCP plugin over OpenAI’s Secure MCP Tunnel, then ask it to answer your footnote requests." },
  { id: "muse", label: "Meta Muse AI", help: "Meta Muse AI needs a way to add custom MCP tools. It hasn’t been tested with Pen Island yet." },
  { id: "grok", label: "xAI Grok Bot", help: "Grok Bot connects through a GitHub sign-in and needs a few things running on your PC. Follow Part 3 of the setup guide (docs/AI-SETUP-GUIDE.md)." },
  { id: "local", label: "Codex / Cursor", help: "In your assistant, add a local MCP server: the command is lc.exe and the argument is mcp. Then ask it to answer your footnote requests." },
  { id: "other", label: "Other MCP assistant", help: "Any assistant that supports MCP tools can connect, using one of the connection commands below." },
];
const KEY = "whiteboard.chatBotClient.v1";
export function loadChatBotClient(): ChatBotClient {
  try {
    const value = localStorage.getItem(KEY);
    return CHATBOT_CLIENTS.find(client => client.id === value)?.id ?? "grok";
  } catch { return "grok"; }
}
export function saveChatBotClient(client: ChatBotClient): void {
  localStorage.setItem(KEY, client);
}

const MODE_KEY = "whiteboard.chatBotAnswerMode.v1";
export function loadChatBotAnswerMode(): ChatBotAnswerMode {
  try { return localStorage.getItem(MODE_KEY) === "llm" ? "llm" : "bot"; }
  catch { return "bot"; }
}
export function saveChatBotAnswerMode(mode: ChatBotAnswerMode): void {
  localStorage.setItem(MODE_KEY, mode);
}
