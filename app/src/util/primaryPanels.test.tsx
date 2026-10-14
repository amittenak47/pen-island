/**
 * @vitest-environment jsdom
 */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { usePrimaryPanels } from "./primaryPanels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Api = ReturnType<typeof usePrimaryPanels> & { footnote: string | null; openFootnote: (id: string | null) => void };

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { roots.splice(0).forEach((root) => act(() => root.unmount())); });

function mount(): Api {
  const api = {} as Api;
  function Harness() {
    const [footnote, openFootnote] = useState<string | null>(null);
    const panels = usePrimaryPanels(footnote, () => openFootnote(null));
    Object.assign(api, panels, { footnote, openFootnote });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<Harness />));
  return api;
}

describe("one primary panel at a time", () => {
  it("opening the ChatBot sheet closes the footnote panel", () => {
    const api = mount();
    act(() => api.openFootnote("fn-1"));
    act(() => api.openChatBot());
    expect(api.footnote).toBeNull();
    expect(api.chatBotOpen).toBe(true);
  });

  it("opening a footnote panel closes the ChatBot sheet and its History", () => {
    const api = mount();
    act(() => api.openChatBot());
    act(() => api.openFootnote("fn-2"));
    expect(api.chatBotOpen).toBe(false);
    expect(api.footnote).toBe("fn-2");
  });

  it("closing the footnote panel leaves the sheet closed until asked", () => {
    const api = mount();
    act(() => api.openChatBot());
    act(() => api.openFootnote("fn-3"));
    act(() => api.openFootnote(null));
    expect(api.chatBotOpen).toBe(false);
  });
});
