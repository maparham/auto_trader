// The SLOPE pane's LINE SHAPE — how many lines it draws and what they are named
// — split out of slope.ts as a leaf with no RUNTIME imports (the SlopeExtend
// import below is `import type`, which the compiler erases outright).
//
// Why its own module: slope.ts is the chart-side module (draw/calc, the MTF
// helpers, klinecharts types), far more than a pure caller needs. Its klinecharts
// import is now a proper `import type` and erased outright, but keeping the line
// shape here as a leaf means exprChartToken.ts / exprInstances.ts stay pure,
// node-testable functions. slope.ts re-exports both names, so every existing
// importer is unaffected.
//
// Mirrors Python indicators/slope.py (`_lengths_of` / `slope_outputs`), which is
// what the backend validates a rule reference against.
import type { SlopeExtend } from "./slope";

/** The pane's MA lengths, per calcParams. Finite non-zero values, first 5;
 * empty/garbage → [9]. */
export function slopeLengths(calcParams: unknown[] | undefined): number[] {
  const xs = (calcParams ?? []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== 0);
  return xs.length ? xs.slice(0, 5) : [9];
}

/** The pane's DATA outputs, in pane order — the names a rule expression may
 * reference as `<instance>.<output>`. Mirrors Python `slope_outputs`, so
 * anything absent here would 422 on the backend.
 *
 * Excludes thHi/thLo: slopeFigures emits those only to drive the pane's y-axis
 * auto-scale, so they are figure keys but not values a rule may read. */
export function slopeOutputs(calcParams: unknown[] | undefined, ext: SlopeExtend): string[] {
  const lines = slopeLengths(calcParams).map((_, i) => `slope${i}`);
  if (!ext.showAccel) return lines;
  return [...lines, ...slopeLengths(calcParams).map((_, i) => `accel${i}`)];
}

/** Bars a smoothing stage consumes before its first honest value: `length - 1`,
 * and 0 when the stage is off. Mirrors Python `_smoothing_warmup`. */
function smoothingWarmup(s: { type?: string; length?: number } | undefined): number {
  // Python `_smoothing_of` recognises only "sma"/"ema"; every other spelling
  // (including "none" and a missing type) is OFF, so it must cost 0 here too.
  if (!s || (s.type !== "sma" && s.type !== "ema")) return 0;
  const n = Math.trunc(Number(s.length));
  return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
}

/** Warm-up bars an instance's OUTPUT needs before its first honest value, in the
 * bars the output is computed on (base bars for an unpinned pane; the pinned
 * pane's own HTF bars otherwise — the caller decides which, exactly as the @tf
 * pin rule does).
 *
 * Mirrors Python `indicators/slope.py::slope_warmup` term for term: MA length +
 * slope period + slope-smoothing warm-up, plus accel period + accel-smoothing
 * warm-up for an `accel*` output. Pinned by
 * frontend/src/lib/indicators/slopeWarmupParity.test.ts and
 * backend/tests/test_slope_warmup_parity.py against the same table of configs.
 *
 * Returns 0 for an output this config does not expose — an unknown reference is
 * the lint layer's error to report, not a reason to inflate the history ask. */
export function slopeWarmup(
  calcParams: unknown[] | undefined,
  ext: SlopeExtend,
  output: string,
): number {
  if (!slopeOutputs(calcParams, ext).includes(output)) return 0;
  const isAccel = output.startsWith("accel");
  const idx = Number(output.slice(isAccel ? "accel".length : "slope".length));
  // Truncated, not rounded: Python `_lengths_of` / `parse_slope_config` coerce
  // every one of these with int(), so a fractional setting must land on the same
  // integer here or the two warm-ups disagree by a bar.
  const length = Math.trunc(slopeLengths(calcParams)[idx]);
  let n = length + (Math.trunc(Number(ext.slopePeriod)) || 3) + smoothingWarmup(ext.smoothing);
  if (isAccel) {
    n += (Math.trunc(Number(ext.accelPeriod)) || 3) + smoothingWarmup(ext.accelSmoothing);
  }
  return n;
}
