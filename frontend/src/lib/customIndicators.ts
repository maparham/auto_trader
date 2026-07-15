// Custom indicators not built into klinecharts (VWAP/AVWAP/EMA/MA/LR/Prev HL/RSI).
// Registered globally (registerIndicator) so they appear in our indicator menu like
// any built-in.
//
// The per-indicator math now lives in ./indicators/*; this module stays the
// assembler + barrel + registration seam so its importers are untouched. It
// re-exports every public symbol from the sub-modules, then reconstructs
// BASE_TEMPLATES from the exported per-type template partials.
import { registerIndicator, type IndicatorTemplate } from "klinecharts";

export * from "./indicators/shared";
export * from "./indicators/ma";
export * from "./indicators/lr";
export * from "./indicators/vwap";
export * from "./indicators/prevHl";
export * from "./indicators/rsi";
export * from "./indicators/sessions";
export * from "./indicators/timeHighlight";
export * from "./indicators/pivots";
export * from "./indicators/pivotBands";
export * from "./indicators/pivotAnalysis";
export * from "./indicators/curveLabels";
export * from "./indicators/slope";

import { EMA_TEMPLATE, MA_TEMPLATE } from "./indicators/ma";
import { LR_TEMPLATE } from "./indicators/lr";
import { VWAP_TEMPLATE, AVWAP_TEMPLATE } from "./indicators/vwap";
import { PREV_HL_TEMPLATE } from "./indicators/prevHl";
import { RSI_TEMPLATE } from "./indicators/rsi";
import { SESSIONS_TEMPLATE, registerSessionsAxis } from "./indicators/sessions";
import { TIME_HIGHLIGHT_TEMPLATE } from "./indicators/timeHighlight";
import { PIVOT_BANDS_TEMPLATE } from "./indicators/pivotBands";
import { PIVOT_ANALYSIS_TEMPLATE } from "./indicators/pivotAnalysis";
import { SLOPE_TEMPLATE, SLOPE_ACCEL_TEMPLATE } from "./indicators/slope";

// Base templates for our custom indicator TYPES, keyed by type. Each is a full
// klinecharts indicator definition MINUS the `name` (the name is assigned per
// instance — either the type itself, or a unique "EMA#abc" id for multi-instance).
// `lib/indicators.ts` clones one of these under a fresh name to add an instance.
export type CustomIndicatorType =
  | "EMA"
  | "MA"
  | "LR"
  | "VWAP"
  | "AVWAP"
  | "PREV_HL"
  | "RSI"
  | "SESSIONS"
  | "TIME_HIGHLIGHT"
  | "PIVOT_BANDS"
  | "PIVOT_ANALYSIS"
  | "SLOPE"
  | "SLOPE_ACCEL";

export const BASE_TEMPLATES: Record<CustomIndicatorType, Omit<IndicatorTemplate, "name">> = {
  EMA: EMA_TEMPLATE,
  MA: MA_TEMPLATE,
  LR: LR_TEMPLATE,
  VWAP: VWAP_TEMPLATE,
  AVWAP: AVWAP_TEMPLATE,
  PREV_HL: PREV_HL_TEMPLATE,
  RSI: RSI_TEMPLATE,
  SESSIONS: SESSIONS_TEMPLATE,
  TIME_HIGHLIGHT: TIME_HIGHLIGHT_TEMPLATE,
  PIVOT_BANDS: PIVOT_BANDS_TEMPLATE,
  PIVOT_ANALYSIS: PIVOT_ANALYSIS_TEMPLATE,
  SLOPE: SLOPE_TEMPLATE,
  SLOPE_ACCEL: SLOPE_ACCEL_TEMPLATE,
};

// Register each base type under its own name (so a single instance can still use
// the bare type name "EMA", and so the type is always resolvable). Per-instance
// clones are registered on demand by lib/indicators.ts (registerInstanceTemplate).
export function registerCustomIndicators(): void {
  registerSessionsAxis();
  for (const [type, tmpl] of Object.entries(BASE_TEMPLATES)) {
    registerIndicator({ ...tmpl, name: type });
  }
}

// Indicators that overlay the price (candle) pane rather than a sub-pane.
export const OVERLAY_INDICATORS = new Set([
  "MA",
  "EMA",
  "SMA",
  "BOLL",
  "BBI",
  "SAR",
  "VWAP",
  "AVWAP",
  "LR",
  "PREV_HL",
  "PIVOT_BANDS",
  "PIVOT_ANALYSIS",
  "TIME_HIGHLIGHT",
]);
