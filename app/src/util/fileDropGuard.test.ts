/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { installFileDropGuard } from "./fileDropGuard";

let remove: (() => void) | null = null;
afterEach(() => { remove?.(); remove = null; });

function drag(type: "dragover" | "drop", types: string[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dataTransfer = { types, dropEffect: "copy" };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return { event, dataTransfer };
}

it("stops a stray file drop from opening in place of the app", () => {
  remove = installFileDropGuard();
  const over = drag("dragover", ["Files"]);
  document.body.dispatchEvent(over.event);
  expect(over.event.defaultPrevented).toBe(true);
  expect(over.dataTransfer.dropEffect).toBe("none");
  const drop = drag("drop", ["Files"]);
  document.body.dispatchEvent(drop.event);
  expect(drop.event.defaultPrevented).toBe(true);
});

it("leaves a drop zone that took the file, and drags that carry no files", () => {
  remove = installFileDropGuard();
  const zone = document.createElement("div");
  document.body.appendChild(zone);
  zone.addEventListener("dragover", event => event.preventDefault());
  const over = drag("dragover", ["Files"]);
  zone.dispatchEvent(over.event);
  expect(over.dataTransfer.dropEffect).toBe("copy");
  const text = drag("drop", ["text/plain"]);
  document.body.dispatchEvent(text.event);
  expect(text.event.defaultPrevented).toBe(false);
  zone.remove();
});
