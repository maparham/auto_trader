// Time gaps: a pane pinned to 1D or 1W already holds the broker's own bar
// starts (mtf.htfStarts). Those are the exact day or week boundaries the slot
// grid should use, so the pinned line is straight for any broker.
import type { SlotAnchors } from "./equalWidthDays";
import { tryCanonicalTf } from "./timeframe";

export function slotAnchorsFor(
  timeframe: string | null,
  htfStarts: readonly number[] | undefined,
): SlotAnchors | null {
  if (!timeframe || !htfStarts?.length) return null;
  const tf = tryCanonicalTf(timeframe);
  if (tf === "DAY") return { dayStarts: htfStarts };
  if (tf === "WEEK") return { weekStarts: htfStarts };
  return null;
}
