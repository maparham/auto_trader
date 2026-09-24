// Timeframe tables: the quick-bar, derived and seconds periods, their groups,
// custom-timeframe expansion, pinning, per-resolution seconds and the
// quick-bar helpers.
import { tfLabel, tfSecondsOf, tryCanonicalTf } from "../timeframe";

export interface Period {
  resolution: string; // backend Resolution value, or a SECONDS_INTERVALS key
  label: string;
  liveOnly?: boolean; // sub-minute: no history, built live from the tick stream
}

// Quick-bar (fixed): the native Capital resolutions, which have full history.
export const PERIODS: Period[] = [
  { resolution: "MINUTE", label: "1m" },
  { resolution: "MINUTE_5", label: "5m" },
  { resolution: "MINUTE_15", label: "15m" },
  { resolution: "MINUTE_30", label: "30m" },
  { resolution: "HOUR", label: "1H" },
  { resolution: "HOUR_4", label: "4H" },
  { resolution: "DAY", label: "1D" },
  { resolution: "WEEK", label: "1W" },
];

// 3m isn't a native Capital resolution (their API rejects it) — the backend
// folds native 1m bars into 3-minute buckets on read, like the coarser derived
// timeframes below. It's the one derived TF finer than a native, so it slots
// into the Minutes group right after 1m rather than into its own group.
const MINUTE_DERIVED_PERIODS: Period[] = [{ resolution: "MINUTE_3", label: "3m" }];

// Derived (non-native) timeframes: the backend folds cached DAY/WEEK base bars
// into calendar buckets — full history + live, but not Capital resolutions. Like
// the seconds group, these live only in the grouped dropdown, not the quick-bar.
const DERIVED_PERIODS: Period[] = [
  { resolution: "WEEK_2", label: "2W" },
  { resolution: "WEEK_3", label: "3W" },
  { resolution: "WEEK_6", label: "6W" },
  { resolution: "MONTH", label: "1M" },
  { resolution: "MONTH_2", label: "2M" },
  { resolution: "MONTH_3", label: "3M" },
  { resolution: "YEAR", label: "1Y" },
];

// Sub-minute intervals, built live by bucketing the tick stream (no history).
// Keys must match the backend's SECONDS_INTERVALS.
const SECONDS_PERIODS: Period[] = [
  { resolution: "SECOND", label: "1s", liveOnly: true },
  { resolution: "SECOND_5", label: "5s", liveOnly: true },
  { resolution: "SECOND_10", label: "10s", liveOnly: true },
  { resolution: "SECOND_15", label: "15s", liveOnly: true },
  { resolution: "SECOND_30", label: "30s", liveOnly: true },
  { resolution: "SECOND_45", label: "45s", liveOnly: true },
];

// Grouped interval menu (TradingView-style). The quick-bar holds the native
// resolutions; this dropdown adds the live-only seconds group above them.
export interface PeriodGroup {
  label: string;
  periods: Period[];
}

export const PERIOD_GROUPS: PeriodGroup[] = [
  { label: "Seconds", periods: SECONDS_PERIODS },
  {
    label: "Minutes",
    // 1m, then derived 3m, then native 5m/15m/30m (ascending by duration).
    periods: [
      ...PERIODS.filter((p) => p.resolution === "MINUTE"),
      ...MINUTE_DERIVED_PERIODS,
      ...PERIODS.filter((p) => p.resolution.startsWith("MINUTE_")),
    ],
  },
  {
    label: "Hours",
    periods: PERIODS.filter((p) => p.resolution.startsWith("HOUR")),
  },
  {
    label: "Days",
    periods: PERIODS.filter((p) => p.resolution === "DAY" || p.resolution === "WEEK"),
  },
  {
    label: "Weeks",
    periods: DERIVED_PERIODS.filter((p) => p.resolution.startsWith("WEEK_")),
  },
  {
    label: "Months",
    periods: DERIVED_PERIODS.filter((p) => p.resolution.startsWith("MONTH")),
  },
  {
    label: "Years",
    periods: DERIVED_PERIODS.filter((p) => p.resolution === "YEAR"),
  },
];

// Every selectable timeframe (seconds → derived), used to resolve a favorite
// resolution key back to its Period and to build the merged quick bar.
export const ALL_PERIODS: Period[] = [
  ...SECONDS_PERIODS,
  ...PERIODS,
  ...MINUTE_DERIVED_PERIODS,
  ...DERIVED_PERIODS,
];

const PERIOD_BY_RESOLUTION = new Map(ALL_PERIODS.map((p) => [p.resolution, p]));

// Whether a canonical resolution key is one of the listed built-in periods
// (quick-bar defaults, derived and live-only seconds). Custom timeframes are
// everything else the grammar accepts.
export function isBuiltinResolution(resolution: string): boolean {
  return PERIOD_BY_RESOLUTION.has(resolution);
}

// The fixed defaults that always occupy the quick bar and can't be removed.
export const DEFAULT_RESOLUTIONS = new Set(PERIODS.map((p) => p.resolution));

// A built-in Period when known, else a synthesized one for any grammar
// timeframe (label or canonical, see lib/timeframe.ts) except the seconds keys,
// which exist only as the listed live-only periods. undefined when invalid.
export function periodByResolution(resolution: string): Period | undefined {
  const hit = PERIOD_BY_RESOLUTION.get(resolution);
  if (hit) return hit;
  const canon = tryCanonicalTf(resolution);
  if (canon == null || canon.startsWith("SECOND")) return undefined;
  return PERIOD_BY_RESOLUTION.get(canon) ?? { resolution: canon, label: tfLabel(canon) };
}

// The saved custom timeframes as Periods: canonical, de-duplicated, built-ins
// and invalid entries dropped, ascending by duration.
export function customPeriods(custom: string[]): Period[] {
  const seen = new Map<string, Period>();
  for (const raw of custom) {
    const canon = tryCanonicalTf(raw);
    if (canon == null || canon.startsWith("SECOND") || isBuiltinResolution(canon)) continue;
    seen.set(canon, { resolution: canon, label: tfLabel(canon) });
  }
  return [...seen.values()].sort(
    (a, b) => (RESOLUTION_SECONDS[a.resolution] ?? 0) - (RESOLUTION_SECONDS[b.resolution] ?? 0),
  );
}

// PERIOD_GROUPS plus the user's "Custom" group (omitted when empty).
export function periodGroups(custom: string[]): PeriodGroup[] {
  const periods = customPeriods(custom);
  return periods.length ? [...PERIOD_GROUPS, { label: "Custom", periods }] : PERIOD_GROUPS;
}

// Timeframes an indicator may pin to: the chart's own timeframe or higher,
// from the native periods plus the user's custom ones. A pin equal to the chart
// differs from "Chart" mode under wait-for-closes: it updates only on bar close
// instead of tracking the forming bar.
export function pinnableTimeframes(chartResolution: string, custom: string[] = []): Period[] {
  const chartSecs = RESOLUTION_SECONDS[chartResolution] ?? 0;
  return [...PERIODS, ...customPeriods(custom)]
    .filter((p) => (RESOLUTION_SECONDS[p.resolution] ?? 0) >= chartSecs)
    .sort(
      (a, b) => (RESOLUTION_SECONDS[a.resolution] ?? 0) - (RESOLUTION_SECONDS[b.resolution] ?? 0),
    );
}

// True when a pinned MTF timeframe is finer than the chart's — reachable by
// raising the chart timeframe after pinning. The pin can't meaningfully render
// there, so callers clamp the computation to chart bars (keeping the pin).
export function pinBelowChart(
  timeframe: string | null | undefined,
  chartResolution: string,
): boolean {
  if (!timeframe || timeframe === "chart") return false;
  const tfSecs = RESOLUTION_SECONDS[timeframe] ?? 0;
  const chartSecs = RESOLUTION_SECONDS[chartResolution] ?? 0;
  return tfSecs > 0 && chartSecs > 0 && tfSecs < chartSecs;
}

// Seconds per built-in resolution bucket; used for scroll-back window math.
const BUILTIN_RESOLUTION_SECONDS: Record<string, number> = {
  SECOND: 1,
  SECOND_5: 5,
  SECOND_10: 10,
  SECOND_15: 15,
  SECOND_30: 30,
  SECOND_45: 45,
  MINUTE: 60,
  MINUTE_3: 180, // derived: folded from native 1m bars
  MINUTE_5: 300,
  MINUTE_15: 900,
  MINUTE_30: 1800,
  HOUR: 3600,
  HOUR_4: 14400,
  DAY: 86400,
  WEEK: 604800,
  // Derived timeframes — approximate widths (months/years aren't fixed); used
  // only for scroll-back window math, never for bucketing (the backend folds).
  WEEK_2: 1209600,
  WEEK_3: 1814400,
  WEEK_6: 3628800,
  MONTH: 2592000,
  MONTH_2: 5184000,
  MONTH_3: 7776000,
  YEAR: 31536000,
};

// Seconds per resolution bucket for ANY timeframe the grammar accepts (see
// lib/timeframe.ts), so custom timeframes flow through every existing
// `RESOLUTION_SECONDS[res] ?? 60` lookup. Enumeration still lists only the
// built-ins, so read it by key; never snapshot it with Object.entries.
export const RESOLUTION_SECONDS: Record<string, number> = new Proxy(BUILTIN_RESOLUTION_SECONDS, {
  get(target, key) {
    if (typeof key !== "string") return undefined;
    return target[key] ?? tfSecondsOf(key) ?? undefined;
  },
  has(target, key) {
    return typeof key === "string" && (key in target || tfSecondsOf(key) != null);
  },
});

/** NOMINAL hours per bar for a resolution — the width the resolution *means*,
 * never one measured off the candles.
 *
 * This is the only definition of bar width a rule operand can be evaluated
 * against: the backend computes it as `resolution_seconds(res) / 3600`
 * (strategy/expr/evaluate.py::_tf_hours), and the two tables agree entry for
 * entry (asserted by feed.test.ts / test_slope_pane_rule_equality.py). Anything
 * measured from candle gaps diverges silently — a MONTH pane's smallest gap is
 * a 28-day February (672h) against this 720h, and a DAY pane's is 23h across a
 * DST spring-forward against 24h.
 *
 * Accepts a canonical resolution ("HOUR_4") or an expression pin alias ("4H"),
 * the same pair the backend's `tf_resolution(pin) or pin` accepts. null when the
 * name is unknown, so callers choose their own fallback. */
export function nominalBarHours(resolution: string): number | null {
  // The Proxy parses pin aliases ("4H", "D") through the grammar too.
  const secs = RESOLUTION_SECONDS[resolution];
  return secs != null && secs > 0 ? secs / 3600 : null;
}

/** nominalBarHours in milliseconds — the declared bar interval callers hand
 * the MTF machinery (see mtfCoordinator.setChartIntervalMs). */
export function declaredIntervalMs(resolution: string): number | null {
  const hours = nominalBarHours(resolution);
  return hours != null ? hours * 3_600_000 : null;
}

// The quick-access timeframe bar: the fixed defaults merged with the user's
// favorite resolutions, de-duped and sorted ascending by duration. The favorite
// list's own order is irrelevant — display order is always by RESOLUTION_SECONDS.
export function quickBarPeriods(favoriteResolutions: string[]): Period[] {
  const byRes = new Map(PERIODS.map((p) => [p.resolution, p]));
  for (const r of favoriteResolutions) {
    const p = periodByResolution(r);
    if (p) byRes.set(p.resolution, p);
  }
  return [...byRes.values()].sort(
    (a, b) =>
      (RESOLUTION_SECONDS[a.resolution] ?? 0) -
      (RESOLUTION_SECONDS[b.resolution] ?? 0),
  );
}

// The quick bar plus the ACTIVE period when it isn't on it (a seconds or custom
// TF), slotted in by duration so the row still reads shortest to longest. The
// active entry is `active` itself, so callers can tell it apart by identity.
export function quickBarWithActive(quickBar: Period[], active: Period): Period[] {
  if (quickBar.some((p) => p.resolution === active.resolution)) return quickBar;
  const secs = RESOLUTION_SECONDS[active.resolution] ?? 0;
  const at = quickBar.findIndex((p) => (RESOLUTION_SECONDS[p.resolution] ?? 0) > secs);
  return at < 0 ? [...quickBar, active] : [...quickBar.slice(0, at), active, ...quickBar.slice(at)];
}

// The enabled quick-bar period immediately FINER than `currentResolution`
// (largest duration strictly below it), or null when there is none (the user
// is already on their lowest enabled timeframe). Duration-based so it works
// even when `currentResolution` itself is not on the quick bar. Used by the
// zoom-to-range tool to drop one timeframe on release.
export function oneTfLower(
  currentResolution: string,
  favoriteResolutions: string[],
): Period | null {
  const curSecs = RESOLUTION_SECONDS[currentResolution];
  if (curSecs == null) return null;
  const ladder = quickBarPeriods(favoriteResolutions); // ascending by duration
  let best: Period | null = null;
  for (const p of ladder) {
    if (p.liveOnly) continue; // live-only seconds TFs have no history to zoom into
    const secs = RESOLUTION_SECONDS[p.resolution] ?? 0;
    if (secs < curSecs) best = p; // ascending, so the last one below wins
  }
  return best;
}
