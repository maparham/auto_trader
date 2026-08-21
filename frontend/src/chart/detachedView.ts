/** Gap (in bars) between the loaded oldest bar and the jump target beyond
 *  which Go-to-date detaches instead of extending history. 50k bars is ~6
 *  months of 5m: under it the parallel cover is at most ~100 requests and a
 *  continuous scrollable history is worth it; over it, extending means
 *  hundreds of requests and (on a cold cache) minutes of backfill. */
export const DETACH_GAP_BARS = 50_000;

/** Bars of context fetched on each side of the target date. */
export const DETACH_CONTEXT_BARS = 1_500;

export interface DetachedTarget { targetMs: number }

export function shouldDetach(
  targetMs: number,
  loadedOldestMs: number | null,
  resSec: number,
): boolean {
  // Never detach if no loaded data
  if (loadedOldestMs === null) return false;

  // Never detach if target is newer than loaded oldest
  if (targetMs >= loadedOldestMs) return false;

  // Calculate gap in bars
  const gapMs = loadedOldestMs - targetMs;
  const gapBars = gapMs / (resSec * 1000);

  return gapBars > DETACH_GAP_BARS;
}

/** The 500-bar fetch windows covering [target - context, target + context],
 *  in seconds, oldest first. */
export function detachedWindows(
  targetMs: number,
  resSec: number,
  pageBars = 500,
): Array<{ fromSec: number; toSec: number }> {
  const targetSec = Math.floor(targetMs / 1000);
  const contextSec = DETACH_CONTEXT_BARS * resSec;

  const startSec = targetSec - contextSec;
  const endSec = targetSec + contextSec;

  const windowSec = pageBars * resSec;
  const windows: Array<{ fromSec: number; toSec: number }> = [];

  for (let fromSec = startSec; fromSec < endSec; fromSec += windowSec) {
    const toSec = Math.min(fromSec + windowSec, endSec);
    windows.push({ fromSec, toSec });
  }

  return windows;
}
