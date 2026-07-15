// Curve-end labels (generic, all indicators)
// ---------------------------------------------------------------------------
// When an indicator is selected or highlighted, a small DOM pill is drawn at the
// right (or left) end of each plotted curve showing that curve's KEY parameter —
// e.g. Prev HL's day-high/low curves get "1d", week gets "1w", a 4-hour rolling
// window gets "4h". The text is per-figure; the position (side + vertical align)
// is configured per instance in the settings modal and lives on extendData under
// the generic `curveLabels` key. Enabled by default.
import {
  PREV_HL_PERIODS,
  prevHlAnchorToInput,
  type PeriodKind,
  type PrevHlExtend,
  type PrevHlRollingUnit,
} from "./prevHl";
import { AVWAP_DEFAULT_BANDS, type AvwapExtend } from "./vwap";
import { maLegendLabel } from "./ma";

export type CurveLabelSide = "right" | "left";
export type CurveLabelAlign = "above" | "center" | "below";

// A pill's placement: which end of the curve it sits past + its vertical align.
export interface CurveLabelPos {
  side?: CurveLabelSide; // which end of the curve the pill sits past (default right)
  align?: CurveLabelAlign; // vertical placement vs the curve end (default center)
}

interface CurveLabelConfig {
  // Default-ON: treat absent as enabled, but an explicit false must persist (the
  // rehydrate guard in the settings modal writes false rather than deleting).
  enabled?: boolean;
  // When true, labels stay visible permanently; otherwise (default) they show only
  // while the indicator is selected or highlighted (hover/legend).
  always?: boolean;
  // Position is configured SEPARATELY for the High curves and the Low curves, so a
  // user can e.g. put High labels above-right and Low labels below-right.
  high?: CurveLabelPos;
  low?: CurveLabelPos;
  // LEGACY flat fields (pre-split). Read-only back-compat: an old config with a
  // single side/align seeds BOTH high and low. New saves use high/low only.
  side?: CurveLabelSide;
  align?: CurveLabelAlign;
}

export interface ResolvedCurveLabels {
  enabled: boolean;
  always: boolean;
  high: Required<CurveLabelPos>;
  low: Required<CurveLabelPos>;
}

// Read the curve-label config off any indicator's extendData with defaults applied.
// A legacy flat side/align seeds both high and low (so older saved instances keep
// their look); otherwise each defaults to right/center.
export function curveLabelConfig(extendData: unknown): ResolvedCurveLabels {
  const c = (extendData as { curveLabels?: CurveLabelConfig } | undefined)?.curveLabels ?? {};
  const resolve = (pos: CurveLabelPos | undefined): Required<CurveLabelPos> => ({
    side: pos?.side ?? c.side ?? "right",
    align: pos?.align ?? c.align ?? "center",
  });
  return {
    enabled: c.enabled ?? true,
    always: c.always ?? false,
    high: resolve(c.high),
    low: resolve(c.low),
  };
}

// Which placement (high vs low) a figure uses, by its key convention (…High/…Low).
// Indicators without a Low curve fall through to the high placement.
export function curveLabelPosFor(cfg: ResolvedCurveLabels, figKey: string): Required<CurveLabelPos> {
  return /low$/i.test(figKey) ? cfg.low : cfg.high;
}

// Abbreviate a rolling unit, matching the chart's own interval buttons (1m / 4H /
// 3D / 1W — lowercase minute, uppercase H/D/W). "bars" has no interval button, so
// "bar" reads clearest.
const ROLLING_UNIT_ABBR: Record<PrevHlRollingUnit, string> = {
  minute: "m",
  hour: "H",
  day: "D",
  week: "W",
  bars: "bar",
};

// Per-FIGURE key parameter, as a readable tag (e.g. "3D range low", "EMA 20",
// "AVWAP +1σ"). Returns null for figures/indicators that have no meaningful
// per-curve parameter (no pill drawn). This is the one generic seam: a switch on
// indType, each indicator contributing its own mapping. `calcParams` carries the
// per-instance lengths/multipliers (length in [0], mult in [1] where applicable).
export function curveLabel(
  indType: string,
  figKey: string,
  extendData: unknown,
  calcParams?: unknown[],
): string | null {
  switch (indType) {
    case "PREV_HL":
      return prevHlCurveLabel(figKey, extendData as PrevHlExtend);
    case "EMA":
      return maCurveLabel("EMA", figKey, extendData, calcParams);
    case "MA":
      return maCurveLabel("MA", figKey, extendData, calcParams);
    case "LR":
      return lrCurveLabel(figKey, calcParams);
    case "VWAP":
      return figKey === "vwap" ? "VWAP" : null;
    case "AVWAP":
      return avwapCurveLabel(figKey, extendData as AvwapExtend);
    case "RSI":
      return figKey === "rsi" ? `RSI ${maLen(calcParams, 14)}` : null;
    // klinecharts built-in overlays (no extendData beyond indType). Figure keys are
    // klinecharts' own; lengths in calcParams[0]. None end in "low" → high slot.
    case "SMA":
      return figKey === "sma" ? `SMA ${maLen(calcParams, 12)}` : null;
    case "BBI":
      // BBI averages four periods (3/6/12/24) — too many to spell out, so just "BBI".
      return figKey === "bbi" ? "BBI" : null;
    case "BOLL":
      return bollCurveLabel(figKey, calcParams);
    case "PIVOT_BANDS":
    case "PIVOT_ANALYSIS":
      // Two curves, already distinguished by side; the pill just names each. The
      // Δ%/Δt figures are operand-only (no plotted curve) → no pill.
      if (figKey === "pivotHigh") return "Pivot High";
      if (figKey === "pivotLow") return "Pivot Low";
      return null;
    default:
      return null;
  }
}

// BOLL (Bollinger Bands): basis "BOLL 20"; the ±mult·σ bands as "BOLL 20 upper"/"lower".
function bollCurveLabel(figKey: string, calcParams?: unknown[]): string | null {
  const base = `BOLL ${maLen(calcParams, 20)}`;
  switch (figKey) {
    case "mid":
      return base;
    case "up":
      return `${base} upper`;
    case "dn":
      return `${base} lower`;
    default:
      return null;
  }
}

// Pull a positive integer length/param from calcParams[i], falling back to `def`.
function maLen(calcParams: unknown[] | undefined, def: number, i = 0): number {
  const n = Number(calcParams?.[i]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

// EMA/MA: base line gets "EMA 20"; the separate smoothing MA gets "EMA 20 MA".
// (The smoothing line only produces coords when smoothing is on, so a "none"
// smoothing never reaches here.) The pill follows the legend rule: a flipped
// instance (Type set to VWMA/EVWMA/…) shows that kind's label, an untouched one
// keeps its template label ("EMA"/"MA"). Default length is the template's own.
function maCurveLabel(
  type: "EMA" | "MA",
  figKey: string,
  extendData: unknown,
  calcParams?: unknown[],
): string | null {
  const templateKind = type === "EMA" ? "ema" : "sma";
  const maType = (extendData as { maType?: unknown } | undefined)?.maType;
  const label = maLegendLabel(maType, templateKind);
  const base = `${label} ${maLen(calcParams, type === "EMA" ? 9 : 20)}`;
  if (figKey === "ma") return base;
  if (figKey === "smoothingMa") return `${base} MA`;
  return null;
}

// LR: regression line "LR 100"; the ±mult·σ channel lines as "LR 100 upper"/"lower".
function lrCurveLabel(figKey: string, calcParams?: unknown[]): string | null {
  const base = `LR ${maLen(calcParams, 100)}`;
  switch (figKey) {
    case "lr":
      return base;
    case "up":
      return `${base} upper`;
    case "dn":
      return `${base} lower`;
    default:
      return null;
  }
}

// AVWAP: value line "AVWAP"; each band line "AVWAP ±Nσ" (or "±N%" in percentage
// mode), N being that band's multiplier from extendData.bands.
function avwapCurveLabel(figKey: string, ext: AvwapExtend): string | null {
  if (figKey === "vwap") return "AVWAP";
  const m = /^(up|dn)([123])$/.exec(figKey);
  if (!m) return null;
  const bands = ext.bands ?? AVWAP_DEFAULT_BANDS;
  const band = bands[Number(m[2]) - 1];
  const mult = band?.mult ?? Number(m[2]);
  const unit = ext.bandMode === "percentage" ? "%" : "σ";
  return `AVWAP ${m[1] === "up" ? "+" : "−"}${mult}${unit}`;
}

// Prev HL: each curve's tag spells out its kind + lookback + which extreme — e.g.
// "3D range low" (low of a 3-day rolling window), "prev 1D high" (previous day's
// high), "prev 2W low", "since 02-01 high" (anchored). The kind/length is shared by
// the boundary's High/Low pair; the trailing "high"/"low" comes from the figure key.
function prevHlCurveLabel(figKey: string, ext: PrevHlExtend): string | null {
  const lengths = ext.lengths ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  const count = (k: PeriodKind) => Math.max(1, Math.floor(lengths[k] ?? 1));
  const p = PREV_HL_PERIODS.find((x) => x.hi === figKey || x.lo === figKey);
  if (!p) return null;
  const side = p.hi === figKey ? "high" : "low";
  let base: string;
  switch (p.kind) {
    case "rolling":
      base = `${count("rolling")}${ROLLING_UNIT_ABBR[rollingUnit]} range`;
      break;
    case "day":
      base = `prev ${count("day")}D`;
      break;
    case "week":
      base = `prev ${count("week")}W`;
      break;
    case "anchor": {
      const ts = Number(ext.anchorTs) || 0;
      if (ts <= 0) return null;
      // Month-day of the anchor (the curve runs from that date); keep it compact.
      base = `since ${prevHlAnchorToInput(ts, ext.tz).slice(5, 10)}`;
      break;
    }
    default:
      return null;
  }
  return `${base} ${side}`;
}
