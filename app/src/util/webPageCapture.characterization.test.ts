import { afterEach, expect, it, vi } from "vitest";
import { readLiveViewport } from "./webPageCapture";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(JSON.stringify({
  url: "https://example.com/", title: "Example", text: "Page text",
})));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webview", () => ({ Webview: { getByLabel: async () => ({}) } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("@tauri-apps/api/dpi", () => ({ LogicalPosition: class {}, LogicalSize: class {} }));
afterEach(() => vi.unstubAllGlobals());

it("invokes the viewport script with its exact command and arguments", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  expect(await readLiveViewport("test-pane")).toEqual({
    url: "https://example.com/", title: "Example", text: "Page text",
  });
  expect(invoke.mock.calls).toMatchInlineSnapshot(`
    [
      [
        "webview_eval_json",
        {
          "label": "test-pane",
          "script": "(() => {
      const vh = window.innerHeight, vw = window.innerWidth;
      const out = [];
      const root = document.body;
      if (root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const raw = node.textContent ? node.textContent.replace(/\\s+/g, " ").trim() : "";
          if (!raw) continue;
          const el = node.parentElement;
          if (!el) continue;
          const box = el.getBoundingClientRect();
          if (box.bottom <= 0 || box.top >= vh || box.right <= 0 || box.left >= vw) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
          out.push(raw);
          if (out.join("\\n").length > 8000) break;
        }
      }
      return { url: location.href, title: document.title, text: out.join("\\n") };
    })()",
        },
      ],
    ]
  `);
});
