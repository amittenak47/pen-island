import { useRef, type MutableRefObject } from "react";
/** A ref that always holds this render's value, assigned during render like the mirrors it replaces. */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
