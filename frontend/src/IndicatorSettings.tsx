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

import { useEffect, useMemo, useRef, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import type { Chart, Indicator } from "klinecharts";
import VisibilityTab from "./VisibilityTab";
import { type VisibilityModel, defaultVisibility, isVisibleOnResolution } from "./lib/visibility";
import { resolveInputs, isMovingAverage, SMOOTHING_TYPES } from "./lib/indicatorMeta";
import { applyPivotBandsTimeframe, applySlopeTimeframe } from "./lib/mtfCoordinator";
import {
  slopeLengths,
  type SlopeExtend,
  type SlopeSmoothing,
  type SlopeThreshold,
  type SlopeUnit,
} from "./lib/indicators/slope";
import type { PriceSource } from "./lib/mtf";
import type {
  MaExtend,
  PivotBandsMode,
  PivotBandsSource,
  AvwapExtend,
  BandMode,
  BandSetting,
  PrevHlAgg,
  RsiExtend,
  RsiDivergenceConfig,
  RsiSmoothing,
  RsiStyle,
  CurveLabelSide,
  CurveLabelAlign,
  SessionDef,
  SessionsExtend,
  TimeWindowDef,
  TimeHighlightExtend,
  PivotAnalysisExtend,
  PivotConnectorStyle,
} from "./lib/customIndicators";
import {
  AVWAP_DEFAULT_BANDS,
  RSI_DIVERGENCE_DEFAULTS,
  RSI_SMOOTHING_DEFAULTS,
  RSI_STYLE_DEFAULTS,
  DEFAULT_SESSIONS,
  DEFAULT_TIME_WINDOWS,
  indTypeOf,
  curveLabelConfig,
  PIVOT_CONNECTOR_DEFAULTS,
  resolvePivotConnector,
} from "./lib/customIndicators";
import { PERIODS, RESOLUTION_SECONDS } from "./lib/feed";
import {
  saveIndicatorConfig,
  loadIndicatorConfigs,
  type SavedIndicatorConfig,
} from "./lib/persist";
import InfoTip from "./components/InfoTip";
import { requestIndicatorOverlayRepaint } from "./lib/signals";
import { mirrorAccelCompanion, syncAccelCompanion } from "./lib/indicators";
import ColorLineStylePicker from "./ColorLineStylePicker";
import { toKLineStyle, fromKLineStyle } from "./lib/lineStyle";
import { cloneStyles } from "./lib/overlays";
import DefaultsMenu from "./indicatorSettings/DefaultsMenu";
import { RsiInputsPanel, RsiDivergencePanel, RsiStylePanel, rsiConfig } from "./indicatorSettings/RsiPanels";
import {
  makeSetPrevHlTimezone,
  makeSetPrevHlLength,
  makeSetPrevHlAgg,
  makeSetPrevHlRolling,
  makeSetPrevHlAnchorInput,
  makeSetBoundaryVisible,
  PrevHlInputsPanel,
  PrevHlCalculationRows,
  PrevHlStylePairs,
  PrevHlLegendToggle,
  prevHlConfig,
} from "./indicatorSettings/PrevHlPanels";
import {
  makeApplyMa,
  MaInputsPanel,
  maConfig,
  makeApplyAvwap,
  AvwapInputsPanel,
  avwapConfig,
} from "./indicatorSettings/MaAvwapPanels";
import {
  makeWriteSessions,
  makePatchSession,
  makeAddSession,
  SessionsInputsPanel,
  SessionsStylePanel,
  sessionsConfig,
} from "./indicatorSettings/SessionsPanels";
import {
  makeWriteWindows,
  makePatchWindow,
  makeAddWindow,
  TimeHighlightInputsPanel,
  TimeHighlightStylePanel,
  timeHighlightConfig,
} from "./indicatorSettings/TimeHighlightPanels";
import {
  DEFAULT_LINE_PALETTE,
  CURVE_LABEL_TYPES,
  parseColor,
  toColor,
  type PrevHlKind,
  type LineDraft,
} from "./indicatorSettings/shared";

interface Props {
  chart: Chart;
  // The focused cell's storage scope — per-indicator config is stored per cell.
  scope: string;
  epic: string;
  // Active data broker id — MTF (higher-timeframe) data is fetched against it.
  brokerId: string;
  chartResolution: string;
  paneId: string;
  name: string;
  onClose: () => void;
}

type Tab = "inputs" | "divergence" | "style" | "visibility";

export default function IndicatorSettings({
  chart,
  scope,
  epic,
  brokerId,
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
  // Pivot Bands supports MTF (like EMA/MA) but lives on the generic inputs path.
  const isPivotBands = type === "PIVOT_BANDS";
  // Slope also supports MTF (like EMA/MA/Pivot Bands) but lives on the generic
  // inputs path too (maLen/slopeN via calcParams, maType/units/source via extend).
  const isSlope = type === "SLOPE";
  // Pivots High/Low: draw-only connector styling (color/width/dash/arrowheads) in
  // the Style tab — no recompute, just an extendData override.
  const isPivotAnalysis = type === "PIVOT_ANALYSIS";
  // Overlay indicators with a multi-line channel get per-line show/hide checkboxes
  // (+ opacity) in the Style tab, like TradingView's band toggles.
  const hasLineToggle = isAvwap || type === "LR" || type === "PREV_HL";

  // Snapshot the original state once, for an exact revert on Cancel/Escape.
  const original = useRef({
    calcParams: ((ind?.calcParams ?? []) as unknown[]).map((v) => Number(v)),
    visible: ind?.visible ?? true,
    // klinecharts mutates an indicator's `.styles` object IN PLACE on
    // overrideIndicator (verified empirically — see overlays.ts's cloneStyles), and
    // getIndicatorByPaneId returns that SAME live object. A later Style-tab edit
    // (apply()/setLine()) would otherwise mutate this "original" snapshot too,
    // making Cancel just re-apply the already-edited value instead of reverting it.
    styles: cloneStyles(ind?.styles ?? null),
    extendData: (ind?.extendData ?? null) as MaExtend | null,
  });

  const [tab, setTab] = useState<Tab>("inputs");
  const [calcParams, setCalcParams] = useState<number[]>(original.current.calcParams);
  // Intent, not the live effective flag: `ind.visible` can be false merely because
  // the interval filter (applyIndicatorIntervalVisibility) hid it on this
  // timeframe. Read the persisted intent (extendData.userVisible) first, falling
  // back to the legacy `visible` flag only when userVisible is genuinely absent
  // (fresh/legacy indicator) — mirrors overlays.ts's rehydrate seed.
  const [visible, setVisible] = useState<boolean>(
    (original.current.extendData as { userVisible?: boolean } | null)?.userVisible ??
      original.current.visible,
  );
  const [showValue, setShowValue] = useState<boolean>(
    !(original.current.extendData as { hideLegendValue?: boolean } | null)?.hideLegendValue,
  );

  // --- Per-timeframe visibility (TV Visibility tab), shared with drawings ---
  const visExt0 = (original.current.extendData ?? {}) as { visibility?: VisibilityModel };
  const [vis, setVis] = useState<VisibilityModel>(visExt0.visibility ?? defaultVisibility());
  // Auto-hide (bar-count) is only wired up for drawings so far — indicators.ts's
  // applyIndicatorIntervalVisibility never evaluates barsSpanned/autoHide, so
  // showing this control for AVWAP (an anchored, finite-extent indicator that
  // conceptually should get it) would expose a toggle that silently does nothing.
  // TODO: wire indicator bar-span (anchor timestamp -> current bar count) and
  // flip this back to `isAvwap` once that lands.
  const showAutoHide = false;

  // --- RSI divergence config (extendData.divergence), OFF by default ---
  const rsiExt0 = (ind?.extendData ?? {}) as RsiExtend;
  const [rsiDiv, setRsiDiv] = useState<RsiDivergenceConfig>(() => ({
    ...RSI_DIVERGENCE_DEFAULTS,
    ...(rsiExt0.divergence ?? {}),
  }));
  // Write a divergence-config patch onto extendData (merging live extendData to
  // preserve indType) and let calc re-run so the markers update immediately.
  // Persistence is handled by the snapshot effect (keyed on rsiDiv).
  // Reset the divergence TUNING to defaults but keep the master on/off as-is, so a
  // reset never silently switches the feature off under the user.
  function resetDivergence() {
    setRsiDivergence({ ...RSI_DIVERGENCE_DEFAULTS, on: rsiDiv.on });
  }
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

  // --- SLOPE: MA lengths (calcParams, up to 5) + slope period/smoothing/
  // color-by-direction (extendData). maType/units/source ride the generic
  // genExtend path above (meta-declared selects); these four don't fit that
  // fixed schema (a variable list + a nested {type,length} object + a bool
  // that's meaningful only for one length), so they get dedicated state here.
  const slopeExt0 = (ind?.extendData ?? {}) as SlopeExtend;
  const [slopePeriod, setSlopePeriod] = useState<number>(slopeExt0.slopePeriod ?? 3);
  const [smoothing, setSmoothing] = useState<SlopeSmoothing>(
    slopeExt0.smoothing ?? { type: "none", length: 9 },
  );
  const [colorByDirection, setColorByDirection] = useState<boolean>(
    slopeExt0.colorByDirection ?? true,
  );
  const [threshold, setThreshold] = useState<SlopeThreshold>(
    slopeExt0.threshold ?? { on: false, level: 0.1, lineStyle: "dotted" },
  );
  const [showMa, setShowMa] = useState<boolean>(slopeExt0.showMa ?? false);
  const [showAccel, setShowAccel] = useState<boolean>(slopeExt0.showAccel ?? false);
  const [accelPeriod, setAccelPeriod] = useState<number>(slopeExt0.accelPeriod ?? 3);
  const [accelSmoothing, setAccelSmoothing] = useState<SlopeSmoothing>(
    slopeExt0.accelSmoothing ?? { type: "none", length: 3 },
  );
  // Acceleration is a second derivative, so its magnitudes are much smaller than
  // the slope's — default the guide level well below the slope threshold's 0.1.
  const [accelThreshold, setAccelThreshold] = useState<SlopeThreshold>(
    slopeExt0.accelThreshold ?? { on: false, level: 0.01, lineStyle: "dotted" },
  );
  const [accelAbsolute, setAccelAbsolute] = useState<boolean>(slopeExt0.accelAbsolute ?? false);

  // --- PIVOT_ANALYSIS: vertical connector style (draw-only, on extendData) ---
  // Colors stay price-driven (up/down); width + line style + arrowheads are shared.
  const pivotConnector0 = resolvePivotConnector(
    ((ind?.extendData ?? {}) as PivotAnalysisExtend).connector,
  );
  const [connector, setConnector] = useState<Required<PivotConnectorStyle>>(pivotConnector0);

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

  // --- Curve-end labels (generic; shown for indicators that map a per-curve tag) ---
  // The pill shown past each curve's end when the indicator is selected/highlighted.
  // Enabled by DEFAULT — an explicit `false` must persist (so it isn't re-defaulted
  // to on at reload), hence we always store the full object once the user touches it.
  const curveLabelExt0 = curveLabelConfig((ind?.extendData ?? {}) as unknown);
  const [curveLabelEnabled, setCurveLabelEnabled] = useState<boolean>(curveLabelExt0.enabled);
  // Position is configured separately for High vs Low curves (side + vertical align).
  const [curveLabelHighSide, setCurveLabelHighSide] = useState<CurveLabelSide>(curveLabelExt0.high.side);
  const [curveLabelHighAlign, setCurveLabelHighAlign] = useState<CurveLabelAlign>(curveLabelExt0.high.align);
  const [curveLabelLowSide, setCurveLabelLowSide] = useState<CurveLabelSide>(curveLabelExt0.low.side);
  const [curveLabelLowAlign, setCurveLabelLowAlign] = useState<CurveLabelAlign>(curveLabelExt0.low.align);
  // "always" = labels stay visible permanently; false (default) = only when the
  // indicator is selected/highlighted.
  const [curveLabelAlways, setCurveLabelAlways] = useState<boolean>(curveLabelExt0.always);
  // Whether this indicator type has a per-curve key parameter to label. Keep in sync
  // with curveLabel()'s switch in customIndicators; ones without a case show no pills,
  // so we hide the controls for them rather than offer a no-op toggle.
  const hasCurveLabels = CURVE_LABEL_TYPES.has(type);
  // Only PREV_HL plots High/Low curve PAIRS that benefit from independently-placed
  // labels; every other type's curves route to the single "high" position slot
  // (none of their figKeys end in "low"), so they show one "Label position" row.
  const hasHighLowSplit = type === "PREV_HL";
  // Whether a high/low position is at its default (right/center) — used both for the
  // omit-when-default rehydrate guard and to drop a default sub-object from the save.
  const isPosDefault = (side: CurveLabelSide, align: CurveLabelAlign) =>
    side === "right" && align === "center";
  // Build the curve-label config object from the current state, omitting default
  // sub-positions but ALWAYS keeping enabled (so an explicit `false` persists).
  function curveLabelObj(next: {
    enabled: boolean;
    always: boolean;
    highSide: CurveLabelSide;
    highAlign: CurveLabelAlign;
    lowSide: CurveLabelSide;
    lowAlign: CurveLabelAlign;
  }) {
    const obj: {
      enabled: boolean;
      always?: boolean;
      high?: { side: CurveLabelSide; align: CurveLabelAlign };
      low?: { side: CurveLabelSide; align: CurveLabelAlign };
    } = { enabled: next.enabled };
    if (next.always) obj.always = true;
    if (!isPosDefault(next.highSide, next.highAlign))
      obj.high = { side: next.highSide, align: next.highAlign };
    if (!isPosDefault(next.lowSide, next.lowAlign))
      obj.low = { side: next.lowSide, align: next.lowAlign };
    return obj;
  }
  // Whether the whole config round-trips to nothing (so we can drop the key entirely).
  const curveLabelIsDefault = (next: Parameters<typeof curveLabelObj>[0]) =>
    next.enabled &&
    !next.always &&
    isPosDefault(next.highSide, next.highAlign) &&
    isPosDefault(next.lowSide, next.lowAlign);
  // Write the curve-label config onto extendData and re-preview (no recompute needed;
  // labels are drawn in ChartCore's redraw from extendData). Persisted by the snapshot
  // effect. The whole key is dropped when fully default; otherwise legacy flat side/
  // align are removed and the high/low form is written.
  function applyCurveLabels(next: Parameters<typeof curveLabelObj>[0]) {
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}) } as { curveLabels?: unknown };
    if (curveLabelIsDefault(next)) delete ext.curveLabels;
    else ext.curveLabels = curveLabelObj(next);
    chart.overrideIndicator({ name, extendData: ext }, paneId);
    if (isSlope) requestIndicatorOverlayRepaint();
  }
  // The current state as the applyCurveLabels/curveLabelObj argument shape.
  const curveLabelState = () => ({
    enabled: curveLabelEnabled,
    always: curveLabelAlways,
    highSide: curveLabelHighSide,
    highAlign: curveLabelHighAlign,
    lowSide: curveLabelLowSide,
    lowAlign: curveLabelLowAlign,
  });

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
    // Pivot Bands' Mode/Source change must recompute the HTF series under an
    // active timeframe (a plain extend write would only re-align the stale one),
    // so route it through the coordinator instead of the generic override.
    if (isPivotBands && (field === "mode" || field === "source")) {
      applyPivotBands(field === "mode" ? { mode: value as string } : { source: value as string });
      return;
    }
    // Slope's MA Type/Units/Source changes must recompute the HTF series under an
    // active timeframe too (a plain extend write would only re-align the stale
    // one), so route them through the coordinator instead of the generic override.
    if (isSlope && (field === "maType" || field === "units" || field === "source")) {
      applySlope({ [field]: value as string });
      return;
    }
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      { name, extendData: { ...((live?.extendData as object) ?? {}), ...next } },
      paneId,
    );
  }

  // --- SESSIONS: editable per-session list (extendData.sessions) ---
  // The whole indicator config is this list. Hours are LOCAL time in each session's
  // timezone (Inputs tab); colours live in the Style tab. Writes merge live
  // extendData (preserve indType); persistence is the snapshot effect (keyed on
  // `sessions`). Writers moved to SessionsPanels.tsx.
  const sessionsExt0 = (ind?.extendData ?? {}) as SessionsExtend;
  const [sessions, setSessions] = useState<SessionDef[]>(() =>
    (sessionsExt0.sessions ?? DEFAULT_SESSIONS).map((s) => ({ ...s })),
  );
  const writeSessions = makeWriteSessions(chart, paneId, name, setSessions);
  const patchSession = makePatchSession(sessions, writeSessions);
  const addSession = makeAddSession(sessions, writeSessions);

  // --- TIME_HIGHLIGHT: editable per-window list (extendData.windows) ---
  // Like SESSIONS, the whole indicator config is this list, but times are always
  // device-local (no per-window zone) and each window carries a visual mode
  // (band / candles / both). Times live on the Inputs tab, colours on the Style
  // tab. Writes merge live extendData (preserve indType); persistence is the
  // snapshot effect (keyed on `windows`). Writers moved to TimeHighlightPanels.tsx.
  const windowsExt0 = (ind?.extendData ?? {}) as TimeHighlightExtend;
  const [windows, setWindows] = useState<TimeWindowDef[]>(() =>
    (windowsExt0.windows ?? DEFAULT_TIME_WINDOWS).map((wn) => ({ ...wn })),
  );
  const writeWindows = makeWriteWindows(chart, paneId, name, setWindows);
  const patchWindow = makePatchWindow(windows, writeWindows);
  const addWindow = makeAddWindow(windows, writeWindows);

  // PREV_HL family writers (moved to PrevHlPanels.tsx; state stays here since the
  // persistence effect + currentConfig() read it directly).
  const setPrevHlTimezone = makeSetPrevHlTimezone(chart, paneId, name, setPrevHlTz);
  const setPrevHlLength = makeSetPrevHlLength(chart, paneId, name, prevHlLengths, setPrevHlLengths);
  const setPrevHlAgg = makeSetPrevHlAgg(chart, paneId, name, prevHlAggs, setPrevHlAggs);
  const setPrevHlRolling = makeSetPrevHlRolling(
    chart,
    paneId,
    name,
    prevHlRollingUnit,
    prevHlGapMode,
    setPrevHlRollingUnit,
    setPrevHlGapMode,
  );
  const setPrevHlAnchorInput = makeSetPrevHlAnchorInput(chart, paneId, name, prevHlTz, setPrevHlAnchorTs);

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
      maConfig(extendData, source, offset, smoothType, smoothLen, timeframe);
    }
    // Pivot Bands persists only the chosen timeframe (never the bulky HTF series);
    // refreshMtfIndicators refetches it on reload, like EMA/MA.
    if (isPivotBands && timeframe !== "chart") extendData.mtf = { timeframe };
    // Slope persists only the chosen timeframe (never the bulky HTF series);
    // refreshMtfIndicators refetches it on reload, like Pivot Bands/EMA/MA.
    if (isSlope && timeframe !== "chart") extendData.mtf = { timeframe };
    if (isSlope) {
      // slopePeriod/smoothing/colorByDirection don't ride genExtend (they're not
      // meta-declared selects) — persist them explicitly so they survive reload.
      extendData.slopePeriod = slopePeriod;
      if (smoothing.type !== "none") extendData.smoothing = smoothing;
      extendData.colorByDirection = colorByDirection;
      extendData.threshold = threshold;
      extendData.showMa = showMa;
      extendData.showAccel = showAccel;
      extendData.accelPeriod = accelPeriod;
      if (accelSmoothing.type !== "none") extendData.accelSmoothing = accelSmoothing;
      extendData.accelThreshold = accelThreshold;
      extendData.accelAbsolute = accelAbsolute;
    }
    if (isPivotAnalysis) {
      // Connector style is draw-only; persist only when it differs from the fixed
      // default so a plain instance carries no `connector` key.
      if (JSON.stringify(connector) !== JSON.stringify(PIVOT_CONNECTOR_DEFAULTS)) {
        extendData.connector = connector;
      }
    }
    if (isAvwap) {
      avwapConfig(extendData, avwapSource, bandMode, bands);
    }
    if (!isMa) {
      // Generic extendData inputs (e.g. LR's Source). For AVWAP, source is set
      // above; this also catches any future extend-input indicators.
      Object.assign(extendData, genExtend);
    }
    if (type === "PREV_HL") {
      // Per-instance timezone override + per-boundary lookback lengths/agg
      // functions + rolling unit/gap mode + anchor timestamp (non-defaults only).
      prevHlConfig(
        extendData,
        prevHlTz,
        prevHlLengths,
        prevHlAggs,
        prevHlRollingUnit,
        prevHlGapMode,
        prevHlAnchorTs,
      );
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
      rsiConfig(extendData, rsiSource, rsiSmooth, rsiDiv, rsiStyle);
    }
    if (hasCurveLabels) {
      // Curve-end labels: omit when fully default so a plain instance carries no key;
      // otherwise store the high/low form (enabled is always kept, so an explicit
      // `false` stays off on reload).
      const st = curveLabelState();
      if (!curveLabelIsDefault(st)) extendData.curveLabels = curveLabelObj(st);
    }
    if (type === "SESSIONS") {
      sessionsConfig(extendData, sessions);
    }
    if (type === "TIME_HIGHLIGHT") {
      timeHighlightConfig(extendData, windows);
    }
    if (!showValue) extendData.hideLegendValue = true;
    // Per-timeframe visibility (TV Visibility tab) — model only when non-default,
    // but userVisible (the intent) is always written once touched, so a later read
    // of intent never falls back to the interval-filtered effective `visible`.
    if (JSON.stringify(vis) !== JSON.stringify(defaultVisibility())) extendData.visibility = vis;
    extendData.userVisible = visible;
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
  }, [name, visible, showValue, calcParams, maLength, source, offset, smoothType, smoothLen, timeframe, avwapSource, bandMode, bands, lines, genExtend, slopePeriod, smoothing, colorByDirection, threshold, showMa, showAccel, accelPeriod, accelSmoothing, accelThreshold, accelAbsolute, connector, prevHlTz, prevHlLengths, prevHlAggs, prevHlRollingUnit, prevHlGapMode, prevHlAnchorTs, rsiDiv, rsiSource, rsiSmooth, rsiStyle, curveLabelEnabled, curveLabelHighSide, curveLabelHighAlign, curveLabelLowSide, curveLabelLowAlign, curveLabelAlways, vis, sessions, windows]);

  // MA/EMA apply (moved to MaAvwapPanels.tsx). Also called directly from
  // setParam's isMa branch below, so it stays a shell-local binding.
  const applyMa = makeApplyMa(chart, epic, name, paneId, brokerId, type, {
    maLength,
    source,
    offset,
    smoothType,
    smoothLen,
    timeframe,
  });

  // Push a Pivot Bands config (chart-TF or MTF) through the coordinator, which
  // refetches + recomputes both step-lines on the higher timeframe when one is
  // set. Reads explicit overrides so a param change never races setState; N/K
  // come from calcParams, mode from genExtend.
  function applyPivotBands(
    next: Partial<{ n: number; k: number; mode: string; source: string; timeframe: string }> = {},
  ) {
    const n = next.n ?? calcParams[0] ?? 5;
    const k = next.k ?? calcParams[1] ?? 3;
    const mode = (next.mode ?? genExtend.mode ?? "last") as PivotBandsMode;
    const source = (next.source ?? genExtend.source ?? "hl") as PivotBandsSource;
    const tf = next.timeframe ?? timeframe;
    void applyPivotBandsTimeframe(
      chart,
      epic,
      name,
      paneId,
      { n, k, mode, source },
      tf === "chart" ? null : tf,
      brokerId,
    );
  }

  // Push a Slope config (chart-TF or MTF) through the coordinator, which refetches
  // + recomputes the slope on the higher timeframe's native bars when one is set
  // (mirrors applyPivotBands above). `lengths` is the calcParams LIST (one MA
  // length per line, up to 5 — mirrors the Pivot Bands N/K pattern but as an
  // array); slopeN/maType/units/source/smoothing come from extendData
  // (slopePeriod/genExtend.maType/genExtend.units/genExtend.source/smoothing
  // state). Reads explicit overrides so a param change never races setState.
  //
  // applySlopeTimeframe's `ext` only explicitly sets maType/units/config.options
  // (source/offset) — slopePeriod/smoothing/colorByDirection ride through ONLY
  // via its leading `...ind.extendData` spread, i.e. whatever is ALREADY stored
  // on the live indicator. So a slopePeriod/smoothing edit must land on the live
  // indicator's extendData BEFORE calling the coordinator, or the coordinator's
  // recompute (chart-TF included) would use the stale stored value instead of
  // the just-changed one.
  function applySlope(
    next: Partial<{
      lengths: number[];
      slopeN: number;
      maType: string;
      units: string;
      source: string;
      smoothing: SlopeSmoothing;
      colorByDirection: boolean;
      threshold: SlopeThreshold;
      showMa: boolean;
      showAccel: boolean;
      accelPeriod: number;
      accelSmoothing: SlopeSmoothing;
      accelThreshold: SlopeThreshold;
      accelAbsolute: boolean;
      timeframe: string;
    }> = {},
  ): void {
    const tf = next.timeframe ?? timeframe;
    const nextSlopeN = next.slopeN ?? slopePeriod;
    const nextSmoothing = next.smoothing ?? smoothing;
    const nextColorByDirection = next.colorByDirection ?? colorByDirection;
    const nextThreshold = next.threshold ?? threshold;
    const nextShowMa = next.showMa ?? showMa;
    const nextShowAccel = next.showAccel ?? showAccel;
    const nextAccelPeriod = next.accelPeriod ?? accelPeriod;
    const nextAccelSmoothing = next.accelSmoothing ?? accelSmoothing;
    const nextAccelThreshold = next.accelThreshold ?? accelThreshold;
    const nextAccelAbsolute = next.accelAbsolute ?? accelAbsolute;
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      {
        name,
        extendData: {
          ...((live?.extendData as object) ?? {}),
          slopePeriod: nextSlopeN,
          smoothing: nextSmoothing.type === "none" ? undefined : nextSmoothing,
          colorByDirection: nextColorByDirection,
          threshold: nextThreshold,
          showMa: nextShowMa,
          showAccel: nextShowAccel,
          accelPeriod: nextAccelPeriod,
          accelSmoothing:
            nextAccelSmoothing.type === "none" ? undefined : nextAccelSmoothing,
          accelThreshold: nextAccelThreshold,
          accelAbsolute: nextAccelAbsolute,
        },
      },
      paneId,
    );
    void applySlopeTimeframe(
      chart,
      epic,
      name,
      paneId,
      {
        maType: (next.maType ?? (genExtend.maType === "sma" ? "sma" : "ema")) as "ema" | "sma",
        lengths: next.lengths ?? slopeLengths(calcParams),
        slopeN: nextSlopeN,
        units: (next.units ?? (genExtend.units as SlopeUnit) ?? "pctHr") as SlopeUnit,
        smoothing: nextSmoothing.type === "none" ? undefined : nextSmoothing,
        options: { source: (next.source ?? genExtend.source ?? "close") as PriceSource, offset },
      },
      tf === "chart" ? null : tf,
      brokerId,
    );
    // applySlopeTimeframe re-syncs the companion too, but only after its awaited
    // fetches: this synchronous call makes the pane appear/disappear instantly on
    // toggle rather than after a network round-trip.
    syncAccelCompanion(chart, name);
    requestIndicatorOverlayRepaint();
  }

  // Merge one field into the connector style, push state + live redraw together.
  function patchConnector(p: Partial<Required<PivotConnectorStyle>>): void {
    const next = { ...connector, ...p };
    setConnector(next);
    applyPivotAnalysis(next);
  }

  // Pivots High/Low connector: draw-only, so a plain extendData override (merged
  // over the live indicator's) is the whole live-update path — no recompute.
  function applyPivotAnalysis(next: Required<PivotConnectorStyle>): void {
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    chart.overrideIndicator(
      {
        name,
        extendData: { ...((live?.extendData as object) ?? {}), connector: next },
      },
      paneId,
    );
  }

  // AVWAP source/bands apply (moved to MaAvwapPanels.tsx). Also called from
  // setLineVisible's isAvwap branch below, so it stays a shell-local binding.
  const applyAvwap = makeApplyAvwap(chart, name, paneId, { avwapSource, bandMode, bands });

  // Generic (non-MA) calcParam apply.
  function apply(next: { calcParams?: number[]; visible?: boolean; lines?: LineDraft[] }) {
    const cp = next.calcParams ?? calcParams;
    const ls = next.lines ?? lines;
    // Gate the live effective `visible` by the interval model too, so editing
    // calcParams/lines on an indicator that's currently interval-hidden (e.g. a
    // "Hours" auto-hide on this timeframe) can't pop it back visible as a
    // side effect — only the intent (`visible` state) is meant to change here.
    const eff = (next.visible ?? visible) && isVisibleOnResolution(vis, chartResolution);
    chart.overrideIndicator(
      {
        name,
        calcParams: cp,
        visible: eff,
        styles: { lines: lineOverrides(ls) },
      },
      paneId,
    );
    // Slope color/width edits route setLine -> apply; bump the overlay repaint so
    // the on-chart MA follows immediately instead of waiting for the 1s tick.
    if (isSlope) requestIndicatorOverlayRepaint();
  }

  function setParam(index: number, value: number) {
    const nextCp = calcParams.slice();
    nextCp[index] = value;
    setCalcParams(nextCp);
    if (isMa && index === 0) {
      setMaLength(value);
      applyMa({ length: value });
    } else if (isPivotBands) {
      // Strength (0) / Window K (1). Under an active timeframe the HTF series must
      // be recomputed with the new param, not just re-aligned — route through the
      // coordinator (which also writes calcParams).
      apply({ calcParams: nextCp });
      applyPivotBands({ n: nextCp[0], k: nextCp[1] });
      // isSlope has no calcParam-sourced input left (MA Lengths is the dedicated
      // editor below, which writes calcParams + calls applySlope directly), so
      // this generic setParam path is never reached for SLOPE.
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
    // A Slope line's color/width also styles the matching accel line — push the
    // parent's freshly-overridden styles onto the companion in place.
    if (isSlope) syncAccelCompanion(chart, name);
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
  // checking shows both. (Moved to PrevHlPanels.tsx.)
  const setBoundaryVisible = makeSetBoundaryVisible(chart, paneId, name, lines, setLines);

  // Toggle the "Show on chart" checkbox: records intent in extendData.userVisible
  // (never falls back to reading the live effective `visible`) and applies the
  // interval filter against the model already in state, so a hidden-by-timeframe
  // indicator isn't accidentally forced visible by this checkbox alone.
  function toggleVisible(v: boolean) {
    setVisible(v);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}), userVisible: v, visibility: vis };
    const effVisible = v && isVisibleOnResolution(vis, chartResolution);
    chart.overrideIndicator({ name, extendData: ext, visible: effVisible }, paneId);
    if (isSlope) mirrorAccelCompanion(chart, name, { extendData: ext, visible: effVisible });
  }

  // Per-timeframe visibility grid (VisibilityTab onChange): persists the model AND
  // re-writes userVisible in the SAME operation (never separately), so a future
  // read of intent never falls back to the interval-filtered effective `visible`.
  function applyVisibility(next: VisibilityModel) {
    setVis(next);
    const live = chart.getIndicatorByPaneId(paneId, name) as Indicator | null;
    const ext = { ...((live?.extendData as object) ?? {}), userVisible: visible, visibility: next };
    const effVisible = visible && isVisibleOnResolution(next, chartResolution);
    chart.overrideIndicator({ name, extendData: ext, visible: effVisible }, paneId);
    if (isSlope) mirrorAccelCompanion(chart, name, { extendData: ext, visible: effVisible });
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
    // The restore rewrites the parent's extendData wholesale (incl. showAccel and
    // accel params), so re-sync the companion: toggle-accel-then-Cancel must not
    // leave an orphaned pane (or a missing one).
    if (isSlope) syncAccelCompanion(chart, name);
    // Revert the persisted snapshot too (the effect saved edits eagerly).
    if (originalCfg.current) saveIndicatorConfig(scope, name, originalCfg.current);
    onClose();
  }

  if (!ind) return null;
  const shortName = ind.shortName || name;

  // Style-tab rows in TradingView display order for AVWAP (VWAP, then Lower/Upper
  // for each band); other indicators keep their figure order.
  const AVWAP_STYLE_ORDER = ["vwap", "dn1", "up1", "dn2", "up2", "dn3", "up3"];
  const styleRows = isAvwap
    ? (AVWAP_STYLE_ORDER.map((k) => lines.find((l) => l.key === k)).filter(Boolean) as LineDraft[])
    : lines;

  // One curve (High or Low) position row: side + align selects. The two curves
  // differ only in their state cell and which curveLabelState key they patch, so
  // render this parameterized rather than copy-pasting the markup twice.
  const curveLabelPosRow = (
    label: string,
    side: CurveLabelSide,
    setSide: (s: CurveLabelSide) => void,
    align: CurveLabelAlign,
    setAlign: (a: CurveLabelAlign) => void,
    sideKey: "highSide" | "lowSide",
    alignKey: "highAlign" | "lowAlign",
  ) => (
    <div className={`ind-row ind-prevhl-grid ind-curvelabel-pos${curveLabelEnabled ? "" : " is-off"}`}>
      <span className="ind-row-head">
        <label>{label}</label>
      </span>
      <span className="ind-curvelabel-selects">
        <select
          value={side}
          disabled={!curveLabelEnabled}
          onChange={(e) => {
            const v = e.target.value as CurveLabelSide;
            setSide(v);
            applyCurveLabels({ ...curveLabelState(), [sideKey]: v });
          }}
        >
          <option value="right">Right end</option>
          <option value="left">Left end</option>
        </select>
        <select
          value={align}
          disabled={!curveLabelEnabled}
          onChange={(e) => {
            const v = e.target.value as CurveLabelAlign;
            setAlign(v);
            applyCurveLabels({ ...curveLabelState(), [alignKey]: v });
          }}
        >
          <option value="above">Above line</option>
          <option value="center">On line</option>
          <option value="below">Below line</option>
        </select>
      </span>
    </div>
  );

  // Curve-end labels: a small tag past each curve's end naming its key parameter
  // (e.g. "1d") while the indicator is selected/highlighted. Purely visual, so it
  // lives in the Style tab (TradingView convention). Show + Position stay visible
  // but disabled when the toggle is off, so the section's shape doesn't jump.
  const renderCurveLabels = () => (
    <>
      <div className="ind-row">
        <label className="ind-check">
          <input
            type="checkbox"
            checked={curveLabelEnabled}
            onChange={(e) => {
              setCurveLabelEnabled(e.target.checked);
              applyCurveLabels({ ...curveLabelState(), enabled: e.target.checked });
            }}
          />
          <span>Curve labels</span>
        </label>
        <InfoTip
          title="Curve labels"
          text={`Shows each curve's key parameter (e.g. ${
            hasHighLowSplit ? "3D range high, prev 1D low" : "EMA 20, AVWAP +1σ"
          }) at its end. By default they appear while the indicator is selected or highlighted; set Show to Always to keep them on permanently.${
            hasHighLowSplit ? " The High and Low curves can be positioned separately." : ""
          }`}
        />
      </div>
      <div className={`ind-row ind-prevhl-grid${curveLabelEnabled ? "" : " is-off"}`}>
        <span className="ind-row-head">
          <label>Show</label>
        </span>
        <select
          value={curveLabelAlways ? "always" : "selected"}
          disabled={!curveLabelEnabled}
          onChange={(e) => {
            const always = e.target.value === "always";
            setCurveLabelAlways(always);
            applyCurveLabels({ ...curveLabelState(), always });
          }}
        >
          <option value="selected">When selected</option>
          <option value="always">Always</option>
        </select>
      </div>
      {/* Only PREV_HL has High/Low curve pairs worth placing separately. Other
          types route every curve to the "high" slot, so they get one row. */}
      {curveLabelPosRow(
        hasHighLowSplit ? "High position" : "Label position",
        curveLabelHighSide,
        setCurveLabelHighSide,
        curveLabelHighAlign,
        setCurveLabelHighAlign,
        "highSide",
        "highAlign",
      )}
      {hasHighLowSplit &&
        curveLabelPosRow(
          "Low position",
          curveLabelLowSide,
          setCurveLabelLowSide,
          curveLabelLowAlign,
          setCurveLabelLowAlign,
          "lowSide",
          "lowAlign",
        )}
    </>
  );

  const foot = (
    <>
      {/* TradingView-style "Defaults" menu: type default + named presets, all
          global. Pinned left (margin-right:auto) opposite Cancel/Ok. */}
      <DefaultsMenu
        chart={chart}
        scope={scope}
        epic={epic}
        name={name}
        type={type}
        currentConfig={currentConfig}
        onClose={onClose}
      />
      <button className="ghost" onClick={cancel}>
        Cancel
      </button>
      <button onClick={onClose}>Ok</button>
    </>
  );

  return (
    <FloatingModal
      className={`ind-settings${type === "PREV_HL" ? " ind-settings-wide" : ""}`}
      title={<strong>{shortName}</strong>}
      onClose={cancel}
      closeLabel="Cancel"
      footer={foot}
    >
        <div className="ind-tabs">
          {((isRsi
            ? ["inputs", "divergence", "style", "visibility"]
            : ["inputs", "style", "visibility"]) as Tab[]).map((t) => (
            <button
              key={t}
              className={`ind-tab ${tab === t ? "on" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "inputs" ? "Inputs" : t === "divergence" ? "Divergence" : t === "style" ? "Style" : "Visibility"}
            </button>
          ))}
        </div>

        <div className="ind-body">
          {tab === "inputs" && isMa && (
            <MaInputsPanel
              maLength={maLength}
              setMaLength={setMaLength}
              source={source}
              setSource={setSource}
              offset={offset}
              setOffset={setOffset}
              smoothType={smoothType}
              setSmoothType={setSmoothType}
              smoothLen={smoothLen}
              setSmoothLen={setSmoothLen}
              timeframe={timeframe}
              setTimeframe={setTimeframe}
              higherTimeframes={higherTimeframes}
              applyMa={applyMa}
            />
          )}

          {tab === "inputs" && isAvwap && (
            <AvwapInputsPanel
              bandMode={bandMode}
              setBandMode={setBandMode}
              bands={bands}
              setBands={setBands}
              avwapSource={avwapSource}
              setAvwapSource={setAvwapSource}
              applyAvwap={applyAvwap}
            />
          )}

          {tab === "inputs" && isRsi && (
            // TradingView-style RSI inputs: length + source, an optional smoothing MA
            // (with Bollinger Bands), and divergence detection.
            <RsiInputsPanel
              calcParams={calcParams}
              setParam={setParam}
              rsiSource={rsiSource}
              rsiSmooth={rsiSmooth}
              setRsiExtend={setRsiExtend}
            />
          )}

          {tab === "divergence" && isRsi && (
            <RsiDivergencePanel
              rsiDiv={rsiDiv}
              setRsiDivergence={setRsiDivergence}
              resetDivergence={resetDivergence}
            />
          )}

          {tab === "inputs" && !isMa && !isAvwap && !isRsi && (
            <>
              {inputs.length === 0 &&
                type !== "PREV_HL" &&
                type !== "SESSIONS" &&
                type !== "TIME_HIGHLIGHT" && (
                  <p className="ind-note">This indicator has no adjustable inputs.</p>
                )}
              {type === "SESSIONS" && (
                <SessionsInputsPanel
                  sessions={sessions}
                  patchSession={patchSession}
                  writeSessions={writeSessions}
                  addSession={addSession}
                />
              )}
              {type === "TIME_HIGHLIGHT" && (
                <TimeHighlightInputsPanel
                  windows={windows}
                  patchWindow={patchWindow}
                  writeWindows={writeWindows}
                  addWindow={addWindow}
                />
              )}
              {isSlope && (
                <div className="slope-lengths">
                  <label>
                    MA Lengths{" "}
                    <InfoTip
                      title="MA Lengths"
                      text="One slope line per moving-average length. Add up to 5 to compare fast and slow momentum."
                    />
                  </label>
                  {calcParams.map((len, i) => (
                    <span className="slope-length-chip" key={i}>
                      <input
                        type="number"
                        min={1}
                        value={Number.isFinite(len) ? len : ""}
                        onChange={(e) => {
                          const nextCp = calcParams.slice();
                          nextCp[i] = Number(e.target.value);
                          setCalcParams(nextCp);
                          applySlope({ lengths: slopeLengths(nextCp) });
                        }}
                      />
                      <button
                        type="button"
                        className="slope-length-remove"
                        aria-label={`Remove length ${i + 1}`}
                        disabled={calcParams.length <= 1}
                        onClick={() => {
                          const nextCp = calcParams.filter((_, j) => j !== i);
                          setCalcParams(nextCp);
                          applySlope({ lengths: slopeLengths(nextCp) });
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    className="slope-length-add"
                    aria-label="Add MA length"
                    title="Add another MA length"
                    disabled={calcParams.length >= 5}
                    onClick={() => {
                      const nextCp = [...calcParams, 9];
                      setCalcParams(nextCp);
                      applySlope({ lengths: slopeLengths(nextCp) });
                    }}
                  >
                    +
                  </button>
                </div>
              )}
              {inputs.map((inp) => {
                // Conditional visibility: skip an input whose showWhen guard isn't
                // met by the current (extend-stored) value of the controlling field.
                if (inp.showWhen) {
                  const ctrl = inputs.find(
                    (d) => d.source === "extend" && d.field === inp.showWhen!.field,
                  );
                  const cur = genExtend[inp.showWhen.field] ?? ctrl?.default;
                  if (!inp.showWhen.equals.includes(cur as string | number)) return null;
                }
                // Label, with an optional ⓘ info tip beside it (matches the
                // hand-built panels like PREV_HL). Plain <label> when no tip.
                const labelEl = inp.tip ? (
                  <span className="ind-row-head">
                    <label>{inp.label}</label>
                    <InfoTip title={inp.label} text={inp.tip} />
                  </span>
                ) : (
                  <label>{inp.label}</label>
                );
                if (inp.source === "calcParam" && inp.index != null) {
                  return (
                    <div className="ind-row" key={inp.key}>
                      {labelEl}
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
                      {labelEl}
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
                if (inp.source === "extend" && inp.field && inp.type === "boolean") {
                  const checked = (genExtend[inp.field] ?? inp.default ?? false) as boolean;
                  return (
                    <div className="ind-row" key={inp.key}>
                      {labelEl}
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setExtendInput(inp.field!, e.target.checked)}
                      />
                    </div>
                  );
                }
                return null;
              })}
              {isSlope && (
                <>
                  <div className="ind-row">
                    <span className="ind-row-head">
                      <label>Slope Period</label>
                      <InfoTip
                        title="Slope Period"
                        text="The number of bars the slope is measured over. Larger is smoother and slower to turn."
                      />
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={slopePeriod}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setSlopePeriod(v);
                        applySlope({ slopeN: v });
                      }}
                    />
                  </div>
                  <div className="ind-group">Smoothing</div>
                  <div className="ind-row">
                    <span className="ind-row-head">
                      <label>Type</label>
                      <InfoTip
                        title="Smoothing"
                        text="The averaging function for the slope line to cut noise. None keeps the raw slope; SMA/EMA smooth it."
                      />
                    </span>
                    <select
                      value={smoothing.type}
                      onChange={(e) => {
                        const next: SlopeSmoothing = {
                          type: e.target.value as SlopeSmoothing["type"],
                          length: smoothing.length,
                        };
                        setSmoothing(next);
                        applySlope({ smoothing: next });
                      }}
                    >
                      {SMOOTHING_TYPES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {smoothing.type !== "none" && (
                    <div className="ind-row">
                      <span className="ind-row-head">
                        <label>Length</label>
                        <InfoTip
                          title="Smoothing Length"
                          text="The number of bars in the smoothing average. Longer is smoother but adds more lag."
                        />
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={smoothing.length}
                        onChange={(e) => {
                          const next: SlopeSmoothing = {
                            type: smoothing.type,
                            length: Number(e.target.value),
                          };
                          setSmoothing(next);
                          applySlope({ smoothing: next });
                        }}
                      />
                    </div>
                  )}
                  <span className="ind-row-head">
                    <label
                      className={`ind-check${calcParams.length > 1 ? " ind-check-disabled" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={colorByDirection}
                        disabled={calcParams.length > 1}
                        onChange={(e) => {
                          setColorByDirection(e.target.checked);
                          applySlope({ colorByDirection: e.target.checked });
                        }}
                      />
                      <span>Color by direction</span>
                    </label>
                    {calcParams.length > 1 && (
                      <InfoTip
                        title="Color by direction"
                        text="Green when the slope is rising, red when falling. Available only with a single line."
                      />
                    )}
                  </span>
                  <span className="ind-row-head">
                    <label className="ind-check">
                      <input
                        type="checkbox"
                        checked={showMa}
                        onChange={(e) => {
                          setShowMa(e.target.checked);
                          applySlope({ showMa: e.target.checked });
                        }}
                      />
                      <span>Show MAs on chart</span>
                    </label>
                    <InfoTip
                      title="Show MAs on chart"
                      text="Plot each length's moving average on the price chart, colored to match its slope line."
                    />
                  </span>
                  <div className="ind-group">Threshold</div>
                  <span className="ind-row-head">
                    <label className="ind-check">
                      <input
                        type="checkbox"
                        checked={threshold.on}
                        onChange={(e) => {
                          const next = { ...threshold, on: e.target.checked };
                          setThreshold(next);
                          applySlope({ threshold: next });
                        }}
                      />
                      <span>Show threshold</span>
                    </label>
                    <InfoTip
                      title="Threshold"
                      text="A symmetric visual guide drawn at +level and −level. Drag either line on the chart to adjust, or set the exact level here. Reference only — it doesn't trigger anything."
                    />
                  </span>
                  {threshold.on && (
                    <>
                      <div className="ind-row">
                        <span className="ind-row-head">
                          <label>Level (±)</label>
                          <InfoTip
                            title="Threshold level"
                            text="The slope magnitude the two lines sit at, in the current slope units. The pane rescales so the lines stay visible."
                          />
                        </span>
                        <input
                          type="number"
                          step="any"
                          value={threshold.level}
                          onChange={(e) => {
                            const next = { ...threshold, level: Number(e.target.value) };
                            setThreshold(next);
                            applySlope({ threshold: next });
                          }}
                        />
                      </div>
                      <div className="ind-row">
                        <span className="ind-row-head">
                          <label>Line</label>
                        </span>
                        <div className="ind-line-controls">
                          <ColorLineStylePicker
                            color={threshold.color ?? "#787B86"}
                            onColor={(hex) => {
                              const next = { ...threshold, color: hex };
                              setThreshold(next);
                              applySlope({ threshold: next });
                            }}
                            lineStyle={threshold.lineStyle ?? "dotted"}
                            onLineStyle={(s) => {
                              const next = { ...threshold, lineStyle: s };
                              setThreshold(next);
                              applySlope({ threshold: next });
                            }}
                          />
                        </div>
                      </div>
                    </>
                  )}
                  <div className="ind-group">Acceleration</div>
                  <span className="ind-row-head">
                    <label className="ind-check">
                      <input
                        type="checkbox"
                        checked={showAccel}
                        onChange={(e) => {
                          setShowAccel(e.target.checked);
                          applySlope({ showAccel: e.target.checked });
                        }}
                      />
                      <span>Show acceleration pane</span>
                    </label>
                    <InfoTip
                      title="Show acceleration pane"
                      text={[
                        "Adds a second pane below showing how fast each MA's slope is changing.",
                        "Positive means the slope is steepening. Negative means it is flattening.",
                      ]}
                    />
                  </span>
                  {showAccel && (
                    <>
                      <span className="ind-row-head">
                        <label className="ind-check">
                          <input
                            type="checkbox"
                            checked={accelAbsolute}
                            onChange={(e) => {
                              setAccelAbsolute(e.target.checked);
                              applySlope({ accelAbsolute: e.target.checked });
                            }}
                          />
                          <span>Plot absolute value</span>
                        </label>
                        <InfoTip
                          title="Plot absolute value"
                          text={[
                            "Plots the magnitude of the acceleration, |accel|, so the line stays at or above zero.",
                            "Use it to see how hard the slope is changing without caring whether it is steepening or flattening.",
                          ]}
                        />
                      </span>
                      <div className="ind-row">
                        <span className="ind-row-head">
                          <label>Acceleration Period</label>
                          <InfoTip
                            title="Acceleration period"
                            text={[
                              "How many bars the slope change is measured over.",
                              "A larger period gives a smaller, smoother reading.",
                              "Units follow the slope's units: a %/hr slope gives %/hr per hour, and %/bar or price/bar gives per bar.",
                            ]}
                          />
                        </span>
                        <input
                          type="number"
                          min={1}
                          value={accelPeriod}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setAccelPeriod(v);
                            applySlope({ accelPeriod: v });
                          }}
                        />
                      </div>
                      <div className="ind-row">
                        <span className="ind-row-head">
                          <label>Smoothing</label>
                          <InfoTip
                            title="Acceleration smoothing"
                            text="Averages the acceleration line to cut noise. Acceleration is a second derivative, so it is noisier than slope."
                          />
                        </span>
                        <select
                          value={accelSmoothing.type}
                          onChange={(e) => {
                            const next: SlopeSmoothing = {
                              type: e.target.value as SlopeSmoothing["type"],
                              length: accelSmoothing.length,
                            };
                            setAccelSmoothing(next);
                            applySlope({ accelSmoothing: next });
                          }}
                        >
                          {SMOOTHING_TYPES.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      {accelSmoothing.type !== "none" && (
                        <div className="ind-row">
                          <span className="ind-row-head">
                            <label>Length</label>
                            <InfoTip
                              title="Smoothing Length"
                              text="The number of bars in the smoothing average. Longer is smoother but adds more lag."
                            />
                          </span>
                          <input
                            type="number"
                            min={1}
                            value={accelSmoothing.length}
                            onChange={(e) => {
                              const next: SlopeSmoothing = {
                                type: accelSmoothing.type,
                                length: Number(e.target.value),
                              };
                              setAccelSmoothing(next);
                              applySlope({ accelSmoothing: next });
                            }}
                          />
                        </div>
                      )}
                      <span className="ind-row-head">
                        <label className="ind-check">
                          <input
                            type="checkbox"
                            checked={accelThreshold.on}
                            onChange={(e) => {
                              const next = { ...accelThreshold, on: e.target.checked };
                              setAccelThreshold(next);
                              applySlope({ accelThreshold: next });
                            }}
                          />
                          <span>Show threshold</span>
                        </label>
                        <InfoTip
                          title="Acceleration threshold"
                          text="A symmetric visual guide drawn at +level and −level on the acceleration pane. Drag either line on the chart to adjust, or set the exact level here. Reference only — it doesn't trigger anything."
                        />
                      </span>
                      {accelThreshold.on && (
                        <>
                          <div className="ind-row">
                            <span className="ind-row-head">
                              <label>Level (±)</label>
                              <InfoTip
                                title="Acceleration threshold level"
                                text="The acceleration magnitude the two lines sit at, in the current acceleration units. The pane rescales so the lines stay visible."
                              />
                            </span>
                            <input
                              type="number"
                              step="any"
                              value={accelThreshold.level}
                              onChange={(e) => {
                                const next = { ...accelThreshold, level: Number(e.target.value) };
                                setAccelThreshold(next);
                                applySlope({ accelThreshold: next });
                              }}
                            />
                          </div>
                          <div className="ind-row">
                            <span className="ind-row-head">
                              <label>Line</label>
                            </span>
                            <div className="ind-line-controls">
                              <ColorLineStylePicker
                                color={accelThreshold.color ?? "#787B86"}
                                onColor={(hex) => {
                                  const next = { ...accelThreshold, color: hex };
                                  setAccelThreshold(next);
                                  applySlope({ accelThreshold: next });
                                }}
                                lineStyle={accelThreshold.lineStyle ?? "dotted"}
                                onLineStyle={(s) => {
                                  const next = { ...accelThreshold, lineStyle: s };
                                  setAccelThreshold(next);
                                  applySlope({ accelThreshold: next });
                                }}
                              />
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
              {type === "PREV_HL" && (
                <PrevHlInputsPanel
                  lines={lines}
                  prevHlLengths={prevHlLengths}
                  prevHlAggs={prevHlAggs}
                  prevHlRollingUnit={prevHlRollingUnit}
                  prevHlAnchorTs={prevHlAnchorTs}
                  prevHlTz={prevHlTz}
                  setBoundaryVisible={setBoundaryVisible}
                  setPrevHlLength={setPrevHlLength}
                  setPrevHlRolling={setPrevHlRolling}
                  setPrevHlAgg={setPrevHlAgg}
                  setPrevHlAnchorInput={setPrevHlAnchorInput}
                />
              )}
              {type !== "SESSIONS" && type !== "TIME_HIGHLIGHT" && (
                <div className="ind-group">Calculation</div>
              )}
              {type === "SESSIONS" || type === "TIME_HIGHLIGHT" ? null : type === "PREV_HL" ? (
                <PrevHlCalculationRows
                  prevHlGapMode={prevHlGapMode}
                  prevHlTz={prevHlTz}
                  setPrevHlRolling={setPrevHlRolling}
                  setPrevHlTimezone={setPrevHlTimezone}
                />
              ) : isPivotBands ? (
                <>
                  {/* Higher-timeframe swings aligned onto the chart bars (no
                      lookahead), same as EMA/MA. */}
                  <div className="ind-row">
                    <label>Timeframe</label>
                    <select
                      value={timeframe}
                      onChange={(e) => {
                        setTimeframe(e.target.value);
                        applyPivotBands({ timeframe: e.target.value });
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
              ) : isSlope ? (
                <>
                  {/* Higher-timeframe slope computed on native HTF bars, aligned
                      onto the chart bars (no lookahead), same as EMA/MA. */}
                  <div className="ind-row">
                    <span className="ind-row-head">
                      <label>Timeframe</label>
                      <InfoTip
                        title="Timeframe"
                        text="Compute the slope on this timeframe instead of the chart's. A higher timeframe gives a steadier, slower trend read."
                      />
                    </span>
                    <select
                      value={timeframe}
                      onChange={(e) => {
                        setTimeframe(e.target.value);
                        applySlope({ timeframe: e.target.value });
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
              ) : (
                <div className="ind-row">
                  <span className="ind-row-head">
                    <label>Timeframe</label>
                    <InfoTip title="Timeframe" text="Higher-timeframe mode is only on EMA, MA, Pivot Bands, and Slope." />
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
              {/* Non-PREV_HL toggles its figure values at the top. PREV_HL shows a
                  range summary instead, and that toggle lives at the bottom (below). */}
              {type !== "PREV_HL" && type !== "SESSIONS" && type !== "TIME_HIGHLIGHT" && (
                <label className="ind-check">
                  <input
                    type="checkbox"
                    checked={showValue}
                    onChange={(e) => toggleShowValue(e.target.checked)}
                  />
                  <span>Show value in legend</span>
                </label>
              )}
              {type === "SESSIONS" && (
                <SessionsStylePanel sessions={sessions} patchSession={patchSession} />
              )}
              {type === "TIME_HIGHLIGHT" && (
                <TimeHighlightStylePanel windows={windows} patchWindow={patchWindow} />
              )}
              {/* PREV_HL: pair each boundary's High and Low on ONE row —
                  "Day  High [color][size]  Low [color][size]" — halving the list.
                  The boundary is greyed when deactivated in the Inputs tab. */}
              {type === "PREV_HL" && <PrevHlStylePairs lines={lines} setLine={setLine} />}
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
              {/* Pivots High/Low: the vertical connector between consecutive same-type
                  pivots. Colors stay price-driven (up when the new pivot is higher,
                  down when lower) via two swatches; width + line style are shared
                  (edit either swatch), and arrowheads toggle on/off. */}
              {isPivotAnalysis && (
                <>
                  <div className="ind-group">Connector</div>
                  <div className="ind-row ind-style-row">
                    <span className="ind-row-head">
                      <label>Rising</label>
                      <InfoTip
                        title="Rising connector"
                        text="Links a pivot to the previous same-type pivot when the new one is higher. Width and line style are shared with the falling connector."
                      />
                    </span>
                    <div className="ind-line-controls">
                      <ColorLineStylePicker
                        color={connector.upColor}
                        onColor={(hex) => patchConnector({ upColor: hex })}
                        size={connector.width}
                        onSize={(s) => patchConnector({ width: s })}
                        lineStyle={connector.lineStyle}
                        onLineStyle={(s) => patchConnector({ lineStyle: s })}
                      />
                    </div>
                  </div>
                  <div className="ind-row ind-style-row">
                    <span className="ind-row-head">
                      <label>Falling</label>
                    </span>
                    <div className="ind-line-controls">
                      <ColorLineStylePicker
                        color={connector.downColor}
                        onColor={(hex) => patchConnector({ downColor: hex })}
                        size={connector.width}
                        onSize={(s) => patchConnector({ width: s })}
                        lineStyle={connector.lineStyle}
                        onLineStyle={(s) => patchConnector({ lineStyle: s })}
                      />
                    </div>
                  </div>
                  <label className="ind-check">
                    <input
                      type="checkbox"
                      checked={connector.arrows}
                      onChange={(e) => patchConnector({ arrows: e.target.checked })}
                    />
                    <span>Arrowheads</span>
                  </label>
                </>
              )}
              {/* RSI Style — mirrors TradingView's RSI Style tab. Every row has a
                  visibility checkbox; line elements add a style (solid/dashed/dotted),
                  bands add an editable level. The RSI line is the klinecharts figure
                  (colour/width via setLine); the rest are canvas-drawn (extendData
                  .style). A box toggles `style.hidden[key]` (unchecked → hidden). */}
              {isRsi && (
                <RsiStylePanel
                  lines={lines}
                  setLine={setLine}
                  rsiStyle={rsiStyle}
                  setRsiStylePatch={setRsiStylePatch}
                />
              )}
              {/* Curve-end labels live on the Style tab — they're presentation, not
                  a calculation input (TradingView convention). */}
              {hasCurveLabels && (
                <>
                  <div className="ind-group">Labels</div>
                  {renderCurveLabels()}
                </>
              )}
              {/* PREV_HL shows a range summary in the legend (e.g. "1 day, since …")
                  instead of per-bar values; this toggle controls that. Kept at the
                  bottom of the Style tab. */}
              {type === "PREV_HL" && (
                <PrevHlLegendToggle showValue={showValue} toggleShowValue={toggleShowValue} />
              )}
            </>
          )}

          {tab === "visibility" && (
            <>
              <label className="ind-check">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => toggleVisible(e.target.checked)}
                />
                <span>Show on chart</span>
              </label>
              <VisibilityTab
                model={vis}
                onChange={applyVisibility}
                showAutoHide={showAutoHide}
                currentResolution={chartResolution}
              />
            </>
          )}
        </div>
    </FloatingModal>
  );
}
