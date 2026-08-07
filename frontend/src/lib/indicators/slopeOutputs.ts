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
import type { SlopeExtend, SlopeUnit } from "./slope";

/** The pane's MA lengths, per calcParams. Finite non-zero values TRUNCATED to
 * whole bars, first 5; empty/garbage → [9].
 *
 * Truncated because Python `_lengths_of` coerces each value with int(), and the
 * length input writes Number(e.target.value) with no rounding — so a typed
 * "5.5" reaches both runtimes verbatim. JS then indexes the MA's rolling window
 * by a fractional offset, which is `undefined`, poisoning the line to NaN, while
 * Python computes a clean SMA(5). Truncating here (AFTER the non-zero filter,
 * exactly as Python does) is what keeps the plotted line and the rule operand
 * equal. Note 0.5 survives the filter and truncates to 0 on BOTH sides — a
 * zero-length MA is all-undefined either way. */
export function slopeLengths(calcParams: unknown[] | undefined): number[] {
  const xs = (calcParams ?? []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== 0);
  return (xs.length ? xs.slice(0, 5) : [9]).map((v) => Math.trunc(v));
}

/** A whole-bar period from a stored setting, falling back to `fallback`.
 * Mirrors Python `parse_slope_config`'s `int(x or 0) or <default>`: a fractional
 * setting truncates, and anything that truncates to 0 (or is unparseable) takes
 * the default. */
export function slopePeriodOf(raw: unknown, fallback: number): number {
  return Math.trunc(Number(raw)) || fallback;
}

/** Coerce a stored/unknown slope unit to a real one. Mirrors Python
 * `parse_slope_config`, which falls back to pctHr for anything outside the set —
 * where the TS math, left unnormalised, would fall through slopeWithUnits' final
 * `else` and silently behave as pctBar. Centralised for the same reason as
 * mtf.ts `normalizeMaKind`. */
export function normalizeSlopeUnit(v: unknown): SlopeUnit {
  return v === "pctBar" || v === "priceBar" || v === "pctHr" ? v : "pctHr";
}

/** output name -> the MA length it selects, in pane order. Mirrors Python
 * `output_lengths`.
 *
 * Outputs are named by LENGTH, not by ordinal: the pane's `[9, 50]` exposes `9`
 * and `50`. A rule SELECTS a line the pane already defines; it does not restate
 * a parameter, so the pane stays the single source of truth. The point is loud
 * failure — retune that line from 9 to 21 and every rule naming `9` fails with
 * unknown_indicator_output listing the lengths that now exist, instead of
 * silently re-pointing at a different line.
 *
 * Duplicate lengths collapse to one name, FIRST WINS (Map insertion order, the
 * same order Python's dict comprehension keeps). Two lines of the same length
 * are the same series, so one name is complete information; the pane still
 * DRAWS whatever it is configured to draw — the dedupe lives in the output
 * namespace only, never in `slopeLengths`.
 *
 * Note a negative length keeps its sign here (`-9`), which no rule can spell:
 * `.` followed by `-` is not a field access. Left alone deliberately — the
 * plotted line is what it is, and filtering here would hide it. */
export function slopeOutputLengths(calcParams: unknown[] | undefined): Map<string, number> {
  // A repeated key keeps its FIRST position in a Map, exactly as in a Python
  // dict, and equal numbers always stringify equally — so a later duplicate
  // rewrites its slot with an identical value and changes nothing. Both stacks
  // land on the same keys in the same order with no explicit dedupe pass.
  return new Map(slopeLengths(calcParams).map((n) => [String(n), n]));
}

/** The pane's DATA outputs, in pane order — the names a rule expression may
 * reference as `<instance>.<output>`. Mirrors Python `slope_outputs`, so
 * anything absent here would 422 on the backend.
 *
 * Excludes thHi/thLo: slopeFigures emits those only to drive the pane's y-axis
 * auto-scale, so they are figure keys but not values a rule may read. */
export function slopeOutputs(calcParams: unknown[] | undefined, ext: SlopeExtend): string[] {
  const lines = [...slopeOutputLengths(calcParams).keys()];
  if (!ext.showAccel) return lines;
  return [...lines, ...lines.map((name) => `accel${name}`)];
}

/** The MA length one of this config's outputs selects, and whether it is the
 * acceleration companion — or null when the config does not expose `output`.
 * Mirrors Python `_resolve_output`, and is the single place a name is turned
 * back into a length so the callers cannot drift apart.
 *
 * Looks the name up in the table rather than stripping a prefix and coercing
 * what is left. */
export function resolveSlopeOutput(
  calcParams: unknown[] | undefined,
  ext: SlopeExtend,
  output: string,
): { length: number; isAccel: boolean } | null {
  // `accel` counts as a prefix only when the remainder is itself a configured
  // length AND the companion is on, so `accel<anything else>` returns null
  // instead of resolving to some line by accident.
  const lengths = slopeOutputLengths(calcParams);
  const direct = lengths.get(output);
  if (direct !== undefined) return { length: direct, isAccel: false };
  if (ext.showAccel && output.startsWith("accel")) {
    const accel = lengths.get(output.slice("accel".length));
    if (accel !== undefined) return { length: accel, isAccel: true };
  }
  return null;
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
  const resolved = resolveSlopeOutput(calcParams, ext, output);
  if (!resolved) return 0;
  // The length is already TRUNCATED, not rounded: Python `_lengths_of` /
  // `parse_slope_config` coerce every one of these with int(), so a fractional
  // setting must land on the same integer here or the two warm-ups disagree by
  // a bar. slopeLengths does that truncation — the same coercion the pane's own
  // math runs through — and the output name is the truncated value spelled out.
  let n = resolved.length + slopePeriodOf(ext.slopePeriod, 3) + smoothingWarmup(ext.smoothing);
  if (resolved.isAccel) {
    n += slopePeriodOf(ext.accelPeriod, 3) + smoothingWarmup(ext.accelSmoothing);
  }
  return n;
}
