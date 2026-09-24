// Static tables and pure helpers shared by BacktestSettingsModal and its
// sections: range/tab/stop/target option lists, the day-window math, the
// positive-number input guards, and the instrument cost profile cache.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CostProfile } from "../api";
import type { BacktestConfig, Costs, DayTimeWindow, HistoryDepth, RangeMode, RiskConfig, ScalingConfig, StopKind, TargetKind } from "../lib/backtestConfig";
import { resolveWindow } from "../lib/backtestWindow";
import { TIMEZONES, offsetLabel } from "../lib/timezones";

export const RANGE_MODES: { value: RangeMode; label: string }[] = [
  { value: "bars", label: "Bars" },
  { value: "lastDay", label: "Day" },
  { value: "lastWeek", label: "Week" },
  { value: "lastMonth", label: "Month" },
  { value: "lastYear", label: "Year" },
];

// SCROLL_TABS are anchors into one continuous pane, results included: the
// results are its last section, sized to fill the pane so landing on them gives
// the whole height rather than a strip squeezed under the settings. The results
// tab is dropped when they live in their own side column — no section to scroll
// to. Presets is deliberately NOT in that pane: it is a library of other
// configurations rather than a part of the one being edited, so it gets its own
// pane that you switch to and cannot drift into by scrolling.
export type ScrollTab = "period" | "strategy" | "costs" | "results";
export type BacktestTab = ScrollTab | "presets";
export const SCROLL_TABS: { value: ScrollTab; label: string; tip: string }[] = [
  { value: "period", label: "Period", tip: "The date range to test and how much history warms up the indicators." },
  { value: "strategy", label: "Strategy", tip: "Entry and exit rules, position size, stops and targets." },
  { value: "costs", label: "Costs", tip: "Spread, commission and slippage applied to every fill." },
  { value: "results", label: "Results", tip: "Metrics, equity curve and the trade list from the last run." },
];
export const PRESETS_TAB = {
  value: "presets",
  label: "Presets",
  tip: "Saved configurations: load one, or save the current settings to reuse later.",
} as const;

// Which suggestion-chip unit each range tab shows (Bars shows none).
export const CHIP_UNIT: Partial<Record<RangeMode, "day" | "week" | "month" | "year">> = {
  lastDay: "day",
  lastWeek: "week",
  lastMonth: "month",
  lastYear: "year",
};

// WFO quick-fill: relative presets stay rolling (mode set, fromMs/toMs cleared),
// mirroring the non-WFO relative modes.
export const WFO_RELATIVE_CHIPS: { mode: RangeMode; label: string }[] = [
  { mode: "lastDay", label: "1D" },
  { mode: "lastWeek", label: "1W" },
  { mode: "lastMonth", label: "1M" },
  { mode: "lastYear", label: "1Y" },
];

export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The schedule mask is always evaluated in the chart's display timezone. Stamp
// it onto the mask right before a run so the backend gate and the frontend
// preview agree, regardless of whatever tz an older saved config carried.
// Friendly label for a resolved IANA zone, e.g. "Tokyo (UTC+09:00)". Falls back
// to the raw id when it's not in the curated list (an arbitrary browser zone).
export function tzDisplay(tz: string): string {
  const city = TIMEZONES.find((t) => t.value === tz)?.label ?? tz;
  const off = offsetLabel(tz);
  return off ? `${city} ${off}` : city;
}

export function withChartTz(cfg: BacktestConfig, tz: string): BacktestConfig {
  const m = cfg.range.mask;
  if (!m) return cfg; // no mask, no gate — tz is irrelevant
  return { ...cfg, range: { ...cfg.range, mask: { ...m, tz } } };
}

export function toggle(list: number[] | undefined, v: number): number[] {
  const s = new Set(list ?? []);
  if (s.has(v)) s.delete(v);
  else s.add(v);
  return [...s].sort((a, b) => a - b);
}
export function timeToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
export function withStart(w: DayTimeWindow | undefined, startMin: number): DayTimeWindow {
  return { startMin, endMin: w?.endMin ?? startMin };
}
export function withEnd(w: DayTimeWindow | undefined, endMin: number): DayTimeWindow {
  return { startMin: w?.startMin ?? 0, endMin };
}

export const HISTORY_DEPTHS: { value: HistoryDepth; label: string; tip: string }[] = [
  { value: "full", label: "Full", tip: "Loads years of history. Slow; only when warm-up cannot size itself." },
  { value: "bars", label: "N bars", tip: "Loads the bar count you set before the window." },
  { value: "minimal", label: "Auto-shortest", tip: "Loads just enough to warm up your indicators. Fastest." },
];

export const STOP_KINDS: { value: StopKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pct", label: "% from entry" },
  { value: "atr", label: "ATR ×" },
  { value: "trailPct", label: "Trailing %" },
  { value: "trailAtr", label: "Trailing ATR ×" },
  { value: "price", label: "Fixed price" },
];
export const TARGET_KINDS: { value: TargetKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pct", label: "% from entry" },
  { value: "atr", label: "ATR ×" },
  { value: "price", label: "Fixed price" },
];

export const EMPTY_RISK: RiskConfig = { stop: { kind: "none" }, target: { kind: "none" } };
export const DEFAULT_SCALING: ScalingConfig = { maxConcurrent: 1 };
// A rough, illustrative bar count for the window timeline — not the exact fetch
// math BacktestButton uses (which also depends on "now" and the live broker's
// actual history limit), just enough to make the history-vs-window split
// tangible while the user is configuring it. Custom ranges without both dates
// set fall back to a nominal week.
const NOMINAL_WINDOW_BARS = 168;

// A number <input> happily keeps a leading zero the model can't represent —
// "0200", or the "0" left behind after you clear the field (Number("") is 0) and
// type your number after it, giving "0200". React won't re-render that away on
// its own when the parsed value is unchanged, so strip it off the raw string in
// place. Returns the cleaned string (may be "" — callers coerce with Number()).
export function cleanNumInput(el: HTMLInputElement): string {
  const cleaned = el.value.replace(/^(-?)0+(?=\d)/, "$1");
  if (cleaned !== el.value) el.value = cleaned;
  return cleaned;
}

// Count/length/magnitude fields must stay positive (an EMA of 0 or -5 bars is
// meaningless). Block the keystrokes that would enter a negative or exponent so
// one can't be typed at all...
export function blockNegKeys(e: ReactKeyboardEvent<HTMLInputElement>) {
  if (e.key === "-" || e.key === "+" || e.key === "e" || e.key === "E") e.preventDefault();
}
// ...and on blur snap a value that came out ≤ 0 (or was left empty mid-edit) up
// to the field's floor, so leaving the field can't commit a non-positive number.
// `commit` is 0-arg because the caller already knows the clamped value to write.
export function clampPosOnBlur(el: HTMLInputElement, floor: number, commit: (n: number) => void) {
  if (!(Number(el.value) > 0)) commit(floor);
}

export function estimateWindowBars(cfg: BacktestConfig, resSeconds: number): number {
  const r = cfg.range;
  if (r.mode === "bars") return r.bars ?? 500;
  if (r.mode === "custom" && !(r.fromMs && r.toMs && r.toMs > r.fromMs)) {
    return NOMINAL_WINDOW_BARS;
  }
  const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
  return Math.max(1, Math.round((toMs - fromMs) / 1000 / resSeconds));
}

// Session-lived cache of fetched instrument cost profiles, keyed by epic, so the
// Costs tab fetches a profile once per epic per session (re-opening the modal for
// the same epic reuses it). Exported reset is for tests.
export const costProfileCache = new Map<string, CostProfile>();
export function resetCostProfileCache(): void {
  costProfileCache.clear();
}

// The instrument-cost fields a CostProfile carries into a Costs object. Quantity,
// commission and starting cash are panel-only and never ride the profile.
export function profileToCostsPatch(p: CostProfile): Partial<Costs> {
  return {
    spread: p.spread,
    slippage: p.slippage,
    finLongDailyPct: p.finLongDailyPct,
    finShortDailyPct: p.finShortDailyPct,
  };
}
