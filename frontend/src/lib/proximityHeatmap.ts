// Pure helpers for the rule proximity heatmap: closeness (0..1) to a canvas
// fill color/alpha, and whether the overlay should show at the current chart
// resolution (hidden below the rule's authored/base timeframe).
import { RESOLUTION_SECONDS } from "./feed";

// Cool (far from firing) to hot (about to fire). Blue-teal -> amber-red.
const COOL = { r: 43, g: 122, b: 155 };  // #2b7a9b
const HOT = { r: 217, g: 102, b: 58 };   // #d9663a

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function heatColor(closeness: number): string {
  const t = clamp01(closeness);
  const r = Math.round(COOL.r + (HOT.r - COOL.r) * t);
  const g = Math.round(COOL.g + (HOT.g - COOL.g) * t);
  const b = Math.round(COOL.b + (HOT.b - COOL.b) * t);
  return `rgba(${r}, ${g}, ${b}, 1)`;
}

// Fully cold contributes nothing; warmth fades the column in. Capped low so
// candles stay readable through the fill (matches timeHighlight's low alpha).
const MAX_ALPHA = 0.32;
export function heatAlpha(closeness: number): number {
  return clamp01(closeness) * MAX_ALPHA;
}

export function heatmapVisible(displayResolution: string, baseResolution: string): boolean {
  const d = RESOLUTION_SECONDS[displayResolution];
  const b = RESOLUTION_SECONDS[baseResolution];
  if (!d || !b) return false;
  return d >= b;
}
