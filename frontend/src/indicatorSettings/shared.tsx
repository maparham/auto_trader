// Shared helpers + static config tables used across IndicatorSettings' shell
// and its per-family panel modules: color parsing, the clearable IntInput,
// the LineDraft line-style model, and the static option/label tables for the
// RSI and PREV_HL families plus the generic curve-label type set.
import { useState } from "react";
import type { PrevHlAgg, RsiElement, RsiSmoothType } from "../lib/customIndicators";
import type { LineStyleOpt } from "../ColorLineStylePicker";

export const DEFAULT_LINE_PALETTE = ["#FF9600", "#935EBD", "#2962ff", "#E11D74", "#01C5C4"];

// Indicator types that plot curves and have a per-curve key parameter to label.
// Keep in sync with curveLabel()'s switch in customIndicators.ts. Includes the
// klinecharts built-in overlays (SMA/BBI/BOLL) alongside our custom indicators.
export const CURVE_LABEL_TYPES = new Set([
  "EMA",
  "MA",
  "LR",
  "VWAP",
  "AVWAP",
  "PREV_HL",
  "RSI",
  "SMA",
  "BBI",
  "BOLL",
  "PIVOT_BANDS",
  "PIVOT_ANALYSIS",
]);

// Line-style options for the RSI band / MA selectors (canvas-drawn elements).
export type RsiLineStyleOpt = "solid" | "dashed" | "dotted";
export type RsiHiddenKey = RsiElement;

// RSI "Smoothing" MA types, mirroring TradingView's RSI panel dropdown.
export const RSI_SMOOTHING_OPTIONS: { value: RsiSmoothType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "sma", label: "SMA" },
  { value: "sma_bb", label: "SMA + Bollinger Bands" },
  { value: "ema", label: "EMA" },
  { value: "rma", label: "SMMA (RMA)" },
  { value: "wma", label: "WMA" },
  { value: "vwma", label: "VWMA" },
];

// PREV_HL lookback inputs: one length + aggregation function per boundary (collapse
// the high/low over the previous N completed periods). Order matches the Style-tab
// rows. "interval" is the chart's own bar timeframe, so the indicator works on any
// TF (e.g. previous N 1H bars).
// PREV_HL has TWO orthogonal concepts, kept in separate Inputs-tab groups:
//  - "rolling": ONE sliding trailing window (the general lookback). Its unit selector
//    spans bars/minutes/hours/days/weeks — the whole nested ladder lives on this one
//    axis, so there are no redundant per-unit rows.
//  - "day"/"week": ANCHORED previous-period lines (the classic PDH/PDL) — calendar
//    periods that step at their boundary, not sliding windows.
export type PrevHlKind = "rolling" | "day" | "week" | "anchor";
// Each boundary has a `tip` explaining what its High/Low lines track.
export const PREV_HL_LENGTH_FIELDS: { kind: PrevHlKind; label: string; tip: string }[] = [
  {
    kind: "rolling",
    label: "Range",
    tip: "High and Low of the last N units. The window slides with every new bar.",
  },
  {
    kind: "day",
    label: "Day",
    tip: "High and Low of the previous trading days. Skips weekends, so Monday looks back to Friday.",
  },
  {
    kind: "week",
    label: "Week",
    tip: "High and Low of the previous weeks. Each week starts Monday.",
  },
];
export const PREV_HL_AGG_OPTIONS: { value: PrevHlAgg; label: string; tip: string }[] = [
  {
    value: "extreme",
    label: "Max / Min",
    tip: "Top line is the highest high. Bottom line is the lowest low.",
  },
  {
    value: "avg",
    label: "Average",
    tip: "Top line is the average of the highs. Bottom line is the average of the lows.",
  },
  {
    value: "median",
    label: "Median",
    tip: "Like Average, but ignores one odd spike.",
  },
];
// Unit for the rolling window. "bars" = the chart's own bars (any timeframe); the
// rest are clock spans. They're all the same axis (1 hour = 60 minutes = …).
export const PREV_HL_ROLLING_UNITS: { value: string; label: string }[] = [
  { value: "bars", label: "bars" },
  { value: "minute", label: "minutes" },
  { value: "hour", label: "hours" },
  { value: "day", label: "days" },
  { value: "week", label: "weeks" },
];
// Whether the rolling time-span counts closed-market time (time units only).
export const PREV_HL_GAP_OPTIONS: { value: "trading" | "wallclock"; label: string; tip: string }[] = [
  {
    value: "trading",
    label: "Trading time",
    tip: "Counts trading bars only. Skips weekends and overnight gaps.",
  },
  {
    value: "wallclock",
    label: "Wall-clock",
    tip: "Counts real clock time. Gaps eat into the window.",
  },
];
// PREV_HL Style-tab rows pair a boundary's High + Low figures on one row.
export const PREV_HL_STYLE_PAIRS: { kind: PrevHlKind; label: string; hiKey: string; loKey: string }[] = [
  { kind: "rolling", label: "Range", hiKey: "rollingHigh", loKey: "rollingLow" },
  { kind: "day", label: "Day", hiKey: "dayHigh", loKey: "dayLow" },
  { kind: "week", label: "Week", hiKey: "weekHigh", loKey: "weekLow" },
  { kind: "anchor", label: "Anchor", hiKey: "anchorHigh", loKey: "anchorLow" },
];

// Color is stored on the indicator as either `#RRGGBB` (alpha 1) or
// `rgba(r,g,b,a)`. The Style tab needs hex (for <input type="color">, which
// rejects rgba and silently snaps to #000000) and alpha SEPARATELY — so we parse
// the stored color → {hex, alpha} exactly once (on load, in lineDefs) and
// recombine to rgba only when applying/persisting (lineOverrides). Scoped to the
// two shapes we emit; not a general CSS-color parser.
export function parseColor(c: string): { hex: string; alpha: number } {
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return { hex, alpha: m[4] != null ? Number(m[4]) : 1 };
  }
  return { hex: /^#[0-9a-f]{6}$/i.test(c) ? c : "#000000", alpha: 1 };
}
export function toColor(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Controlled integer input that stays clearable: committing `floor(Number(v)) || d`
// on every keystroke would snap an emptied field straight back to the default (the
// falsy-zero trap), so keep the raw string as a draft while focused and only commit
// keystrokes that parse; blur drops the draft back to the committed value.
export function IntInput({
  value,
  min,
  max,
  disabled,
  commit,
}: {
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  commit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Math.floor(Number(e.target.value));
        if (e.target.value !== "" && Number.isFinite(n)) commit(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export interface LineDraft {
  key: string; // figure key (vwap/up1/dn1/…) — operations key by this, not row index
  label: string;
  color: string; // hex (#RRGGBB); opacity carried separately
  opacity: number; // 0..1, becomes the rgba alpha on apply
  size: number;
  lineStyle: LineStyleOpt; // solid/dashed/dotted → klinecharts {style, dashedValue}
  visible: boolean; // per-line show/hide (calc-omit via extendData.lineHidden)
}
