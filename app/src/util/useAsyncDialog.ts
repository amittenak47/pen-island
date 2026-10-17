import { useCallback, useState } from "react";
import { messageOf } from "./messageOf";

/** Confirm, wait, close on success; keep failures visible for retry or cancel. */
export function useAsyncDialog() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback(() => {
    setError(null);
    setOpen(true);
  }, []);

  const cancel = useCallback(() => {
    if (pending) return;
    setOpen(false);
    setError(null);
  }, [pending]);

  const run = useCallback(async <T,>(action: () => Promise<T>, onSuccess?: (value: T) => void) => {
    setPending(true);
    setError(null);
    try {
      const value = await action();
      // Keep caller updates and dismissal in the same continuation, with one
      // await: an async wrapper around action would add another microtask.
      onSuccess?.(value);
      setOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }, []);

  return { open, pending, error, show, cancel, run };
}
