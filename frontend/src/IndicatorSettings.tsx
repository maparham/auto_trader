// TradingView-style per-indicator settings modal, opened from the indicator
// legend's gear icon (ChartCore's OnTooltipIconClick -> indicatorSettingsRequest
// -> App mounts this). Reads the live indicator via getIndicatorByPaneId and
// writes changes back with overrideIndicator. Three tabs mirror TV:
//   Inputs     — for our TV-style EMA/MA: Length, Source, Offset, Smoothing and
//                the Calculation group (Timeframe = multi-timeframe). For every
//                other indicator: its numeric calcParams (labeled via
//                indicatorMeta), with a disabled Timeframe placeholder.
//   Style      — per-line color + thickness
//   Visibility — whether the indicator is drawn
//
// Edits preview live on the chart; Cancel/Escape restores the opening snapshot.

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { Chart, Indicator } from "klinecharts";
import {
  resolveInputs,
  isMovingAverage,
  PRICE_SOURCES,
  SMOOTHING_TYPES,
} from "./lib/indicatorMeta";
import { applyMaTimeframe } from "./lib/mtfCoordinator";
import type {
  MaExtend,
  AvwapExtend,
  BandMode,
  BandSetting,
  PrevHlAgg,
  RsiExtend,
  RsiDivergenceConfig,
  RsiSmoothing,
  RsiSmoothType,
  RsiStyle,
  RsiElement,
} from "./lib/customIndicators";
import {
  AVWAP_DEFAULT_BANDS,
  RSI_DIVERGENCE_DEFAULTS,
  RSI_SMOOTHING_DEFAULTS,
  RSI_STYLE_DEFAULTS,
  indTypeOf,
  prevHlAnchorToInput,
  prevHlInputToAnchor,
} from "./lib/customIndicators";
import { PERIODS, RESOLUTION_SECONDS } from "./lib/feed";
import { TIMEZONES, offsetLabel } from "./lib/timezones";
import {
  saveIndicatorConfig,
  loadIndicatorConfigs,
  loadIndicatorDefault,
  saveIndicatorDefault,
  clearIndicatorDefault,
  loadIndicatorPresets,
  saveIndicatorPreset,
  deleteIndicatorPreset,
  type SavedIndicatorConfig,
} from "./lib/persist";
import { applyIndicator, removeIndicatorById } from "./lib/indicators";
import { toast } from "./lib/notify";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import InfoTip from "./InfoTip";
import ColorLineStylePicker, { type LineStyleOpt } from "./ColorLineStylePicker";
import { toKLineStyle, fromKLineStyle } from "./lib/lineStyle";

interface Props {
  chart: Chart;
  // The focused cell's storage scope — per-indicator config is stored per cell.
  scope: string;
  epic: string;
  chartResolution: string;
  paneId: string;
  name: string;
  onClose: () => void;
}

type Tab = "inputs" | "style" | "visibility";

const DEFAULT_LINE_PALETTE = ["#FF9600", "#935EBD", "#2962ff", "#E11D74", "#01C5C4"];

// Line-style options for the RSI band / MA selectors (canvas-drawn elements).
type RsiLineStyleOpt = "solid" | "dashed" | "dotted";
type RsiHiddenKey = RsiElement;

// RSI "Smoothing" MA types, mirroring TradingView's RSI panel dropdown.
const RSI_SMOOTHING_OPTIONS: { value: RsiSmoothType; label: string }[] = [
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
type PrevHlKind = "rolling" | "day" | "week" | "anchor";
// Each boundary has a `tip` explaining what its High/Low lines track.
const PREV_HL_LENGTH_FIELDS: { kind: PrevHlKind; label: string; tip: string }[] = [
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
const PREV_HL_AGG_OPTIONS: { value: PrevHlAgg; label: string; tip: string }[] = [
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
const PREV_HL_ROLLING_UNITS: { value: string; label: string }[] = [
  { value: "bars", label: "bars" },
  { value: "minute", label: "minutes" },
  { value: "hour", label: "hours" },
  { value: "day", label: "days" },
  { value: "week", label: "weeks" },
];
// Whether the rolling time-span counts closed-market time (time units only).
const PREV_HL_GAP_OPTIONS: { value: "trading" | "wallclock"; label: string; tip: string }[] = [
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
const PREV_HL_STYLE_PAIRS: { kind: PrevHlKind; label: string; hiKey: string; loKey: string }[] = [
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
function parseColor(c: string): { hex: string; alpha: number } {
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return { hex, alpha: m[4] != null ? Number(m[4]) : 1 };
  }
  return { hex: /^#[0-9a-f]{6}$/i.test(c) ? c : "#000000", alpha: 1 };
}
function toColor(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface LineDraft {
  key: string; // figure key (vwap/up1/dn1/…) — operations key by this, not row index
  label: string;
  color: string; // hex (#RRGGBB); opacity carried separately
  opacity: number; // 0..1, becomes the rgba alpha on apply
  size: number;
  lineStyle: LineStyleOpt; // solid/dashed/dotted → klinecharts {style, dashedValue}
  visible: boolean; // per-line show/hide (calc-omit via extendData.lineHidden)
}

export default function IndicatorSettings({
  chart,
  scope,
  epic,
  chartResolution,
  paneId,
  name,
  onClose,
}: Props) {
  const ind = useMemo(
    () => chart.getIndicatorByPaneId(paneId, name) as Indicator | null,
    [chart, paneId, name],
  );
  // `name` is the instance id (klinecharts name, e.g. "EMA#a1b2"); the real TYPE
  // (EMA/MA/AVWAP/…) drives which input panels show. Resolve it from extendData.
  const type = ind ? indTypeOf(ind) : name;
  const isMa = isMovingAverage(type);
  const isAvwap = type === "AVWAP";
  const isRsi = type === "RSI";
  // Overlay indicators with a multi-line channel get per-line show/hide checkboxes
  // (+ opacity) in the Style tab, like TradingView's band toggles.
  const hasLineToggle = isAvwap || type === "LR" || type === "PREV_HL";

  // Snapshot the original state once, for an exact revert on Cancel/Escape.
  const original = useRef({
    calcParams: ((ind?.calcParams ?? []) as unknown[]).map((v) => Number(v)),
    visible: ind?.visible ?? true,
    styles: ind?.styles ?? null,
    extendData: (ind?.extendData ?? null) as MaExtend | null,
  });

  const [tab, setTab] = useState<Tab>("inputs");
  const drag = useDraggable();
  const [calcParams, setCalcParams] = useState<number[]>(original.current.calcParams);
  const [visible, setVisible] = useState<boolean>(original.current.visible);
  const [showValue, setShowValue] = useState<boolean>(
    !(original.current.extendData as { hideLegendValue?: boolean } | null)?.hideLegendValue,
  );

  // --- RSI divergence config (extendData.divergence), OFF by default ---
  const rsiExt0 = (ind?.extendData ?? {}) as RsiExtend;
  const [rsiDiv, setRsiDiv] = useState<RsiDivergenceConfig>(() => ({
    ...RSI_DIVERGENCE_DEFAULTS,
    ...(rsiExt0.divergence ?? {}),
  }));
  // Write a divergence-config patch onto extendData (merging live extendData to
  // preserve indType) and let calc re-run so the markers update immediately.
  // Persistence is handled by the snapshot effect (keyed on rsiDiv).
  function setRsiDivergence(patch: Partial<RsiDivergenceConfig>) {
    const next = { ...rsiDiv, ...patch };
    setRsiDiv(next);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      { name, extendData: { ...((live?.extendData as object) ?? {}), divergence: next } },
      paneId,
    );
  }

  // --- RSI source (price the RSI is computed on) + smoothing MA (extendData) ---
  const [rsiSource, setRsiSource] = useState<string>(rsiExt0.source ?? "close");
  const [rsiSmooth, setRsiSmooth] = useState<RsiSmoothing>(() => ({
    ...RSI_SMOOTHING_DEFAULTS,
    ...(rsiExt0.smoothing ?? {}),
  }));
  // Write a source/smoothing patch onto extendData (merging live extendData to
  // preserve indType + divergence) and recompute. Persisted by the snapshot effect.
  function setRsiExtend(patch: { source?: string; smoothing?: RsiSmoothing }) {
    if (patch.source !== undefined) setRsiSource(patch.source);
    if (patch.smoothing !== undefined) setRsiSmooth(patch.smoothing);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as RsiExtend;
    if (patch.source !== undefined) ext.source = patch.source as RsiExtend["source"];
    if (patch.smoothing !== undefined) ext.smoothing = patch.smoothing;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  // --- RSI Style-tab colours/levels (extendData.style), resolved over defaults ---
  const [rsiStyle, setRsiStyle] = useState<RsiStyle>(() => {
    const s = (rsiExt0.style ?? {}) as Partial<RsiStyle>;
    return {
      ...RSI_STYLE_DEFAULTS,
      ...s,
      upper: { ...RSI_STYLE_DEFAULTS.upper, ...s.upper },
      middle: { ...RSI_STYLE_DEFAULTS.middle, ...s.middle },
      lower: { ...RSI_STYLE_DEFAULTS.lower, ...s.lower },
    };
  });
  function setRsiStylePatch(patch: Partial<RsiStyle>) {
    const next: RsiStyle = {
      ...rsiStyle,
      ...patch,
      upper: { ...rsiStyle.upper, ...patch.upper },
      middle: { ...rsiStyle.middle, ...patch.middle },
      lower: { ...rsiStyle.lower, ...patch.lower },
    };
    setRsiStyle(next);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      { name, extendData: { ...((live?.extendData as object) ?? {}), style: next } },
      paneId,
    );
  }

  // --- Moving-average (EMA/MA) inputs, sourced from calcParams + extendData ---
  const ext0 = (ind?.extendData ?? {}) as MaExtend;
  const [maLength, setMaLength] = useState<number>(original.current.calcParams[0] ?? (type === "EMA" ? 9 : 20));
  const [source, setSource] = useState<string>(ext0.source ?? "close");
  const [offset, setOffset] = useState<number>(ext0.offset ?? 0);
  const [smoothType, setSmoothType] = useState<string>(ext0.smoothing?.type ?? "none");
  const [smoothLen, setSmoothLen] = useState<number>(ext0.smoothing?.length ?? 9);
  const [timeframe, setTimeframe] = useState<string>(ext0.mtf?.timeframe ?? "chart");

  // --- AVWAP inputs (source + bands), sourced from extendData (AvwapExtend) ---
  const avwapExt0 = (ind?.extendData ?? {}) as AvwapExtend;
  const [avwapSource, setAvwapSource] = useState<string>(avwapExt0.source ?? "hlc3");
  const [bandMode, setBandMode] = useState<BandMode>(avwapExt0.bandMode ?? "stdev");
  const [bands, setBands] = useState<[BandSetting, BandSetting, BandSetting]>(
    avwapExt0.bands ?? AVWAP_DEFAULT_BANDS,
  );

  // --- PREV_HL: per-instance timezone override + per-boundary length/agg (Inputs) ---
  // "chart" = follow the global chart axis zone; an IANA name buckets this
  // instance's day/week boundaries in that zone (extendData.tz). Lengths and
  // aggregation functions are per boundary (rolling/day/week); the rolling boundary
  // also carries a unit (bars/minute/hour/day/week) and a gap mode.
  const prevHlExt0 = (ind?.extendData ?? {}) as {
    tz?: string;
    lengths?: Partial<Record<PrevHlKind, number>>;
    aggs?: Partial<Record<PrevHlKind, PrevHlAgg>>;
    rollingUnit?: string;
    gapMode?: "trading" | "wallclock";
    anchorTs?: number;
  };
  const [prevHlTz, setPrevHlTz] = useState<string>(prevHlExt0.tz ?? "chart");
  // anchor uses no length/agg (always max/min since its timestamp) — its record
  // entries are unused placeholders so the maps stay keyed by PrevHlKind.
  const [prevHlLengths, setPrevHlLengths] = useState<Record<PrevHlKind, number>>(() => ({
    rolling: prevHlExt0.lengths?.rolling ?? 1,
    day: prevHlExt0.lengths?.day ?? 1,
    week: prevHlExt0.lengths?.week ?? 1,
    anchor: 1,
  }));
  const [prevHlAggs, setPrevHlAggs] = useState<Record<PrevHlKind, PrevHlAgg>>(() => ({
    rolling: prevHlExt0.aggs?.rolling ?? "extreme",
    day: prevHlExt0.aggs?.day ?? "extreme",
    week: prevHlExt0.aggs?.week ?? "extreme",
    anchor: "extreme",
  }));
  const [prevHlRollingUnit, setPrevHlRollingUnit] = useState<string>(
    prevHlExt0.rollingUnit ?? "hour",
  );
  const [prevHlGapMode, setPrevHlGapMode] = useState<"trading" | "wallclock">(
    prevHlExt0.gapMode ?? "trading",
  );
  // Anchor timestamp (epoch ms; 0 = unplaced). The Inputs row shows it as a
  // datetime-local in the instance's timezone.
  const [prevHlAnchorTs, setPrevHlAnchorTs] = useState<number>(
    Number(prevHlExt0.anchorTs) || 0,
  );

  const inputs = resolveInputs(type, ind?.calcParams as unknown[] | undefined);

  // --- Generic extendData inputs (e.g. LR's Source select) ---
  // For non-MA/non-AVWAP indicators whose meta declares `source:"extend"` inputs,
  // hold each field's value here and write it onto extendData on change.
  const genExt0 = (ind?.extendData ?? {}) as Record<string, unknown>;
  const [genExtend, setGenExtend] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const inp of inputs) {
      if (inp.source === "extend" && inp.field) {
        init[inp.field] = genExt0[inp.field] ?? inp.default;
      }
    }
    return init;
  });
  function setExtendInput(field: string, value: unknown) {
    const next = { ...genExtend, [field]: value };
    setGenExtend(next);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      { name, extendData: { ...((live?.extendData as object) ?? {}), ...next } },
      paneId,
    );
  }

  // PREV_HL timezone override: write extendData.tz and let calc re-bucket. "chart"
  // stores no tz (omit the key) so the instance follows the global chart zone.
  // Merges live extendData to preserve lineHidden / indType. Persistence is handled
  // by the snapshot effect (keyed on prevHlTz).
  function setPrevHlTimezone(tz: string) {
    setPrevHlTz(tz);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as { tz?: string };
    if (tz === "chart") delete ext.tz;
    else ext.tz = tz;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  // PREV_HL lookback length for one boundary: write extendData.lengths and let calc
  // re-aggregate. A length of 1 (the default) is omitted from the stored map so a
  // default-everywhere instance carries no `lengths` key. Merges live extendData.
  function setPrevHlLength(kind: PrevHlKind, value: number) {
    const v = Math.max(1, Math.floor(value || 1));
    const nextLengths = { ...prevHlLengths, [kind]: v };
    setPrevHlLengths(nextLengths);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as {
      lengths?: Partial<Record<PrevHlKind, number>>;
    };
    const lengths: Partial<Record<PrevHlKind, number>> = {};
    for (const f of PREV_HL_LENGTH_FIELDS) {
      if (nextLengths[f.kind] > 1) lengths[f.kind] = nextLengths[f.kind];
    }
    if (Object.keys(lengths).length) ext.lengths = lengths;
    else delete ext.lengths;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  // PREV_HL aggregation function for one boundary: write extendData.aggs and let
  // calc re-aggregate. "extreme" (the default) is omitted so a default instance
  // carries no `aggs` key. Merges live extendData to preserve lengths/tz/lineHidden.
  function setPrevHlAgg(kind: PrevHlKind, fn: PrevHlAgg) {
    const nextAggs = { ...prevHlAggs, [kind]: fn };
    setPrevHlAggs(nextAggs);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as {
      aggs?: Partial<Record<PrevHlKind, PrevHlAgg>>;
    };
    const aggs: Partial<Record<PrevHlKind, PrevHlAgg>> = {};
    for (const f of PREV_HL_LENGTH_FIELDS) {
      if (nextAggs[f.kind] !== "extreme") aggs[f.kind] = nextAggs[f.kind];
    }
    if (Object.keys(aggs).length) ext.aggs = aggs;
    else delete ext.aggs;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  // PREV_HL rolling unit (bars/minute/hour/day/week) and gap mode (trading/wallclock):
  // write onto extendData and recompute. Defaults ("hour"/"trading") are omitted. Both
  // share this writer so the merge logic stays in one place.
  function setPrevHlRolling(next: { unit?: string; gap?: "trading" | "wallclock" }) {
    const unit = next.unit ?? prevHlRollingUnit;
    const gap = next.gap ?? prevHlGapMode;
    if (next.unit) setPrevHlRollingUnit(next.unit);
    if (next.gap) setPrevHlGapMode(next.gap);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as {
      rollingUnit?: string;
      gapMode?: "trading" | "wallclock";
    };
    if (unit !== "hour") ext.rollingUnit = unit;
    else delete ext.rollingUnit;
    if (gap !== "trading") ext.gapMode = gap;
    else delete ext.gapMode;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  // PREV_HL anchor: parse the typed datetime-local (in the instance's timezone) to an
  // epoch ms and write extendData.anchorTs. Empty clears it (unplaced → no line).
  function setPrevHlAnchorInput(input: string) {
    const ts = prevHlInputToAnchor(input, prevHlTz === "chart" ? undefined : prevHlTz);
    setPrevHlAnchorTs(ts);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as { anchorTs?: number };
    if (ts > 0) ext.anchorTs = ts;
    else delete ext.anchorTs;
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  // Only timeframes strictly higher than the chart's qualify for MTF.
  const chartSecs = RESOLUTION_SECONDS[chartResolution] ?? 0;
  const higherTimeframes = PERIODS.filter(
    (p) => (RESOLUTION_SECONDS[p.resolution] ?? 0) > chartSecs,
  );

  // Line-type figures, paired with their effective default colors so the Style
  // tab shows the colors actually on screen even when nothing's been overridden.
  const lineDefs = useMemo<LineDraft[]>(() => {
    const figures = (ind?.figures ?? []).filter((f) => f.type === "line");
    const globalLines = chart.getStyles().indicator?.lines ?? [];
    const overrides = ind?.styles?.lines ?? [];
    // Friendly Style-tab labels for AVWAP's otherwise-untitled band figures
    // (TradingView wording: VWAP, then Lower/Upper band #N).
    const AVWAP_LINE_LABELS: Record<string, string> = {
      vwap: "VWAP",
      up1: "Upper band #1",
      dn1: "Lower band #1",
      up2: "Upper band #2",
      dn2: "Lower band #2",
      up3: "Upper band #3",
      dn3: "Lower band #3",
    };
    // Previous-period H/L lines carry no figure title (so the lines don't flood
    // the legend), so the Style tab names them here — the rolling/day/week
    // H/L rows the user toggles individually.
    const PREV_HL_LINE_LABELS: Record<string, string> = {
      rollingHigh: "Range High",
      rollingLow: "Range Low",
      dayHigh: "Day High",
      dayLow: "Day Low",
      weekHigh: "Week High",
      weekLow: "Week Low",
      anchorHigh: "Anchor High",
      anchorLow: "Anchor Low",
    };
    const hidden = (ind?.extendData as { lineHidden?: Record<string, boolean> } | undefined)?.lineHidden ?? {};
    return figures.map((f, i) => {
      const label =
        (isAvwap && AVWAP_LINE_LABELS[f.key]) ||
        (type === "PREV_HL" && PREV_HL_LINE_LABELS[f.key]) ||
        (f.title || f.key || `Line ${i + 1}`).replace(/:\s*$/, "");
      const raw =
        overrides[i]?.color ??
        globalLines[i % (globalLines.length || 1)]?.color ??
        DEFAULT_LINE_PALETTE[i % DEFAULT_LINE_PALETTE.length];
      const { hex, alpha } = parseColor(raw);
      const size = overrides[i]?.size ?? globalLines[i]?.size ?? 1;
      // Recover the dash style from whichever full style is in effect (override,
      // else this figure's own default), so the picker opens on the real style.
      const styleSrc = overrides[i] ?? globalLines[i % (globalLines.length || 1)];
      const lineStyle = fromKLineStyle(styleSrc?.style, styleSrc?.dashedValue);
      return { key: f.key, label, color: hex, opacity: alpha, size, lineStyle, visible: !hidden[f.key] };
    });
  }, [ind, chart, isAvwap, type]);
  const [lines, setLines] = useState<LineDraft[]>(lineDefs);
  // Whether to PERSIST line styles. We must NOT freeze styles just because the
  // modal was opened — that would pin the current defaults and stop registration
  // default changes (e.g. AVWAP band colors) from ever taking effect. So persist
  // styles only when the user actually edits a line (setLine), OR when custom
  // styles were already saved (so reopening without editing never wipes them).
  const linesEdited = useRef<boolean>(loadIndicatorConfigs(scope)[name]?.styles != null);

  // Build FULL line-style overrides by merging {color,size} onto the line's
  // existing FULL style. klinecharts stores indicator.styles as-is (no merge with
  // defaults) and its line drawer reads dashedValue[0]/style/smooth — a partial
  // {color,size} override leaves those undefined and crashes the draw. We base
  // each entry on the indicator's OWN current per-figure style (so a dashed band
  // stays dashed — AVWAP's band lines), falling back to the global default line
  // style only when the indicator has no per-figure style. Applies to the live
  // override AND the persisted snapshot so a restored line never crashes.
  function lineOverrides(ls: LineDraft[]) {
    const globalDefaults = chart.getStyles().indicator?.lines ?? [];
    const indLines = ind?.styles?.lines ?? [];
    return ls.map((l, i) => ({
      ...(globalDefaults[i % (globalDefaults.length || 1)] ?? {}),
      ...(indLines[i] ?? {}), // preserve this figure's own smooth/etc.
      color: toColor(l.color, l.opacity), // recombine hex + opacity → #hex or rgba
      size: l.size,
      ...toKLineStyle(l.lineStyle), // solid/dashed/dotted → {style, dashedValue}
    }));
  }

  // Build the full persisted settings snapshot from the modal's current state.
  // AVWAP's anchor (calcParams[0]) is per-epic, so it's excluded here. Only config
  // goes into extendData — never the bulky computed MTF series.
  function currentConfig(): SavedIndicatorConfig {
    const extendData: Record<string, unknown> = {};
    if (isMa) {
      extendData.source = source;
      extendData.offset = offset;
      if (smoothType !== "none") extendData.smoothing = { type: smoothType, length: smoothLen };
      if (timeframe !== "chart") extendData.mtf = { timeframe };
    }
    if (isAvwap) {
      extendData.source = avwapSource;
      extendData.bandMode = bandMode;
      extendData.bands = bands;
    }
    if (!isMa) {
      // Generic extendData inputs (e.g. LR's Source). For AVWAP, source is set
      // above; this also catches any future extend-input indicators.
      Object.assign(extendData, genExtend);
    }
    if (type === "PREV_HL" && prevHlTz !== "chart") {
      // Per-instance timezone override; "chart" follows the global zone (no key).
      extendData.tz = prevHlTz;
    }
    if (type === "PREV_HL") {
      // Per-boundary lookback lengths + agg functions; only store non-defaults
      // (length > 1, agg !== "extreme") so a default instance carries neither key.
      const lengths: Partial<Record<PrevHlKind, number>> = {};
      const aggs: Partial<Record<PrevHlKind, PrevHlAgg>> = {};
      for (const f of PREV_HL_LENGTH_FIELDS) {
        if (prevHlLengths[f.kind] > 1) lengths[f.kind] = prevHlLengths[f.kind];
        if (prevHlAggs[f.kind] !== "extreme") aggs[f.kind] = prevHlAggs[f.kind];
      }
      if (Object.keys(lengths).length) extendData.lengths = lengths;
      if (Object.keys(aggs).length) extendData.aggs = aggs;
      // Rolling unit + gap mode (non-default only).
      if (prevHlRollingUnit !== "hour") extendData.rollingUnit = prevHlRollingUnit;
      if (prevHlGapMode !== "trading") extendData.gapMode = prevHlGapMode;
      // Anchor timestamp (epoch ms); omitted when unplaced.
      if (prevHlAnchorTs > 0) extendData.anchorTs = prevHlAnchorTs;
    }
    if (isAvwap || !isMa) {
      // Per-line visibility (Style tab) → only the hidden lines, by figure key.
      const lineHidden: Record<string, boolean> = {};
      for (const l of lines) if (!l.visible) lineHidden[l.key] = true;
      if (Object.keys(lineHidden).length) extendData.lineHidden = lineHidden;
    }
    if (type === "RSI") {
      // Source + smoothing + divergence: only persist each when it differs from the
      // defaults, so a plain RSI carries no extra keys.
      if (rsiSource !== "close") extendData.source = rsiSource;
      if (rsiSmooth.type !== "none") extendData.smoothing = rsiSmooth;
      const isDefault = (Object.keys(RSI_DIVERGENCE_DEFAULTS) as Array<keyof RsiDivergenceConfig>).every(
        (k) => rsiDiv[k] === RSI_DIVERGENCE_DEFAULTS[k],
      );
      if (!isDefault) extendData.divergence = rsiDiv;
      if (JSON.stringify(rsiStyle) !== JSON.stringify(RSI_STYLE_DEFAULTS)) extendData.style = rsiStyle;
    }
    if (!showValue) extendData.hideLegendValue = true;
    return {
      calcParams: isAvwap ? undefined : isMa ? [maLength] : calcParams,
      visible,
      styles: linesEdited.current && lines.length ? { lines: lineOverrides(lines) } : undefined,
      extendData: Object.keys(extendData).length ? extendData : undefined,
    };
  }

  // Persist the snapshot on every change so all settings survive a reload
  // (Toolbar.createIndicatorOn re-applies it). The first run captures the opening
  // config so Cancel can restore it (edits save eagerly, like the live preview).
  const originalCfg = useRef<SavedIndicatorConfig | null>(null);
  useEffect(() => {
    if (!ind) return;
    const cfg = currentConfig();
    if (originalCfg.current === null) originalCfg.current = cfg;
    saveIndicatorConfig(scope, name, cfg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, visible, showValue, calcParams, maLength, source, offset, smoothType, smoothLen, timeframe, avwapSource, bandMode, bands, lines, genExtend, prevHlTz, prevHlLengths, prevHlAggs, prevHlRollingUnit, prevHlGapMode, prevHlAnchorTs, rsiDiv, rsiSource, rsiSmooth, rsiStyle]);

  // Push a moving-average config (chart-TF or MTF) through the coordinator, which
  // refetches HTF data when a timeframe is set. Reads explicit overrides so it
  // never races setState.
  function applyMa(next: Partial<{
    length: number;
    source: string;
    offset: number;
    smoothType: string;
    smoothLen: number;
    timeframe: string;
  }> = {}) {
    const length = next.length ?? maLength;
    const src = (next.source ?? source) as MaExtend["source"];
    const off = next.offset ?? offset;
    const st = next.smoothType ?? smoothType;
    const sl = next.smoothLen ?? smoothLen;
    const tf = next.timeframe ?? timeframe;
    const options: MaExtend = {
      source: src,
      offset: off,
      smoothing: st === "none" ? undefined : { type: st as "sma" | "ema", length: sl },
    };
    void applyMaTimeframe(
      chart,
      epic,
      name,
      paneId,
      { kind: type === "EMA" ? "ema" : "sma", length, options },
      tf === "chart" ? null : tf,
    );
  }

  // AVWAP source/bands apply: write the config onto extendData and let calc
  // re-run (the generic `apply` only touches calcParams/visible/styles, so it
  // would NOT recompute on a source/band change). Reads explicit overrides so it
  // never races setState, and merges live extendData to preserve hideLegendValue.
  function applyAvwap(
    next: Partial<{
      source: string;
      bandMode: BandMode;
      bands: [BandSetting, BandSetting, BandSetting];
      lineHidden: Record<string, boolean>;
    }> = {},
  ) {
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext: AvwapExtend = {
      ...((live?.extendData as AvwapExtend) ?? {}),
      source: (next.source ?? avwapSource) as AvwapExtend["source"],
      bandMode: next.bandMode ?? bandMode,
      bands: next.bands ?? bands,
      ...(next.lineHidden ? { lineHidden: next.lineHidden } : {}),
    };
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  // Generic (non-MA) calcParam apply.
  function apply(next: { calcParams?: number[]; visible?: boolean; lines?: LineDraft[] }) {
    const cp = next.calcParams ?? calcParams;
    const ls = next.lines ?? lines;
    chart.overrideIndicator(
      {
        name,
        calcParams: cp,
        visible: next.visible ?? visible,
        styles: { lines: lineOverrides(ls) },
      },
      paneId,
    );
  }

  function setParam(index: number, value: number) {
    const nextCp = calcParams.slice();
    nextCp[index] = value;
    setCalcParams(nextCp);
    if (isMa && index === 0) {
      setMaLength(value);
      applyMa({ length: value });
    } else {
      apply({ calcParams: nextCp });
    }
  }

  // Edit a line's STYLE (color/opacity/width), keyed by figure key so the TV
  // display reorder can't corrupt which line is edited. Goes through the styles
  // path (gated by linesEdited).
  function setLine(key: string, patch: Partial<LineDraft>) {
    linesEdited.current = true; // a real edit → now persist styles
    const next = lines.map((l) => (l.key === key ? { ...l, ...patch } : l));
    setLines(next);
    apply({ lines: next });
  }

  // Toggle a line's VISIBILITY (Style tab checkbox). Visibility lives in
  // extendData.lineHidden (calc-omit), NOT styles — so it must go through the
  // AVWAP extendData path and is NOT gated by linesEdited.
  function setLineVisible(key: string, visible: boolean) {
    const next = lines.map((l) => (l.key === key ? { ...l, visible } : l));
    setLines(next);
    const lineHidden: Record<string, boolean> = {};
    for (const l of next) if (!l.visible) lineHidden[l.key] = true;
    if (isAvwap) {
      applyAvwap({ lineHidden });
    } else {
      // Generic: write lineHidden onto extendData and let calc re-run (it omits
      // a hidden figure's key so klinecharts draws nothing). Merge live extend.
      const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
      chart.overrideIndicator(
        { name, extendData: { ...((live?.extendData as object) ?? {}), lineHidden } },
        paneId,
      );
    }
  }

  // PREV_HL: toggle a whole boundary (its High AND Low) from the Inputs-tab row
  // checkbox. Shares the SAME `lines`/lineHidden source of truth as the Style-tab
  // per-line checkboxes, so the two stay in sync. Unchecking hides both lines;
  // checking shows both.
  function setBoundaryVisible(kind: PrevHlKind, visible: boolean) {
    const keys = new Set([`${kind}High`, `${kind}Low`]);
    const next = lines.map((l) => (keys.has(l.key) ? { ...l, visible } : l));
    setLines(next);
    const lineHidden: Record<string, boolean> = {};
    for (const l of next) if (!l.visible) lineHidden[l.key] = true;
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      { name, extendData: { ...((live?.extendData as object) ?? {}), lineHidden } },
      paneId,
    );
  }
  // A boundary is "on" if either of its lines is still visible (so the row
  // checkbox reflects, and re-enables, the boundary as a whole).
  function boundaryActive(kind: PrevHlKind): boolean {
    return lines.some((l) => (l.key === `${kind}High` || l.key === `${kind}Low`) && l.visible);
  }

  function toggleVisible(v: boolean) {
    setVisible(v);
    apply({ visible: v });
  }

  // Show/hide this indicator's value in the legend. Stored on extendData
  // (hideLegendValue), read by the shared legendTooltipSource. Merges with the
  // live extendData so MA/EMA source/offset/MTF settings are preserved.
  // Persistence is handled by the snapshot effect (keyed on showValue).
  function toggleShowValue(show: boolean) {
    setShowValue(show);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}), hideLegendValue: !show };
    chart.overrideIndicator({ name, extendData: ext }, paneId);
  }

  function cancel() {
    // Restore the original snapshot (incl. extendData for MA/MTF), then close.
    chart.overrideIndicator(
      {
        name,
        calcParams: original.current.calcParams,
        visible: original.current.visible,
        styles: original.current.styles ?? { lines: [] },
        extendData: original.current.extendData ?? {},
      },
      paneId,
    );
    // Revert the persisted snapshot too (the effect saved edits eagerly).
    if (originalCfg.current) saveIndicatorConfig(scope, name, originalCfg.current);
    onClose();
  }

  useCloseOnEscape(cancel);

  // --- TradingView-style "Defaults" menu (footer) ----------------------------
  // Global per-TYPE presets: a single default that seeds freshly-added instances,
  // plus named presets applied on demand. Both store the SAME SavedIndicatorConfig
  // currentConfig() produces (see persist.ts). Applying recreates the instance from
  // the chosen config (the established copy/paste mechanism) and closes the modal —
  // reopening reads the fresh live state. We DON'T try to push a config back into the
  // modal's ~12 useState fields.
  const [defOpen, setDefOpen] = useState(false);
  const [naming, setNaming] = useState(false); // inline "Save as preset…" name field
  const [presetName, setPresetName] = useState("");
  const defMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!defOpen) return;
    const onDown = (e: MouseEvent) => {
      if (defMenuRef.current && !defMenuRef.current.contains(e.target as Node)) {
        setDefOpen(false);
        setNaming(false);
      }
    };
    // Capture phase: the modal body calls stopPropagation on mousedown, which
    // would otherwise prevent this document-level listener from ever seeing
    // clicks inside the modal.
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [defOpen]);

  // Recreate THIS instance (same id) from `cfg`, then close. Reuses the same
  // remove+add path as paste; reusing the id keeps its per-cell config key aligned.
  // `cfg === null` resets to the type baseline (no config → BASE_TEMPLATES defaults).
  // `rehydrate: true` so an AVWAP keeps its placed anchor across the recreate (the
  // anchor lives in per-epic storage, NOT in the preset config which is anchorless).
  function applyConfigToOpenInstance(cfg: SavedIndicatorConfig | null) {
    removeIndicatorById(chart, scope, name); // also clears this id's per-cell config
    saveIndicatorConfig(scope, name, cfg ?? {}); // persist the new config for next reload
    applyIndicator(chart, scope, epic, { id: name, type }, { config: cfg ?? {}, rehydrate: true });
    setDefOpen(false);
    onClose();
  }

  function saveAsDefault() {
    saveIndicatorDefault(type, currentConfig());
    setDefOpen(false);
    toast(`Saved ${type} default`);
  }
  function resetToDefault() {
    // Type default if one exists, else the bare type baseline.
    applyConfigToOpenInstance(loadIndicatorDefault(type));
  }
  function commitPreset() {
    const nm = presetName.trim();
    if (!nm) return;
    saveIndicatorPreset(type, nm, currentConfig());
    setNaming(false);
    setPresetName("");
    setDefOpen(false);
    toast(`Saved preset "${nm}"`);
  }
  function applyPreset(nm: string) {
    const cfg = loadIndicatorPresets(type)[nm];
    if (cfg) applyConfigToOpenInstance(cfg);
  }
  function removePreset(nm: string) {
    deleteIndicatorPreset(type, nm);
    // keep the menu open so the user can delete several; force a re-read by toggling
    setDefOpen(false);
    setTimeout(() => setDefOpen(true), 0);
  }

  if (!ind) return null;
  const shortName = ind.shortName || name;

  // Style-tab rows in TradingView display order for AVWAP (VWAP, then Lower/Upper
  // for each band); other indicators keep their figure order.
  const AVWAP_STYLE_ORDER = ["vwap", "dn1", "up1", "dn2", "up2", "dn3", "up3"];
  const styleRows = isAvwap
    ? (AVWAP_STYLE_ORDER.map((k) => lines.find((l) => l.key === k)).filter(Boolean) as LineDraft[])
    : lines;

  return (
    <div className="modal-backdrop modal-backdrop--clear" onMouseDown={cancel}>
      <div
        className={`modal ind-settings${type === "PREV_HL" ? " ind-settings-wide" : ""}`}
        style={drag.style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head" {...drag.handleProps}>
          <strong>{shortName}</strong>
          <button className="modal-close" onClick={cancel} title="Cancel">
            ✕
          </button>
        </div>

        <div className="ind-tabs">
          {(["inputs", "style", "visibility"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`ind-tab ${tab === t ? "on" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "inputs" ? "Inputs" : t === "style" ? "Style" : "Visibility"}
            </button>
          ))}
        </div>

        <div className="ind-body">
          {tab === "inputs" && isMa && (
            <>
              <div className="ind-row">
                <label>Length</label>
                <input
                  type="number"
                  min={1}
                  value={maLength}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setMaLength(v);
                    applyMa({ length: v });
                  }}
                />
              </div>
              <div className="ind-row">
                <label>Source</label>
                <select
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    applyMa({ source: e.target.value });
                  }}
                >
                  {PRICE_SOURCES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ind-row">
                <label>Offset</label>
                <input
                  type="number"
                  step={1}
                  value={offset}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setOffset(v);
                    applyMa({ offset: v });
                  }}
                />
              </div>

              <div className="ind-group">Smoothing</div>
              <div className="ind-row">
                <label>Type</label>
                <select
                  value={smoothType}
                  onChange={(e) => {
                    setSmoothType(e.target.value);
                    applyMa({ smoothType: e.target.value });
                  }}
                >
                  {SMOOTHING_TYPES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {smoothType !== "none" && (
                <div className="ind-row">
                  <label>Length</label>
                  <input
                    type="number"
                    min={1}
                    value={smoothLen}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSmoothLen(v);
                      applyMa({ smoothLen: v });
                    }}
                  />
                </div>
              )}

              <div className="ind-group">Calculation</div>
              <div className="ind-row">
                <label>Timeframe</label>
                <select
                  value={timeframe}
                  onChange={(e) => {
                    setTimeframe(e.target.value);
                    applyMa({ timeframe: e.target.value });
                  }}
                >
                  <option value="chart">Chart</option>
                  {higherTimeframes.map((p) => (
                    <option key={p.resolution} value={p.resolution}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <span className="ind-row-head">
                <label className="ind-check">
                  <input type="checkbox" checked disabled readOnly />
                  <span>Wait for timeframe closes</span>
                </label>
                <InfoTip
                  title="Wait for timeframe closes"
                  text="Uses only closed higher-timeframe bars. No peeking at the current, unfinished bar."
                />
              </span>
            </>
          )}

          {tab === "inputs" && isAvwap && (
            <>
              <div className="ind-group">Bands Settings</div>
              <div className="ind-row">
                <label>Bands Calculation Mode</label>
                <select
                  value={bandMode}
                  onChange={(e) => {
                    const v = e.target.value as BandMode;
                    setBandMode(v);
                    applyAvwap({ bandMode: v });
                  }}
                >
                  <option value="stdev">Standard Deviation</option>
                  <option value="percentage">Percentage</option>
                </select>
              </div>
              {bands.map((b, i) => (
                <div className="ind-row" key={i}>
                  <label className="ind-check ind-check-inline">
                    <input
                      type="checkbox"
                      checked={b.on}
                      onChange={(e) => {
                        const nextB = bands.map((x, j) =>
                          j === i ? { ...x, on: e.target.checked } : x,
                        ) as [BandSetting, BandSetting, BandSetting];
                        setBands(nextB);
                        applyAvwap({ bands: nextB });
                      }}
                    />
                    <span>Bands Multiplier #{i + 1}</span>
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={b.mult}
                    onChange={(e) => {
                      const nextB = bands.map((x, j) =>
                        j === i ? { ...x, mult: Number(e.target.value) } : x,
                      ) as [BandSetting, BandSetting, BandSetting];
                      setBands(nextB);
                      applyAvwap({ bands: nextB });
                    }}
                  />
                </div>
              ))}
              <div className="ind-row">
                <label>Source</label>
                <select
                  value={avwapSource}
                  onChange={(e) => {
                    setAvwapSource(e.target.value);
                    applyAvwap({ source: e.target.value });
                  }}
                >
                  {PRICE_SOURCES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {tab === "inputs" && isRsi && (
            // TradingView-style RSI inputs: length + source, an optional smoothing MA
            // (with Bollinger Bands), and divergence detection.
            <>
              <div className="ind-group">RSI Settings</div>
              <div className="ind-row">
                <label>RSI Length</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={Number.isFinite(calcParams[0]) ? calcParams[0] : ""}
                  onChange={(e) => setParam(0, Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                />
              </div>
              <div className="ind-row">
                <label>Source</label>
                <select value={rsiSource} onChange={(e) => setRsiExtend({ source: e.target.value })}>
                  {PRICE_SOURCES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {/* Matches TradingView's built-in RSI: a single toggle. Pivot lookback
                  (5/5) and range (5–60) are the TV defaults, applied automatically;
                  regular bullish + bearish divergences are marked on the plot. */}
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={rsiDiv.on}
                  onChange={(e) => setRsiDivergence({ on: e.target.checked })}
                />
                <span>Calculate Divergence</span>
                <InfoTip
                  title="Calculate Divergence"
                  text="Marks bullish and bearish RSI divergences on the plot. That's where price makes a new high or low but the RSI does not."
                />
              </label>

              <div className="ind-group">Smoothing</div>
              <div className="ind-row">
                <label>Type</label>
                <select
                  value={rsiSmooth.type}
                  onChange={(e) =>
                    setRsiExtend({ smoothing: { ...rsiSmooth, type: e.target.value as RsiSmoothType } })
                  }
                >
                  {RSI_SMOOTHING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {/* TV always shows Length + BB StdDev, greying each when inapplicable:
                  Length is off when Type is None; BB StdDev only applies to
                  'SMA + Bollinger Bands'. */}
              <div className={`ind-row${rsiSmooth.type === "none" ? " is-off" : ""}`}>
                <label>Length</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={rsiSmooth.length}
                  disabled={rsiSmooth.type === "none"}
                  onChange={(e) =>
                    setRsiExtend({
                      smoothing: { ...rsiSmooth, length: Math.max(1, Math.floor(Number(e.target.value)) || 1) },
                    })
                  }
                />
              </div>
              <div className={`ind-row${rsiSmooth.type === "sma_bb" ? "" : " is-off"}`}>
                <span className="ind-row-head">
                  <label>BB StdDev</label>
                  <InfoTip
                    title="BB StdDev"
                    text="Bollinger Band width in standard deviations. Only used by 'SMA + Bollinger Bands'."
                  />
                </span>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={rsiSmooth.bbStdDev}
                  disabled={rsiSmooth.type !== "sma_bb"}
                  onChange={(e) =>
                    setRsiExtend({
                      smoothing: { ...rsiSmooth, bbStdDev: Math.max(0, Number(e.target.value) || 0) },
                    })
                  }
                />
              </div>

              <div className="ind-group">Calculation</div>
              <div className="ind-row">
                <span className="ind-row-head">
                  <label>Timeframe</label>
                  <InfoTip title="Timeframe" text="Higher-timeframe mode is only on EMA and MA." />
                </span>
                <select value="chart" disabled>
                  <option value="chart">Chart</option>
                </select>
              </div>
            </>
          )}

          {tab === "inputs" && !isMa && !isAvwap && !isRsi && (
            <>
              {inputs.length === 0 && type !== "PREV_HL" && (
                <p className="ind-note">This indicator has no adjustable inputs.</p>
              )}
              {inputs.map((inp) => {
                if (inp.source === "calcParam" && inp.index != null) {
                  return (
                    <div className="ind-row" key={inp.key}>
                      <label>{inp.label}</label>
                      <input
                        type="number"
                        min={inp.min}
                        max={inp.max}
                        step={inp.step ?? 1}
                        value={Number.isFinite(calcParams[inp.index]) ? calcParams[inp.index] : ""}
                        onChange={(e) => setParam(inp.index!, Number(e.target.value))}
                      />
                    </div>
                  );
                }
                if (inp.source === "extend" && inp.field && inp.type === "select") {
                  return (
                    <div className="ind-row" key={inp.key}>
                      <label>{inp.label}</label>
                      <select
                        value={String(genExtend[inp.field] ?? inp.default ?? "")}
                        onChange={(e) => setExtendInput(inp.field!, e.target.value)}
                      >
                        {(inp.options ?? []).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                }
                return null;
              })}
              {type === "PREV_HL" && (
                // Two groups: a single sliding "Rolling range" (the general lookback)
                // and the anchored "Previous period" lines (day/week PDH-PDL).
                (() => {
                  // One row renderer shared by both groups. Checkbox toggles the
                  // boundary's H/L lines; greyed + disabled when off. The rolling row
                  // also shows a unit selector (bars/minutes/hours/days/weeks).
                  const renderRow = (f: (typeof PREV_HL_LENGTH_FIELDS)[number]) => {
                    const on = boundaryActive(f.kind);
                    const aggTip = PREV_HL_AGG_OPTIONS.find((o) => o.value === prevHlAggs[f.kind])?.tip ?? "";
                    const aggLabel = PREV_HL_AGG_OPTIONS.find((o) => o.value === prevHlAggs[f.kind])?.label ?? "";
                    return (
                      <div className={`ind-row${on ? "" : " is-off"}`} key={f.kind}>
                        <span className="ind-row-head">
                          <label className="ind-check ind-check-inline">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) => setBoundaryVisible(f.kind, e.target.checked)}
                            />
                            <span>{f.label}</span>
                          </label>
                          <InfoTip
                            title={f.label}
                            text={[f.tip, `Function (${aggLabel}): ${aggTip}`]}
                          />
                        </span>
                        <div className="ind-line-controls ind-prevhl-controls">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={prevHlLengths[f.kind]}
                            disabled={!on}
                            onChange={(e) => setPrevHlLength(f.kind, Number(e.target.value))}
                          />
                          {f.kind === "rolling" && (
                            <select
                              className="ind-unit-select"
                              value={prevHlRollingUnit}
                              disabled={!on}
                              onChange={(e) => setPrevHlRolling({ unit: e.target.value })}
                            >
                              {PREV_HL_ROLLING_UNITS.map((u) => (
                                <option key={u.value} value={u.value}>
                                  {u.label}
                                </option>
                              ))}
                            </select>
                          )}
                          <select
                            value={prevHlAggs[f.kind]}
                            disabled={!on}
                            onChange={(e) => setPrevHlAgg(f.kind, e.target.value as PrevHlAgg)}
                          >
                            {PREV_HL_AGG_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  };
                  return (
                    <>
                      <div className="ind-group ind-group-head">
                        <span>Rolling range</span>
                        <InfoTip
                          title="Rolling range"
                          text="One sliding window that follows price. Pick the size and the unit. 1 hour = 60 minutes = 4 bars on a 15m chart, all the same line."
                        />
                      </div>
                      {PREV_HL_LENGTH_FIELDS.filter((f) => f.kind === "rolling").map(renderRow)}
                      <div className="ind-group ind-group-head">
                        <span>Previous period</span>
                        <InfoTip
                          title="Previous period"
                          text="High and Low of recent days and weeks. They reset at each new day or week."
                        />
                      </div>
                      {PREV_HL_LENGTH_FIELDS.filter((f) => f.kind !== "rolling").map(renderRow)}
                      <div className="ind-group ind-group-head">
                        <span>Anchored</span>
                        <InfoTip
                          title="Anchored"
                          text="Highest high and lowest low since a date you pick. The lines run from that point to now. Nothing shows before it. The date uses the Timezone below."
                        />
                      </div>
                      {(() => {
                        const on = boundaryActive("anchor");
                        return (
                          <div className={`ind-row${on ? "" : " is-off"}`}>
                            <label className="ind-check ind-check-inline">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) => setBoundaryVisible("anchor", e.target.checked)}
                              />
                              <span>Anchor</span>
                            </label>
                            <input
                              type="datetime-local"
                              className="ind-anchor-input"
                              disabled={!on}
                              value={prevHlAnchorToInput(
                                prevHlAnchorTs,
                                prevHlTz === "chart" ? undefined : prevHlTz,
                              )}
                              onChange={(e) => setPrevHlAnchorInput(e.target.value)}
                            />
                          </div>
                        );
                      })()}
                    </>
                  );
                })()
              )}
              <div className="ind-group">Calculation</div>
              {type === "PREV_HL" ? (
                <>
                  {/* How the rolling time-span treats closed-market time. */}
                  <div className="ind-row">
                    <span className="ind-row-head">
                      <label>Rolling span</label>
                      <InfoTip
                        title="Rolling span"
                        text="How the Range window handles market gaps. Trading time skips them; Wall-clock counts them. Only affects time units, not bars."
                      />
                    </span>
                    <select
                      value={prevHlGapMode}
                      onChange={(e) => setPrevHlRolling({ gap: e.target.value as "trading" | "wallclock" })}
                    >
                      {PREV_HL_GAP_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Timezone decides where the Day/Week boundaries fall. "chart"
                      follows the global axis zone; a specific zone anchors them. */}
                  <div className="ind-row">
                    <span className="ind-row-head">
                      <label>Timezone</label>
                      <InfoTip
                        title="Timezone"
                        text="Sets when a new day or week starts. 'Chart' uses the chart's timezone; or pick a market's zone."
                      />
                    </span>
                    <select
                      className="tz-select"
                      value={prevHlTz}
                      onChange={(e) => setPrevHlTimezone(e.target.value)}
                    >
                      <option value="chart">Chart</option>
                      {TIMEZONES.filter((tz) => tz.value).map((tz) => {
                        const off = offsetLabel(tz.value);
                        return (
                          <option key={tz.value} value={tz.value}>
                            {off ? `${tz.label} ${off}` : tz.label}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </>
              ) : (
                <div className="ind-row">
                  <span className="ind-row-head">
                    <label>Timeframe</label>
                    <InfoTip title="Timeframe" text="Higher-timeframe mode is only on EMA and MA." />
                  </span>
                  <select value="chart" disabled>
                    <option value="chart">Chart</option>
                  </select>
                </div>
              )}
            </>
          )}

          {tab === "style" && (
            <>
              {/* PREV_HL shows a lookback summary in the legend (e.g. "1 day, since …")
                  instead of per-bar values; the toggle controls that. Other indicators
                  toggle their figure values. */}
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={showValue}
                  onChange={(e) => toggleShowValue(e.target.checked)}
                />
                <span>{type === "PREV_HL" ? "Show lookback in legend" : "Show value in legend"}</span>
              </label>
              {/* PREV_HL: pair each boundary's High and Low on ONE row —
                  "Day  High [color][size]  Low [color][size]" — halving the list.
                  The boundary is greyed when deactivated in the Inputs tab. */}
              {type === "PREV_HL" &&
                PREV_HL_STYLE_PAIRS.map((p) => {
                  const hi = lines.find((l) => l.key === p.hiKey);
                  const lo = lines.find((l) => l.key === p.loKey);
                  if (!hi || !lo) return null;
                  const off = !boundaryActive(p.kind);
                  const ctl = (l: LineDraft, side: string) => (
                    <ColorLineStylePicker
                      color={l.color}
                      onColor={(hex) => setLine(l.key, { color: hex })}
                      size={l.size}
                      onSize={(s) => setLine(l.key, { size: s })}
                      lineStyle={l.lineStyle}
                      onLineStyle={(s) => setLine(l.key, { lineStyle: s })}
                      disabled={off}
                      title={`${p.label} ${side} line`}
                    />
                  );
                  const rowTip = off
                    ? `${p.label} is off. Turn it on in the Inputs tab to edit its lines.`
                    : `Colour and thickness of the ${p.label} High and Low lines. Set visibility and lookback in the Inputs tab.`;
                  return (
                    <div
                      className={`ind-row ind-style-row ind-style-pair${off ? " is-off" : ""}`}
                      key={p.kind}
                    >
                      <span className="ind-pair-boundary">
                        {p.label}
                        <InfoTip title={p.label} text={rowTip} />
                      </span>
                      <span className="ind-pair-side">High</span>
                      <div className="ind-line-controls">{ctl(hi, "High")}</div>
                      <span className="ind-pair-side ind-pair-side-lo">Low</span>
                      <div className="ind-line-controls">{ctl(lo, "Low")}</div>
                    </div>
                  );
                })}
              {type !== "PREV_HL" && !isRsi &&
                styleRows.map((l) => {
                // A band line whose multiplier is OFF in the Inputs tab can't draw,
                // so disable (grey) its whole row — TV shows it but it does nothing.
                const bandIdx = isAvwap && l.key !== "vwap" ? Number(l.key.slice(-1)) - 1 : -1;
                const off = bandIdx >= 0 && !bands[bandIdx]?.on;
                return (
                  <div className={`ind-row ind-style-row${off ? " is-off" : ""}`} key={l.key}>
                    {/* PREV_HL activates each boundary (both lines) from the Inputs
                        tab, so the Style tab shows no per-line checkbox here — just a
                        plain label. AVWAP/LR keep their per-line show/hide checkbox. */}
                    <span className="ind-row-head">
                      {hasLineToggle && type !== "PREV_HL" ? (
                        <label className="ind-check ind-check-inline">
                          <input
                            type="checkbox"
                            checked={l.visible}
                            disabled={off}
                            onChange={(e) => setLineVisible(l.key, e.target.checked)}
                          />
                          <span>{l.label}</span>
                        </label>
                      ) : (
                        <label>{l.label}</label>
                      )}
                      {off && hasLineToggle && type !== "PREV_HL" && (
                        <InfoTip title={l.label} text="Turn this band on in the Inputs tab first." />
                      )}
                    </span>
                    <div className="ind-line-controls">
                      {/* One TradingView-style swatch: colour grid + opacity +
                          thickness + line style. Opacity matters most for AVWAP's
                          bands but is offered on every line now. */}
                      <ColorLineStylePicker
                        color={l.color}
                        onColor={(hex) => setLine(l.key, { color: hex })}
                        opacity={l.opacity}
                        onOpacity={(a) => setLine(l.key, { opacity: a })}
                        size={l.size}
                        onSize={(s) => setLine(l.key, { size: s })}
                        lineStyle={l.lineStyle}
                        onLineStyle={(s) => setLine(l.key, { lineStyle: s })}
                        disabled={off}
                      />
                    </div>
                  </div>
                );
              })}
              {/* RSI Style — mirrors TradingView's RSI Style tab. Every row has a
                  visibility checkbox; line elements add a style (solid/dashed/dotted),
                  bands add an editable level. The RSI line is the klinecharts figure
                  (colour/width via setLine); the rest are canvas-drawn (extendData
                  .style). A box toggles `style.hidden[key]` (unchecked → hidden). */}
              {isRsi &&
                (() => {
                  const toggle = (key: RsiHiddenKey) => (e: ChangeEvent<HTMLInputElement>) =>
                    setRsiStylePatch({ hidden: { ...rsiStyle.hidden, [key]: !e.target.checked } });
                  const check = (key: RsiHiddenKey, label: string) => (
                    <label className="ind-check ind-check-inline">
                      <input type="checkbox" checked={!rsiStyle.hidden[key]} onChange={toggle(key)} />
                      <span>{label}</span>
                    </label>
                  );
                  // A line element (MA, bands): one swatch with colour + line style.
                  const lineSwatch = (
                    color: string,
                    style: RsiLineStyleOpt,
                    onColor: (c: string) => void,
                    onStyle: (v: RsiLineStyleOpt) => void,
                  ) => (
                    <ColorLineStylePicker
                      color={color}
                      onColor={onColor}
                      lineStyle={style}
                      onLineStyle={(v) => onStyle(v as RsiLineStyleOpt)}
                    />
                  );
                  // A fill / divergence element: colour only.
                  const fillSwatch = (color: string, onColor: (c: string) => void) => (
                    <ColorLineStylePicker color={color} onColor={onColor} title="Color" />
                  );
                  const rsiLine = lines.find((l) => l.key === "rsi");
                  return (
                    <div className="ind-rsi-style">
                      {/* The RSI line (figure): always shown (the indicator's whole
                          point), so its checkbox is permanently checked + disabled.
                          Colour + thickness via setLine. */}
                      <div className="ind-row ind-style-row">
                        <label className="ind-check ind-check-inline">
                          <input type="checkbox" checked disabled readOnly />
                          <span>RSI</span>
                        </label>
                        <div className="ind-line-controls">
                          <ColorLineStylePicker
                            color={rsiLine?.color ?? "#7E57C2"}
                            onColor={(hex) => setLine("rsi", { color: hex })}
                            size={rsiLine?.size ?? 1}
                            onSize={(s) => setLine("rsi", { size: s })}
                          />
                        </div>
                      </div>
                      {/* RSI-based MA: colour + line style. */}
                      <div className="ind-row ind-style-row">
                        {check("ma", "RSI-based MA")}
                        <div className="ind-line-controls">
                          {lineSwatch(
                            rsiStyle.ma,
                            rsiStyle.maLineStyle,
                            (c) => setRsiStylePatch({ ma: c }),
                            (v) => setRsiStylePatch({ maLineStyle: v }),
                          )}
                        </div>
                      </div>
                      {/* Divergence colours. */}
                      <div className="ind-row ind-style-row">
                        {check("bull", "Regular Bullish")}
                        <div className="ind-line-controls">
                          {fillSwatch(rsiStyle.bull, (c) => setRsiStylePatch({ bull: c }))}
                        </div>
                      </div>
                      <div className="ind-row ind-style-row">
                        {check("bear", "Regular Bearish")}
                        <div className="ind-line-controls">
                          {fillSwatch(rsiStyle.bear, (c) => setRsiStylePatch({ bear: c }))}
                        </div>
                      </div>
                      {/* Band lines: colour + line style + level. */}
                      {(
                        [
                          ["RSI Upper Band", "upper"],
                          ["RSI Middle Band", "middle"],
                          ["RSI Lower Band", "lower"],
                        ] as Array<[string, "upper" | "middle" | "lower"]>
                      ).map(([label, key]) => (
                        <div className="ind-row ind-style-row" key={key}>
                          {check(key, label)}
                          <div className="ind-line-controls">
                            {lineSwatch(
                              rsiStyle[key].color,
                              rsiStyle[key].lineStyle,
                              (c) => setRsiStylePatch({ [key]: { ...rsiStyle[key], color: c } }),
                              (v) => setRsiStylePatch({ [key]: { ...rsiStyle[key], lineStyle: v } }),
                            )}
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step={1}
                              value={rsiStyle[key].level}
                              onChange={(e) =>
                                setRsiStylePatch({
                                  [key]: {
                                    ...rsiStyle[key],
                                    level: Math.max(0, Math.min(100, Math.floor(Number(e.target.value)) || 0)),
                                  },
                                })
                              }
                              title="Level"
                            />
                          </div>
                        </div>
                      ))}
                      {/* Fills: colour only. */}
                      {(
                        [
                          ["RSI Background Fill", "bgFill", "bg"],
                          ["Overbought Gradient Fill", "obFill", "ob"],
                          ["Oversold Gradient Fill", "osFill", "os"],
                        ] as Array<[string, "bgFill" | "obFill" | "osFill", RsiHiddenKey]>
                      ).map(([label, key, hk]) => (
                        <div className="ind-row ind-style-row" key={key}>
                          {check(hk, label)}
                          <div className="ind-line-controls">
                            {fillSwatch(rsiStyle[key], (c) => setRsiStylePatch({ [key]: c }))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
            </>
          )}

          {tab === "visibility" && (
            <label className="ind-check">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => toggleVisible(e.target.checked)}
              />
              <span>Show on chart</span>
            </label>
          )}
        </div>

        <div className="modal-foot">
          {/* TradingView-style "Defaults" menu: type default + named presets, all
              global. Pinned left (margin-right:auto) opposite Cancel/Ok. */}
          <div className="menu ind-def-menu" ref={defMenuRef}>
            <span className="ind-row-head">
              <button
                className={`ghost ${defOpen ? "on" : ""}`}
                onClick={() => setDefOpen((v) => !v)}
              >
                Defaults ▾
              </button>
              <InfoTip
                title="Defaults"
                text="Save these settings as the default for this indicator, or store named presets."
              />
            </span>
            {defOpen && (
              <div className="dropdown ind-def-dropdown">
                <ul>
                  <li onClick={resetToDefault}>Reset settings</li>
                  <li onClick={saveAsDefault}>Save as default</li>
                  {loadIndicatorDefault(type) && (
                    <li
                      onClick={() => {
                        clearIndicatorDefault(type);
                        setDefOpen(false);
                        toast(`Cleared ${type} default`);
                      }}
                    >
                      Clear default
                    </li>
                  )}
                  <li className="sep" />
                  {Object.keys(loadIndicatorPresets(type)).map((nm) => (
                    <li key={nm} className="ind-def-preset">
                      <span onClick={() => applyPreset(nm)} title={`Apply "${nm}"`}>
                        {nm}
                      </span>
                      <button
                        className="ind-def-del"
                        title={`Delete "${nm}"`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removePreset(nm);
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                  {naming ? (
                    <li className="ind-def-name">
                      <input
                        autoFocus
                        placeholder="Preset name…"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitPreset();
                          if (e.key === "Escape") {
                            setNaming(false);
                            setPresetName("");
                          }
                        }}
                      />
                      <button onClick={commitPreset}>Save</button>
                    </li>
                  ) : (
                    <li onClick={() => setNaming(true)}>Save as preset…</li>
                  )}
                </ul>
              </div>
            )}
          </div>
          <button className="ghost" onClick={cancel}>
            Cancel
          </button>
          <button onClick={onClose}>Ok</button>
        </div>
      </div>
    </div>
  );
}
