// The chart-axis timezone that calendar-bucketed indicators follow (PREV_HL
// day/week, TIME_HIGHLIGHT windows; only PREV_HL has a registry series, so
// only PREV_HL is stamped below). A leaf with no imports, so pure modules
// (exprInstances.ts, indicatorAlertInstance.ts) can read it without pulling
// klinecharts in. ChartCore pushes the user's zone through
// setIndicatorTimezone; prevHl.ts re-exports both functions for its callers.

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// The resolved IANA zone (never ""). Defaults to the browser zone so the
// indicators are right even before ChartCore pushes the chart's zone.
let indicatorTz: string = browserZone();

/** Set the zone ("" means the browser zone). Returns true if it changed, so
 * the caller only forces a recompute when needed. */
export function setIndicatorTimezone(tz: string): boolean {
  const resolved = tz || browserZone();
  if (resolved === indicatorTz) return false;
  indicatorTz = resolved;
  return true;
}

export function getIndicatorTimezone(): string {
  return indicatorTz;
}

// Pane types whose VALUES bucket by calendar day or week in a timezone.
const TZ_STAMPED_TYPES: ReadonlySet<string> = new Set(["PREV_HL"]);

function isValidZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz === "chart") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True when a pane carries its own valid zone (a per-pane override), so the
 * chart zone never reaches it: a chart-zone change leaves its config as is. */
export function hasPaneTimezone(extendData: unknown): boolean {
  return isValidZone((extendData as { tz?: unknown } | null | undefined)?.tz);
}

/** extendData as the backend must see it. The server has no chart zone of its
 * own (it would bucket in UTC), so a calendar-bucketed pane with no valid
 * per-pane `tz` gets the chart's current zone written in. A valid override is
 * kept. Other types come back as the same reference. Never mutates. */
export function withChartTimezone(type: string, extendData: unknown): unknown {
  if (!TZ_STAMPED_TYPES.has(type)) return extendData;
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as Record<string, unknown>;
  if (isValidZone(ext.tz)) return extendData;
  return { ...ext, tz: indicatorTz };
}
