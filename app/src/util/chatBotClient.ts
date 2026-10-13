/** Assistant-specific connection guidance. The MCP inbox stays provider-neutral. */
export type ChatBotClient = "dots" | "muse" | "grok" | "local" | "other";
export type ChatBotAnswerMode = "bot" | "llm";
export const CHATBOT_CLIENTS: { id: ChatBotClient; label: string; help: string }[] = [
  { id: "dots", label: "OpenAI Dots", help: "Use a custom MCP plugin connected to the PC through OpenAI's private tunnel. After connecting it, ask your dot to list footnote requests and answer them." },
  { id: "muse", label: "Meta Muse AI", help: "Requires an assistant connection that supports MCP tools. Muse compatibility has not been verified. If your app offers no custom MCP connection, selecting it here cannot connect it." },
  { id: "grok", label: "xAI Grok Bot", help: "Personal Grok Bot signs in with OAuth only. Run lc mcp --listen with a private token, the ChatBot OAuth bridge (GitHub sign-in, your account only) and ngrok pointed at the bridge, then add the ngrok URL ending in /mcp in Grok Bot and sign in. Keep Pen Island, lc mcp, the bridge and ngrok running. Full steps: docs/AI-SETUP-GUIDE.md, Part 3." },
  { id: "local", label: "Codex / Cursor", help: "Add a local MCP server in your assistant with the full path to lc.exe and the argument mcp. Ask it to list_footnote_requests, get_footnote_request, then submit_footnote." },
  { id: "other", label: "Other MCP assistant", help: "Connect a local command or the private HTTP adapter using a client that supports MCP tools." },
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
