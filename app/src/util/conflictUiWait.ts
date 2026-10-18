export const CONFLICT_UI_MOUNT_MS = 3_000;
/**
 * How long a window that went away has to come back before it counts as gone.
 *
 * React's development mode mounts every component, unmounts it and mounts it
 * again. The test unmount reported "unavailable" and failed the walk on the
 * spot, so in the dev desktop window no merge window could ever open: every
 * conflict ended as "couldn't open the merge window". A real close never
 * remounts; it still fails, just this much later.
 */
export const CONFLICT_UI_GONE_MS = 250;

export interface ConflictUiLifecycle {
  signal: AbortSignal;
  onMounted(): void;
  onUnavailable(): void;
}

/** Time-limit mounting, not the reader's decision after the window appears. */
export function waitForConflictUi<T>(
  show: ((lifecycle: ConflictUiLifecycle) => Promise<T>) | undefined,
  signal: AbortSignal,
  reason: string,
): Promise<T> {
  const ui = new AbortController();
  let mounted = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let gone: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  return new Promise<T>((resolve, reject) => {
    const finish = (cause?: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(gone);
      signal.removeEventListener("abort", stop);
      ui.abort();
      if (cause) reject(cause);
      else resolve(result!);
    };
    stop = () => finish(new Error("Sync stopped. Tap Sync to retry."));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => {
      if (!mounted) finish(new Error(reason));
    }, CONFLICT_UI_MOUNT_MS);
    if (!show) { finish(new Error(reason)); return; }
    try {
      Promise.resolve(show({
        signal: ui.signal,
        onMounted: () => { mounted = true; clearTimeout(timer); clearTimeout(gone); },
        onUnavailable: () => {
          clearTimeout(gone);
          gone = setTimeout(() => finish(new Error(reason)), CONFLICT_UI_GONE_MS);
        },
      })).then((value) => {
        if (value == null) finish(new Error(reason));
        else finish(undefined, value);
      }, (cause) => finish(cause));
    } catch (cause) { finish(cause); }
  });
}

/** Preview preparation must not hide a conflict before the mount watchdog starts. */
export function prepareConflictUi<T>(work: Promise<T>, signal: AbortSignal, reason: string): Promise<T> {
  return waitForConflictUi(() => work, signal, reason);
}
