/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAsyncDialog } from "./useAsyncDialog";

let root: Root;
let dialog: ReturnType<typeof useAsyncDialog>;

function Probe() {
  dialog = useAsyncDialog();
  return null;
}

function state() {
  return { open: dialog.open, pending: dialog.pending, error: dialog.error };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("starts closed, opens cleanly, and cancels without running an action", () => {
  expect(state()).toEqual({ open: false, pending: false, error: null });
  act(() => dialog.show());
  expect(state()).toEqual({ open: true, pending: false, error: null });
  act(() => dialog.cancel());
  expect(state()).toEqual({ open: false, pending: false, error: null });
});

it("stays pending while the action runs, blocks cancel, and closes/clears pending on success", async () => {
  const job = deferred<string>();
  const action = vi.fn(() => job.promise);
  act(() => dialog.show());
  let completion!: Promise<void>;
  act(() => {
    completion = dialog.run(action);
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(state()).toEqual({ open: true, pending: true, error: null });
  act(() => dialog.cancel());
  expect(state()).toEqual({ open: true, pending: true, error: null });
  await act(async () => { job.resolve("saved"); await completion; });
  expect(state()).toEqual({ open: false, pending: false, error: null });
  act(() => dialog.show());
  expect(state()).toEqual({ open: true, pending: false, error: null });
});

it("runs success updates before dismissal, in the action's first promise continuation", async () => {
  const job = deferred<number>();
  const events: string[] = [];
  act(() => dialog.show());
  let completion!: Promise<void>;
  act(() => {
    completion = dialog.run(() => job.promise, value => {
      events.push(`success:${value}`);
      flushSync(() => {});
      expect(state()).toEqual({ open: true, pending: true, error: null });
    });
  });
  await act(async () => {
    job.resolve(42);
    queueMicrotask(() => {
      // run registered its await first. Its success callback must already have
      // run when the next microtask observes the result.
      events.push("next microtask");
    });
    await completion;
  });
  expect(events).toEqual(["success:42", "next microtask"]);
  expect(state()).toEqual({ open: false, pending: false, error: null });
});

it("keeps rejection errors visible, clears them before retrying, and clears pending on both outcomes", async () => {
  const first = deferred<void>();
  act(() => dialog.show());
  act(() => { void dialog.run(() => first.promise); });
  await act(async () => first.reject({ error: { message: "Could not save" } }));
  expect(state()).toEqual({ open: true, pending: false, error: "Could not save" });
  const retry = deferred<void>();
  act(() => { void dialog.run(() => retry.promise); });
  expect(state()).toEqual({ open: true, pending: true, error: null });
  await act(async () => retry.resolve());
  expect(state()).toEqual({ open: false, pending: false, error: null });
});

it("clears an old error both when shown again and when cancelled", async () => {
  act(() => dialog.show());
  await act(async () => dialog.run(async () => { throw new Error("First failure"); }));
  expect(dialog.error).toBe("First failure");
  act(() => dialog.show());
  expect(state()).toEqual({ open: true, pending: false, error: null });
  await act(async () => dialog.run(async () => { throw new Error("Second failure"); }));
  act(() => dialog.cancel());
  expect(state()).toEqual({ open: false, pending: false, error: null });
  act(() => dialog.show());
  expect(state()).toEqual({ open: true, pending: false, error: null });
});

it("handles synchronous action failures and exceptions in success updates like rejections", async () => {
  act(() => dialog.show());
  await act(async () => dialog.run(() => { throw "Synchronous failure"; }));
  expect(state()).toEqual({ open: true, pending: false, error: "Synchronous failure" });
  await act(async () => dialog.run(async () => "saved", () => { throw new Error("Update failure"); }));
  expect(state()).toEqual({ open: true, pending: false, error: "Update failure" });
});

it("does not introduce a duplicate-run lock or a pending counter absent from the original handler", async () => {
  const first = deferred<void>(), second = deferred<void>();
  const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  act(() => dialog.show());
  act(() => { void dialog.run(action); });
  act(() => { void dialog.run(action); });
  expect(action).toHaveBeenCalledTimes(2);
  await act(async () => first.resolve());
  expect(state()).toEqual({ open: false, pending: false, error: null });
  await act(async () => second.reject(new Error("Later failure")));
  expect(state()).toEqual({ open: false, pending: false, error: "Later failure" });
});

it("keeps show and run stable across state changes", () => {
  const show = dialog.show, run = dialog.run;
  act(() => dialog.show());
  expect(dialog.show).toBe(show);
  expect(dialog.run).toBe(run);
  act(() => dialog.cancel());
  expect(dialog.show).toBe(show);
  expect(dialog.run).toBe(run);
});
