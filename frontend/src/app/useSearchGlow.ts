// The brief glow on cells the tab-bar symbol search jumps to or matches.
import { useCallback, useEffect, useRef, useState } from "react";

export function useSearchGlow() {
  // Cells flashed by the symbol search (jump or live typing). Cleared after
  // ~2s; the CSS animation fades the outline over the same window.
  const [searchGlow, setSearchGlow] = useState<string[]>([]);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCells = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    if (glowTimer.current != null) clearTimeout(glowTimer.current);
    // Clear-then-set across a frame so re-flashing the same cells restarts
    // the CSS animation (same class on the same node never replays).
    setSearchGlow([]);
    requestAnimationFrame(() => {
      setSearchGlow(ids);
      glowTimer.current = setTimeout(() => setSearchGlow([]), 2000);
    });
  }, []);
  useEffect(
    () => () => {
      if (glowTimer.current != null) clearTimeout(glowTimer.current);
    },
    [],
  );
  return { searchGlow, flashCells };
}
