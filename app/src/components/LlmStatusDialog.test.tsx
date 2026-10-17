/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./LoadingDoodle", () => ({ LoadingDoodle: () => null }));

import { LlmStatusDialog } from "./LlmStatusDialog";

let host: HTMLDivElement | null = null;
afterEach(() => { host?.remove(); host = null; });

function render(props: Parameters<typeof LlmStatusDialog>[0]): HTMLElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<LlmStatusDialog {...props} />));
  return document.body;
}

const labels = (body: HTMLElement) =>
  [...body.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");

it("asks whether to use a model on first launch, with no stop-asking choice", () => {
  const body = render({ phase: "open", variant: "firstRun", onOpenSettings: () => {}, onContinueWithout: () => {}, onStopAsking: () => {} });
  expect(body.textContent).toContain("Use an AI model?");
  const all = labels(body).join(" | ");
  expect(all).toContain("Set up a model");
  expect(all).toContain("Use without AI");
  expect(all).not.toContain("Don't ask at startup");
});

it("offers to stop asking when the chosen model is offline", () => {
  const body = render({ phase: "open", onOpenSettings: () => {}, onContinueWithout: () => {}, onStopAsking: () => {} });
  expect(body.textContent).toContain("Coach LLM is offline");
  expect(labels(body).join(" | ")).toContain("Don't ask at startup");
});
