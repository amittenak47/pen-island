import { useCallback, useRef, type RefObject } from "react";
import { fetchNextColorHuntPalette } from "../util/colorHunt";
import { appendInkPalette, type InkPaletteHistory } from "../util/inkPaletteHistory";

/** The toolbar and preset sheet share one in-flight palette request per board. */
export function useInkPaletteAdvance(
  historyRef: RefObject<InkPaletteHistory>,
  applyHistory: (history: InkPaletteHistory) => void,
  paper: () => string,
  onError: (error: unknown) => void,
) {
  const fetching = useRef(false);
  return useCallback(() => {
    if (fetching.current) return;
    fetching.current = true;
    void fetchNextColorHuntPalette(historyRef.current, undefined, paper())
      .then(palette => applyHistory(appendInkPalette(historyRef.current, palette)))
      .catch(onError)
      .finally(() => { fetching.current = false; });
  }, [historyRef, applyHistory, paper, onError]);
}
