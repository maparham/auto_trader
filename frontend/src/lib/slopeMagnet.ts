// Magnet snapping for the Slope tool's interactive ENDPOINT drags. Placement (the two
// click-to-place anchors) snaps natively via klinecharts' overlay `mode`; but the
// post-draw endpoint drags are driven by ChartCore's own pointer path (overrideOverlay),
// which bypasses native snapping — so this pure helper reproduces the "snap to the
// nearest bar OHLC" behavior for that path. Only endpoints snap; midpoint-translate and
// rotate preserve the line's geometry, so they never snap.

import { MAGNET_SENSITIVITY, type MagnetMode } from "./magnet";

// One OHLC candidate: its price and where that price sits in pixels (screen y). The
// caller supplies the pixel via convertToPixel so weak-magnet's proximity test matches
// klinecharts' own px threshold.
export interface BarPricePixel {
  price: number;
  py: number;
}

// Snap a dragged endpoint's price to the nearest bar OHLC value, per the magnet mode:
//   normal        → never snap (return the raw cursor price)
//   strong_magnet → always snap to the nearest OHLC
//   weak_magnet   → snap only when the nearest OHLC is within `sensitivityPx` of the cursor
// "Nearest" is by screen distance (pixels), so it matches what the eye sees at any zoom.
export function snapSlopeEndpoint(
  rawPrice: number,
  cursorPy: number,
  candidates: BarPricePixel[],
  mode: MagnetMode,
  sensitivityPx: number = MAGNET_SENSITIVITY,
): number {
  if (mode === "normal" || candidates.length === 0) return rawPrice;
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c.py - cursorPy) < Math.abs(best.py - cursorPy)) best = c;
  }
  if (mode === "strong_magnet") return best.price;
  return Math.abs(best.py - cursorPy) <= sensitivityPx ? best.price : rawPrice;
}
