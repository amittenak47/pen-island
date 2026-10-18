/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { documentLayerHeight } from "./documentLayer";

describe("documentLayerHeight", () => {
  it("does not feed a padded frame height back into document growth", () => {
    const slot = document.createElement("div");
    const inner = document.createElement("div");
    inner.className = "lc-md-ink-doc";
    slot.append(inner);
    Object.defineProperty(slot, "scrollHeight", { value: 9180 });
    Object.defineProperty(inner, "scrollHeight", { value: 9000 });
    expect(documentLayerHeight(slot)).toBe(9000);
  });
  it("takes the inner document scrollHeight when the slot is still at the 1100 floor", () => {
    const slot = document.createElement("div");
    const inner = document.createElement("div");
    inner.className = "lc-md-ink-doc";
    slot.append(inner);
    Object.defineProperty(slot, "scrollHeight", { configurable: true, value: 1100 });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 9000 });
    Object.defineProperty(inner, "offsetHeight", { configurable: true, value: 9000 });
    expect(documentLayerHeight(slot)).toBe(9000);
  });

  it("reads a code document the same way", () => {
    const slot = document.createElement("div");
    const inner = document.createElement("div");
    inner.className = "lc-code-doc";
    slot.append(inner);
    Object.defineProperty(slot, "scrollHeight", { configurable: true, value: 1100 });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(inner, "offsetHeight", { configurable: true, value: 4000 });
    expect(documentLayerHeight(slot)).toBe(4000);
  });
  it("ignores a layer laid out too narrow to be a column yet", () => {
    const slot = document.createElement("div");
    const inner = document.createElement("div");
    inner.className = "lc-web-doc-wrap";
    slot.append(inner);
    const onScreen = () => [{ width: 32, height: 58848 }] as unknown as DOMRectList;
    Object.defineProperty(inner, "getClientRects", { value: onScreen });
    Object.defineProperty(slot, "getClientRects", { value: onScreen });
    Object.defineProperty(inner, "clientWidth", { configurable: true, value: 32 });
    Object.defineProperty(slot, "clientWidth", { configurable: true, value: 32 });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 58848 });
    Object.defineProperty(slot, "scrollHeight", { configurable: true, value: 58848 });
    expect(documentLayerHeight(slot)).toBe(0);
    Object.defineProperty(inner, "clientWidth", { configurable: true, value: 920 });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 20914 });
    expect(documentLayerHeight(slot)).toBe(20914);
  });
});
