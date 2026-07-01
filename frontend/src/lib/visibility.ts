// Per-timeframe visibility model shared by drawings (OverlayManager / DrawingSettings)
// and indicators (applyIndicatorIntervalVisibility / IndicatorSettings). TradingView's
// Visibility tab: each time unit has an enable checkbox + a [min,max] numeric range; the
// object shows on a resolution iff its unit is enabled and the resolution's numeric value
// falls in range. Default = all units on, full range = "show on all intervals".
//
// Framework-free and exhaustively unit-tested; the React UI lives in VisibilityTab.tsx.

import { RESOLUTION_SECONDS } from "./feed";

export type VisUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years";

export interface UnitVisibility {
  on: boolean;
  min: number;
  max: number;
}

export interface VisibilityModel {
  units: Record<VisUnit, UnitVisibility>;
  // Auto-hide a finite-extent object when it spans fewer than `minBars` visible bars at
  // the current resolution. Off by default; only meaningful for drawings + anchored
  // indicators (full-width indicators span every bar so it can never fire).
  autoHide: { on: boolean; minBars: number };
}

// Supported unit rows + TradingView slider bounds. Only the units this app has
// intervals for (no Ticks/Ranges) — includes the derived Month/Year timeframes
// (lib/feed.ts DERIVED_PERIODS: MONTH/MONTH_2/MONTH_3, YEAR). Order is the render order.
export const VISIBILITY_UNITS: { unit: VisUnit; label: string; max: number }[] = [
  { unit: "seconds", label: "Seconds", max: 59 },
  { unit: "minutes", label: "Minutes", max: 59 },
  { unit: "hours", label: "Hours", max: 24 },
  { unit: "days", label: "Days", max: 366 },
  { unit: "weeks", label: "Weeks", max: 52 },
  { unit: "months", label: "Months", max: 12 },
  { unit: "years", label: "Years", max: 10 },
];

const PREFIX_UNIT: Record<string, VisUnit> = {
  SECOND: "seconds",
  MINUTE: "minutes",
  HOUR: "hours",
  DAY: "days",
  WEEK: "weeks",
  MONTH: "months",
  YEAR: "years",
};

export function defaultVisibility(): VisibilityModel {
  const units = {} as Record<VisUnit, UnitVisibility>;
  for (const u of VISIBILITY_UNITS) units[u.unit] = { on: true, min: 1, max: u.max };
  return { units, autoHide: { on: false, minBars: 3 } };
}

// "MINUTE" -> {minutes,1}; "MINUTE_15" -> {minutes,15}; "HOUR_4" -> {hours,4}. The
// resolution keys come from lib/feed.ts (PREFIX or PREFIX_<n>). Returns null if the
// prefix isn't a supported unit (caller fails open).
export function parseResolution(res: string): { unit: VisUnit; value: number } | null {
  if (!res) return null;
  const us = res.indexOf("_");
  const prefix = us === -1 ? res : res.slice(0, us);
  const unit = PREFIX_UNIT[prefix];
  if (!unit) return null;
  const value = us === -1 ? 1 : Number(res.slice(us + 1));
  return Number.isFinite(value) ? { unit, value } : { unit, value: 1 };
}

export function isVisibleOnResolution(m: VisibilityModel, res: string): boolean {
  const parsed = parseResolution(res);
  if (!parsed) return true; // unknown resolution => fail open
  const cfg = m.units[parsed.unit];
  if (!cfg) return true;
  return cfg.on && parsed.value >= cfg.min && parsed.value <= cfg.max;
}

// Whole/fractional bars between two ms timestamps at `res`. Infinity for an unknown
// resolution so auto-hide (which compares `< minBars`) never fires on it.
export function barsSpanned(t1: number, t2: number, res: string): number {
  const secs = RESOLUTION_SECONDS[res];
  if (!secs) return Infinity;
  return Math.abs(t2 - t1) / (secs * 1000);
}

export type VisPreset = "all" | "finer" | "coarser" | "only" | "custom";

// Fine -> coarse unit order (index = rank).
const UNIT_ORDER: VisUnit[] = VISIBILITY_UNITS.map((u) => u.unit);
const UNIT_MAX: Record<VisUnit, number> = Object.fromEntries(
  VISIBILITY_UNITS.map((u) => [u.unit, u.max]),
) as Record<VisUnit, number>;

// Rewrites `m.units` per the given quick-set preset against `res`'s unit+value,
// leaving `autoHide` untouched. "custom" and an unparseable `res` are no-ops (the
// dropdown falls back to "Custom" and presets are inert).
export function applyPreset(m: VisibilityModel, res: string, preset: VisPreset): VisibilityModel {
  if (preset === "custom") return m;
  const parsed = parseResolution(res);
  if (!parsed) return m;
  const { unit, value } = parsed;
  const rank = UNIT_ORDER.indexOf(unit);

  const units = {} as Record<VisUnit, UnitVisibility>;
  for (let i = 0; i < UNIT_ORDER.length; i++) {
    const u = UNIT_ORDER[i];
    const max = UNIT_MAX[u];
    if (preset === "all") {
      units[u] = { on: true, min: 1, max };
    } else if (preset === "only") {
      units[u] = u === unit ? { on: true, min: value, max: value } : { on: false, min: 1, max };
    } else if (preset === "finer") {
      if (i < rank) units[u] = { on: true, min: 1, max };
      else if (i === rank) units[u] = { on: true, min: 1, max: value };
      else units[u] = { on: false, min: 1, max };
    } else {
      // coarser
      if (i > rank) units[u] = { on: true, min: 1, max };
      else if (i === rank) units[u] = { on: true, min: value, max };
      else units[u] = { on: false, min: 1, max };
    }
  }
  return { units, autoHide: { ...m.autoHide } };
}

// Returns the preset whose generated units equal `m.units`, else "custom". Also
// "custom" for an unparseable `res` (presets have nothing to compare against).
export function detectPreset(m: VisibilityModel, res: string): VisPreset {
  if (!parseResolution(res)) return "custom";
  for (const p of ["all", "only", "finer", "coarser"] as const) {
    const candidate = applyPreset(defaultVisibility(), res, p);
    let match = true;
    for (const u of UNIT_ORDER) {
      const a = candidate.units[u];
      const b = m.units[u];
      if (a.on !== b.on || (a.on && (a.min !== b.min || a.max !== b.max))) {
        match = false;
        break;
      }
    }
    if (match) return p;
  }
  return "custom";
}

