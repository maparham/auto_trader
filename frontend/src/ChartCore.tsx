// Owns a klinecharts-core Chart instance. Loads history for the current
// symbol/period, streams live updates, applies the theme, and supports
// scroll-back pagination. Hands the Chart up via onReady so the toolbar can
// drive indicators, overlays, and the price scale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  init,
  dispose,
  LoadDataType,
  DomPosition,
  ActionType,
  type Chart,
  type Indicator,
  type KLineData,
} from "klinecharts";
import {
  fetchRecent,
  fetchRange,
  fetchMarketMeta,
  fetchCandleCacheStats,
  openLive,
  RESOLUTION_SECONDS,
  type Instrument,
  type LiveHandle,
  type LiveStatus,
  type Period,
  type CandleCacheStats,
  PERIODS,
} from "./lib/feed";
import ChartRangeBar from "./ChartRangeBar";
import { rangeWindow, goToDateTs, type RangeKey } from "./lib/rangeWindow";
import { pageHistoryBack } from "./lib/historyPaging";
import { klineStyles } from "./lib/chartTheme";
import ChartLegend, {
  buildLegendRows,
  buildSubPaneLegends,
  type ChartLegendHandle,
  type LegendRow,
  type SubPaneLegendData,
} from "./ChartLegend";
import { ChartController } from "./lib/chartController";
import { isInvertShortcut } from "./lib/invertShortcut";
import InstrumentDetailsModal from "./InstrumentDetailsModal";
import CandleCacheStatsModal from "./CandleCacheStatsModal";
import CurveLabels, { type CurveLabelsHandle, type CurveLabelPill } from "./CurveLabels";
import { clearBacktest } from "./lib/backtest";
import { toast } from "./lib/notify";
import {
  alertEditRequest,
  requestConfirm,
  indicatorSettingsRequest,
  drawingSettingsRequest,
  alertsChanged,
  openSettings,
  requestSymbolSearch,
  pendingEditsSignal,
  draftOrderSignal,
  tradeLineUiSignal,
  setTradeHovered,
  setTradeSelected,
  selectTradeLine,
  openTradeEditor,
  tradePanelOpen,
  editTradeSignal,
  discardPendingEdit,
  discardPendingField,
  confirmLineEditsSignal,
  draggingLineSignal,
  type PendingEdit,
  type TradeLineField,
  type DraftOrder,
  type TradeLineUi,
} from "./lib/signals";
import {
  loadAvwapAnchor,
  loadDrawings,
  saveAvwapAnchor,
  saveIndicatorVisible,
  saveIndicators,
  saveScalePriceOnly,
  loadLegendCollapsed,
  saveLegendCollapsed,
  CONDITION_LABELS,
  type AlertCondition,
  type AlertTrigger,
  type SavedIndicatorConfig,
} from "./lib/persist";
import {
  addIndicatorInstance,
  hydrateIndicators,
  removeIndicatorById,
  reorderSubPanes,
  setAllIndicatorsHidden,
  subPaneOrder,
} from "./lib/indicators";
import { type VisibilityModel, defaultVisibility, isVisibleOnResolution } from "./lib/visibility";
import { maybeAutoApplyTemplate } from "./lib/templates";
import {
  indTypeOf,
  setIndicatorTimezone,
  curveLabel,
  curveLabelConfig,
  curveLabelPosFor,
} from "./lib/customIndicators";
import { chartSync, rangeSync, readVisibleRange, readExactAnchor, applyVisibleRange, applyVisibleRangeExact, setAlignAnchor, getAlignAnchor, setGestureCell, isGestureCell, releaseGestureCell } from "./lib/chartSync";
import { refreshMtfIndicators } from "./lib/mtfCoordinator";
import { PositionLines, tradeLineSpecs, DRAFT_ID, bracketLabels, drawPositionBracket } from "./lib/positionLines";
import {
  brokerLabel,
  setLivePrice,
  subscribeTrades,
  tradeLabel,
  mergeTradeLevels,
  clampLevelToPrice,
  applyEditedLevels,
  closePosition,
  cancelWorkingOrder,
  refreshTrades,
  getTradesAccount,
  getLivePrice,
  type TradeView,
  type OrderSide,
} from "./lib/trading";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { BellIcon, MenuIcons } from "./lib/menuIcons";
import { chartColors, loadSettings, type BidAsk, type BidAskStyle, type Clock, type CrosshairStyle, type DateFormat, type PriceSide, type Theme } from "./theme";
import { hexToRgba, DASH_DASHED, DASH_DOTTED } from "./lib/lineStyle";
import { makeFormatDate } from "./lib/timeFormat";
import { formatRemaining, resolveExpiry } from "./lib/alertUi";

// The browser's IANA timezone (e.g. "Europe/London"), used when the user picks
// "Browser time". klinecharts needs an explicit name; passing "" can leave the
// previous timezone in place, so we always resolve to a concrete zone.
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// convertFromPixel/convertToPixel are typed to return T | T[]; we always pass a
// one-element array, so normalize to the single result.
function first<T>(r: T | T[]): T {
  return (Array.isArray(r) ? r[0] : r) as T;
}

// How close (px) a click/cursor must be to a curve to select/hover it.
const HIT_TOLERANCE_PX = 6;
// How close (px) the cursor must come to a trade/alert line for the price guide (the
// "+" affordance + its price) to MAGNET onto that line's exact level, AND the single
// band a press must fall within to GRAB that line. Grab-band == cursor-band: the
// ns-resize cursor that signals "draggable" shows within this same distance (see the
// snapTarget logic in onMove), so a line grabs exactly where its cursor appeared —
// no dead zone where the line drags but no cursor warned you, or vice-versa.
const ALERT_SNAP_PX = 5;
const DOT_RADIUS = 3.5; // selection marker radius
// Selection markers are anchored to fixed BARS (every DOT_STEP-th bar by
// timestamp phase), NOT to fixed screen spacing — so they stay glued to the
// chart through zoom/scroll instead of sliding along the curve. When zoomed out
// far enough that they'd crowd below MIN_DOT_GAP_PX, the step doubles (octave
// thinning): half the dots drop out but the rest stay put (a multiple of the
// base step), so they still never slide.
const DOT_STEP = 6; // ~48px apart at the default bar spacing (8px)
const MIN_DOT_GAP_PX = 30;
// klinecharts' own initial bar spacing (its DEFAULT_BAR_SPACE, not exported) — used to
// restore the time axis on double-click, matching what a freshly loaded chart starts at.
const DEFAULT_BAR_SPACE = 8;

// AVWAP anchor drag handle: a larger solid grab handle painted at the anchor bar
// when AVWAP is selected, draggable left/right to re-anchor (TradingView-style).
const ANCHOR_HANDLE_R = 6; // drawn radius
const ANCHOR_GRAB_PX = 11; // mousedown hit radius (forgiving)

// A selectable indicator line resolved to pixel coordinates for the current
// view. One entry per `type:"line"` figure — an indicator can plot several
// (e.g. MACD's DIF/DEA). Each point keeps its bar timestamp `t` so the dot
// painter can anchor markers to bars. Rebuilt each redraw and read by BOTH the
// painter and the click/hover hit-test, so neither re-runs convertToPixel.
interface LineCache {
  paneId: string;
  name: string;
  // The figure key of this specific line (e.g. "dayHigh") and the indicator's
  // type — together they resolve the curve's key-parameter tag for the end label.
  figKey: string;
  indType: string;
  extendData: unknown; // carries per-curve label text + config (curveLabels)
  calcParams?: unknown[]; // lengths/multipliers, for name+params curve labels
  color: string;
  coords: Array<{ x: number; y: number; t: number }>;
}

// Distance from point (px,py) to the segment (ax,ay)-(bx,by).
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Resolve every visible indicator line across ALL panes to pixel coordinates.
// Skips hidden indicators, non-line figures (bars/histograms — TV puts handles
// on plotted lines, not on the MACD histogram), and warmup/unplaced gaps (null
// result values; our indicators have no mid-series holes so adjacent valid
// points never bridge a real gap). Coordinates are container-absolute
// (convertToPixel absolute:true adds each pane's top offset), so a single
// full-height overlay canvas aligns sub-pane dots (RSI/MACD) too.
function buildLineCache(chart: Chart): LineCache[] {
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  if (!panes) return [];
  const dl = chart.getDataList();
  const vr = chart.getVisibleRange();
  const lineStyles = chart.getStyles().indicator.lines;
  const out: LineCache[] = [];
  for (const [paneId, inds] of panes) {
    for (const [name, ind] of inds) {
      if (ind.visible === false) continue;
      const result = ind.result as Array<Record<string, number | undefined>>;
      const indType = indTypeOf(ind);
      let lineIdx = 0;
      for (const fig of ind.figures) {
        if (fig.type !== "line") continue;
        const styleIdx = lineIdx++;
        const pts: Array<{ timestamp: number; value: number }> = [];
        for (let i = vr.from; i < vr.to; i++) {
          const v = result[i]?.[fig.key];
          const k = dl[i];
          if (k && typeof v === "number" && Number.isFinite(v)) {
            pts.push({ timestamp: k.timestamp, value: v });
          }
        }
        if (pts.length < 2) continue;
        const px = chart.convertToPixel(pts, { paneId, absolute: true }) as Array<{
          x: number;
          y: number;
        }>;
        const coords = px.map((c, k) => ({ x: c.x, y: c.y, t: pts[k].timestamp }));
        const color =
          ind.styles?.lines?.[styleIdx]?.color ??
          lineStyles[styleIdx % lineStyles.length]?.color ??
          "#FF9600";
        out.push({
          paneId,
          name,
          figKey: fig.key,
          indType,
          extendData: ind.extendData,
          calcParams: ind.calcParams,
          color,
          coords,
        });
      }
    }
  }
  return out;
}

// Nearest cached line within HIT_TOLERANCE_PX of (px,py), as pane+name — so a
// curve click/hover identifies its indicator (sub-pane indicators included).
function hitTestCache(
  cache: LineCache[],
  px: number,
  py: number,
): { paneId: string; name: string } | null {
  let best: { paneId: string; name: string; d: number } | null = null;
  for (const line of cache) {
    const c = line.coords;
    for (let i = 1; i < c.length; i++) {
      const d = distToSegment(px, py, c[i - 1].x, c[i - 1].y, c[i].x, c[i].y);
      if (d <= HIT_TOLERANCE_PX && (!best || d < best.d)) {
        best = { paneId: line.paneId, name: line.name, d };
      }
    }
  }
  return best ? { paneId: best.paneId, name: best.name } : null;
}

// Draw TradingView-style hollow selection handles (background-filled circle +
// colored ring) at screen-equidistant points along the selected indicator's
// line(s), onto the dedicated overlay canvas (above klinecharts' canvases, so
// the ring sits ON TOP of the line). Returns nothing; clears nothing.
function paintSelectionDots(
  ctx: CanvasRenderingContext2D,
  cache: LineCache[],
  sel: { paneId: string; name: string },
  fill: string,
  barSpace: number,
): void {
  for (const line of cache) {
    if (line.paneId !== sel.paneId || line.name !== sel.name) continue;
    const coords = line.coords;
    if (coords.length < 2) continue;
    // Bar interval (ms): the smallest positive gap between adjacent bars (so
    // weekend/overnight gaps don't distort the per-bar phase used for anchoring).
    let barMs = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const d = coords[i].t - coords[i - 1].t;
      if (d > 0 && d < barMs) barMs = d;
    }
    if (!Number.isFinite(barMs) || barMs <= 0) continue;
    // Octave-thin when zoomed out so dots never crowd, but only by doubling the
    // step (a multiple of the base) so the surviving dots stay anchored to the
    // same bars — they thin/reappear on zoom, never slide.
    let step = DOT_STEP;
    while (step * barSpace < MIN_DOT_GAP_PX) step *= 2;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = line.color;
    ctx.fillStyle = fill;
    for (const p of coords) {
      if (Math.round(p.t / barMs) % step !== 0) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

// Build the curve-end label pills. A line gets a pill when its labels are enabled
// AND either (a) its config is "always" (permanent) or (b) the indicator is ACTIVE
// — selected/legend-hovered/curve-hovered, the same triggers that show the selection
// handles. One pill per figure that resolves a non-empty key-parameter tag. Anchored
// to the curve's last coord for side:"right", its first for side:"left" — both in
// container space.
function buildCurveLabelPills(
  cache: LineCache[],
  targets: Array<{ paneId: string; name: string }>,
  maxX: number, // right edge of the main plot, so right-side pills stay on-chart
): CurveLabelPill[] {
  const active = (paneId: string, name: string) =>
    targets.some((t) => t.paneId === paneId && t.name === name);
  const pills: CurveLabelPill[] = [];
  for (const line of cache) {
    if (line.coords.length === 0) continue;
    const cfg = curveLabelConfig(line.extendData);
    if (!cfg.enabled) continue;
    if (!cfg.always && !active(line.paneId, line.name)) continue;
    const text = curveLabel(line.indType, line.figKey, line.extendData, line.calcParams);
    if (!text) continue;
    // High and Low curves get independently-configured positions.
    const pos = curveLabelPosFor(cfg, line.figKey);
    const end = pos.side === "right" ? line.coords[line.coords.length - 1] : line.coords[0];
    pills.push({
      key: `${line.paneId}:${line.name}:${line.figKey}`,
      text,
      x: end.x,
      y: end.y,
      color: line.color,
      side: pos.side,
      align: pos.align,
      maxX,
    });
  }
  return pills;
}

// Resolve the AVWAP anchor bar to a pixel point on the candle pane, or null when
// AVWAP isn't placed/active or the anchor bar is scrolled outside the visible
// range. Returns the anchor bar's timestamp and the line color too, so the
// handle can be painted in the plot color and hit-tested against the cursor.
function avwapAnchorPixel(
  chart: Chart,
  id: string, // the AVWAP INSTANCE id (its klinecharts name)
): { x: number; y: number; ts: number; color: string } | null {
  const ind = chart.getIndicatorByPaneId("candle_pane", id) as Indicator | null | undefined;
  if (!ind || ind.visible === false) return null;
  const anchorTs = Number(ind.calcParams?.[0]) || 0;
  if (anchorTs <= 0) return null; // unplaced
  const dl = chart.getDataList();
  const idx = dl.findIndex((k) => k.timestamp >= anchorTs);
  if (idx < 0) return null; // anchor is newer than the last loaded bar
  const vr = chart.getVisibleRange();
  if (idx < vr.from || idx >= vr.to) return null; // off-screen: no handle
  const result = ind.result as Array<Record<string, number | undefined>>;
  const v = result[idx]?.vwap;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const px = chart.convertToPixel([{ timestamp: dl[idx].timestamp, value: v }], {
    paneId: "candle_pane",
    absolute: true,
  }) as Array<{ x: number; y: number }>;
  if (!px[0]) return null;
  const color =
    ind.styles?.lines?.[0]?.color ??
    chart.getStyles().indicator.lines[0]?.color ??
    "#FF9600";
  return { x: px[0].x, y: px[0].y, ts: dl[idx].timestamp, color };
}

// If the selected indicator is an AVWAP INSTANCE, return its id (its klinecharts
// name); else null. Resolves type via extendData.indType so it works regardless of
// the instance id (e.g. "AVWAP#a1b2"). Used to scope the anchor handle/drag to the
// selected AVWAP when several may exist.
function selectedAvwapId(
  chart: Chart,
  sel: { paneId: string; name: string } | null,
): string | null {
  if (!sel) return null;
  const ind = chart.getIndicatorByPaneId(sel.paneId, sel.name) as Indicator | null | undefined;
  return ind && indTypeOf(ind) === "AVWAP" ? sel.name : null;
}

// Paint the AVWAP anchor grab handle: a solid disc with a white ring, larger than
// the selection dots so it reads as the draggable base of the anchored VWAP.
function paintAnchorHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  ring: string,
): void {
  ctx.beginPath();
  ctx.arc(x, y, ANCHOR_HANDLE_R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ring;
  ctx.stroke();
}

function fmtCountdown(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

interface Props {
  // Identity + storage scope for this cell (one tab can hold several cells).
  cellId: string;
  tabId: string;
  scope: string;
  symbol: Instrument;
  // Active data broker id ("capital"). Epics are broker-specific, so candle
  // history + the live stream are fetched against this broker; a change refetches.
  brokerId: string;
  period: Period;
  theme: Theme;
  // IANA timezone for the time axis ("" = browser local).
  timezone: string;
  // Time-axis timestamp format: clock (24h/12h) + date format.
  clock: Clock;
  dateFormat: DateFormat;
  // Prefix day-granularity timestamps with the weekday. Global.
  showWeekday: boolean;
  // Which side of the spread candles render from (bid/mid/ask). Global setting;
  // a change refetches history and reconnects the live stream for this cell.
  priceSide: PriceSide;
  // Live bid & ask display: off / axis labels / labels + lines. Global.
  bidAsk: BidAsk;
  // Colors / line opacity / line style for the bid & ask display. Global.
  bidAskStyle: BidAskStyle;
  // Appearance of the crosshair guide lines (style/color/opacity). Global.
  crosshair: CrosshairStyle;
  // When on, broadcast this cell's hovered timestamp to its tab's sibling cells
  // and paint their broadcasts as a vertical time guide (crosshair link).
  syncCrosshair?: boolean;
  // When on, scrolling/zooming the time axis here matches the same wall-clock
  // window on the tab's sibling cells (date-range link; mapped by timestamp).
  syncTime?: boolean;
  // "Lock charts" master mode. Same effect as syncTime/Crosshair/Interval combined,
  // but the date-range broadcast carries this cell's barSpace so siblings (forced to
  // the same interval) reproduce the window EXACTLY rather than approximately.
  locked?: boolean;
  // Published once the chart instance + controller are live, so App can route the
  // FOCUSED cell's chart/controller to the Toolbar / AlertsSidebar / modals.
  onReady?: (cellId: string, chart: Chart, controller: ChartController) => void;
  // Fired on pointer-down anywhere in the cell, so App can mark it focused.
  onFocus?: (cellId: string) => void;
  // Switch THIS cell's interval (used by the quick-range bar when a preset needs a
  // coarser/finer resolution than the current one). Cell-scoped so a keyboard-
  // activated preset targets the owning cell even without a prior pointer-down.
  onPeriod?: (cellId: string, p: Period) => void;
}

const BA_TAG_H = 18; // .ba-tag height; used to stack bid/ask clear of the price pill

const PAGE_BARS = 500; // older bars to request per scroll-back page
// Empty windows can be legitimate (weekend/overnight gaps), so step back a few
// windows before declaring history exhausted instead of stopping at the first gap.
const MAX_EMPTY_WINDOWS = 6;

export default function ChartCore({
  cellId,
  tabId,
  scope,
  symbol,
  brokerId,
  period,
  theme,
  timezone,
  clock,
  dateFormat,
  showWeekday,
  priceSide,
  bidAsk,
  bidAskStyle,
  crosshair,
  syncCrosshair,
  syncTime,
  locked,
  onReady,
  onFocus,
  onPeriod,
}: Props) {
  // Per-cell controller: its own OverlayManager + the per-chart UI signals that
  // used to be module globals. Stable for the life of this mount (the cell key is
  // cell.id, so cellId/scope never change here). Destructured into same-named
  // locals so the rest of this component reads them exactly as before.
  const controller = useMemo(() => new ChartController(cellId, scope), [cellId, scope]);
  const {
    overlays,
    avwapAnchorMode,
    autoScale,
    invertScale,
    scalePriceOnly,
    measureArmed,
    selectedIndicator,
    legendHovered,
    legendHoverName,
    curveHover,
    indicatorRemoved,
  } = controller;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const wsRef = useRef<LiveHandle | null>(null);
  const inited = useRef(false);
  // Active quick-range button (null once the user manually zooms/scrolls or
  // changes interval). Transient — not persisted.
  const [activeRange, setActiveRange] = useState<RangeKey | null>(null);
  // The in-flight quick-range request (resolution + window + the series identity it
  // was issued for). Acts as an ownership token: ensureCoverageAndFit bails if a
  // newer pick replaces it OR the epic/broker/side drifts from what it captured.
  // The data-load effect consumes it once the (possibly new-resolution) bars land.
  type RangeReq = {
    resolution: string;
    fromTs: number;
    toTs: number;
    epic: string;
    broker: string;
    side: PriceSide;
  };
  const pendingRangeRef = useRef<RangeReq | null>(null);
  // The token a walk-back has already been launched for, so a re-run of the
  // data-load effect (priceSide/broker change, same pending pick) can't start a
  // second concurrent walk over the same token.
  const launchedTokenRef = useRef<RangeReq | null>(null);
  // True while a range pick is programmatically moving the view, so the
  // scroll/zoom listener doesn't treat it as a manual gesture and clear the pill.
  const programmaticMoveRef = useRef(false);
  // Prepend a page of older bars, keeping beyond-data (dataIndex-only) drawing
  // anchors glued: a prepend renumbers every bar, so those anchors must shift by
  // the page size too (see OverlayManager.shiftIndexAnchoredPoints). Shared by the
  // quick-range walk and the drawing-anchor coverage walk. klinecharts handles this
  // itself only for its native Forward loads (the scroll-back loader's callback);
  // applyNewData is an INIT-type change, where its updatePointPosition skips the
  // shift but still BACK-FILLS point.timestamp from whatever bar now sits at the
  // stale index — permanently pinning a future anchor onto a historical bar. So
  // the shift must run BEFORE the data lands: the pre-shifted index stays beyond
  // the data and the back-fill leaves the point timestamp-less, as intended.
  const applyOlderBars = (merged: KLineData[]) => {
    const chart = chartRef.current;
    if (!chart) return;
    overlays.shiftIndexAnchoredPoints(merged.length - chart.getDataList().length);
    chart.applyNewData(merged, true);
  };

  // Pan/zoom the chart to a window without the scroll/zoom listener clearing the
  // active-range pill: flag the move as programmatic, then release on the next
  // macrotask after klinecharts has emitted its scroll event.
  const fitVisibleRange = (chart: Chart, fromTs: number, toTs: number) => {
    programmaticMoveRef.current = true;
    applyVisibleRange(chart, fromTs, toTs);
    setTimeout(() => {
      programmaticMoveRef.current = false;
    }, 0);
  };

  // Page older history back until the loaded data reaches `fromTs`, then fit
  // [fromTs, toTs]. The backend caps a single fetch at 1000 bars, so a calendar
  // window (e.g. a month of 30m bars ≈ 1400) won't fit in one request — we walk
  // back in PAGE_BARS windows (mirroring the scroll-back driver, gaps and all).
  // `token` is the pendingRangeRef object; we abort if a newer pick replaces it.
  //
  // DESIGN DEBT: this and the setLoadDataCallback scroll-back loader are TWO paging
  // paths coordinating through loose shared refs (cursorSecRef/exhaustedRef/
  // loadingRef/emptyStreakRef). We close the races here with the loadingRef mutex +
  // wait-out + identity guard, but a third consumer (chart replay) should collapse
  // both into one HistoryPager owner — see the "Known design debt" note in
  // docs/superpowers/plans/2026-06-30-visible-range-selector.md.
  const ensureCoverageAndFit = async (token: RangeReq) => {
    // Re-entry guard: the data-load effect can re-run (priceSide/broker change)
    // and call this again with the SAME pending token while a walk is in flight.
    if (launchedTokenRef.current === token) return;
    launchedTokenRef.current = token;
    const { resolution, fromTs, toTs } = token;
    // Stale once a newer pick replaces the token, the chart is torn down, or the
    // series identity drifts from what this pick captured (epic/broker/side/
    // resolution) — the same defence the scroll-back loader applies.
    const isStale = () =>
      pendingRangeRef.current !== token ||
      !chartRef.current ||
      epicRef.current !== token.epic ||
      brokerIdRef.current !== token.broker ||
      priceSideRef.current !== token.side ||
      resRef.current !== token.resolution;
    // Take the scroll-back loader's mutex so klinecharts' own Forward-load (which
    // our applyNewData(more=true) keeps arming) can't page concurrently and race us
    // over cursorSecRef/exhaustedRef. If a scroll-back page is ALREADY in flight,
    // wait it out first — otherwise its .finally would flip loadingRef false partway
    // through our walk and reopen the gate. (Bounded so active scrolling can't wedge
    // us; once we hold the mutex, further scroll-back loads bail.)
    for (let i = 0; loadingRef.current && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (isStale()) return;
    }
    loadingRef.current = true;
    try {
      const result = await pageHistoryBack<KLineData>({
        fromTs,
        toTs,
        resSec: RESOLUTION_SECONDS[resolution] ?? 60,
        pageBars: PAGE_BARS,
        maxPages: 16,
        maxEmpty: 4,
        isStale,
        getData: () => chartRef.current?.getDataList(),
        fetchOlder: (fromSec, toSec) =>
          fetchRange(token.epic, resolution, fromSec, toSec, token.side, token.broker),
        applyData: applyOlderBars,
        onCursor: (sec) => {
          cursorSecRef.current = sec;
        },
        onProgress: () => {
          exhaustedRef.current = false;
        },
        onExhausted: () => {
          exhaustedRef.current = true;
        },
      });
      if (result !== "aborted" && chartRef.current && pendingRangeRef.current === token) {
        fitVisibleRange(chartRef.current, fromTs, toTs);
        pendingRangeRef.current = null;
      }
    } finally {
      // Release the mutex only if a newer pick hasn't taken ownership (it holds the
      // mutex for its own walk); the current owner — or a settled idle state —
      // releases it.
      if (pendingRangeRef.current === token || pendingRangeRef.current === null) {
        loadingRef.current = false;
      }
    }
  };

  // Drawings anchor by timestamp, and klinecharts snaps a timestamp to the NEAREST
  // LOADED bar — an anchor older than the initial 500-bar window clamps to the left
  // edge of the loaded data, pivoting the drawing to a wrong slope until the user
  // happens to scroll back far enough (paint-time re-resolution self-heals once the
  // bars exist). After a load, silently page history back until the oldest saved
  // drawing anchor is covered — bounded like a quick-range walk, and with NO fit:
  // the view stays parked at the live edge. Alerts are horizontal (no timestamp),
  // so only drawings matter here.
  const ensureDrawingAnchorCoverage = async () => {
    const chart = chartRef.current;
    if (!chart) return;
    const epic = epicRef.current;
    const resolution = resRef.current;
    const broker = brokerIdRef.current;
    const side = priceSideRef.current;
    const anchors = loadDrawings(scope, epic)
      .flatMap((d) => d.points ?? [])
      .map((p) => p.timestamp)
      .filter((t): t is number => t != null);
    if (!anchors.length) return;
    const fromTs = Math.min(...anchors);
    const first = chart.getDataList()[0];
    if (!first || fromTs >= first.timestamp) return; // already covered (or nothing to extend)
    // A quick-range pick owns paging (it covers + fits its own window) — stay out of
    // its way now, and abort via isStale if one starts mid-walk.
    if (pendingRangeRef.current) return;
    const isStale = () =>
      !chartRef.current ||
      pendingRangeRef.current !== null ||
      epicRef.current !== epic ||
      brokerIdRef.current !== broker ||
      priceSideRef.current !== side ||
      resRef.current !== resolution;
    // Same mutex dance as ensureCoverageAndFit: wait out an in-flight scroll-back
    // page (bounded), then hold the mutex so the two pagers can't interleave.
    for (let i = 0; loadingRef.current && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (isStale()) return;
    }
    if (isStale()) return;
    loadingRef.current = true;
    try {
      await pageHistoryBack<KLineData>({
        fromTs,
        toTs: first.timestamp,
        resSec: RESOLUTION_SECONDS[resolution] ?? 60,
        pageBars: PAGE_BARS,
        maxPages: 16,
        maxEmpty: 4,
        isStale,
        getData: () => chartRef.current?.getDataList(),
        fetchOlder: (fromSec, toSec) => fetchRange(epic, resolution, fromSec, toSec, side, broker),
        applyData: applyOlderBars,
        onCursor: (sec) => {
          cursorSecRef.current = sec;
        },
        onProgress: () => {
          exhaustedRef.current = false;
        },
        onExhausted: () => {
          exhaustedRef.current = true;
        },
      });
      // Bounded walk: a very old anchor on a very fine interval can exceed the page
      // budget — the drawing then still clamps. Say so instead of failing silently.
      const oldest = chartRef.current?.getDataList()[0];
      if (oldest && oldest.timestamp > fromTs) {
        console.debug(
          `[chart] drawing-anchor coverage capped for ${epic}@${resolution}: oldest anchor ${new Date(fromTs).toISOString()} predates loaded history`,
        );
      }
    } finally {
      // Release only if a quick-range pick hasn't taken the mutex for its own walk.
      if (pendingRangeRef.current === null) {
        loadingRef.current = false;
      }
    }
  };

  // A quick-range button: switch interval if needed (the data-load effect then
  // covers + fits once bars land), else cover + fit over the current interval now.
  const onRangePick = (key: RangeKey) => {
    const chart = chartRef.current;
    if (!chart) return;
    // Keyboard activation (Enter/Space) fires no pointer-down, so focus this cell
    // explicitly — otherwise an interval switch would target whatever cell was
    // focused before (the period setter is cell-scoped, so this also makes the
    // marker/pill land on the cell the user actually clicked).
    onFocus?.(cellId);
    const { resolution, fromTs, toTs } = rangeWindow(
      key,
      Date.now(),
      timezone || browserTimezone(),
    );
    setActiveRange(key);
    // Mark the period start for the on-chart separator (fromTs=0 for "All" sits
    // off the left edge, so paintSeparator just won't draw it — intended).
    separatorTsRef.current = fromTs;
    const token: RangeReq = {
      resolution,
      fromTs,
      toTs,
      epic: symbol.epic,
      broker: brokerId,
      side: priceSide,
    };
    pendingRangeRef.current = token;
    if (resolution !== period.resolution) {
      const target = PERIODS.find((p) => p.resolution === resolution);
      if (target) onPeriod?.(cellId, target);
      return;
    }
    void ensureCoverageAndFit(token);
  };

  // Calendar "go to date": center the chosen date in the current window, keeping
  // the interval. Degrades to the loaded extent if the date predates history.
  const onGoToDate = (dateStr: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    // Resolve the picked day in the chart timezone (consistent with the range
    // buttons / separator), not UTC midnight.
    const dateMs = goToDateTs(dateStr, timezone || browserTimezone());
    const cur = readVisibleRange(chart);
    const span = cur ? cur.toTs - cur.fromTs : 30 * 86_400_000;
    setActiveRange(null);
    separatorTsRef.current = null;
    fitVisibleRange(chart, dateMs - span / 2, dateMs + span / 2);
  };
  // On-chart trade lines (entry/SL/TP for positions + resting orders). Server-
  // owned, non-persisted; see positionLines.ts.
  const posLinesRef = useRef<PositionLines | null>(null);
  // Latest trades + pending drags from the shared signals, so an epic change can
  // re-filter/re-merge without waiting for the next poll tick.
  const tradesRef = useRef<TradeView[]>([]);
  const pendingRef = useRef<Record<string, PendingEdit>>({});
  const draftRef = useRef<DraftOrder | null>(null);
  // Per-trade line UI (hidden ids + hovered + selected) from the positions panel /
  // chart, so hide/hover/select re-filter the drawn lines without waiting for a poll.
  const tradeUiRef = useRef<TradeLineUi>({ hidden: [], hovered: null, selected: null, selectedField: null });
  // Mirrors confirmLineEditsSignal so the drag handler (below) can decide whether a
  // drag should select the trade (confirm mode) or just stage for auto-apply.
  const confirmLineEditsRef = useRef<boolean>(confirmLineEditsSignal.value);
  // Redraw trade lines filtered to the current epic. Set in chart init; called
  // again after a symbol-change rehydrate so the new epic's lines appear at once.
  const posDrawRef = useRef<() => void>(() => {});
  // Coalesces the heavy overlay redraw triggered by pending-edit changes to one per
  // animation frame, so a line drag (which restages the pending price on every
  // mousemove) repaints the overlay once per frame, not once per pixel.
  const pendingRedrawRafRef = useRef(0);
  // Unsubscribe from the shared trades/pending subscriptions (stored in a ref so
  // the effect's outer teardown can reach it; the subscribe happens in init).
  const posUnsubRef = useRef<() => void>(() => {});
  // Indicator-selection overlay: a canvas above klinecharts' canvases on which we
  // paint the hollow selection handles, plus a cache of every visible indicator
  // line in pixel space (rebuilt each redraw, read by the click/hover hit-test).
  const selCanvasRef = useRef<HTMLCanvasElement>(null);
  const lineCacheRef = useRef<LineCache[]>([]);
  // The H position bracket: a split-colour spine linking the SELECTED trade's (or the
  // staged draft's) entry to its SL/TP, with %/R:R badges. Its own canvas so it can be
  // repainted cheaply without touching the heavier selection/redraw layer.
  // `bracketShownRef` lets us clear it exactly once on the active→idle transition so the
  // common nothing-selected move costs ~nothing. The spine appears WHERE the cursor is
  // but does NOT track it (constant horizontal drift was just visual noise): `bracketXRef`
  // freezes the x at activation and `bracketKeyRef` re-freezes when the subject changes.
  const bracketCanvasRef = useRef<HTMLCanvasElement>(null);
  const bracketShownRef = useRef(false);
  const bracketXRef = useRef<number | null>(null);
  const bracketKeyRef = useRef<string | null>(null);
  const paintBracketRef = useRef<() => void>(() => {});
  // The period-start separator: a dashed vertical line + date pill marking where
  // the active quick-range begins (e.g. start of today for 1D). Painted on its own
  // canvas in the redraw cycle so it tracks scroll/zoom; cleared when no range is
  // active (the pill clears on manual zoom/scroll too).
  const sepCanvasRef = useRef<HTMLCanvasElement>(null);
  const separatorTsRef = useRef<number | null>(null);
  const paintSeparatorRef = useRef<() => void>(() => {});
  // Detect epic vs interval changes in the data-load effect so a stale quick-range
  // (separator + pill + in-flight fit) doesn't bleed onto a different series/interval.
  const prevEpicRef = useRef(symbol.epic);
  const prevResRef = useRef(period.resolution);
  // Cache for the separator's label + accent so paintSeparator doesn't rebuild an
  // Intl formatter / read getComputedStyle every redraw (it runs on every tick).
  const sepCacheRef = useRef<{ ts: number; tz: string; theme: string; label: string; accent: string } | null>(
    null,
  );
  // Imperative handle to the curve-end label pills (a sibling DOM overlay). Pills
  // are recomputed from the line cache each redraw and pushed here, mirroring the
  // legend's imperative-update pattern (no React churn per crosshair pixel).
  const curveLabelsRef = useRef<CurveLabelsHandle>(null);
  // While the cursor is parked over the "+" affordance, klinecharts has lost the
  // canvas hover and dropped its crosshair. We redraw just the HORIZONTAL crosshair
  // line ourselves at this y (the vertical one is intentionally gone — x is
  // meaningless on the axis strip). Also used to draw the snapped crosshair when the
  // cursor is within ALERT_SNAP_PX of an alert line. null = neither case active.
  const plusCrosshairYRef = useRef<number | null>(null);
  // Tracks whether the snap was active on the last onMove so we only call
  // setSuppressNativeLine when the state actually changes.
  const snapActiveRef = useRef(false);
  // Crosshair-link: the timestamp broadcast by a SIBLING cell (null = none). When
  // set, redraw paints a vertical time guide at that bar. syncCrosshairRef mirrors
  // the prop so the once-mounted crosshair subscription can read it without
  // re-subscribing.
  const syncedTsRef = useRef<number | null>(null);
  const syncCrosshairRef = useRef<boolean>(!!syncCrosshair);
  syncCrosshairRef.current = !!syncCrosshair;
  // Formats a timestamp for the synced crosshair's x-axis label, mirroring
  // klinecharts' own crosshair label (identical dtf options + the user's
  // clock/date format), so a linked chart's time pill reads the same as the
  // chart under the cursor. Rebuilt by the format effect below.
  const crosshairLabelFmtRef = useRef<(ts: number) => string>(() => "");
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  // Date-range link: syncTimeRef mirrors the prop so the once-mounted scroll/zoom
  // subscription can read it. A cell only broadcasts the gestures it owns (the cell
  // the cursor is on); a sibling merely applying a range never owns one, so it can't
  // echo back — see the broadcast effect and isGestureCell in chartSync.
  const syncTimeRef = useRef<boolean>(!!syncTime);
  syncTimeRef.current = !!syncTime;
  // "Lock charts" exact mode: when set, the date-range broadcast carries this cell's
  // barSpace so siblings reproduce the window pixel-for-pixel (see onRange below).
  const lockedRef = useRef<boolean>(!!locked);
  lockedRef.current = !!locked;
  // Last timestamp this cell published as the live (cursor-driven) align anchor, so
  // the hover handler only re-broadcasts when the hovered BAR changes, not every move.
  const lastHoverAnchorTsRef = useRef<number | null>(null);
  // AVWAP anchor drag: the handle's current pixel (when AVWAP is selected and the
  // anchor is on-screen), whether a drag is in progress, and guards so a drag
  // doesn't also fire the click→deselect at mouseup. pendingAnchorX/raf throttle
  // the O(bars) recalc to one per animation frame while dragging.
  const anchorPxRef = useRef<{ x: number; y: number; ts: number; color: string } | null>(null);
  const draggingAnchorRef = useRef(false);
  const dragMovedRef = useRef(false);
  const justDraggedRef = useRef(false);
  const pendingAnchorXRef = useRef(0);
  const anchorRafRef = useRef(0);
  // Trade- and alert-line drags are driven by makeLineDrag instances created inside the
  // chart effect (their active/moved state lives in those closures, not in refs); the
  // effect exposes isActive() for the few places that need to know a drag is in flight.
  // snapHover is the alert the crosshair has snapped to and auto-hovered, so a leave can
  // clear it.
  const snapHoverRef = useRef<string | null>(null);
  // redraw() is defined far below (useCallback); the once-mounted click handler
  // needs to trigger a repaint after changing the selection, so reach it via ref.
  const redrawRef = useRef<() => void>(() => {});

  // DOM legend (top-left): which candle-pane indicator ROWS exist is React state,
  // gated on a shallow signature so it only re-renders on add/remove/visibility/
  // recolor — not per crosshair pixel. The legend's VALUES update imperatively via
  // this handle (textContent), driven from the crosshair subscription + live tick.
  const [legendRows, setLegendRows] = useState<LegendRow[]>([]);
  const legendRowsSigRef = useRef("");
  // TV-style legend chevron: collapsed hides the indicator rows (symbol/OHLC row
  // stays). Per-cell, persisted so it survives reload.
  const [legendCollapsed, setLegendCollapsed] = useState(() => loadLegendCollapsed(scope));
  const toggleLegendCollapsed = () => {
    const next = !legendCollapsed;
    setLegendCollapsed(next);
    saveLegendCollapsed(scope, next);
  };
  // Sub-pane indicator legends (Volume/MACD/RSI…): same signature-gated pattern as
  // the candle rows, but the signature also folds in each pane's `top` so the cards
  // reposition when a separator is dragged (geometry, not just membership, changed).
  const [subPaneLegends, setSubPaneLegends] = useState<SubPaneLegendData[]>([]);
  const subPaneLegendsSigRef = useRef("");
  // Drop-indicator line's y-offset (relative to chart root) during a sub-pane drag;
  // null when no drag is in progress.
  const [paneDropTop, setPaneDropTop] = useState<number | null>(null);
  const legendHandleRef = useRef<ChartLegendHandle>(null);
  // Latest hovered bar index from the crosshair (null = no crosshair → last bar).
  const crosshairIdxRef = useRef<number | null>(null);
  const getChart = useCallback(() => chartRef.current, []);
  // Selected candle-pane indicator name as React state (mirrors the
  // selectedIndicator signal) so the DOM legend re-renders its blue row highlight.
  // The selected indicator's name drives the blue row highlight. Names are globally
  // unique across panes, so a single name covers the candle legend AND the sub-pane
  // legends — whichever card holds that row highlights it.
  const [selectedName, setSelectedName] = useState<string | null>(
    selectedIndicator.value?.name ?? null,
  );
  useEffect(
    () => selectedIndicator.subscribe((s) => setSelectedName(s?.name ?? null)),
    [],
  );
  // Hovering an indicator's legend row also shows its curve in "selected mode"
  // (the hollow handles), TradingView-style — repaint the overlay on hover change.
  useEffect(() => legendHoverName.subscribe(() => redrawRef.current()), [legendHoverName]);
  // The inverse: hovering an indicator's CURVE highlights its legend card AND paints
  // its curve in selected mode. Mirror the name into state (the DOM legend's card
  // highlight) and repaint the overlay (the curve handles) on every hover change.
  const [curveHoverNameState, setCurveHoverNameState] = useState<string | null>(
    curveHover.value?.name ?? null,
  );
  useEffect(
    () =>
      curveHover.subscribe((s) => {
        setCurveHoverNameState(s?.name ?? null);
        redrawRef.current();
      }),
    [curveHover],
  );

  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  // True once the chart has candles to show (history loaded or a live tick arrived).
  const [hasData, setHasData] = useState(false);
  // Chart instance exists (init effect ran). State, not a ref read in render, so the
  // quick-range bar enables the moment the chart is live even on a static frame.
  const [chartReady, setChartReady] = useState(false);
  // Banner gate: no data for a grace period. Gated on time, NOT the live status —
  // the WS connects to OUR backend (which stays up), so it reports "live" even when
  // the upstream broker delivers nothing (maintenance / auth). A healthy load sets
  // hasData within ~1-2s, well under the grace, so this never flashes normally.
  const [noData, setNoData] = useState(false);
  // The backend's error detail from the last failed history load (e.g. a broker
  // 401/maintenance), shown in the no-data banner. null when the load just returned
  // empty (404 / closed market) with no error to report.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Whether the (long) error detail is expanded in the banner.
  const [errorOpen, setErrorOpen] = useState(false);
  const [anchoring, setAnchoring] = useState(false);
  // True while the Measure ruler is armed — drives the crosshair cursor on the
  // chart container (mirrors `anchoring`), reset when a press consumes the arm.
  const [measureArmedUi, setMeasureArmedUi] = useState(false);
  // Cursor over the chart canvas: "cur-pointer" (hand) over a selectable indicator
  // curve, "cur-default" (arrow) over the legend strip, "" = klinecharts crosshair.
  // A class (not inline style) because klinecharts sets cursor on the canvas itself,
  // which beats an ancestor's inline cursor; updated only on boundary crossings.
  // "cur-ns" (ns-resize) when snapped to a draggable line — single-select so it
  // cleanly overrides "cur-pointer" (a line drag beats curve selection).
  const [cursorMode, setCursorMode] = useState<"" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns">("");
  const cursorModeRef = useRef<"" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns">("");
  // Live price label + candle countdown, anchored at the last close on the axis.
  const [priceTag, setPriceTag] = useState<{
    y: number;
    price: number;
    countdown: string | null;
    w: number; // price-axis column width, so the pill fits inside it
    // Last candle's body direction, so the pill matches the dotted last-price
    // line's up/down color (TradingView keeps the line and its label one color).
    dir: "up" | "down";
  } | null>(null);
  // Live bid & ask axis pills (TradingView's bid/ask price labels). Each is null
  // when the bid/ask display is off, the feed is down, or the side is unknown.
  const [bidTag, setBidTag] = useState<{ y: number; price: number; w: number } | null>(null);
  const [askTag, setAskTag] = useState<{ y: number; price: number; w: number } | null>(null);
  const [alertTags, setAlertTags] = useState<
    Array<{
      id: string;
      y: number;
      level: number;
      condition: AlertCondition;
      trigger: AlertTrigger;
      expiresAt: number | null;
      hovered: boolean;
      active: boolean;
      selected: boolean;
    }>
  >([]);
  // The ACTIVE line's pill for the selected trade (at most one): the entry, SL, or TP
  // line the user clicked/dragged. The entry pill shows symbol + summary + uPnL +
  // close; the SL/TP pills show symbol + level + the P/L that level would realise if
  // hit + remove. Any pill shows Apply/Discard when ITS OWN line has a staged drag.
  // Anchored at the line's pixel y (recomputed in redraw); x frozen at selection.
  const [tradePills, setTradePills] = useState<
    Array<{
      tradeId: string;
      field: TradeLineField;
      y: number;
      epic: string;
      kind: "position" | "order";
      side: OrderSide;
      qty: number;
      level: number;
      pl: number | null; // entry: uPnL; SL/TP: P/L if that level is hit
      changed: boolean; // this line has an un-applied drag → show Apply/Discard
    }>
  >([]);
  // Shared x for the trade pill, frozen at selection so the buttons sit still. null
  // until a trade is selected (mirrors pillLeftRef's "don't snap to 0" intent).
  const tradePillLeftRef = useRef<number | null>(null);
  // The on-line pill is shown while the line is hovered/selected (driven by
  // klinecharts via overlays) OR while the cursor is over the pill itself —
  // moving cursor from canvas line onto the DOM pill ends the line hover, so this
  // local flag keeps it from flickering away under the pointer.
  const [pillHoverId, setPillHoverId] = useState<string | null>(null);
  // Last alert whose pill was shown (hovered/selected). Sticky — only ever set to
  // a real id, never cleared — so when the cursor slides off the line onto the "+"
  // affordance (a DOM sibling that makes klinecharts drop the canvas hover) we can
  // keep that pill alive instead of letting it vanish.
  const lastActivePillIdRef = useRef<string | null>(null);
  // Whether the dotted last-price line is currently suppressed (klinecharts style).
  // We hide it — and the live price axis pill — while an alert line is click-selected
  // so the selected alert reads cleanly with nothing layered over its price row. A
  // mere hover does NOT trigger this (the live price stays the authoritative read);
  // only selection does. Tracked as a ref so redraw() (runs every tick) only calls
  // setStyles on an actual transition, not on every frame.
  const lastPriceHiddenRef = useRef(false);
  // True while the cursor is over the price-axis column (right strip). Hides the
  // alert pill outright — the axis is a no-interaction zone, so the descriptive
  // pill (and its delete button) shouldn't ride along there. Toggled on transition
  // only (ref mirrors it for the once-mounted mousemove handler).
  const [onAxis, setOnAxis] = useState(false);
  const onAxisRef = useRef(false);
  // Alert pills track the cursor's x so they sit next to the pointer (TV-style).
  // Positioned imperatively (like the "+" affordance) to avoid a re-render per
  // mousemove: cursorXRef holds the latest x, pillNodesRef the live pill nodes.
  const cursorXRef = useRef(0);
  const pillNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Last computed `left` (px) per pill id. The pill's x is set imperatively (no
  // per-mousemove re-render), but React owns the element's `style`, so on any
  // re-render it would reset `left` to the CSS default (0) and a frozen, selected
  // pill would jump to the far left. Seeding the rendered style from this ref makes
  // React reassert the imperative position instead of clobbering it.
  const pillLeftRef = useRef<Map<string, number>>(new Map());
  // Low-frequency clock driving the pill's remaining-time chip. Only ticks while a
  // VISIBLE pill actually has an expiry, so we don't re-render on idle.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Place a pill just past the cursor, flipping to the left of it near the right
  // edge so it never spills over the price axis. Reads refs only, so it's stable.
  const positionPill = useCallback((node: HTMLDivElement) => {
    const c = chartRef.current;
    const cont = containerRef.current;
    const mainW = c?.getSize("candle_pane", DomPosition.Main)?.width ?? cont?.clientWidth ?? 0;
    const gap = 14;
    const w = node.offsetWidth;
    let left = cursorXRef.current + gap;
    if (mainW && left + w + 4 > mainW) left = cursorXRef.current - w - gap;
    if (left < 4) left = 4;
    node.style.left = `${left}px`;
    const id = node.dataset.alertId;
    if (id) pillLeftRef.current.set(id, left); // survive React re-renders (see ref)
  }, []);

  // Stable ref callback for pill nodes (id carried via data-alert-id). Stable so
  // React only runs it on real mount/unmount — NOT on every redraw, which would
  // otherwise yank a selected (frozen) pill back to the cursor. On mount, a pill
  // is placed at the cursor unless its line is already selected.
  const registerPill = useCallback(
    (node: HTMLDivElement | null) => {
      const map = pillNodesRef.current;
      if (node) {
        const id = node.dataset.alertId ?? "";
        map.set(id, node);
        // Position on mount unless this is the frozen, selected pill that already
        // has a stored x (re-mount after a redraw) — repositioning that would yank
        // it to the cursor. A selected pill with no stored x (selected straight from
        // the sidebar, never hovered) still gets placed once so it isn't at left 0.
        const isSelected = id === overlays.getSelectedAlertId();
        if (!isSelected || !pillLeftRef.current.has(id)) positionPill(node);
      } else {
        for (const [id, n] of map)
          if (!n.isConnected) {
            map.delete(id);
            pillLeftRef.current.delete(id); // drop the stored left with the node
          }
      }
    },
    [positionPill],
  );

  // Anchor the active line's pill at its OWN label's spot (the far-left edge, where the
  // line draws its `TP …`/`SL …` label). Selecting a line then suppresses that canvas
  // label (see tradeLineSpecs `selectedField`) and shows the pill IN ITS PLACE — the
  // label "grows" into the richer, actionable pill rather than a second pill dropping
  // near the cursor and covering it (Idea C). 0 matches the label's background left edge
  // (drawn at x:6 with paddingLeft:6).
  const freezeTradePillX = useCallback(() => {
    tradePillLeftRef.current = 0;
  }, []);

  // "+" axis affordance: positioned imperatively on mousemove (no per-move state).
  const wrapRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLDivElement>(null);
  const plusPriceLabelRef = useRef<HTMLSpanElement>(null);
  const plusPriceRef = useRef(0);
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number; price: number } | null>(null);
  const plusMenuOpenRef = useRef(false);
  plusMenuOpenRef.current = plusMenu != null;
  // TradingView-style right-click menu for an indicator (Settings / Hide / Copy /
  // Remove). Opened from a legend-row right-click (ChartLegend) or a right-click on
  // the indicator's curve (onContextMenu below). paneId + name identify the target.
  const [indMenu, setIndMenu] = useState<{
    x: number;
    y: number;
    paneId: string;
    name: string;
  } | null>(null);
  // TradingView-style right-click menu for the CHART itself (empty space) — Paste an
  // indicator or drawing copied earlier. Opened by a right-click that isn't on an
  // indicator curve.
  const [chartMenu, setChartMenu] = useState<{ x: number; y: number } | null>(null);
  // TradingView-style right-click menu for the PRICE AXIS column — a single "Scale
  // price chart only" toggle (see onContextMenu, which opens it over the axis strip).
  const [axisMenu, setAxisMenu] = useState<{ x: number; y: number } | null>(null);
  // Reflect the persisted toggle so the menu's checkmark stays in sync across cells.
  const [scaleOnly, setScaleOnly] = useState(scalePriceOnly.value);
  // The value only changes via toggleScalePriceOnly (a user action after mount), so
  // the initial useState seed is authoritative — just subscribe to later flips.
  useEffect(() => scalePriceOnly.subscribe(setScaleOnly), [scalePriceOnly]);
  // Invert scale (Alt/Option+I or the toolbar "I" button): push the flip onto the
  // live chart. Candle pane only — klinecharts' YAxisImp.isReverse() ignores
  // yAxis.reverse for sub-panes. Session-only, so no initial apply is needed
  // (the signal is always false at mount) — just react to later flips. Theme
  // changes deep-merge styles via klineStyles() (which never sets reverse), so
  // an active inversion survives them.
  useEffect(
    () =>
      invertScale.subscribe((reverse) => {
        // setStyles triggers a synchronous repaint that can throw from deep in
        // klinecharts (x-axis tick formatting on a NaN scroll offset — a latent
        // bug unrelated to inversion) AFTER the style is already committed.
        // Signal.set stops notifying on a throw, so contain it here or the
        // toolbar "I" button (a later subscriber) would miss the flip.
        try {
          chartRef.current?.setStyles({ yAxis: { reverse } });
        } catch (e) {
          console.error("invert-scale repaint", e);
        }
      }),
    [invertScale],
  );
  // Flip "scale price chart only": persist it, push it onto the live chart, and
  // re-apply the current y-axis type to force calcRange to rerun (same recompute
  // path the auto-fit double-click uses).
  const toggleScalePriceOnly = useCallback(() => {
    const next = !scalePriceOnly.value;
    scalePriceOnly.set(next);
    saveScalePriceOnly(scope, next);
    const c = chartRef.current;
    if (!c) return;
    (c as unknown as { _scalePriceOnly?: boolean })._scalePriceOnly = next;
    // Only re-fit while in auto-scale mode. If the user manually scaled the axis
    // (autoScale off), calcRange is bypassed so the flag has no effect yet — and
    // re-applying the y-axis type would discard their manual zoom AND leave the
    // toolbar "A" falsely off. The flag then takes effect the next time they re-fit.
    if (autoScale.value) c.setStyles({ yAxis: { type: c.getStyles().yAxis.type } });
  }, [scalePriceOnly, scope, autoScale]);
  // status read inside the once-mounted countdown interval without re-subscribing.
  const statusRef = useRef<LiveStatus>(status);
  statusRef.current = status;
  // Flip the no-data banner on only after a grace period with no candles, so a
  // normal load (history lands in ~1-2s) never shows it; a switch resets hasData
  // false → this re-arms. Cleared the instant data arrives.
  useEffect(() => {
    if (hasData) {
      setNoData(false);
      return;
    }
    const t = setTimeout(() => setNoData(true), 6000);
    return () => clearTimeout(t);
  }, [hasData, symbol.epic, period.resolution, brokerId]);
  // Authoritative display precision fetched per epic. Symbols persisted from the
  // bulk markets list can lack pricePrecision (e.g. oil), so we don't trust the
  // stored value: fetch the platform's own decimals and prefer them.
  const [fetchedPrecision, setFetchedPrecision] = useState<number | null>(null);
  const effPrecision = fetchedPrecision ?? symbol.pricePrecision ?? 2;
  const precisionRef = useRef(effPrecision);
  precisionRef.current = effPrecision;
  // Whether this epic's market is currently closed (derived from opening hours),
  // fetched with precision and polled (see effect below). Drives the price label's
  // "closed" text in place of the candle countdown; the ref lets the once-mounted
  // countdown logic read it without re-subscribing. (The tab badge's closed/next-open
  // state is sourced separately by an App-level epic poll, so this cell tracks only
  // the boolean it needs for its own price label.)
  const [marketClosed, setMarketClosed] = useState(false);
  const marketClosedRef = useRef(marketClosed);
  marketClosedRef.current = marketClosed;
  // When the live stream last delivered a candle. Lets the open/closed check be
  // event-driven: a ticking stream means the market is open (no server call), so
  // we only re-check status when the stream falls silent (see the effect below).
  const lastCandleAtRef = useRef(0);
  // Instrument-details modal (opened by clicking the legend symbol).
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cacheStatsOpen, setCacheStatsOpen] = useState(false);
  const [cacheStats, setCacheStats] = useState<CandleCacheStats | null>(null);
  // Current epic/resolution, readable from once-mounted callbacks without re-subscribing.
  const epicRef = useRef(symbol.epic);
  epicRef.current = symbol.epic;
  const resRef = useRef(period.resolution);
  resRef.current = period.resolution;
  // Active broker, readable from once-mounted callbacks (scroll-back) without re-subscribing.
  const brokerIdRef = useRef(brokerId);
  brokerIdRef.current = brokerId;
  // Scroll-back (getBars) reads refs, not props, so keep the live price side here.
  const priceSideRef = useRef(priceSide);
  priceSideRef.current = priceSide;
  // redraw() (a []-deps callback) reads the bid/ask setting + latest quote sides
  // through refs, not the captured props.
  const bidAskRef = useRef(bidAsk);
  bidAskRef.current = bidAsk;
  const bidAskStyleRef = useRef(bidAskStyle);
  bidAskStyleRef.current = bidAskStyle;
  const crosshairRef = useRef(crosshair);
  crosshairRef.current = crosshair;
  const bidRef = useRef<number | null>(null);
  const askRef = useRef<number | null>(null);
  // Current theme, readable from the once-mounted mousemove handler so the
  // legend-hover restyle doesn't snap back to the mount-time theme.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Scroll-back pagination state (reset per symbol/period load).
  const loadingRef = useRef(false); // re-entrancy guard
  const exhaustedRef = useRef(false); // no older history left
  const cursorSecRef = useRef(0); // unix-sec boundary we've loaded back to
  const emptyStreakRef = useRef(0); // consecutive empty windows (gap-walking)

  // Create the chart once (StrictMode-safe: init has no idempotent guard).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || inited.current) return;
    inited.current = true;
    const chart = init(el);
    if (!chart) return;
    chartRef.current = chart;
    // Seed the "scale price chart only" flag onto the live chart before any render
    // or indicator add, so the patched YAxisImp.calcRange fits candles-only from the
    // first frame (see chartController.scalePriceOnly). Read via a cast — it's an
    // app-owned property on the klinecharts instance, not part of its public type.
    (chart as unknown as { _scalePriceOnly?: boolean })._scalePriceOnly =
      scalePriceOnly.value;
    setChartReady(true);
    chart.setTimezone(timezone || browserTimezone());
    chart.setCustomApi({ formatDate: makeFormatDate(clock, dateFormat, showWeekday) });

    // Preload the Material Symbols subset the legend icons are drawn from, then
    // nudge a redraw — otherwise the first hover can paint before the canvas font
    // is ready and show blank icons.
    document.fonts
      ?.load("16px 'Material Symbols Outlined'")
      .then(() => chartRef.current?.setStyles(klineStyles(theme, legendHovered.value, crosshairRef.current)))
      .catch(() => {});

    // Indicator legend action icons (TradingView-style, configured in chartTheme):
    // gear opens the per-indicator settings modal, eye toggles visibility, ✕
    // removes. Removal is announced via indicatorRemoved so the Toolbar keeps its
    // active-set / paneByName / persisted list in sync (the legend bypasses it).
    chart.subscribeAction(
      ActionType.OnTooltipIconClick,
      (data?: { paneId: string; indicatorName: string; iconId: string }) => {
        const c = chartRef.current;
        if (!c || !data) return;
        const { paneId, indicatorName: name, iconId } = data;
        if (iconId === "setting") {
          indicatorSettingsRequest.set({ paneId, name });
        } else if (iconId === "visible_toggle") {
          const ind = c.getIndicatorByPaneId(paneId, name) as
            | { visible?: boolean }
            | null;
          const next = !(ind?.visible ?? true);
          c.overrideIndicator({ name, visible: next }, paneId);
          saveIndicatorVisible(scope, name, next);
        } else if (iconId === "remove") {
          c.removeIndicator(paneId, name);
          const next = controller.indicators.value.filter((i) => i.id !== name);
          controller.indicators.set(next);
          saveIndicators(scope, next);
          indicatorRemoved.set(name);
        }
      },
    );

    // Repaint the selection overlay. Our dots live on our OWN canvas (not
    // klinecharts'), so we just re-run the component's redraw (wired via ref once
    // mounted), which rebuilds the line cache and repaints the canvas.
    const repaint = () => redrawRef.current();

    // Chart clicks drive, in priority order:
    //  1. AVWAP anchor placement (while in anchor mode) — resolve x to a bar ts.
    //  2. TradingView-style indicator selection: a click on a candle-pane
    //     indicator's legend row, or near ANY indicator's curve (sub-panes
    //     included), selects it (hollow handles appear); a click on empty chart
    //     space deselects. Keyed by pane+name (v1 is one-instance-per-name).
    const onClick = (e: MouseEvent) => {
      const c = chartRef.current;
      if (!c) return;
      // Swallow the click that closes an anchor drag, so it doesn't deselect AVWAP.
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const anchoringId = avwapAnchorMode.value;
      if (anchoringId) {
        const pt = first(
          c.convertFromPixel([{ x, y }], { paneId: "candle_pane", absolute: true }),
        );
        if (typeof pt.timestamp !== "number") return;
        c.overrideIndicator({ name: anchoringId, calcParams: [pt.timestamp] });
        saveAvwapAnchor(scope, epicRef.current, anchoringId, pt.timestamp);
        avwapAnchorMode.set(null);
        return;
      }

      // The top-left legend is now DOM (<ChartLegend>): its rows handle their own
      // select-click and the eye/gear/trash icons their own clicks (pointer-events
      // on the rows; the container is pass-through). So here we only handle curve
      // hits on the canvas: a click near ANY indicator's curve (sub-panes included)
      // selects it; a click on empty chart space deselects.
      const hit = hitTestCache(lineCacheRef.current, x, y);
      if (hit) {
        const cur = selectedIndicator.value;
        if (cur?.paneId !== hit.paneId || cur?.name !== hit.name) {
          selectedIndicator.set({ paneId: hit.paneId, name: hit.name });
          repaint();
        }
      } else if (selectedIndicator.value) {
        selectedIndicator.set(null);
        repaint();
      }
      // Alert-line selection (chart -> panel). klinecharts doesn't fire onSelected
      // for these horizontal priceLines on a plain click, so we hit-test them here
      // ourselves. Single-click SELECTS (idempotent — re-selecting the same line is
      // a no-op, NOT a toggle: a toggle would make the first click after a fresh,
      // auto-selected create deselect, so selecting took two clicks). Deselection
      // happens via empty-space click or selecting another line. This is the
      // counterpart to the sidebar row click, so the two stay in sync.
      const alertHit = alertHitTest(x, y);
      if (alertHit) overlays.selectAlert(alertHit);
      else if (!hit) overlays.selectAlert(null);
      // Clear the drawing selection on an empty-space click. klinecharts fires
      // onSelected for drawings but NOT onDeselected on empty space (verified), so
      // mirror the indicator/alert deselect here. Skip when a drawing is under the
      // cursor — that click is selecting it (onSelected handles that).
      if (!hit && !alertHit && !overlays.getHoveredDrawingId()) overlays.selectDrawing(null);
      // Trade-line selection (chart -> dock). Single-click focuses THAT line (its pill
      // shows + dock row lights up) without opening the edit ticket — double-click
      // opens it. A click on empty space drops the trade.
      const tradeHit = tradeLineHitTest(x, y);
      if (tradeHit) selectTradeLine(tradeHit.id, tradeHit.field, false /* openPanel */);
      // Click on empty space drops the trade — UNLESS the edit ticket is open. Clicking
      // away from the lines must not slam an open ticket shut (you're still editing it);
      // it closes only via its own Cancel/✕/Escape, or by opening another trade.
      else if (!tradePanelOpen.value) setTradeSelected(null);
    };

    // Shared alert-line hit-test (used by single-click select and double-click
    // edit): returns the id of the alert line within HIT_TOLERANCE_PX of (x,y) in
    // the candle pane (not the axis column), or null.
    const alertHitTest = (x: number, y: number): string | null => {
      const c = chartRef.current;
      if (!c) return null;
      const mainW = c.getSize("candle_pane", DomPosition.Main)?.width ?? Infinity;
      if (x > mainW) return null;
      for (const a of overlays.getAlerts()) {
        const ay = first(
          c.convertToPixel([{ value: a.level }], { paneId: "candle_pane", absolute: true }),
        ).y;
        if (ay != null && Math.abs(ay - y) <= HIT_TOLERANCE_PX) return a.id;
      }
      return null;
    };

    // This cell's trade lines, each resolved to a pixel-y ONCE — the single source
    // for the hover hit-test, the drag-grab test, AND the magnet/snap. Built from the
    // SAME tradeLineSpecs that draws the lines (current hidden/hovered/selected
    // applied) so a hidden, un-revealed line isn't hittable and it matches exactly
    // what's on screen. The draft (un-submitted) order is included (it has no dock
    // row but IS a snap target); consumers that don't want it filter on DRAFT_ID.
    // Computing it once per mousemove avoids rebuilding the spec list and re-running
    // convertToPixel per line in two separate places on the hot path.
    type TradeLinePx = {
      id: string;
      field: TradeLineField;
      level: number;
      draggable: boolean;
      y: number | undefined;
    };
    const tradeLinePixels = (): TradeLinePx[] => {
      const c = chartRef.current;
      if (!c) return [];
      const specs = tradeLineSpecs({
        trades: tradesRef.current,
        pending: pendingRef.current,
        epic: epicRef.current,
        precision: precisionRef.current,
        levelsDraggable: true,
        onDrag: () => {},
        draft: draftRef.current,
        hidden: new Set(tradeUiRef.current.hidden),
        hovered: tradeUiRef.current.hovered,
        selected: tradeUiRef.current.selected,
      });
      return specs.map((s) => {
        const sep = s.key.lastIndexOf(":");
        return {
          id: s.key.slice(0, sep),
          field: s.key.slice(sep + 1) as TradeLineField, // "price" | "stop" | "tp"
          level: s.level,
          draggable: s.draggable,
          y: first(
            c.convertToPixel([{ value: s.level }], { paneId: "candle_pane", absolute: true }),
          ).y,
        };
      });
    };

    // Trade-line hit-test (chart -> dock, for hover + click-select): the TRADE id +
    // field of the entry/SL/TP line within HIT_TOLERANCE_PX of (x,y) in the candle
    // pane, or null. A locked position-entry line ignores klinecharts overlay events,
    // so this manual test (not onMouseEnter) covers every line. Excludes the draft.
    const tradeLineHitTest = (
      x: number,
      y: number,
    ): { id: string; field: TradeLineField } | null => {
      const c = chartRef.current;
      if (!c) return null;
      const mainW = c.getSize("candle_pane", DomPosition.Main)?.width ?? Infinity;
      if (x > mainW) return null;
      let best: { id: string; field: TradeLineField; d: number } | null = null;
      for (const t of tradeLinePixels()) {
        if (t.id === DRAFT_ID || t.y == null) continue;
        const d = Math.abs(t.y - y);
        if (d <= HIT_TOLERANCE_PX && (!best || d < best.d)) best = { id: t.id, field: t.field, d };
      }
      return best ? { id: best.id, field: best.field } : null;
    };

    // Double-click an alert line -> open the edit modal (prefilled). Uses the same
    // DOM hit-test (klinecharts' overlay dblclick is unreliable for these lines).
    const onDblClick = (e: MouseEvent) => {
      const c = chartRef.current;
      if (!c) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Double-click a trade line -> force the edit ticket open. Using openTradeEditor
      // rather than selectTradeLine because a dblclick is preceded by two clicks that
      // may have toggled selection back to its start state — force-set unconditionally.
      const tradeHit = tradeLineHitTest(x, y);
      if (tradeHit) {
        openTradeEditor(tradeHit.id, tradeHit.field);
        return;
      }
      const id = alertHitTest(x, y);
      if (id) {
        alertEditRequest.set({ id });
        return;
      }
      // Double-click a drawing -> open its TV-style settings modal. hoveredDrawingId
      // is set by the overlay's onMouseEnter, so it's reliable here.
      const drawingId = overlays.getHoveredDrawingId();
      if (drawingId) {
        drawingSettingsRequest.set({ id: drawingId });
        return;
      }
      // Double-click an indicator's curve -> open its settings (TradingView-style).
      const hit = hitTestCache(lineCacheRef.current, x, y);
      if (hit) indicatorSettingsRequest.set({ paneId: hit.paneId, name: hit.name });
    };

    // Right-click the chart -> our context menu (Paste an indicator). Suppress the
    // native browser menu. Skip the price-axis column (klinecharts owns that).
    const onContextMenu = (e: MouseEvent) => {
      const c = chartRef.current;
      if (!c) return;
      // If the right-click landed on a drawing, klinecharts has already fired the
      // overlay's own onRightClick (→ the Toolbar's Lock/Settings/Delete menu).
      // Yield: don't ALSO open the empty-space "Paste indicator" menu, which would
      // clobber it. (This was the bug that made drawings feel non-editable: the
      // Paste menu always won.) hoveredDrawingId is set by the overlay's
      // onMouseEnter, so it's reliably current here — no event-ordering race.
      if (overlays.getHoveredDrawingId()) return;
      const rect = el.getBoundingClientRect();
      // overPriceAxis (defined below, initialized before this listener ever fires)
      // is the shared "is the cursor in the right-hand y-axis column" test — reused
      // here so the axis-menu region can't drift from the drag/double-click gestures.
      if (overPriceAxis(e)) {
        // The y-axis column spans the FULL chart height, but "Scale price chart only"
        // only affects the candle pane. Restrict the toggle to the candle pane's own
        // axis strip (the topmost pane); a right-click on a sub-pane (RSI/MACD/Volume)
        // axis falls through to native behavior, since the toggle can't scale it.
        const candleH = c.getSize("candle_pane", DomPosition.Main)?.height ?? 0;
        if (candleH && e.clientY - rect.top <= candleH) {
          e.preventDefault();
          setAxisMenu({ x: e.clientX, y: e.clientY });
        }
        return;
      }
      e.preventDefault();
      setChartMenu({ x: e.clientX, y: e.clientY });
    };

    // AVWAP anchor drag. When AVWAP is selected and the cursor presses on its
    // anchor handle, we steal the gesture from klinecharts (capture-phase
    // stopPropagation, so its mousedown — and thus chart panning — never starts)
    // and re-anchor on each move. Persist on release.
    const onAnchorMove = (ev: MouseEvent) => {
      if (!draggingAnchorRef.current) return;
      dragMovedRef.current = true;
      const r = el.getBoundingClientRect();
      pendingAnchorXRef.current = ev.clientX - r.left;
      if (anchorRafRef.current) return; // coalesce to one recalc per frame
      anchorRafRef.current = requestAnimationFrame(() => {
        anchorRafRef.current = 0;
        const c = chartRef.current;
        if (!c || !draggingAnchorRef.current) return;
        const pt = first(
          c.convertFromPixel([{ x: pendingAnchorXRef.current }], {
            paneId: "candle_pane",
            absolute: true,
          }),
        );
        if (typeof pt.timestamp !== "number") return;
        const id = selectedAvwapId(c, selectedIndicator.value);
        if (!id) return;
        c.overrideIndicator({ name: id, calcParams: [pt.timestamp] });
        repaint();
      });
    };
    const onAnchorUp = () => {
      if (!draggingAnchorRef.current) return;
      draggingAnchorRef.current = false;
      if (anchorRafRef.current) {
        cancelAnimationFrame(anchorRafRef.current);
        anchorRafRef.current = 0;
      }
      window.removeEventListener("mousemove", onAnchorMove);
      window.removeEventListener("mouseup", onAnchorUp, true);
      const c = chartRef.current;
      const id = c ? selectedAvwapId(c, selectedIndicator.value) : null;
      const ind = id
        ? (c?.getIndicatorByPaneId("candle_pane", id) as Indicator | null | undefined)
        : null;
      const ts = Number(ind?.calcParams?.[0]) || 0;
      if (id && ts > 0) saveAvwapAnchor(scope, epicRef.current, id, ts);
      // A real drag must not also fire the click→deselect that follows mouseup.
      // The synthesized click (if any) consumes this synchronously; the timeout
      // self-clears it when the release was OFF the chart (toolbar/legend), where
      // no click is synthesized — so the flag can't get stuck and swallow a later
      // legitimate click.
      if (dragMovedRef.current) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 0);
      }
      if (cursorModeRef.current === "cur-grabbing") {
        cursorModeRef.current = "cur-grab";
        setCursorMode("cur-grab");
      }
    };
    const onAnchorDown = (e: MouseEvent) => {
      if (e.button !== 0 || avwapAnchorMode.value) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return; // placing a measure anchor
      const c0 = chartRef.current;
      if (!c0 || !selectedAvwapId(c0, selectedIndicator.value)) return;
      const a = anchorPxRef.current;
      if (!a) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (Math.hypot(x - a.x, y - a.y) > ANCHOR_GRAB_PX) return;
      // Grab it: block klinecharts' pan and begin dragging the anchor.
      e.preventDefault();
      e.stopPropagation();
      draggingAnchorRef.current = true;
      dragMovedRef.current = false;
      justDraggedRef.current = false; // fresh gesture
      cursorModeRef.current = "cur-grabbing";
      setCursorMode("cur-grabbing");
      window.addEventListener("mousemove", onAnchorMove);
      window.addEventListener("mouseup", onAnchorUp, true);
    };

    // --- Manual horizontal-line drag (trade SL/TP/entry + alert lines) ---
    // klinecharts only drags these overlays once they're already selected (a first press
    // on an unselected line reads as a click), so we drive the drag ourselves: a press
    // anywhere the ns-resize cursor shows grabs the nearest draggable line on the FIRST
    // press, selected or not. Both line kinds share one state machine (makeLineDrag) and
    // differ only in three seams: what it grabs (`grab`), what a move does (`onMove`), and
    // what a release does (`onCommit`). The shared plumbing — first-move detection, the
    // y→price convert, the window listener add/remove pairing, and the justDraggedRef
    // trailing-click swallow — lives in one place. A press hands the gesture to whichever
    // kind has the GLOBALLY nearest line (the registry below), so a nearer alert beats a
    // farther trade and vice-versa.
    type LineHit = { d: number }; // pixel distance from the press to the line it found
    type LineGrab = { d: number; begin: () => void }; // a found line, ready to start dragging
    type LineDrag = {
      // Probe for the nearest grabbable line of this kind at pixel y; null if none in band.
      tryGrab: (yPix: number) => LineGrab | null;
      isActive: () => boolean; // a drag of this kind is in flight (window listeners live)
      dispose: () => void; // drop window listeners NOW (unmount mid-drag; teardown can't
      // wait for onUp, which fires on window and may never come if the cell is gone)
    };
    // One drag state machine. `grab(y)` returns the kind's nearest hit (with its pixel
    // distance `d`); `onMove(hit, level)` is fed the price at the cursor's y on each move
    // after the first; `onBegin(hit)` runs once on that first move; `onCommit(hit, moved)`
    // runs on release and returns whether to swallow the trailing click.
    const makeLineDrag = <H extends LineHit>(spec: {
      grab: (yPix: number) => H | null;
      onBegin?: (hit: H) => void;
      onMove: (hit: H, level: number, chart: Chart) => void;
      onCommit: (hit: H, moved: boolean) => boolean;
      // Tear down an IN-FLIGHT drag's transient side-effects without committing it —
      // run from dispose() on unmount-mid-drag, where onCommit must NOT fire (no
      // persist/select on a dying cell), but a begin-side-effect on a GLOBAL signal
      // would otherwise stick true forever.
      onAbort?: (hit: H) => void;
    }): LineDrag => {
      let active: H | null = null;
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        const c = chartRef.current;
        if (!active || !c) return;
        const r = el.getBoundingClientRect();
        const pt = first(
          c.convertFromPixel([{ y: ev.clientY - r.top }], { paneId: "candle_pane", absolute: true }),
        );
        if (pt.value == null) return;
        if (!moved) {
          moved = true;
          spec.onBegin?.(active);
        }
        spec.onMove(active, pt.value, c);
      };
      const onUp = () => {
        const hit = active;
        if (!hit) return;
        active = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        if (spec.onCommit(hit, moved)) {
          // Swallow the trailing click so it can't undo what the release just did. The
          // synthesized click (if any) consumes this synchronously; the timeout self-
          // clears it when the release was OFF the chart (where no click fires), so the
          // flag can't get stuck and swallow a later legitimate click.
          justDraggedRef.current = true;
          setTimeout(() => { justDraggedRef.current = false; }, 0);
        }
      };
      const start = (hit: H) => {
        active = hit;
        moved = false;
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp, true);
      };
      return {
        tryGrab: (yPix) => {
          const hit = spec.grab(yPix);
          return hit ? { d: hit.d, begin: () => start(hit) } : null;
        },
        isActive: () => active != null,
        dispose: () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp, true);
          if (active) spec.onAbort?.(active); // drop an in-flight drag's transient state
          active = null;
        },
      };
    };

    // Trade lines (SL / TP / order-entry, plus a staged limit's draft entry/SL/TP).
    // Nearest DRAGGABLE line within ALERT_SNAP_PX of pixel y — the same band that shows
    // the ns-resize cursor. onMove routes a DRAFT_ID drag to the draft order instead of a
    // server-trade pending edit.
    const grabbableTradeLine = (yPix: number): { id: string; field: TradeLineField; d: number } | null => {
      let best: { id: string; field: TradeLineField; d: number } | null = null;
      for (const t of tradeLinePixels()) {
        if (!t.draggable || t.y == null) continue;
        const d = Math.abs(t.y - yPix);
        if (d <= ALERT_SNAP_PX && (!best || d < best.d)) best = { id: t.id, field: t.field, d };
      }
      return best;
    };
    const tradeDrag = makeLineDrag<{ id: string; field: TradeLineField; d: number }>({
      grab: grabbableTradeLine,
      onBegin: () => draggingLineSignal.set(true), // pause no-confirm auto-apply until the drop
      onMove: (hit, value, c) => {
        let level = Number(value.toFixed(precisionRef.current));
        // A staged DRAFT line (limit-order entry / SL / TP) edits the draft order, not a
        // server trade — route it there and bail. The backend validates levels on submit,
        // so no client-side clamp here (matches the draft's old native-drag behaviour).
        if (hit.id === DRAFT_ID) {
          const d = draftOrderSignal.value;
          if (d) {
            const key = hit.field === "tp" ? "takeProfit" : hit.field; // price|stop|takeProfit
            draftOrderSignal.set({ ...d, [key]: level });
            paintBracketRef.current(); // keep the draft's bracket glued while dragging
          }
          return;
        }
        // Keep SL/TP on the valid side of the latest price (long: SL below / TP above;
        // short: reversed) — clamp so the line can't be dragged across it.
        const trade = tradesRef.current.find((t) => t.id === hit.id);
        if (trade && (hit.field === "stop" || hit.field === "tp")) {
          const last = getLivePrice(epicRef.current) ?? c.getDataList().at(-1)?.close;
          if (last != null) {
            const tick = Number((10 ** -precisionRef.current).toFixed(precisionRef.current));
            level = Number(
              clampLevelToPrice(hit.field, trade.side, last, level, tick).toFixed(precisionRef.current),
            );
          }
        }
        const pendKey = hit.field === "tp" ? "takeProfit" : hit.field;
        const cur = pendingEditsSignal.value;
        pendingEditsSignal.set({ ...cur, [hit.id]: { ...cur[hit.id], [pendKey]: level } });
        // Keep the bracket glued to the line AS it drags. The pending-edit subscription
        // only repaints on the next rAF, so the line (redrawn synchronously) would
        // otherwise pull ahead of its spine/legs for a frame — repaint now, in lockstep.
        paintBracketRef.current();
        // Confirm mode: focus the dragged line so its pill (Apply/Discard) shows — but
        // openPanel=false, so DRAGGING a line never pops the edit ticket open (only an
        // explicit double-click does). No-confirm mode leaves selection alone (the dock
        // auto-applies on the drop).
        if (confirmLineEditsRef.current) setTradeSelected(hit.id, hit.field, false);
      },
      onCommit: (_hit, moved) => {
        // A press with no move is a plain click → let onClick select/toggle (don't swallow).
        if (!moved) return false;
        draggingLineSignal.set(false); // let no-confirm auto-apply commit the final level
        // A real drag must not also fire the trailing click (which would toggle the
        // just-focused line's selection back off) — swallow it.
        return true;
      },
      // draggingLineSignal is a GLOBAL signal (pauses no-confirm auto-apply across every
      // cell). If this cell unmounts mid-drag, onCommit never runs — reset it here so it
      // can't stay paused forever. Idempotent: harmless if the drag never moved.
      onAbort: () => draggingLineSignal.set(false),
    });

    // Alert lines. klinecharts' native alert drag only engages on a press dead-on the
    // line after a separate selecting click, so a press in the magnet band reads as a
    // click, never a drag. We grab the nearest alert within the band on the FIRST press
    // and drive it ourselves (overlays.beginAlertDrag/dragAlertTo/endAlertDrag), so a
    // crosshair snap means the line is immediately draggable.
    const grabbableAlert = (yPix: number): { id: string; d: number } | null => {
      const c = chartRef.current;
      if (!c) return null;
      let best: { id: string; d: number } | null = null;
      for (const al of overlays.getAlerts()) {
        const ay = first(
          c.convertToPixel([{ value: al.level }], { paneId: "candle_pane", absolute: true }),
        ).y;
        if (ay == null) continue;
        const d = Math.abs(ay - yPix);
        if (d <= ALERT_SNAP_PX && (!best || d < best.d)) best = { id: al.id, d };
      }
      return best;
    };
    const alertDrag = makeLineDrag<{ id: string; d: number }>({
      grab: grabbableAlert,
      onBegin: (hit) => overlays.beginAlertDrag(hit.id), // hide the "+" and glue the label, like the native drag
      onMove: (hit, value) => overlays.dragAlertTo(hit.id, value),
      onCommit: (hit, moved) => {
        // A real drag quantizes + persists; a press with no move is a plain click → select.
        if (moved) {
          overlays.endAlertDrag(hit.id);
        } else {
          overlays.selectAlert(hit.id);
          // We swallow the trailing click below, but that click is the ONLY path that
          // enforces single-selection across types (it clears a selected indicator/trade).
          // Mirror that cross-type deselect here so selecting an alert still drops them —
          // otherwise a previously-selected trade/indicator stays lit alongside the alert.
          if (selectedIndicator.value) { selectedIndicator.set(null); repaint(); }
          if (!tradePanelOpen.value) setTradeSelected(null);
        }
        // Either way, swallow the trailing click: onClick's alertHitTest uses the tighter
        // HIT_TOLERANCE_PX, so a click inside the wider magnet band would otherwise miss
        // and deselect (or toggle) the very line we just grabbed.
        return true;
      },
    });

    // The registry: one capture-phase mousedown grabs the GLOBALLY nearest line across
    // all kinds. Trade is listed first, so an equal-distance press grabs the trade (an
    // alert must be strictly closer to win) — preserving the prior precedence where the
    // trade handler ran first and only declined to a strictly-nearer alert.
    const lineDrags: LineDrag[] = [tradeDrag, alertDrag];
    const onLineDown = (e: MouseEvent) => {
      if (e.button !== 0 || avwapAnchorMode.value || e.metaKey || e.ctrlKey) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return; // placing a measure anchor
      const c = chartRef.current;
      if (!c) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const mainW = c.getSize("candle_pane", DomPosition.Main)?.width ?? Infinity;
      if (x > mainW) return; // the y-axis strip is a scale gesture, not a line grab
      let winner: LineGrab | null = null;
      for (const drag of lineDrags) {
        const g = drag.tryGrab(y);
        if (g && (!winner || g.d < winner.d)) winner = g;
      }
      if (!winner) return;
      // Grab it: block klinecharts' pan, its own (selection-gated) overlay drag, AND its
      // click-select (we select ourselves on a no-move release).
      e.preventDefault();
      e.stopPropagation();
      winner.begin();
    };

    // ⌘/Ctrl-drag clone (TradingView-style): pressing ⌘ on a drawing leaves a copy
    // behind and drags the original. We clone IN PLACE on the ⌘-mousedown and do
    // NOT stopPropagation — klinecharts then drags the overlay the press targeted,
    // so the duplicate stays at the source position. hoveredDrawingId is the
    // pressed drawing (set by its onMouseEnter). Left button only; never in anchor
    // mode (the AVWAP handler above already claimed those presses).
    const onClonePress = (e: MouseEvent) => {
      if (e.button !== 0 || (!e.metaKey && !e.ctrlKey) || avwapAnchorMode.value) return;
      const id = overlays.getHoveredDrawingId();
      if (!id) return;
      const d = overlays.getDrawing(id);
      if (!d || d.lock) return;
      overlays.placeDrawing({
        name: d.name,
        points: d.points,
        styles: d.styles,
        visible: d.visible,
        zLevel: d.zLevel,
        extendData: d.extendData,
      });
    };

    // --- Measure ruler (TradingView-style) ---
    // A transient two-point overlay drawn by CLICK, like the Draw-menu tools: arm it
    // (ruler button, or hold Shift), click to set the start, move, click to set the
    // end. klinecharts collects the two anchors — no press-drag. On completion the
    // box freezes and the tool disarms (one-shot). The frozen box is discarded on the
    // next plain press, Esc, or a symbol/interval change. Nothing is persisted.
    //
    // Arming and the draw are wired to the measureArmed signal in a separate effect
    // (subscribe → startMeasureDraw; measureDone → disarm). These two capture-phase
    // presses are the remaining pieces: reserve a Shift press for measuring, and
    // clear a frozen box on a plain press. Neither stops propagation — klinecharts
    // must still receive the press to place the anchor. Registered FIRST so arming
    // via Shift flips measureArmed before the line/clone/anchor handlers run (they
    // bail while measuring), keeping every placing click for the ruler.
    const onMeasureShift = (e: MouseEvent) => {
      if (e.button !== 0 || !e.shiftKey) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return;
      // The price-axis strip is a scale gesture, not a measurement.
      const c = chartRef.current;
      const mainW = c?.getSize("candle_pane", DomPosition.Main)?.width ?? Infinity;
      if (e.clientX - el.getBoundingClientRect().left > mainW) return;
      measureArmed.set(true); // → startMeasureDraw() synchronously; THIS click sets the start
    };
    const onMeasureClear = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey) return;
      // Only a plain press with a FROZEN box (not armed, not mid-draw) clears it.
      if (measureArmed.value || overlays.isMeasureDrawing()) return;
      if (overlays.hasMeasure()) overlays.clearMeasure();
    };

    // TradingView-style "A" auto-scale: pressing on the price-axis column (the
    // strip right of the candle pane) is a manual y-axis scale gesture, so it
    // exits auto mode and the toolbar "A" de-highlights. Re-enabled by clicking
    // "A" (Toolbar.autoFit). Capture phase so it sees the press before the chart.
    // True when the pointer x is within the price-axis column (right of the
    // candle pane's main area). Shared by the press (exit auto) and double-click
    // (re-enter auto) handlers below.
    const overPriceAxis = (e: MouseEvent): boolean => {
      const c = chartRef.current;
      const mainW = c?.getSize("candle_pane", DomPosition.Main)?.width ?? 0;
      if (!mainW) return false;
      return e.clientX - el.getBoundingClientRect().left > mainW;
    };
    const onAxisDown = (e: MouseEvent) => {
      if (e.button !== 0 || !autoScale.value) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return; // measuring owns the press
      if (overPriceAxis(e)) autoScale.set(false);
    };
    // Double-clicking the price-axis column resets to auto-scale (TV behaviour):
    // re-fit the price axis and re-highlight the toolbar "A".
    const onAxisDblClick = (e: MouseEvent) => {
      if (e.button !== 0 || !overPriceAxis(e)) return;
      // Re-applying the current y-axis type recomputes the fit, clearing any
      // manual zoom (matches Toolbar.autoFit).
      const type = chartRef.current?.getStyles().yAxis.type;
      chartRef.current?.setStyles({ yAxis: { type } });
      autoScale.set(true);
    };
    // True when the pointer y is within the time-axis strip (below the candle
    // pane's main area). Mirrors overPriceAxis but for the bottom edge.
    const overTimeAxis = (e: MouseEvent): boolean => {
      const c = chartRef.current;
      const xAxisH = c?.getSize("x_axis_pane", DomPosition.Root)?.height ?? 0;
      if (!xAxisH) return false;
      const rect = el.getBoundingClientRect();
      return e.clientY - rect.top > rect.height - xAxisH;
    };
    // Double-clicking the time-axis strip resets the bar spacing to its
    // default (TV behaviour) WITHOUT moving the view — mirrors onAxisDblClick,
    // which only re-fits the price axis and never pans it either. Anchored at
    // the pane's right edge (matching plain setBarSpace's natural anchor, which
    // holds the right-offset fixed) via zoomAtCoordinate rather than
    // chart.setBarSpace directly: setBarSpace never fires klinecharts'
    // ActionType.OnZoom, so the lock-charts date-range sync below (subscribed
    // to OnZoom/OnScroll) would silently fail to mirror this reset to sibling
    // cells. zoomAtCoordinate goes through the same zoom() path a wheel-zoom
    // gesture does, so it fires OnZoom like any other zoom.
    const onTimeAxisDblClick = (e: MouseEvent) => {
      if (e.button !== 0 || !overTimeAxis(e)) return;
      const c = chartRef.current;
      const cur = c?.getBarSpace();
      const mainW = c?.getSize("candle_pane", DomPosition.Main)?.width;
      if (!c || !cur || !mainW) return;
      c.zoomAtCoordinate(DEFAULT_BAR_SPACE / cur, { x: mainW });
    };

    // A removed indicator (legend trash icon) must drop its selection, or a
    // re-added same-name indicator would appear pre-selected.
    const unsubRemoved = indicatorRemoved.subscribe((name) => {
      if (selectedIndicator.value?.name === name) {
        selectedIndicator.set(null);
        repaint();
      }
    });

    // Show/move (or clear) our self-drawn horizontal crosshair line, repainting the
    // overlay only when it actually changes so it isn't redrawn every mousemove.
    const setPlusCrosshair = (ny: number | null) => {
      if (plusCrosshairYRef.current !== ny) {
        plusCrosshairYRef.current = ny;
        repaint();
      }
    };

    // "+" affordance follows the cursor's price on the right axis (TV-style).
    const onMove = (e: MouseEvent) => {
      const c = chartRef.current;
      const btn = plusBtnRef.current;
      if (!c) return;
      if (draggingAnchorRef.current || tradeDrag.isActive()) return; // window listeners drive the drag
      const r = el.getBoundingClientRect();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      // Legend hover (crosshair-hide + per-row icons/highlight) is now owned by the
      // DOM <ChartLegend> via its own mouse events — nothing to do here.
      // Cursor affordance: hand over a selectable indicator curve, else the chart's
      // crosshair. Driven by a class (klinecharts sets cursor on the canvas itself,
      // beating an inline cursor on an ancestor); updated only on a mode change.
      // A hand cursor over a selectable indicator curve OR a hovered drawing
      // overlay (klinecharts tracks the latter via the overlay's onMouseEnter,
      // mirrored into overlays.hoveredDrawingId). Both signal "click to select".
      // Hit-test the cursor against indicator curves ONCE: drives the hand cursor,
      // the legend-card highlight, AND the curve's selected-mode handles (curveHover).
      // Excludes hovered drawings — a drawing isn't an indicator, so it must not light
      // up a legend. hitTestCache returns a fresh object each call, so compare fields.
      const curveHit = avwapAnchorMode.value
        ? null
        : hitTestCache(lineCacheRef.current, lx, ly);
      const ch = curveHover.value;
      if (ch?.paneId !== curveHit?.paneId || ch?.name !== curveHit?.name) {
        curveHover.set(curveHit);
      }
      const overLine =
        !avwapAnchorMode.value &&
        (!!curveHit || !!overlays.getHoveredDrawingId());
      // Over the AVWAP anchor handle (only painted when AVWAP is selected): a grab
      // cursor signals it's draggable, taking priority over the curve's hand.
      // anchorPxRef is non-null only when an AVWAP instance is selected and on-screen
      // (set in redraw), so its presence already implies "AVWAP selected".
      const a = anchorPxRef.current;
      const overAnchor =
        !avwapAnchorMode.value &&
        !!a &&
        Math.hypot(lx - a.x, ly - a.y) <= ANCHOR_GRAB_PX;
      const nextCursor = avwapAnchorMode.value
        ? ""
        : overAnchor
          ? "cur-grab"
          : overLine
            ? "cur-pointer"
            : "";
      if (nextCursor !== cursorModeRef.current) {
        cursorModeRef.current = nextCursor;
        setCursorMode(nextCursor);
      }
      if (!btn || plusMenuOpenRef.current) return;
      if (avwapAnchorMode.value) {
        btn.style.display = "none"; // don't compete with anchor-placement clicks
        setPlusCrosshair(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Pills follow the cursor while their line is merely hovered (a click-
      // selected line's pill stays frozen so its delete button is reachable). Run
      // this BEFORE the "+"-hover early-return below, so the pill keeps tracking the
      // cursor even while it's parked over the "+" affordance.
      cursorXRef.current = x;
      // Over the price-axis column the pill is hidden entirely (gated in render), so
      // skip repositioning it there; otherwise keep non-selected pills at the cursor.
      const mainW = c.getSize("candle_pane", DomPosition.Main)?.width ?? rect.width;
      const nextOnAxis = x > mainW;
      if (nextOnAxis !== onAxisRef.current) {
        onAxisRef.current = nextOnAxis;
        setOnAxis(nextOnAxis);
      }
      if (!nextOnAxis && pillNodesRef.current.size) {
        const selectedId = overlays.getSelectedAlertId();
        // A pill freezes the instant its line is hovered (same as a click-selected
        // pill) so reaching its delete button is a straight line, not a chase — see
        // registerPill's initial placement above for the one-time position on mount.
        const hoveredId = overlays.getHoveredAlertId();
        for (const [id, node] of pillNodesRef.current) {
          if (id !== selectedId && id !== hoveredId) positionPill(node);
        }
      }
      // This cell's trade lines, resolved to pixel-y ONCE for both the dock-hover
      // mirror just below AND the magnet/snap further down (was built twice/move).
      const tlp = tradeLinePixels();
      // Chart -> dock hover: highlight the dock row for the trade line under the
      // cursor (null over the axis or empty space). Mirrors the dock row's own
      // onMouseEnter so hovering a line and hovering a row light up the same pair.
      // The cursor is over EITHER the chart or a dock row at any moment (never
      // both), so this and the row handler never fight over `hovered`.
      let hoverTradeId: string | null = null;
      if (!nextOnAxis) {
        let bestD = Infinity;
        for (const t of tlp) {
          if (t.id === DRAFT_ID || t.y == null) continue; // the draft has no dock row
          const d = Math.abs(t.y - y);
          if (d <= HIT_TOLERANCE_PX && d < bestD) { bestD = d; hoverTradeId = t.id; }
        }
      }
      setTradeHovered(hoverTradeId);
      // Repaint the bracket now that BOTH the cursor x (spine) and the hover gate are
      // current for this move — so parking on a line shows it at once, and leaving the
      // lines (nothing selected) clears it. Cheap: a no-op clear when nothing's active.
      paintBracketRef.current();
      // Over ANY alert line — selected or not — the WHOLE "+" affordance (circle + price
      // box) stays and looks IDENTICAL to a normal hover: the price readout is ALWAYS
      // visible (the box, z-49, reads on top of the never-hidden amber tag), the shape
      // never changes as the cursor crosses a line. We only make it click-THROUGH
      // (`.passthrough` → pointer-events:none) over a line so the mousedown reaches the
      // canvas and selects/drags the line underneath instead of being swallowed by the
      // "+" circle that protrudes into the pane. We union getHoveredAlertId (klinecharts'
      // native onMouseEnter, which can FALSE-NEGATIVE) with a direct alertHitTest so the
      // line is detected in both bands. ONLY EXCEPTION: while DRAGGING a line, hide the
      // affordance entirely (the price box would fight the drag).
      const overAlertId = overlays.getHoveredAlertId() ?? alertHitTest(x, y);
      // Magnet: the nearest alert line within ALERT_SNAP_PX of the cursor. When set, the
      // price guide snaps onto that line's exact level/y below (so the readout locks to the
      // alert's price and the "+" aligns dead-on the line), and the affordance also goes
      // click-through (so a click there still selects/drags the line under it).
      // Snap targets: alert lines PLUS every trade line (entry/limit, SL, TP for
      // open positions, resting orders, and the staged draft) on this epic — built
      // from the same tradeLineSpecs that draws them, so the magnet locks onto the
      // exact level shown. The price guide snaps to the nearest within ALERT_SNAP_PX.
      // Each target carries whether its line is draggable, so when the crosshair
      // snaps to a draggable one we can show the ns-resize cursor right away (even
      // a few px off the line), matching the on-line hover affordance. Alert lines
      // are draggable; trade lines use their spec's `draggable` (a filled
      // position's entry is not).
      const snapTargets: { y: number; level: number; draggable: boolean; isTrade?: boolean; alertId?: string }[] = [];
      for (const al of overlays.getAlerts()) {
        const ay = first(
          c.convertToPixel([{ value: al.level }], { paneId: "candle_pane", absolute: true }),
        ).y;
        if (ay != null) snapTargets.push({ y: ay, level: al.level, draggable: true, alertId: al.id });
      }
      // Trade lines reuse tlp's already-resolved pixel-y (no re-convert). Hidden,
      // un-revealed lines are absent from tlp, so the magnet won't lock onto them.
      for (const t of tlp) {
        if (t.y != null) snapTargets.push({ y: t.y, level: t.level, draggable: t.draggable, isTrade: true });
      }
      let snapTarget: { y: number; level: number; draggable: boolean; isTrade?: boolean; alertId?: string } | null = null;
      for (const t of snapTargets) {
        if (Math.abs(t.y - y) <= ALERT_SNAP_PX &&
            (snapTarget == null || Math.abs(t.y - y) < Math.abs(snapTarget.y - y))) {
          snapTarget = t;
        }
      }
      // Snapping the crosshair onto an alert line auto-hovers it (emphasis + on-line
      // pill), so the line the guide locked to is immediately the one a press will
      // grab — no waiting for klinecharts' tighter, false-negative-prone onMouseEnter.
      // The magnet band is a superset of that hit band, so the snap can own hover:
      // set it while snapped, clear it on leave (but only the hover WE set, so a
      // sidebar-row hover on a different line is left alone). Skipped mid-drag: the
      // isDraggingAlert guard below returns BEFORE the hover mutation, so a drag past a
      // neighbouring alert can't momentarily emphasise it (and snapTarget here is stale,
      // built from the alert's pre-move y anyway — the alertDrag move drives the real drag).
      if (overlays.isDraggingAlert()) {
        btn.classList.remove("passthrough");
        btn.style.display = "none";
        setPlusCrosshair(null);
        if (snapActiveRef.current) { overlays.setSuppressNativeLine(false); snapActiveRef.current = false; }
        return;
      }
      const snapAlertId = snapTarget && !snapTarget.isTrade ? snapTarget.alertId ?? null : null;
      if (snapAlertId) {
        if (overlays.getHoveredAlertId() !== snapAlertId) overlays.hoverAlert(snapAlertId);
      } else if (snapHoverRef.current && overlays.getHoveredAlertId() === snapHoverRef.current) {
        overlays.hoverAlert(null);
      }
      snapHoverRef.current = snapAlertId;
      // Suppress the klinecharts native horizontal crosshair line while snapping. The
      // native line tracks the cursor's y (a few px off the snapped line), so leaving
      // it on would double the alert/trade line. We DON'T replace it with our own line
      // either (see setPlusCrosshair below) — the alert/trade line is the only guide.
      const nextSnap = snapTarget != null;
      if (nextSnap !== snapActiveRef.current) {
        snapActiveRef.current = nextSnap;
        overlays.setSuppressNativeLine(nextSnap);
      }
      // Snapped to a DRAGGABLE line (within the band, not just on it): show the
      // ns-resize cursor immediately, like the on-line hover affordance. Done via
      // the single-select cursorMode (not a CSS class) so it OVERRIDES the curve-
      // hover "pointer" — dragging a line beats selecting a curve — rather than
      // losing a specificity fight. Off on the axis (x > mainW).
      if (
        snapTarget?.draggable === true &&
        x <= mainW &&
        (cursorModeRef.current as string) !== "cur-ns"
      ) {
        cursorModeRef.current = "cur-ns";
        setCursorMode("cur-ns");
      }
      btn.classList.toggle("passthrough", overAlertId != null || snapTarget != null);
      // Hide the "+" pill the moment the cursor crosses onto the price-axis strip
      // (x > mainW), even when it's over the "+" itself. The axis is a drag/scale
      // gesture zone; a DOM button sitting there with pointer-events:auto would
      // swallow the mousedown and block y-axis scaling. The "+" icon protrudes left
      // of mainW into the candle pane, so it stays reachable while the cursor is in
      // the pane — only the on-axis portion is sacrificed.
      const overPlus = btn.contains(e.target as Node);
      // The "+" is a quick-create PRICE-alert affordance and its price box reads the
      // candle_pane scale — meaningless over a sub-pane (RSI/MACD/Volume), whose y-axis
      // is an indicator value, not a price. Below the candle pane's bottom edge, hide the
      // affordance entirely (like the on-axis guard) so klinecharts' own crosshair label
      // shows that pane's value on its y-axis. Done before any box positioning so crossing
      // the separator never flashes a stale price.
      // klinecharts only populates a pane bounding's `top`/`height` (never `bottom`,
      // which stays 0), so derive the candle pane's bottom edge as top + height.
      const cb = c.getSize("candle_pane", DomPosition.Root);
      const candleBottom = cb ? cb.top + cb.height : null;
      if (x > mainW || (candleBottom != null && y > candleBottom)) {
        btn.style.display = "none";
        setPlusCrosshair(null);
        return;
      }
      // Price comes from the cursor's y (x doesn't affect the value), so it still
      // resolves while the cursor is out over the "+"/axis strip.
      const pt = first(
        c.convertFromPixel([{ y }], { paneId: "candle_pane", absolute: true }),
      );
      if (pt.value == null) return;
      // Snapped onto an alert line: lock the guide to the alert's exact level + y; else
      // it tracks the cursor's price/y as usual.
      const guideY = snapTarget ? snapTarget.y : y;
      const guideVal = snapTarget ? snapTarget.level : pt.value;
      plusPriceRef.current = guideVal;
      if (plusPriceLabelRef.current) {
        plusPriceLabelRef.current.textContent = guideVal.toFixed(precisionRef.current);
        // Size the price box to the y-axis column so the number sits inside the
        // axis and the "+" circle's right edge lands on the column's left border.
        plusPriceLabelRef.current.style.width = `${Math.max(0, rect.width - mainW)}px`;
      }
      // Round so the "+" pill (translateY(-50%), even height) stays crisp.
      btn.style.top = `${Math.round(guideY)}px`;
      btn.style.display = "flex";
      // Over the "+", klinecharts dropped its crosshair; keep our guide alive at the
      // cursor's y. But NOT when snapped onto an alert/trade line: the native line is
      // already suppressed, and drawing ours at the snapped y would sit right on top of
      // that line and read as a doubled/messy line. The alert/trade line is its own
      // guide there, so leave the crosshair line hidden when snapped.
      setPlusCrosshair(overPlus && snapTarget == null ? guideY : null);
    };
    const onLeave = () => {
      setPlusCrosshair(null);
      if (snapActiveRef.current) { overlays.setSuppressNativeLine(false); snapActiveRef.current = false; }
      // Drop a snap-driven alert hover as the cursor leaves (klinecharts' own
      // onMouseLeave covers the on-line case; this covers the wider magnet band).
      if (snapHoverRef.current && !alertDrag.isActive()) {
        if (overlays.getHoveredAlertId() === snapHoverRef.current) overlays.hoverAlert(null);
        snapHoverRef.current = null;
      }
      // onMove stops firing past the canvas edge, so clear the curve-hover highlight.
      if (curveHover.value !== null) curveHover.set(null);
      // Drop any chart-driven trade-line hover as the cursor leaves the chart. If
      // it's heading for a dock row, that row's onMouseEnter re-sets it (mouseleave
      // here fires before the row's mouseenter), so the highlight lands correctly.
      setTradeHovered(null);
      // Clear a hover-only bracket now that the hover is gone (a SELECTED trade's bracket
      // stays). Runs after setTradeHovered so paintBracket sees the cleared hover.
      paintBracketRef.current();
      if (onAxisRef.current) {
        onAxisRef.current = false;
        setOnAxis(false);
      }
      if (cursorModeRef.current !== "") {
        cursorModeRef.current = "";
        setCursorMode("");
      }
      if (!plusMenuOpenRef.current && plusBtnRef.current) {
        plusBtnRef.current.classList.remove("passthrough");
        plusBtnRef.current.style.display = "none";
      }
    };
    const unsubAnchor = avwapAnchorMode.subscribe((id) => setAnchoring(id != null));
    // Arm/draw the measure ruler off the measureArmed signal: arming starts the
    // interactive draw (click/drag to place the two anchors); disarming mid-draw
    // cancels it; measureDone disarms the one-shot after completion. Also drives the
    // crosshair cursor (measureArmedUi).
    const unsubMeasureArm = measureArmed.subscribe((on) => {
      setMeasureArmedUi(on);
      if (on) {
        overlays.startMeasureDraw();
        // Focus the cell so Esc reaches onKeyDown even when arming came from the
        // toolbar button (which would otherwise hold focus) — Esc must always cancel.
        wrapRef.current?.focus({ preventScroll: true });
      } else if (overlays.isMeasureDrawing()) {
        overlays.clearMeasure(); // disarmed before finishing
      }
    });
    overlays.setMeasureDone(() => measureArmed.set(false));

    if (chart) {
      chart.setStyles(klineStyles(theme, legendHovered.value, crosshairRef.current));
      el.addEventListener("click", onClick);
      el.addEventListener("dblclick", onDblClick); // alert-line -> edit; curve -> settings
      el.addEventListener("contextmenu", onContextMenu); // right-click -> Paste menu
      // Measure ruler FIRST among the capture-phase mousedowns: a Shift press flips
      // measureArmed here before the line/clone/anchor handlers run (they bail while
      // measuring), so every placing press is reserved for the ruler. Neither measure
      // handler stops propagation — klinecharts still needs the press to place a point.
      el.addEventListener("mousedown", onMeasureShift, true);
      el.addEventListener("mousedown", onMeasureClear, true);
      // Capture-phase so it runs before klinecharts' own canvas mousedown — when we
      // grab the anchor handle we stopPropagation, blocking the chart's pan start.
      el.addEventListener("mousedown", onAnchorDown, true);
      el.addEventListener("mousedown", onClonePress, true);
      el.addEventListener("mousedown", onAxisDown, true);
      el.addEventListener("mousedown", onLineDown, true);
      el.addEventListener("dblclick", onAxisDblClick, true);
      el.addEventListener("dblclick", onTimeAxisDblClick, true);
      const wrap = wrapRef.current;
      wrap?.addEventListener("mousemove", onMove);
      wrap?.addEventListener("mouseleave", onLeave);
      // The price-axis strip is a klinecharts DOM element that sits over the
      // chart-wrap, so mousemove on wrap stops firing when the cursor slides onto
      // it. We need onMove to keep running there so onAxis can be set to true.
      containerRef.current?.addEventListener("mousemove", onMove);
      // Scroll-back pagination. klinecharts requests "Forward" (= older, prepended
      // to the left) when the user scrolls to the left edge. We answer with a
      // window of older bars; returning more=false stops further requests. Guards
      // prevent the old infinite loop (each prepend re-triggering a load).
      // NOTE: shares cursorSecRef/exhaustedRef/loadingRef with the quick-range walk
      // (ensureCoverageAndFit) — see its "DESIGN DEBT" comment before adding a third
      // paging consumer.
      chart.setLoadDataCallback((params) => {
        if (params.type !== LoadDataType.Forward) {
          params.callback([], params.type === LoadDataType.Backward ? false : true);
          return;
        }
        if (exhaustedRef.current || loadingRef.current || !params.data) {
          params.callback([], !exhaustedRef.current);
          return;
        }
        loadingRef.current = true;
        const resSec = RESOLUTION_SECONDS[resRef.current] ?? 60;
        const toSec = cursorSecRef.current - 1;
        // Cap the per-page span. For high/derived timeframes PAGE_BARS*resSec is
        // enormous (a 1Y page = 500 years), and the backend folds that from DAY
        // base bars — Capital.get_candles would loop ~180 sequential requests for
        // one page, stalling the chart and tripping the breaker. Bounding the span
        // just makes pages smaller (more of them); it stays hole-free because the
        // cursor follows fromSec exactly. ~6yr keeps the base fetch to a few pages.
        const MAX_PAGE_SPAN_SEC = 6 * 365 * 86400;
        const fromSec = toSec - Math.min(PAGE_BARS * resSec, MAX_PAGE_SPAN_SEC);
        const boundary = params.data.timestamp;
        const epic = epicRef.current;
        const resolution = resRef.current;
        const broker = brokerIdRef.current;
        fetchRange(epic, resolution, fromSec, toSec, priceSideRef.current, broker)
          .then((older) => {
            // Defend against the symbol/broker changing mid-flight.
            if (
              epic !== epicRef.current ||
              resolution !== resRef.current ||
              broker !== brokerIdRef.current
            ) {
              params.callback([], true);
              return;
            }
            cursorSecRef.current = fromSec; // advance back even across gaps
            const fresh = older.filter((b) => b.timestamp < boundary);
            if (fresh.length === 0) {
              emptyStreakRef.current += 1;
              if (emptyStreakRef.current >= MAX_EMPTY_WINDOWS) {
                exhaustedRef.current = true;
                params.callback([], false);
              } else {
                params.callback([], true); // keep walking back past the gap
              }
            } else {
              emptyStreakRef.current = 0;
              // A Forward load: klinecharts' own updatePointPosition shifts
              // dataIndex-only overlay points by the prepend size here — do NOT
              // shift them again (see applyOlderBars for the INIT-type path).
              params.callback(fresh, true);
            }
          })
          .catch(() => params.callback([], true))
          .finally(() => {
            loadingRef.current = false;
          });
      });
      overlays.attach(chart);
      // On-chart trade lines for this cell. Subscribes to the shared trades poll
      // AND pending drags, and redraws (filtered to THIS cell's epic, pending
      // merged over server levels) on every update. Bound to this chart instance,
      // so it lives and dies with the chart (remount-safe). Stage 2 renders
      // read-only; drag/edit wiring lands in Stage 3.
      const posLines = new PositionLines(chart, precisionRef.current, (hovering) =>
        containerRef.current?.classList.toggle("trade-line-grab", hovering),
      );
      posLinesRef.current = posLines;
      // A dropped line stages a pending edit (merged over server level so the
      // poll can't snap it back). The panel shows a combined Apply/Cancel.
      const onDrag = (
        id: string,
        field: "price" | "stop" | "takeProfit",
        level: number,
      ) => {
        // A line drag ends with a trailing DOM click; swallow it (same flag AVWAP
        // uses) so it doesn't toggle the trade's selection back off. A PURE click on
        // a line fires no onDrag, so click-to-select still works.
        justDraggedRef.current = true;
        if (id === DRAFT_ID) {
          // Dragging a draft line just sets that value (Submit commits it).
          const d = draftOrderSignal.value;
          if (d) draftOrderSignal.set({ ...d, [field]: level });
          return;
        }
        const cur = pendingEditsSignal.value;
        pendingEditsSignal.set({ ...cur, [id]: { ...cur[id], [field]: level } });
        // Confirm mode: dragging a line selects its trade AND focuses the dragged line
        // (so Apply/Discard land on THAT line's pill) — but openPanel=false, so a DRAG
        // never opens the edit ticket (only an explicit double-click does). No-confirm
        // mode leaves selection alone so the dock's auto-apply effect commits the drag at
        // once (selecting would mark it editId and exclude it).
        if (confirmLineEditsRef.current) {
          setTradeSelected(id, field === "takeProfit" ? "tp" : field, false);
        }
      };
      const drawPositions = () => {
        // Sidebar eye menu "Hide positions and orders": master-hide clears every
        // line (render([]) removes the previously-rendered ones) instead of
        // building specs from the (unaffected) underlying trade state.
        posLines.render(
          controller.positionsHidden.value
            ? []
            : tradeLineSpecs({
                trades: tradesRef.current,
                pending: pendingRef.current,
                epic: epicRef.current,
                precision: precisionRef.current,
                levelsDraggable: true,
                onDrag,
                draft: draftRef.current,
                hidden: new Set(tradeUiRef.current.hidden),
                hovered: tradeUiRef.current.hovered,
                selected: tradeUiRef.current.selected,
                // Blank the focused line's own label so its pill takes that spot (Idea C).
                selectedField: tradeUiRef.current.selectedField,
              }),
        );
      };
      posDrawRef.current = drawPositions;
      const unsubTrades = subscribeTrades((t) => {
        tradesRef.current = t;
        drawPositions();
        redrawRef.current(); // refresh the selected-trade pill (label/uPnL/levels)
      });
      const unsubPending = pendingEditsSignal.subscribe((p) => {
        pendingRef.current = p;
        drawPositions(); // move the line now (cheap — reconciles just the changed line)
        // Coalesce the heavier overlay redraw (pill follow + P/L + selection canvas)
        // to one per frame: a line drag restages pending every mousemove, and redrawing
        // the whole overlay per pixel is wasteful (and laggy on slower machines).
        if (pendingRedrawRafRef.current) return;
        pendingRedrawRafRef.current = requestAnimationFrame(() => {
          pendingRedrawRafRef.current = 0;
          redrawRef.current();
        });
      });
      const unsubDraft = draftOrderSignal.subscribe((d) => {
        draftRef.current = d;
        drawPositions();
        paintBracketRef.current(); // the bracket follows the draft's SL/TP too
      });
      const unsubConfirm = confirmLineEditsSignal.subscribe((v) => {
        confirmLineEditsRef.current = v;
      });
      const unsubTradeUi = tradeLineUiSignal.subscribe((ui) => {
        const prevSelected = tradeUiRef.current.selected;
        const prevField = tradeUiRef.current.selectedField;
        const selectedChanged = ui.selected !== prevSelected;
        const fieldChanged = ui.selectedField !== prevField;
        tradeUiRef.current = ui;
        // Trade selection is mutually exclusive with this cell's alert/drawing/
        // indicator selection. We clear here (not only in onClick) so selecting a
        // trade via a DOCK ROW — whose click never reaches the chart's onClick —
        // still drops the chart's other selection. Guard on the transition TO a
        // non-null selection so a pure hover update doesn't re-clear every move.
        if (ui.selected && selectedChanged) {
          overlays.selectAlert(null);
          overlays.selectDrawing(null);
          if (selectedIndicator.value) selectedIndicator.set(null);
        }
        drawPositions();
        // Re-anchor / show / hide the active-line pill when the selected TRADE or the
        // focused LINE changes — not on every hover tick. Freeze the pill's x at the
        // cursor only on a new trade selection; clear it on deselect.
        if (selectedChanged) {
          if (ui.selected) freezeTradePillX();
          else tradePillLeftRef.current = null;
        }
        if (selectedChanged || fieldChanged) redrawRef.current();
      });
      // The bracket now keys off EDIT state, which lives in its own signals — repaint it
      // when the edit ticket opens/closes or its target changes (e.g. Cancel sets
      // tradePanelOpen=false without a tradeLineUiSignal change).
      const unsubEditOpen = tradePanelOpen.subscribe(() => paintBracketRef.current());
      const unsubEditId = editTradeSignal.subscribe(() => paintBracketRef.current());
      // Sidebar eye menu "Hide positions and orders" toggle: re-run drawPositions
      // (which reads controller.positionsHidden.value itself, above).
      const unsubPositionsHidden = controller.positionsHidden.subscribe(() => drawPositions());
      posUnsubRef.current = () => {
        unsubTrades();
        unsubPending();
        unsubDraft();
        unsubConfirm();
        unsubTradeUi();
        unsubEditOpen();
        unsubEditId();
        unsubPositionsHidden();
        if (pendingRedrawRafRef.current) {
          cancelAnimationFrame(pendingRedrawRafRef.current);
          pendingRedrawRafRef.current = 0;
        }
      };
      // Prime precision synchronously at attach so alert-level rounding never sees a
      // null precision: fetchPrecision() resolves async, and an alert created/edited in
      // that window would otherwise be stored/read raw. effPrecision already has a
      // synchronous fallback (symbol.pricePrecision ?? 2); the async fetch refines it.
      overlays.setPricePrecision(effPrecision);
      controller.chart = chart;
      // Let outside chrome (DrawSidebar) hand keyboard focus to this cell after
      // arming a drawing tool, so Esc-cancel reaches onKeyDown (same reason the
      // measure arm subscription focuses the wrap above).
      controller.focusChart = () => wrapRef.current?.focus({ preventScroll: true });
      // Hydrate this cell's saved indicators synchronously on chart-ready (they
      // recalc once data arrives). Done here — not after the async data fetch — so
      // the focused Toolbar reflects them immediately on mount / tab switch, and
      // non-focused cells get them too (the Toolbar binds only to the focused cell).
      controller.indicators.set(hydrateIndicators(chart, scope, symbol.epic));
      // e2e verify hook: a per-cell registry plus a focused alias. Tests that
      // predate multi-cell use `__chart`; multi-cell tests index `__charts`.
      const w = window as unknown as { __chart?: Chart; __charts?: Map<string, Chart> };
      (w.__charts ??= new Map()).set(cellId, chart);
      w.__chart = chart;
      onReady?.(cellId, chart, controller);
    }
    return () => {
      wsRef.current?.close();
      unsubAnchor();
      unsubMeasureArm();
      overlays.setMeasureDone(null);
      unsubRemoved();
      el.removeEventListener("click", onClick);
      el.removeEventListener("dblclick", onDblClick);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("mousedown", onMeasureShift, true);
      el.removeEventListener("mousedown", onMeasureClear, true);
      el.removeEventListener("mousedown", onAnchorDown, true);
      el.removeEventListener("mousedown", onClonePress, true);
      el.removeEventListener("mousedown", onAxisDown, true);
      el.removeEventListener("mousedown", onLineDown, true);
      // Drop any live window listeners from an in-flight line drag — teardown can't wait
      // for onUp (it fires on window and may never come if the cell unmounts mid-drag).
      lineDrags.forEach((d) => d.dispose());
      el.removeEventListener("dblclick", onAxisDblClick, true);
      el.removeEventListener("dblclick", onTimeAxisDblClick, true);
      window.removeEventListener("mousemove", onAnchorMove);
      window.removeEventListener("mouseup", onAnchorUp, true);
      wrapRef.current?.removeEventListener("mousemove", onMove);
      wrapRef.current?.removeEventListener("mouseleave", onLeave);
      containerRef.current?.removeEventListener("mousemove", onMove);
      posUnsubRef.current();
      posUnsubRef.current = () => {};
      posLinesRef.current?.clear();
      posLinesRef.current = null;
      posDrawRef.current = () => {};
      overlays.detach();
      controller.chart = null;
      controller.focusChart = null;
      const w = window as unknown as { __charts?: Map<string, Chart> };
      w.__charts?.delete(cellId);
      if (el) dispose(el);
      chartRef.current = null;
      inited.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme / symbol / period / live-status changes -> restyle. The canvas legend
  // embeds the symbol (green while live), interval, and precision, so it must
  // re-apply on those too. crosshair (style/color/opacity) restyles here too so a
  // settings change shows at once instead of waiting for the next mouse move.
  useEffect(() => {
    chartRef.current?.setStyles(klineStyles(theme, legendHovered.value, crosshairRef.current));
    // A full base-style re-apply resets priceMark.last.line.show to its default
    // (visible). If an alert is selected the last-price line must stay hidden, so
    // re-assert it here. lastPriceHiddenRef already reflects the desired state, so
    // a single re-apply keeps it in sync without waiting for the next redraw().
    if (lastPriceHiddenRef.current) {
      chartRef.current?.setStyles({ candle: { priceMark: { last: { line: { show: false } } } } });
    }
  }, [theme, symbol.epic, effPrecision, period.label, status, crosshair]);

  // Resolve the epic's authoritative precision + open/closed status on symbol
  // change, then poll the status so the tab badge and price label flip when the
  // market closes (or reopens) while the chart stays open. One snapshot call
  // yields both (fetchMarketMeta); precision is stable so we only apply it once.
  //
  // Event-driven, NOT polled: fetch once for precision + the initial state, then
  // re-check only on an event —
  //   - closed market: a single re-check scheduled exactly at `nextOpen`;
  //   - open market: nothing, unless the live stream falls silent for a while (a
  //     possible close), then ONE fallback re-check confirms it.
  // A market that's ticking (even slowly) keeps the badge open with zero server
  // calls; a reopened market flips instantly on its first tick (stream handler).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only consulted while the stream is silent; an active stream never triggers it.
    const FALLBACK_MS = 180_000;
    setFetchedPrecision(null); // drop the previous epic's value while we re-resolve
    // Default to open on an in-cell symbol switch so a now-open symbol doesn't flash
    // "closed" until the first fetch resolves a round-trip later.
    setMarketClosed(false);

    const schedule = (closed: boolean, nextOpen: string | null): void => {
      clearTimeout(timer);
      if (cancelled) return;
      if (closed && nextOpen) {
        // Re-check exactly when it should reopen — an event, not a poll.
        const ms = Math.min(Math.max(1000, Date.parse(nextOpen) - Date.now()), 2_000_000_000);
        timer = setTimeout(() => void recheck(false), ms);
        return;
      }
      // Open (or closed with no known reopen): re-check only if the stream goes
      // quiet — a ticking market needs no server call.
      const fallback = (): void => {
        if (cancelled) return;
        if (Date.now() - lastCandleAtRef.current < FALLBACK_MS) {
          if (marketClosedRef.current) setMarketClosed(false); // ticks ⇒ open
          timer = setTimeout(fallback, FALLBACK_MS);
        } else {
          void recheck(false); // silent for a while → confirm open/closed
        }
      };
      timer = setTimeout(fallback, FALLBACK_MS);
    };

    const recheck = async (wantPrecision: boolean): Promise<void> => {
      let meta: Awaited<ReturnType<typeof fetchMarketMeta>>;
      try {
        meta = await fetchMarketMeta(symbol.epic, brokerId);
      } catch {
        schedule(false, null); // transient: treat as open, re-arm the silence check
        return;
      }
      if (cancelled) return;
      if (wantPrecision && meta.pricePrecision != null) setFetchedPrecision(meta.pricePrecision);
      // null `closed` (failed lookup) is treated as open, so it never shows a live
      // market closed.
      const closed = meta.closed === true;
      setMarketClosed(closed);
      schedule(closed, meta.nextOpen);
    };

    void recheck(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [symbol.epic, brokerId]);

  // A market open/closed change must repaint the price pill (the redraw reads the
  // ref, so a re-render alone won't). The tab badge is sourced separately by an
  // App-level epic poll, so this cell only needs to refresh its own price label.
  useEffect(() => {
    redrawRef.current();
  }, [marketClosed]);

  // Apply precision to the chart whenever it resolves (the async fetch lands after
  // the symbol/period effect's initial setPriceVolumePrecision).
  useEffect(() => {
    chartRef.current?.setPriceVolumePrecision(effPrecision, 0);
    overlays.setPricePrecision(effPrecision); // keep alert-level rounding in lockstep
    redrawRef.current(); // re-place the price/bid/ask pills at the new decimals
  }, [effPrecision]);

  // Timezone changes -> retime the axis ("" follows the browser), and rebucket the
  // Previous-period H/L lines in the same zone so their day/week/month/year steps
  // stay aligned with the axis date labels. PREV_HL has no calcParams, so we force
  // a recompute by re-applying its extendData (klinecharts reruns calc on override).
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const resolved = timezone || browserTimezone();
    c.setTimezone(resolved);
    if (!setIndicatorTimezone(resolved)) return; // zone unchanged → nothing to redo
    const candlePane = c.getIndicatorByPaneId("candle_pane") as
      | Map<string, Indicator>
      | null
      | undefined;
    for (const [id, ind] of candlePane ?? []) {
      if (indTypeOf(ind) !== "PREV_HL") continue;
      c.overrideIndicator({ name: id, extendData: { ...(ind.extendData as object) } });
    }
  }, [timezone]);

  // Time-axis format changes -> re-register the formatter. setCustomApi doesn't
  // force a repaint on its own, so nudge one via setStyles (same trick the
  // font-load path uses) to reformat the axis ticks + crosshair label at once.
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const fmt = makeFormatDate(clock, dateFormat, showWeekday);
    c.setCustomApi({ formatDate: fmt });
    c.setStyles(klineStyles(themeRef.current, legendHovered.value, crosshairRef.current));
    // The full base-style re-apply un-hides the last-price line; if an alert is
    // selected it must stay hidden, so re-assert (see the theme effect's rationale).
    if (lastPriceHiddenRef.current) {
      c.setStyles({ candle: { priceMark: { last: { line: { show: false } } } } });
    }
    // Mirror klinecharts' dtf (same options) so our synced-crosshair label matches
    // the source chart's. "YYYY-MM-DD HH:mm" is the format klinecharts hands to
    // formatDate for the crosshair; makeFormatDate re-renders it per clock/date pref.
    let dtf: Intl.DateTimeFormat | null = null;
    try {
      dtf = new Intl.DateTimeFormat("en", {
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: timezone || browserTimezone(),
      });
    } catch {
      dtf = null;
    }
    crosshairLabelFmtRef.current = dtf ? (ts: number) => fmt(dtf!, ts, "YYYY-MM-DD HH:mm") : () => "";
  }, [clock, dateFormat, showWeekday, timezone]);

  // Symbol / period changes -> reload history, (re)subscribe live, set scroll-back.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let cancelled = false;

    chart.setPriceVolumePrecision(effPrecision, 0);
    overlays.setPricePrecision(effPrecision); // keep alert-level rounding in lockstep
    overlays.setEpic(symbol.epic);
    // Alerts are stored per broker; address them with THIS cell's broker (not the
    // ambient persistBroker the toolbar may flip mid-switch). In lockstep with setEpic.
    overlays.setBroker(brokerId);
    // Backtest markers/equity belong to the previous series — drop them.
    clearBacktest(chart);
    // Reset scroll-back state for the new series.
    loadingRef.current = false;
    exhaustedRef.current = false;
    emptyStreakRef.current = 0;

    // Drop a stale quick-range when this re-run isn't the range pick itself.
    // - Epic change: the boundary belongs to the OLD instrument's timeline — clear
    //   the separator, the pill, and any in-flight fit (it targeted the old series).
    // - Manual interval change (toolbar, no pending pick): the view no longer
    //   matches the preset, so drop the pill; the separator stays (a "start of
    //   today" marker is still valid at any interval).
    const epicChanged = prevEpicRef.current !== symbol.epic;
    const resChanged = prevResRef.current !== period.resolution;
    prevEpicRef.current = symbol.epic;
    prevResRef.current = period.resolution;
    // A symbol or interval change invalidates any live measurement (its anchors map
    // onto the old timescale) — discard it and disarm the ruler.
    if (epicChanged || resChanged) {
      measureArmed.set(false);
      overlays.clearMeasure();
    }
    if (epicChanged) {
      separatorTsRef.current = null;
      sepCacheRef.current = null;
      pendingRangeRef.current = null;
      setActiveRange(null);
    } else if (resChanged && !pendingRangeRef.current) {
      setActiveRange(null);
    }
    // No data for the new series until history loads or a live tick arrives. The
    // banner is grace-gated, so this can't flash during a normal load — only when
    // the broker is genuinely unreachable.
    setHasData(false);
    setLoadError(null);
    setErrorOpen(false);

    (async () => {
      // Tolerate a failed initial load (offline/DNS/refused/CORS make fetchRecent
      // REJECT, not return []): fall back to no history and carry on. Crucially this
      // still reaches rehydrate() below, which advances overlays.hydratedEpic — skip
      // it and persist() stays gated on the stale epic forever, silently dropping
      // every alert/drawing the user adds until they switch symbol again.
      let bars: KLineData[];
      try {
        bars = await fetchRecent(symbol.epic, period.resolution, 500, priceSide, brokerId);
      } catch (err) {
        console.warn(`[chart] initial load failed for ${symbol.epic}; continuing with no history`, err);
        bars = [];
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
      if (cancelled || !chartRef.current) return;
      // Cursor starts at the oldest loaded bar; scroll-back requests older windows.
      cursorSecRef.current = bars.length
        ? Math.floor(bars[0].timestamp / 1000)
        : Math.floor(Date.now() / 1000);
      // more=true enables klinecharts to request older history (Forward) when the
      // user scrolls to the left edge; setLoadDataCallback above answers it.
      // Live-only (seconds) intervals have no history, so disable scroll-back to
      // avoid firing empty fetchRange windows that walk back for nothing.
      chartRef.current.applyNewData(bars, !period.liveOnly);
      // Live-only (seconds) intervals legitimately start empty and fill from the
      // stream, so don't badge them no-data on the empty history; the first tick
      // below flips hasData true. Native intervals with no history are genuinely
      // empty until proven otherwise.
      setHasData(bars.length > 0);
      // Anchor to the latest bars so the live/forming candle is on-screen.
      chartRef.current.scrollToRealTime();
      // Rehydrate this symbol's saved drawings + alerts now that the data (and
      // therefore the timescale their points map onto) is loaded. Passing the
      // resolution makes rehydrate adopt it BEFORE points materialize — a
      // future-anchored point decodes its timestamp with the bar width, and a
      // trailing setResolution() call left it decoding with the PREVIOUS
      // timeframe's width on every switch (trendline slope changed, and the
      // next persist baked the drift in). This also re-derives each drawing's
      // per-interval visibility, so no separate setResolution call remains.
      overlays.rehydrate(period.resolution);
      // Redraw position lines for the (possibly new) epic at the current precision.
      posLinesRef.current?.setPrecision(effPrecision);
      posDrawRef.current();
      // Re-evaluate the selected-trade pill against the now-current epic: selecting a
      // dock row for an OFF-chart symbol switches the epic here, and the pill only
      // shows for a trade on this epic — so refresh once the rehydrate lands rather
      // than waiting for the next live tick.
      redrawRef.current();
      // Mirror the drawings' interval filter for indicators: re-derive each
      // indicator's effective visibility (user intent AND interval match) against
      // the now-current resolution. Runs here so both a fresh rehydrate (above)
      // and a plain period switch (this effect re-runs on period.resolution) land
      // on the right on-chart state — a view reaction only, nothing persisted.
      // Guard: the sidebar eye menu's "Hide indicators" master switch overrides
      // this re-derive — while it's on, re-assert all-hidden instead of un-hiding.
      setAllIndicatorsHidden(chartRef.current, controller.indicatorsHidden.value, period.resolution);
      // A quick-range pick that switched interval parked its window here; the
      // initial new-resolution bars are loaded, so page back to the period start
      // (if needed) and fit. ensureCoverageAndFit clears pendingRangeRef when done.
      const pend = pendingRangeRef.current;
      if (pend && pend.resolution === period.resolution && chartRef.current) {
        void ensureCoverageAndFit(pend);
      }
      // Page back (no fit) until every saved drawing anchor maps onto a loaded bar —
      // otherwise klinecharts clamps older anchors to the first loaded bar and the
      // drawing renders with the wrong slope on this interval. Live-only intervals
      // have no history to page. No-op when a quick-range walk owns paging.
      if (!period.liveOnly) void ensureDrawingAnchorCoverage();
      // Re-apply each AVWAP instance's anchor for this epic (anchors are per-epic,
      // per-instance; no-op if no AVWAP is active).
      const candlePane = chartRef.current.getIndicatorByPaneId("candle_pane") as
        | Map<string, Indicator>
        | null
        | undefined;
      for (const [id, ind] of candlePane ?? []) {
        if (indTypeOf(ind) !== "AVWAP") continue;
        chartRef.current.overrideIndicator({
          name: id,
          calcParams: [loadAvwapAnchor(scope, symbol.epic, id)],
        });
      }
      // Re-fetch HTF data for any EMA/MA pinned to a higher timeframe — the
      // stashed series belonged to the previous epic/range (no-op otherwise).
      void refreshMtfIndicators(chartRef.current, symbol.epic, brokerId);

      // Auto-apply this symbol's default template onto a FRESH cell (no saved
      // indicators or drawings yet). Runs after rehydrate so the empty-cell gate
      // sees the final state; a populated/customized cell is left untouched.
      maybeAutoApplyTemplate(chartRef.current, controller, scope, symbol.epic);

      // Live updates for the current bar.
      wsRef.current?.close();
      setStatus("connecting");
      setLastPrice(null);
      wsRef.current = openLive(
        symbol.epic,
        period.resolution,
        (k: KLineData, bid: number | null, ask: number | null) => {
          const chart = chartRef.current;
          if (!chart) return;
          // Latest raw spread sides for the bid/ask lines (redraw reads the refs).
          bidRef.current = bid;
          askRef.current = ask;
          // updateData updates the last bar (==ts) or appends (>ts); an older ts
          // is silently ignored by klinecharts. Log regressions so a frozen chart
          // is diagnosable rather than mysterious.
          const list = chart.getDataList();
          const lastTs = list.length ? list[list.length - 1].timestamp : 0;
          if (k.timestamp < lastTs) {
            console.warn(
              `[live] stale candle ${k.timestamp} < last ${lastTs} for ${symbol.epic}; ignoring`,
            );
            return;
          }
          chart.updateData(k);
          setHasData(true); // a flowing stream clears the no-data banner (React no-ops if unchanged)
          setLastPrice(k.close);
          // Publish the price so the positions dock can mark P&L to market without
          // polling the server (see trading.setLivePrice / PositionsPanel).
          setLivePrice(symbol.epic, k.close);
          // A live candle proves the market is open: record it (so the status check
          // stays event-driven) and flip the badge open instantly if it was closed.
          lastCandleAtRef.current = Date.now();
          if (marketClosedRef.current) setMarketClosed(false);
          redraw(); // keep the price/alert pills glued as the bar moves
          // NOTE: alert FIRING is owned by the background alertEngine (the single
          // authority across all tabs, active included) — not here. This chart feed
          // only drives the visible candles/pills. The engine persists fired/removed
          // alerts and bumps the alerts signal; overlays reconciles its lines off it.
        },
        setStatus,
        priceSide,
        brokerId,
      );
    })();

    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol.epic, period.resolution, priceSide, brokerId]);

  // Sidebar eye menu "Hide indicators": subscribe to the master switch and apply
  // it to the live chart on every toggle (mirrors the resolution-change call above,
  // which re-asserts hidden instead of un-hiding while this switch is on).
  useEffect(() => {
    return controller.indicatorsHidden.subscribe((hidden) => {
      if (!chartRef.current) return;
      // resRef (not the closed-over period.resolution) — this effect only re-runs
      // when `controller` changes (a new cell), so a plain interval switch must be
      // read live via the ref, same idiom as the scroll-back fetcher above (~2204).
      setAllIndicatorsHidden(chartRef.current, hidden, resRef.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  // Candle-cache stats badge: poll this cell's own series on an interval, reset
  // to null immediately on series change so the badge never shows a stale
  // series' numbers while the new one's first poll is in flight.
  useEffect(() => {
    let cancelled = false;
    setCacheStats(null);
    const poll = () => {
      void fetchCandleCacheStats(symbol.epic, period.resolution, priceSide, brokerId).then(
        (s) => {
          if (!cancelled) setCacheStats(s);
        },
      );
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol.epic, period.resolution, priceSide, brokerId]);

  const cacheBadge = (() => {
    if (!cacheStats) return null;
    if (cacheStats.oldestTs == null) {
      return {
        label: "n/a",
        title: "No cache data yet for this series.",
        state: "none" as const,
      };
    }
    const ageSec = cacheStats.lastFetchTs != null ? Date.now() / 1000 - cacheStats.lastFetchTs : null;
    const fresh = ageSec != null && ageSec < 60;
    const days = Math.max(0, Math.round((cacheStats.newestTs! - cacheStats.oldestTs) / 86400));
    const total = cacheStats.hits + cacheStats.misses;
    const hitPct = total > 0 ? Math.round((cacheStats.hits / total) * 100) : null;
    return {
      label: hitPct != null ? `${hitPct}%` : "—",
      title: `Hit rate: ${hitPct != null ? `${hitPct}% (${cacheStats.hits}/${total})` : "n/a"} · Coverage: ${days}d · ${cacheStats.cachedBarCount} bars`,
      state: fresh ? ("fresh" as const) : ("stale" as const),
    };
  })();

  // Paint the H position bracket for the active trade/draft on its own canvas. Cheap
  // and React-free, so it runs on every mousemove (to track the cursor's x) as well as
  // from `redraw` (so the spine stays glued to its lines through scroll/zoom/ticks and
  // line drags). Stable — reads refs only.
  const paintBracket = useCallback(() => {
    const chart = chartRef.current;
    const canvas = bracketCanvasRef.current;
    const wrap = wrapRef.current;
    if (!chart || !canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    // Resolve the bracket's source: the staged draft (if on this epic) takes priority,
    // else the click-selected trade. Anything else → nothing to group.
    const epic = epicRef.current;
    const draft = draftRef.current;
    let entry: number | null = null;
    let stop: number | null = null;
    let tp: number | null = null;
    // The subject the bracket is drawn for — used to re-freeze the spine x when it
    // changes (hover trade A → hover trade B should re-appear at the new cursor, not
    // keep A's x).
    let activeKey: string | null = null;
    if (draft && draft.epic === epic) {
      // A draft is actively being staged → always grouped.
      stop = draft.stop ?? null;
      tp = draft.takeProfit ?? null;
      // A limit draft has an entry line; a market draft fills at market, so anchor its
      // %/R:R on the live price instead (suppressed below if no price is flowing).
      entry = draft.type === "limit" ? draft.price ?? null : getLivePrice(epic) ?? null;
      activeKey = "draft";
    } else {
      // An existing trade's bracket shows ONLY while it's in EDIT state — i.e. the edit
      // ticket is open for it (opened by double-clicking a line or the dock pencil).
      // Mere hover or a single-click selection no longer trigger it: showing R:R/% on a
      // casual hover was just visual noise. Dragging a line WHILE the ticket is open
      // keeps it (editId stays set), so the spine stays glued through the drag.
      const editId = tradePanelOpen.value ? editTradeSignal.value : null;
      const sel = editId
        ? tradesRef.current.find((t) => t.id === editId && t.epic === epic)
        : null;
      if (sel) {
        const merged = mergeTradeLevels(sel, pendingRef.current[sel.id] ?? {});
        entry = merged.price ?? sel.priceLevel;
        stop = merged.stop;
        tp = merged.takeProfit;
        activeKey = sel.id;
      }
    }

    // Nothing active (no SL and no TP, or no entry anchor) → clear once and bail. The
    // wrap.clientWidth/Height reads below force a layout reflow, so the overwhelmingly
    // common nothing-selected mousemove bails HERE first (cheap ref reads only) and never
    // touches the canvas unless it had previously drawn a bracket that needs clearing.
    if (entry == null || (stop == null && tp == null)) {
      if (bracketShownRef.current) {
        const cw = wrap.clientWidth;
        const ch = wrap.clientHeight;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        bracketShownRef.current = false;
      }
      bracketKeyRef.current = null;
      bracketXRef.current = null;
      return;
    }
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    bracketShownRef.current = true;

    const yOf = (v: number | null): number | null => {
      if (v == null) return null;
      const y = first(
        chart.convertToPixel([{ value: v }], { paneId: "candle_pane", absolute: true }),
      ).y;
      return y == null ? null : Math.round(y);
    };
    const mainW = chart.getSize("candle_pane", DomPosition.Main)?.width ?? w;
    // The spine APPEARS where the cursor is, then stays put — tracking the cursor was
    // just visual churn. Freeze the x when the bracket activates or its subject changes;
    // reuse it otherwise. Fallback (selected from a dock row with no chart cursor): a
    // third across, mirroring the trade pill.
    if (activeKey !== bracketKeyRef.current || bracketXRef.current == null) {
      const cx = cursorXRef.current > 0 ? cursorXRef.current : Math.round(mainW / 3);
      bracketXRef.current = cx;
      bracketKeyRef.current = activeKey;
    }
    const spineX = Math.max(60, Math.min(mainW - 12, bracketXRef.current));
    drawPositionBracket({
      ctx,
      entryY: yOf(entry),
      stopY: yOf(stop),
      tpY: yOf(tp),
      spineX,
      mainW,
      labels: bracketLabels({ entry, stop, tp }),
    });
  }, []);
  paintBracketRef.current = paintBracket;

  // Recompute the axis overlays (live price+countdown pill, alert label pills)
  // from the chart's current geometry. Stable (reads refs), so it can be wired to
  // the 1s tick, scroll/zoom, live ticks, and overlay changes without churn.
  // Format the separator's pill in the chart's timezone (so it matches the time
  // axis): always date + "HH:mm", e.g. "1 Jun 00:00".
  const fmtSeparatorLabel = useCallback(
    (ts: number): string =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone || undefined,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(ts)
        .replace(",", ""),
    [timezone],
  );

  // Paint (or clear) the period-start separator on its own canvas.
  const paintSeparator = useCallback(() => {
    const chart = chartRef.current;
    const canvas = sepCanvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const ts = separatorTsRef.current;
    if (ts == null || !chart) return;
    // Don't draw a boundary the loaded history doesn't actually reach: klinecharts
    // clamps an out-of-range timestamp to the OLDEST bar's x (it doesn't extrapolate),
    // which would plant the line on the wrong bar with the true period date — a
    // confident-looking lie. Allow up to one bar of slack for exact-edge snapping.
    const data = chart.getDataList();
    const oldest = data?.[0]?.timestamp;
    const resMs = (RESOLUTION_SECONDS[resRef.current] ?? 60) * 1000;
    if (oldest != null && ts < oldest - resMs) return;
    const x = first(
      chart.convertToPixel([{ timestamp: ts }], { paneId: "candle_pane", absolute: true }),
    )?.x;
    if (!Number.isFinite(x) || x < 0 || x > w) return; // off-screen / unmappable
    const xr = Math.round(x as number) + 0.5;
    // Stop the line at the bottom of the candle pane (above the time axis), so the
    // pill sits in the axis gutter like a TradingView session marker.
    const mainH = chart.getSize("candle_pane", DomPosition.Main)?.height ?? h;

    // Label + accent are derived from (ts, tz, theme) only — cache so a live-ticking
    // chart doesn't rebuild an Intl formatter / flush style on every frame.
    if (
      !sepCacheRef.current ||
      sepCacheRef.current.ts !== ts ||
      sepCacheRef.current.tz !== timezone ||
      sepCacheRef.current.theme !== theme
    ) {
      sepCacheRef.current = {
        ts,
        tz: timezone,
        theme,
        label: fmtSeparatorLabel(ts),
        accent: getComputedStyle(wrap).getPropertyValue("--accent").trim() || "#2962ff",
      };
    }
    const { label, accent } = sepCacheRef.current;

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xr, 0);
    ctx.lineTo(xr, mainH);
    ctx.stroke();
    ctx.restore();

    // Date pill anchored at the boundary, just above the time axis.
    ctx.save();
    ctx.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    const tw = ctx.measureText(label).width;
    const padX = 5;
    const pillH = 15;
    const pillW = tw + padX * 2;
    let pillX = xr - pillW / 2;
    pillX = Math.max(2, Math.min(pillX, w - pillW - 2)); // keep on-screen
    const pillY = mainH - pillH - 3;
    ctx.fillStyle = accent;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 3);
      ctx.fill();
    } else {
      ctx.fillRect(pillX, pillY, pillW, pillH);
    }
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, pillX + padX, pillY + pillH / 2 + 0.5);
    ctx.restore();
  }, [fmtSeparatorLabel, timezone, theme]);
  paintSeparatorRef.current = paintSeparator;

  const redraw = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) {
      setPriceTag(null);
      setAlertTags([]);
      paintSeparatorRef.current();
      return;
    }
    // Round the pixel y: these pills center with transform: translateY(-50%) over
    // an even height, so a fractional top would land their text on half-pixels
    // (blurry). Rounding the top keeps it crisp.
    const yOf = (value: number): number | undefined => {
      const y = first(chart.convertToPixel([{ value }], { paneId: "candle_pane", absolute: true })).y;
      return y == null ? undefined : Math.round(y);
    };

    // Last-price pill y + height, captured so the bid/ask pills below can stack
    // around it instead of hiding behind it on a tight spread (TradingView does
    // the same). Height matches .price-tag CSS: 40px with countdown, else 20px.
    let lastPriceY: number | null = null;
    let priceTagHeight = 20;
    const dl = chart.getDataList();
    if (dl.length) {
      const last = dl[dl.length - 1];
      const y = yOf(last.close);
      if (y == null) {
        setPriceTag(null);
      } else {
        let countdown: string | null = null;
        if (marketClosedRef.current) {
          // Closed market: the WS still connects (status "live"), so the timer
          // would otherwise tick to 0:00 and freeze. Show "closed" in its place.
          countdown = "closed";
        } else if (statusRef.current === "live") {
          const resSec = RESOLUTION_SECONDS[resRef.current] ?? 60;
          const rem = Math.max(
            0,
            Math.floor((last.timestamp + resSec * 1000 - Date.now()) / 1000),
          );
          countdown = fmtCountdown(rem);
        }
        // Width of the price-axis column, so the pill fills it exactly (its left
        // edge lands on the column border) instead of spilling into the chart.
        const mainW = chart.getSize("candle_pane", DomPosition.Main)?.width ?? 0;
        const totalW = containerRef.current?.clientWidth ?? mainW;
        const dir = last.close >= last.open ? "up" : "down";
        setPriceTag({ y, price: last.close, countdown, w: Math.max(0, totalW - mainW), dir });
        lastPriceY = y;
        priceTagHeight = countdown ? 40 : 20;
      }
    } else {
      setPriceTag(null);
    }

    // Live bid & ask axis pills. Shown only when enabled, the feed is live, and the
    // side is known (the lines themselves are painted on the overlay canvas below).
    const showBidAsk = bidAskRef.current !== "off" && statusRef.current === "live";
    const bidV = bidRef.current;
    const askV = askRef.current;
    if (showBidAsk && (bidV != null || askV != null)) {
      const mainW = chart.getSize("candle_pane", DomPosition.Main)?.width ?? 0;
      const totalW = containerRef.current?.clientWidth ?? mainW;
      const w = Math.max(0, totalW - mainW);
      let by = bidV != null ? yOf(bidV) : undefined;
      let ay = askV != null ? yOf(askV) : undefined;
      // bid <= close <= ask always, so on the axis ask sits at/above the last-price
      // pill and bid at/below it. When the spread is tighter than the pills are
      // tall they'd overlap the last-price pill; push ask up / bid down just enough
      // to clear it (BA_TAG_H matches .ba-tag height) so all three stay readable.
      if (lastPriceY != null) {
        const gap = priceTagHeight / 2 + BA_TAG_H / 2;
        if (ay != null) ay = Math.min(ay, lastPriceY - gap);
        if (by != null) by = Math.max(by, lastPriceY + gap);
      }
      // Suppress the side the main price line already IS: when candles use the bid
      // (priceSide "bid"), the last-price pill is the bid, so a separate Bid label
      // is redundant — hide it (same for "ask").
      const side = priceSideRef.current;
      setBidTag(side !== "bid" && bidV != null && by != null ? { y: by, price: bidV, w } : null);
      setAskTag(side !== "ask" && askV != null && ay != null ? { y: ay, price: askV, w } : null);
    } else {
      setBidTag(null);
      setAskTag(null);
    }

    const tags: Array<{
      id: string;
      y: number;
      level: number;
      condition: AlertCondition;
      trigger: AlertTrigger;
      expiresAt: number | null;
      hovered: boolean;
      active: boolean;
      selected: boolean;
    }> = [];
    for (const a of overlays.getAlerts()) {
      const y = yOf(a.level);
      if (y != null)
        tags.push({
          id: a.id,
          y,
          level: a.level,
          condition: a.condition,
          trigger: a.trigger,
          expiresAt: a.expiresAt,
          hovered: a.hovered,
          active: a.active,
          selected: a.selected,
        });
    }
    // When a click-SELECTED alert sits ON the live-price row, the live price line and
    // its axis pill step aside so the selected alert owns that row unobstructed
    // (TV-style). This is SCOPED to overlap: selecting an alert on a different row
    // must NOT hide the live price (you still want the live read) — only the alert
    // the user is actively working at the price level does. Hover never counts —
    // only selection — so a passing cursor never hides the live price. The overlap
    // band is half the price pill plus half an alert tag (~20px): within it the two
    // axis pills visually collide. Suppress the dotted last-price line via klinecharts
    // styles (guarded by a ref so we only setStyles on a transition) and drop the DOM
    // price pill here.
    const ALERT_TAG_HALF = 10; // .alert-tag is 20px tall (App.css)
    const priceObscured =
      lastPriceY != null &&
      tags.some((t) => t.selected && Math.abs(t.y - lastPriceY!) <= priceTagHeight / 2 + ALERT_TAG_HALF);
    if (priceObscured !== lastPriceHiddenRef.current) {
      lastPriceHiddenRef.current = priceObscured;
      chart.setStyles({ candle: { priceMark: { last: { line: { show: !priceObscured } } } } });
    }
    if (priceObscured) setPriceTag(null);
    setAlertTags(tags);
    const act = tags.find((t) => t.active);
    if (act) lastActivePillIdRef.current = act.id;

    // The ACTIVE line's pill, only for a trade on THIS cell's epic. Levels merge
    // pending over server (so a dragged line is tracked); recomputed here so the pill
    // follows its line through scroll/zoom/live ticks. Only the focused line shows.
    const selId = tradeUiRef.current.selected;
    const field = tradeUiRef.current.selectedField;
    const sel = selId
      ? tradesRef.current.find((t) => t.id === selId && t.epic === epicRef.current)
      : null;
    if (!sel || !field) {
      setTradePills([]);
    } else {
      const pend = pendingRef.current[sel.id] ?? {};
      const merged = mergeTradeLevels(sel, pend);
      const dir = sel.side === "buy" ? 1 : -1;
      // P/L a level would realise if price reached it (from the fixed open level).
      const plAt = (lvl: number) => dir * sel.quantity * (lvl - sel.priceLevel);
      const common = {
        tradeId: sel.id, epic: sel.epic, kind: sel.kind, side: sel.side, qty: sel.quantity,
      };
      let pill: (typeof tradePills)[number] | null = null;
      if (field === "price") {
        const lvl = merged.price ?? sel.priceLevel;
        const y = yOf(lvl);
        if (y != null) pill = { ...common, field, y, level: lvl, pl: sel.upnl, changed: pend.price !== undefined };
      } else if (field === "stop" && merged.stop != null) {
        const y = yOf(merged.stop);
        if (y != null) pill = { ...common, field, y, level: merged.stop, pl: plAt(merged.stop), changed: pend.stop !== undefined };
      } else if (field === "tp" && merged.takeProfit != null) {
        const y = yOf(merged.takeProfit);
        if (y != null) pill = { ...common, field, y, level: merged.takeProfit, pl: plAt(merged.takeProfit), changed: pend.takeProfit !== undefined };
      }
      setTradePills(pill ? [pill] : []);
    }

    // Indicator-selection overlay (one canvas above klinecharts'): the hollow
    // selection handles on the curve, plus the white legend CARDS for hovered/
    // selected candle-pane rows (opaque, so they cover the grid/candles behind
    // them and read as solid in any theme).
    lineCacheRef.current = buildLineCache(chart);
    const canvas = selCanvasRef.current;
    const wrap = wrapRef.current;
    if (canvas && wrap) {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        // Self-drawn horizontal crosshair: only when the cursor is parked over the "+"
        // and NOT snapped (klinecharts dropped its own there, and we don't want a line
        // doubling an alert/trade line under a snap). Mirrors the chart's crosshair line style.
        // We gate only on the top-level show flags, NOT hl.show — that flag is what
        // setSuppressNativeLine writes to hide the native line, so reading it here would
        // cancel our own draw. cs.show / cs.horizontal.show still honor user preference.
        const py = plusCrosshairYRef.current;
        if (py != null) {
          const cs = chart.getStyles().crosshair;
          const hl = cs.horizontal.line;
          if (cs.show !== false && cs.horizontal.show !== false) {
            const mainW = chart.getSize("candle_pane", DomPosition.Main)?.width ?? w;
            ctx.save();
            ctx.strokeStyle = hl.color;
            ctx.lineWidth = hl.size || 1;
            if (hl.style === "dashed") ctx.setLineDash(hl.dashedValue ?? [4, 2]);
            const yy = Math.round(py) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, yy);
            ctx.lineTo(mainW, yy);
            ctx.stroke();
            ctx.restore();
          }
        }
        // Crosshair link: a vertical time guide AND its x-axis time label at a
        // sibling cell's hovered bar — so every linked chart shows the matching
        // timestamp pill, TradingView-style, not just the chart under the cursor.
        const syncTs = syncCrosshairRef.current ? syncedTsRef.current : null;
        if (syncTs != null) {
          const cs = chart.getStyles().crosshair;
          if (cs.show !== false && cs.vertical.show !== false) {
            const sx = first(
              chart.convertToPixel([{ timestamp: syncTs }], {
                paneId: "candle_pane",
                absolute: true,
              }),
            ).x;
            if (sx != null) {
              const vl = cs.vertical.line;
              if (vl.show !== false) {
                ctx.save();
                ctx.strokeStyle = vl.color;
                ctx.lineWidth = vl.size || 1;
                if (vl.style === "dashed") ctx.setLineDash(vl.dashedValue ?? [4, 2]);
                const xx = Math.round(sx) + 0.5;
                ctx.beginPath();
                ctx.moveTo(xx, 0);
                ctx.lineTo(xx, h);
                ctx.stroke();
                ctx.restore();
              }
              // The x-axis time label pill, mirroring klinecharts' own crosshair
              // label (read the resolved style + reuse the same formatter). The
              // x-axis is the bottom strip; its height comes from its own pane.
              const txt = cs.vertical.text;
              const label = txt.show !== false ? crosshairLabelFmtRef.current(syncTs) : "";
              const xAxisH = chart.getSize("x_axis_pane", DomPosition.Root)?.height ?? 0;
              if (label && xAxisH > 1) {
                ctx.save();
                ctx.font = `${txt.weight} ${txt.size}px ${txt.family}`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                const boxW = ctx.measureText(label).width + txt.paddingLeft + txt.paddingRight;
                const boxH = txt.size + txt.paddingTop + txt.paddingBottom;
                // Center on the guide x, clamped to stay within the plot width. The
                // upper bound is floored at boxW/2 so a label wider than the pane
                // (very narrow cell + long timestamp) pins to the left edge rather
                // than overflowing off it (w - boxW/2 would otherwise go negative).
                const cx = Math.min(Math.max(sx, boxW / 2), Math.max(boxW / 2, w - boxW / 2));
                const cy = h - xAxisH / 2; // vertically centered in the x-axis strip
                const left = cx - boxW / 2;
                const top = cy - boxH / 2;
                const r = Math.min(txt.borderRadius, boxH / 2);
                ctx.beginPath();
                ctx.moveTo(left + r, top);
                ctx.arcTo(left + boxW, top, left + boxW, top + boxH, r);
                ctx.arcTo(left + boxW, top + boxH, left, top + boxH, r);
                ctx.arcTo(left, top + boxH, left, top, r);
                ctx.arcTo(left, top, left + boxW, top, r);
                ctx.closePath();
                ctx.fillStyle = txt.backgroundColor as string;
                ctx.fill();
                if (txt.borderSize > 0) {
                  ctx.lineWidth = txt.borderSize;
                  ctx.strokeStyle = txt.borderColor;
                  ctx.stroke();
                }
                ctx.fillStyle = txt.color;
                ctx.fillText(label, cx, cy);
                ctx.restore();
              }
            }
          }
        }
        // Bid & ask price lines (TradingView style): dashed horizontals across the
        // main pane at the live bid (blue) and ask (red). Labels are DOM pills; this
        // draws only the lines, and only in "lines" mode while the feed is live.
        if (bidAskRef.current === "lines" && statusRef.current === "live") {
          const mainW = chart.getSize("candle_pane", DomPosition.Main)?.width ?? w;
          const st = bidAskStyleRef.current;
          // opacity + dash apply to the lines (the labels stay opaque). hexToRgba
          // folds the opacity into the stroke since canvas has no line-alpha field.
          const dash =
            st.lineStyle === "solid" ? [] : st.lineStyle === "dotted" ? DASH_DOTTED : DASH_DASHED;
          const drawLevel = (value: number | null, hex: string) => {
            if (value == null) return;
            const ly = first(
              chart.convertToPixel([{ value }], { paneId: "candle_pane", absolute: true }),
            ).y;
            if (ly == null) return;
            ctx.save();
            ctx.strokeStyle = hexToRgba(hex, st.opacity);
            ctx.lineWidth = 1;
            ctx.setLineDash(dash);
            const yy = Math.round(ly) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, yy);
            ctx.lineTo(mainW, yy);
            ctx.stroke();
            ctx.restore();
          };
          // Skip the side the main price line already coincides with (see pills).
          const side = priceSideRef.current;
          if (side !== "ask") drawLevel(askRef.current, st.askColor);
          if (side !== "bid") drawLevel(bidRef.current, st.bidColor);
        }
        const sel = selectedIndicator.value;
        if (sel) {
          paintSelectionDots(
            ctx,
            lineCacheRef.current,
            sel,
            chartColors[themeRef.current].bg,
            chart.getBarSpace(),
          );
        }
        // Hovering a candle-pane indicator's legend row also shows its curve in
        // selected mode (handles), unless it's already the selected one (no double
        // paint). Driven by the legendHoverName signal (set by <ChartLegend>).
        const hovName = legendHoverName.value;
        if (hovName && !(sel?.paneId === "candle_pane" && sel.name === hovName)) {
          paintSelectionDots(
            ctx,
            lineCacheRef.current,
            { paneId: "candle_pane", name: hovName },
            chartColors[themeRef.current].bg,
            chart.getBarSpace(),
          );
        }
        // Hovering an indicator's CURVE (any pane) shows it in selected mode too —
        // the inverse of the legend-row hover above, but pane-exact (curveHover
        // carries paneId), so sub-pane curves (RSI/MACD/Volume) get handles as well.
        // Skip when it's already the selected indicator (no double paint).
        const curveHov = curveHover.value;
        if (curveHov && !(sel?.paneId === curveHov.paneId && sel.name === curveHov.name)) {
          paintSelectionDots(
            ctx,
            lineCacheRef.current,
            curveHov,
            chartColors[themeRef.current].bg,
            chart.getBarSpace(),
          );
        }
        // AVWAP anchor grab handle — only while AVWAP is selected and its anchor
        // bar is on-screen. anchorPxRef is read by the drag hit-test and the
        // grab-cursor check, so refresh it every redraw (null otherwise).
        const avwapId = selectedAvwapId(chart, sel);
        const anchor = avwapId ? avwapAnchorPixel(chart, avwapId) : null;
        anchorPxRef.current = anchor;
        if (anchor) {
          paintAnchorHandle(ctx, anchor.x, anchor.y, anchor.color, chartColors[themeRef.current].bg);
        }
        // Curve-end key-parameter labels for the SAME active indicators that show
        // selection handles (selected + legend-hover candle row + curve-hover any
        // pane). DOM pills, pushed imperatively — see <CurveLabels>.
        const labelTargets: Array<{ paneId: string; name: string }> = [];
        if (sel) labelTargets.push(sel);
        if (hovName && !(sel?.paneId === "candle_pane" && sel.name === hovName)) {
          labelTargets.push({ paneId: "candle_pane", name: hovName });
        }
        if (curveHov && !(sel?.paneId === curveHov.paneId && sel.name === curveHov.name)) {
          labelTargets.push(curveHov);
        }
        // Always rebuild — pills can show with no selection at all (an "always"
        // indicator) or for the selected/hovered targets. buildCurveLabelPills
        // returns [] when nothing qualifies, clearing the overlay.
        curveLabelsRef.current?.setPills(
          buildCurveLabelPills(
            lineCacheRef.current,
            labelTargets,
            chart.getSize("candle_pane", DomPosition.Main)?.width ?? w,
          ),
        );
      }
    }

    // Refresh the DOM legend: re-derive the candle-pane indicator rows and only
    // setState when the shallow signature changes (add/remove/visibility/recolor),
    // then push the latest values imperatively (for the crosshair bar, or the last
    // bar when no crosshair) — never a React re-render per crosshair pixel.
    const { rows, sig } = buildLegendRows(chart, period.label);
    if (sig !== legendRowsSigRef.current) {
      legendRowsSigRef.current = sig;
      setLegendRows(rows);
    }
    // Same for the sub-pane legends (Volume/MACD/RSI…); the signature folds in each
    // pane's top so a separator drag repositions the cards (see buildSubPaneLegends).
    const sub = buildSubPaneLegends(chart);
    if (sub.sig !== subPaneLegendsSigRef.current) {
      subPaneLegendsSigRef.current = sub.sig;
      setSubPaneLegends(sub.subPanes);
    }
    legendHandleRef.current?.updateValues(crosshairIdxRef.current);
    // Keep the position bracket glued to its lines as geometry shifts (scroll/zoom/
    // tick/drag) — the cursor needn't move for the lines to.
    paintBracket();
    // Period-start separator follows the same geometry (via ref so it isn't a dep).
    paintSeparatorRef.current();
  }, [paintBracket]);
  redrawRef.current = redraw;

  // Apply a bid/ask display OR style change immediately (pills + lines) instead of
  // waiting for the next tick. redraw reads bidAskRef/bidAskStyleRef, kept current
  // above; the label colors come from the bidAskStyle prop in render. priceSide is
  // here too so hiding the redundant bid/ask side updates at once on a side switch.
  useEffect(() => {
    redrawRef.current();
  }, [bidAsk, bidAskStyle, priceSide]);

  // 1s tick keeps the countdown live and tracks slow price/scroll drift.
  useEffect(() => {
    redraw();
    const id = setInterval(redraw, 1000);
    return () => clearInterval(id);
  }, [redraw, status, period.resolution]);

  // Redraw immediately when alerts change or the view scrolls/zooms/pane-drags.
  // OnPaneDrag fires while a separator between panes is dragged — without it the
  // sub-pane legend cards would lag ~1s (next tick) before snapping to the pane's new
  // top. A ResizeObserver on the container covers the other geometry shifts (window
  // resize, split-layout cell resize) that move pane positions without a chart action.
  useEffect(() => {
    overlays.setAlertsListener(redraw);
    const chart = chartRef.current;
    chart?.subscribeAction(ActionType.OnScroll, redraw);
    chart?.subscribeAction(ActionType.OnZoom, redraw);
    chart?.subscribeAction(ActionType.OnPaneDrag, redraw);
    // OnPaneDrag keeps the cards moving DURING the drag; the final mouseup frame can
    // settle the pane geometry without another action, so re-read after layout on
    // pointerup (rAF = post-layout). A ResizeObserver on the container catches the
    // remaining cases (window / split-cell resize) where panes move without a drag.
    const onPointerUp = () => requestAnimationFrame(() => redrawRef.current());
    window.addEventListener("pointerup", onPointerUp);
    // Tell klinecharts to re-measure first, THEN redraw. On a split-layout switch
    // (e.g. 2h→1) the surviving cell keeps its id, so <ChartCore> is not remounted
    // — the chart instance persists with the old (narrower) container's internal
    // layout. Without resize(), it keeps the stale main-pane width and dumps the
    // extra space into the y-axis gutter (axis balloons to ~half the cell). resize()
    // refits the panes to the new width; redraw then reads fresh getSize() for the pills.
    const ro = new ResizeObserver(() => {
      chartRef.current?.resize();
      redrawRef.current();
    });
    if (containerRef.current) ro.observe(containerRef.current);
    // The background alertEngine can fire/remove an alert on THIS (active) epic and
    // write the change to storage; reconcile the on-chart lines off the signal so a
    // "once" alert it deleted also vanishes from the chart.
    const unsubAlerts = alertsChanged.subscribe(() => overlays.reconcileAlerts());
    return () => {
      overlays.setAlertsListener(null);
      unsubAlerts();
      ro.disconnect();
      window.removeEventListener("pointerup", onPointerUp);
      chart?.unsubscribeAction(ActionType.OnScroll, redraw);
      chart?.unsubscribeAction(ActionType.OnZoom, redraw);
      chart?.unsubscribeAction(ActionType.OnPaneDrag, redraw);
    };
  }, [redraw]);

  // The DOM legend's values track the crosshair (TradingView-style): on each
  // crosshair change, remember the hovered bar index and push the values for that
  // bar imperatively (textContent). When the crosshair leaves the chart, klinecharts
  // fires with no dataIndex → fall back to the last bar. klinecharts already
  // rAF-throttles crosshair changes, and we only touch textContent (no re-render).
  useEffect(() => {
    const chart = chartRef.current;
    const onCrosshair = (data?: { dataIndex?: number }) => {
      const idx = typeof data?.dataIndex === "number" ? data.dataIndex : null;
      crosshairIdxRef.current = idx;
      legendHandleRef.current?.updateValues(idx);
      // While the cursor is over THIS chart it's the link source, not a receiver, so
      // drop any sibling guide it was painting and repaint — otherwise that guide
      // stays frozen under this cell's own crosshair when the pointer crosses straight
      // from a sibling (which doesn't reliably fire its own "cursor left" event). Our
      // redraw isn't wired to crosshair changes, so clear it here explicitly.
      if (idx != null && syncedTsRef.current != null) {
        syncedTsRef.current = null;
        redrawRef.current();
      }
      // Crosshair link: broadcast the hovered bar's timestamp to sibling cells (or
      // null when the cursor leaves this chart, so their guides clear).
      const dl = chart?.getDataList();
      const ts = idx != null && dl && dl[idx] ? dl[idx].timestamp : null;
      if (syncCrosshairRef.current) {
        chartSync.publish(tabIdRef.current, { sourceCellId: cellId, timestamp: ts });
      }
      // Lock: the alignment anchor FOLLOWS THE CURSOR. Hovering a bar makes it the
      // tab's anchor and re-aligns siblings live (no click needed) — only when the
      // hovered bar changes. On cursor-leave (ts null) the anchor stays put (sticky),
      // so a later pan/zoom keeps the last-hovered candle aligned. Skipped mid-drawing
      // so placing a drawing's points doesn't yank the other charts around.
      if (lockedRef.current && !overlays.isDrawing()) {
        if (ts == null) {
          lastHoverAnchorTsRef.current = null; // re-assert on the next hover
        } else if (ts !== lastHoverAnchorTsRef.current && chart) {
          lastHoverAnchorTsRef.current = ts;
          setGestureCell(cellId); // the hovered cell is the master → siblings can't echo
          setAlignAnchor(tabIdRef.current, ts);
          const r = readVisibleRange(chart);
          const exact = readExactAnchor(chart, ts);
          if (r && exact) {
            rangeSync.publish(tabIdRef.current, { sourceCellId: cellId, ...r, ...exact });
          }
        }
      }
    };
    chart?.subscribeAction(ActionType.OnCrosshairChange, onCrosshair);
    return () => chart?.unsubscribeAction(ActionType.OnCrosshairChange, onCrosshair);
  }, [cellId]);

  // Receive sibling cells' crosshair broadcasts for this tab and paint a vertical
  // time guide at the shared timestamp (cleared on null / when not linked).
  useEffect(() => {
    const unsub = chartSync.subscribe(tabId, (m) => {
      if (m.sourceCellId === cellId) return; // ignore our own broadcasts
      const next = syncCrosshair ? m.timestamp : null;
      if (syncedTsRef.current === next) return;
      syncedTsRef.current = next;
      redrawRef.current();
    });
    return () => {
      unsub();
      // Drop any lingering guide when this cell stops listening (tab/sync change).
      if (syncedTsRef.current != null) {
        syncedTsRef.current = null;
        redrawRef.current();
      }
    };
  }, [tabId, cellId, syncCrosshair]);

  // Date-range link — BROADCAST. When the link is on, publish this cell's visible
  // time window (the two pixel-edge timestamps) to the tab's sibling cells on every
  // scroll/zoom, coalesced to one publish per frame. Only the cell the cursor is
  // driving broadcasts: pointer-enter / pointer-down / wheel mark this cell as the
  // gesture owner, and onRange bails unless it still owns the gesture. A sibling
  // that merely applies a range gets no pointer events, so it never owns and never
  // echoes — that's what prevents the A→B→A feedback loop (no reliance on klinecharts'
  // scroll-callback timing). Live data ticks fire no scroll/zoom, so an untouched
  // cell never broadcasts on its own.
  useEffect(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    const claim = () => setGestureCell(cellId);
    // klinecharts fires OnScroll/OnZoom roughly once per frame, so publish straight
    // away rather than coalescing through requestAnimationFrame (rAF is paused while
    // the tab is hidden, which would silently stall the link). Gesture ownership —
    // not event timing — is what prevents the echo loop.
    const onRange = () => {
      // A user-driven scroll/zoom drops the quick-range pill (the view no longer
      // matches the preset). The separator MARKER persists though — it's anchored
      // to the period-start timestamp and only becomes visible once you scroll/zoom
      // away from the left edge, which is exactly when it's useful.
      if (!programmaticMoveRef.current) setActiveRange(null);
      if (!syncTimeRef.current || !isGestureCell(cellId)) return;
      // Lock mode needs a window even at a whitespace edge (to keep mirroring siblings
      // pixel-for-pixel); the plain link skips broadcasting there so siblings stay put.
      const r = readVisibleRange(chart, lockedRef.current);
      if (!r) return;
      // Under lock, carry the exact-mode anchor (barSpace + reference bar + its pixel)
      // so siblings on the same interval mirror the window pixel-for-pixel; the plain
      // date-range link omits it (cross-interval, synthesised from fromTs/toTs). The
      // anchor is the tab's sticky align timestamp (last hovered bar) when set, else
      // the right-edge bar — so a hover-aligned offset is preserved through pan/zoom.
      const exact = lockedRef.current
        ? readExactAnchor(chart, getAlignAnchor(tabIdRef.current))
        : null;
      rangeSync.publish(tabIdRef.current, { sourceCellId: cellId, ...r, ...exact });
    };
    container.addEventListener("pointerenter", claim);
    container.addEventListener("pointerdown", claim);
    // Capture phase: klinecharts fires OnScroll SYNCHRONOUSLY from its own wheel
    // handler on an inner container div, before a bubbling wheel reaches us. A
    // capture-phase listener on this ancestor runs first, so `claim` lands before
    // onRange even on the very first wheel after a remount. Programmatic scrolls
    // (a receiver applying a range) dispatch no DOM wheel event, so this only ever
    // claims on real user input — preserving the user-vs-programmatic distinction
    // that keeps the A→B→A echo loop closed.
    container.addEventListener("wheel", claim, { capture: true, passive: true });
    chart.subscribeAction(ActionType.OnScroll, onRange);
    chart.subscribeAction(ActionType.OnZoom, onRange);
    return () => {
      container.removeEventListener("pointerenter", claim);
      container.removeEventListener("pointerdown", claim);
      container.removeEventListener("wheel", claim, { capture: true });
      chart.unsubscribeAction(ActionType.OnScroll, onRange);
      chart.unsubscribeAction(ActionType.OnZoom, onRange);
      // Drop ownership if this (unmounting) cell held it, so the global never points
      // at a dead cell and a freshly-mounted cell's first scroll isn't suppressed.
      releaseGestureCell(cellId);
    };
  }, [cellId]);

  // Date-range link — RECEIVE. Match a sibling cell's broadcast window onto this
  // cell's own bars (handles a different interval). Always applies: publishing is
  // already gated on the source being linked, so a message only ever arrives when
  // this cell should follow it.
  useEffect(() => {
    const unsub = rangeSync.subscribe(tabId, (m) => {
      if (m.sourceCellId === cellId) return; // ignore our own broadcasts
      const chart = chartRef.current;
      if (!chart) return;
      // Exact anchor present = "lock charts" mode (siblings share the interval):
      // reproduce the master's window pixel-for-pixel. Absent = cross-interval date-
      // range link, which synthesises the window from the two edge timestamps.
      if (m.barSpace != null && m.anchorTs != null && m.anchorX != null) {
        applyVisibleRangeExact(chart, m.anchorTs, m.anchorX, m.barSpace);
      } else {
        applyVisibleRange(chart, m.fromTs, m.toTs);
      }
    });
    return unsub;
  }, [tabId, cellId]);

  const precision = effPrecision;
  // Hovering an alert line swaps the crosshair for a drag cursor (TV-style).
  const alertHovered = alertTags.some((t) => t.hovered);

  // Pills currently on screen: the descriptive pill shows while the line is
  // hovered/selected (or the pill itself is hovered), and never over the y-axis.
  const visibleTags = alertTags.filter(
    (t) => !onAxis && (t.active || pillHoverId === t.id),
  );
  // Drive the remaining-time chip: tick once a minute, but ONLY while a visible
  // pill actually carries an expiry (otherwise stay idle — no wasted re-renders).
  const anyVisibleExpiry = visibleTags.some((t) => t.expiresAt != null);
  useEffect(() => {
    if (!anyVisibleExpiry) return;
    setNowTick(Date.now()); // refresh immediately when a pill with expiry appears
    const h = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(h);
  }, [anyVisibleExpiry]);

  // Resolve which pane holds an indicator instance by its (globally unique) name.
  // The legend handlers take only a name (the same name shows in the candle legend
  // or a sub-pane legend), so they look up the owning paneId here — candle_pane for
  // overlays, the dedicated pane for Volume/MACD/RSI/etc. Falls back to candle_pane.
  const paneIdOf = useCallback((name: string): string => {
    const c = chartRef.current;
    const all = c?.getIndicatorByPaneId() as
      | Map<string, Map<string, unknown>>
      | null
      | undefined;
    for (const [paneId, inds] of all ?? []) if (inds.has(name)) return paneId;
    return "candle_pane";
  }, []);

  // DOM legend action-icon handlers (mirror the OnTooltipIconClick routing used by
  // sub-pane indicators): gear opens the settings modal, eye toggles visibility,
  // trash removes (and announces via indicatorRemoved so the Toolbar stays in sync).
  // Each resolves the owning pane via paneIdOf, so they work for candle-pane overlays
  // AND sub-pane indicators (Volume/MACD/RSI) alike.
  const onLegendToggleVisible = useCallback((name: string) => {
    const c = chartRef.current;
    if (!c) return;
    const paneId = paneIdOf(name);
    const ind = c.getIndicatorByPaneId(paneId, name) as
      | { visible?: boolean; extendData?: unknown }
      | null;
    const next = !(ind?.visible ?? true);
    // Also write extendData.userVisible in the SAME operation (never separately) —
    // applyIndicatorIntervalVisibility (lib/indicators.ts) recomputes intent from
    // extendData.userVisible on every period change and does NOT fall back to the
    // live `visible` flag once userVisible has ever been explicitly set. Toggling
    // only the live flag here would make this eye icon appear to self-revert on the
    // next timeframe switch, since the stale userVisible would win again.
    const ext = { ...((ind?.extendData as object) ?? {}), userVisible: next };
    const vis = (ext as { visibility?: VisibilityModel }).visibility ?? defaultVisibility();
    c.overrideIndicator(
      { name, extendData: ext, visible: next && isVisibleOnResolution(vis, period.resolution) },
      paneId,
    );
    // Visibility persists by scope+name (pane-agnostic) and is re-applied on hydrate,
    // so sub-pane indicators now keep their hidden state across reloads too.
    saveIndicatorVisible(scope, name, next);
    redrawRef.current();
  }, [paneIdOf, period.resolution]);
  const onLegendOpenSettings = useCallback((name: string) => {
    indicatorSettingsRequest.set({ paneId: paneIdOf(name), name });
  }, [paneIdOf]);
  const onLegendRemove = useCallback((name: string) => {
    const c = chartRef.current;
    if (!c) return;
    removeIndicatorById(c, scope, name);
    const next = controller.indicators.value.filter((i) => i.id !== name);
    controller.indicators.set(next);
    saveIndicators(scope, next);
    indicatorRemoved.set(name);
    // Refresh the row list now (indicatorRemoved only repaints when the removed
    // indicator was the selected one; an unselected removal would otherwise linger
    // until the next 1s tick).
    redrawRef.current();
  }, [controller, scope, indicatorRemoved]);
  const onLegendSelectRow = useCallback((name: string) => {
    const paneId = paneIdOf(name);
    const cur = selectedIndicator.value;
    if (cur?.paneId === paneId && cur?.name === name) return;
    selectedIndicator.set({ paneId, name });
    redrawRef.current();
  }, [paneIdOf]);

  // Copy an indicator's full live config (type + calcParams / visibility / per-line
  // styles / extendData inputs) to the clipboard as JSON. Paste creates a fresh
  // instance of that type with this exact config (TradingView-style). The config
  // shape matches SavedIndicatorConfig so it round-trips through persisted storage.
  const copyIndicator = useCallback((paneId: string, name: string) => {
    const c = chartRef.current;
    if (!c) return;
    const ind = c.getIndicatorByPaneId(paneId, name) as Indicator | null;
    if (!ind) return;
    const payload = {
      __autoTraderIndicator: 1 as const,
      type: indTypeOf(ind), // the real type (EMA/MA/…), NOT the instance id
      config: {
        calcParams: ind.calcParams as number[] | undefined,
        visible: ind.visible,
        styles: ind.styles?.lines
          ? { lines: ind.styles.lines.map((l) => ({ color: l.color, size: l.size })) }
          : undefined,
        extendData: ind.extendData as Record<string, unknown> | undefined,
      } satisfies SavedIndicatorConfig,
    };
    const json = JSON.stringify(payload, null, 2);
    navigator.clipboard?.writeText(json).then(
      () => toast(`Copied ${ind.shortName ?? indTypeOf(ind)} settings`),
      () => toast("Copy failed (clipboard blocked)"),
    );
  }, []);

  // Paste: read the clipboard, and if it holds a copied indicator, ALWAYS add a
  // fresh instance of that type with the copied config (never dedupe — TradingView
  // behaviour). The anchor (AVWAP's calcParams[0]) rides along literally in the
  // config, so a pasted AVWAP keeps the source's exact anchor.
  const pasteIndicator = useCallback(async () => {
    const c = chartRef.current;
    if (!c) return;
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      toast("Paste failed (clipboard blocked)");
      return;
    }
    let parsed: { __autoTraderIndicator?: number; type?: string; config?: SavedIndicatorConfig };
    try {
      parsed = JSON.parse(text);
    } catch {
      toast("Clipboard has no indicator to paste");
      return;
    }
    if (parsed.__autoTraderIndicator !== 1 || !parsed.type) {
      toast("Clipboard has no indicator to paste");
      return;
    }
    const inst = addIndicatorInstance(c, scope, epicRef.current, parsed.type, {
      config: parsed.config,
      forceHidden: controller.indicatorsHidden.value,
    });
    if (!inst) {
      toast(`Can't paste ${parsed.type}`);
      return;
    }
    const next = [...controller.indicators.value, inst];
    controller.indicators.set(next);
    saveIndicators(scope, next);
    redrawRef.current();
    toast(`Pasted ${parsed.type}`);
  }, [controller, scope]);

  // Ctrl/Cmd+C: copy the SELECTED indicator (if any). Returns true when it acted, so
  // the key handler only swallows the event when there's a selection to copy (else
  // normal text copy still works). Mirrors the legend ⋯ → Copy.
  const copySelectedIndicator = useCallback((): boolean => {
    const sel = selectedIndicator.value;
    if (!sel) return false;
    copyIndicator(sel.paneId, sel.name);
    return true;
  }, [copyIndicator]);

  // --- drawing clipboard (mirrors the indicator clipboard: system clipboard +
  // a tagged JSON envelope, so copy/paste works across cells and tabs) ----------

  // Ctrl/Cmd+C: copy the SELECTED drawing. Returns true when it acted (so the key
  // handler only swallows the event when there was a drawing to copy).
  const copySelectedDrawing = useCallback((): boolean => {
    const id = overlays.getSelectedDrawingId();
    if (!id) return false;
    const d = overlays.getDrawing(id);
    if (!d) return false;
    const payload = {
      __autoTraderDrawing: 1 as const,
      name: d.name,
      points: d.points,
      styles: d.styles,
      visible: d.visible,
      zLevel: d.zLevel,
      extendData: d.extendData,
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(
      () => toast("Copied drawing"),
      () => toast("Copy failed (clipboard blocked)"),
    );
    return true;
  }, [overlays]);

  // Ctrl/Cmd+V: if the clipboard holds a copied drawing, place a duplicate offset a
  // few bars right + a small price delta down so it's visibly distinct from the
  // source (TradingView-style). Returns true when it consumed a drawing payload.
  const pasteDrawing = useCallback(async (): Promise<boolean> => {
    const c = chartRef.current;
    if (!c) return false;
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      return false;
    }
    let parsed: {
      __autoTraderDrawing?: number;
      name?: string;
      points?: Array<{ timestamp?: number; value?: number }>;
      styles?: unknown;
      visible?: boolean;
      zLevel?: number;
      extendData?: unknown;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (parsed.__autoTraderDrawing !== 1 || !parsed.name || !parsed.points) return false;
    // Offset: +2 bars on the time axis, −0.25% on price, so the paste doesn't land
    // exactly on top of the original. barMs from the smallest adjacent-bar gap.
    const dl = c.getDataList();
    let barMs = 60_000;
    for (let i = 1; i < dl.length; i++) {
      const g = dl[i].timestamp - dl[i - 1].timestamp;
      if (g > 0) {
        barMs = Math.min(barMs === 60_000 ? g : barMs, g);
      }
    }
    const dt = barMs * 2;
    const points = parsed.points.map((p) => ({
      timestamp: p.timestamp != null ? p.timestamp + dt : p.timestamp,
      value: p.value != null ? p.value * 0.9975 : p.value,
    }));
    const id = overlays.placeDrawing({
      name: parsed.name,
      points,
      styles: parsed.styles as never,
      visible: parsed.visible,
      zLevel: parsed.zLevel,
      extendData: parsed.extendData,
    });
    if (id) toast("Pasted drawing");
    return true;
  }, [overlays]);

  // Delete/Backspace: remove the selected drawing (TradingView behaviour).
  const deleteSelectedDrawing = useCallback((): boolean => {
    const id = overlays.getSelectedDrawingId();
    if (!id) return false;
    overlays.remove(id);
    return true;
  }, [overlays]);

  // Pane-aware versions of the legend handlers (the legend ones hardcode
  // candle_pane; a curve right-click can target a sub-pane like RSI/MACD).
  const toggleVisibleOn = useCallback((paneId: string, name: string) => {
    const c = chartRef.current;
    if (!c) return;
    const ind = c.getIndicatorByPaneId(paneId, name) as { visible?: boolean } | null;
    const next = !(ind?.visible ?? true);
    c.overrideIndicator({ name, visible: next }, paneId);
    if (paneId === "candle_pane") saveIndicatorVisible(scope, name, next);
    redrawRef.current();
  }, []);
  const removeOn = useCallback(
    (_paneId: string, name: string) => {
      const c = chartRef.current;
      if (!c) return;
      removeIndicatorById(c, scope, name);
      const next = controller.indicators.value.filter((i) => i.id !== name);
      controller.indicators.set(next);
      saveIndicators(scope, next);
      indicatorRemoved.set(name);
      redrawRef.current();
    },
    [controller, scope, indicatorRemoved],
  );

  // Move a sub-pane to a new slot: rebuild panes, persist the new order, and re-resolve
  // the current selection's paneId (recreate mints new paneIds). No-op for candle_pane.
  const reorderPaneByName = useCallback(
    (name: string, targetIndex: number) => {
      const c = chartRef.current;
      if (!c) return;
      const paneId = paneIdOf(name);
      if (paneId === "candle_pane") return;
      const next = reorderSubPanes(
        c,
        scope,
        epicRef.current,
        controller.indicators.value,
        paneId,
        targetIndex,
      );
      if (!next) return;
      controller.indicators.set(next);
      saveIndicators(scope, next);
      const sel = selectedIndicator.value;
      if (sel) selectedIndicator.set({ paneId: paneIdOf(sel.name), name: sel.name });
      redrawRef.current();
    },
    [paneIdOf, scope, controller, selectedIndicator],
  );

  // Drag a sub-pane by its legend handle: track the pointer against each reorderable
  // pane's vertical band, show a drop-indicator line, and on release move the pane to
  // the hovered slot. Rebuild happens via reorderPaneByName (shared with the menu).
  // Abort an in-flight pane drag if the cell unmounts (tab switch, layout change) —
  // its window listeners would otherwise outlive the chart they close over.
  const paneDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => paneDragCleanupRef.current?.(), []);
  const startPaneReorderDrag = useCallback(
    (paneId: string, name: string) => {
      const c = chartRef.current;
      const wrap = wrapRef.current;
      if (!c || !wrap) return;
      const order = subPaneOrder(c);
      if (order.length < 2 || order.indexOf(paneId) < 0) return;
      const rootTop = wrap.getBoundingClientRect().top;
      const bounds = order.map((pid) => {
        const s = c.getSize(pid, DomPosition.Main);
        const top = s?.top ?? 0;
        return { top, bottom: top + (s?.height ?? 0) };
      });
      const from = order.indexOf(paneId);
      let target = from;
      const move = (ev: PointerEvent) => {
        const y = ev.clientY - rootTop;
        let t = 0;
        for (const b of bounds) {
          if ((b.top + b.bottom) / 2 < y) t++;
          else break;
        }
        // Visual insertion line among the CURRENT panes (includes the moving pane).
        const last = bounds[bounds.length - 1];
        setPaneDropTop(t >= bounds.length ? last.bottom : bounds[t].top);
        // arrayMove target is the final index AFTER removal, so discount the moving
        // pane's own slot when the cursor is below it (downward drag).
        target = Math.max(0, Math.min(order.length - 1, t > from ? t - 1 : t));
      };
      // Shared teardown: pointerup commits, pointercancel (touch/OS gesture
      // takeover — pointerup never follows) and a mid-drag unmount just abort.
      // Without the cancel path the drop indicator sticks and the next unrelated
      // pointerup anywhere would commit a reorder the user never dropped.
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        paneDragCleanupRef.current = null;
        setPaneDropTop(null);
      };
      const cancel = () => cleanup();
      const up = () => {
        cleanup();
        if (target !== from) reorderPaneByName(name, target);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      paneDragCleanupRef.current = cleanup;
    },
    [reorderPaneByName],
  );

  // The shared TradingView-style menu, used by both triggers (legend row + curve).
  const indicatorMenuItems = useCallback(
    (paneId: string, name: string): MenuItem[] => {
      const ind = chartRef.current?.getIndicatorByPaneId(paneId, name) as
        | { visible?: boolean }
        | null;
      const visible = ind?.visible ?? true;
      const order = paneId === "candle_pane" ? [] : subPaneOrder(chartRef.current!);
      const idx = order.indexOf(paneId);
      const moveItems: MenuItem[] =
        idx < 0 || order.length < 2
          ? []
          : [
              ...(idx > 0
                ? [{ label: "Move up", icon: MenuIcons.moveUp, onClick: () => reorderPaneByName(name, idx - 1) }]
                : []),
              ...(idx < order.length - 1
                ? [{ label: "Move down", icon: MenuIcons.moveDown, onClick: () => reorderPaneByName(name, idx + 1) }]
                : []),
            ];
      return [
        {
          label: "Settings",
          icon: MenuIcons.settings,
          onClick: () => indicatorSettingsRequest.set({ paneId, name }),
        },
        { label: "Copy", icon: MenuIcons.copy, onClick: () => copyIndicator(paneId, name) },
        {
          label: visible ? "Hide" : "Show",
          icon: visible ? MenuIcons.hide : MenuIcons.show,
          onClick: () => toggleVisibleOn(paneId, name),
        },
        ...moveItems,
        { label: "Remove", icon: MenuIcons.remove, danger: true, onClick: () => removeOn(paneId, name) },
      ];
    },
    [copyIndicator, toggleVisibleOn, removeOn, reorderPaneByName],
  );

  // The legend's ⋯ "more" button opens the menu (anchored below the button).
  const onLegendOpenMenu = useCallback((name: string, x: number, y: number) => {
    setIndMenu({ x, y, paneId: paneIdOf(name), name });
  }, [paneIdOf]);

  return (
    <div
      ref={wrapRef}
      className={`chart-wrap${alertHovered ? " alert-hover" : ""}${cursorMode ? " " + cursorMode : ""}`}
      style={{ width: "100%", height: "100%", position: "relative", outline: "none" }}
      // tabIndex makes the cell focusable so Ctrl/Cmd+C/V are scoped to it (only the
      // focused cell responds — no global listener cross-talk between split cells).
      tabIndex={0}
      // Capture-phase so focus registers even when an inner handler (anchor drag)
      // stops propagation. App marks this cell focused → routes the chrome to it; we
      // also DOM-focus the wrap so it receives keyboard shortcuts.
      onPointerDownCapture={() => {
        onFocus?.(cellId);
        wrapRef.current?.focus({ preventScroll: true });
      }}
      onKeyDown={(e) => {
        // Don't hijack copy/paste/delete while typing in a field.
        const t = e.target as HTMLElement;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
        // Escape cancels the most recent transient first: an ARMED measure (TV: Esc
        // cancels the ruler), then an armed/mid-placement drawing tool, and only
        // then a leftover frozen measure box — a stale box must not swallow the
        // Esc meant for the tool the user just armed.
        if (e.key === "Escape") {
          if (measureArmed.value) {
            measureArmed.set(false);
            overlays.clearMeasure();
            e.preventDefault();
          } else if (overlays.cancelDrawing()) {
            // TV: Esc cancels an armed/mid-placement drawing tool.
            e.preventDefault();
          } else if (overlays.hasMeasure()) {
            overlays.clearMeasure();
            e.preventDefault();
          }
          return;
        }
        // Escape on a selected trade (discard pending → deselect) is handled by a
        // window listener in App, so it works even when focus isn't on the chart.
        // Delete / Backspace removes the selected drawing (no modifier).
        if (e.key === "Delete" || e.key === "Backspace") {
          if (deleteSelectedDrawing()) e.preventDefault();
          return;
        }
        // Alt/Option+I: TV-style invert scale (flip the price axis upside down).
        if (isInvertShortcut(e)) {
          invertScale.set(!invertScale.value);
          e.preventDefault();
          return;
        }
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const k = e.key.toLowerCase();
        if (k === "c") {
          // A selected drawing wins over a selected indicator for copy; fall back to
          // the indicator. Only swallow the event when something was copied (else
          // normal text copy still works).
          if (copySelectedDrawing() || copySelectedIndicator()) e.preventDefault();
        } else if (k === "v") {
          // Try a drawing paste first; if the clipboard holds an indicator instead,
          // fall through to the indicator paste. Both read the clipboard async.
          e.preventDefault();
          void pasteDrawing().then((did) => {
            if (!did) void pasteIndicator();
          });
        }
      }}
    >
      <div
        ref={containerRef}
        className={anchoring || measureArmedUi ? "anchoring" : undefined}
        style={{ width: "100%", height: "100%" }}
      />
      {paneDropTop != null && (
        <div className="pane-drop-indicator" style={{ top: paneDropTop }} />
      )}
      <ChartRangeBar
        activeKey={activeRange}
        disabled={!chartReady}
        onPick={onRangePick}
        onGoToDate={onGoToDate}
      />
      {/* Indicator-selection overlay: hollow selection handles + the AVWAP anchor
          grab handle + the self-drawn "+" crosshair, painted in redraw(). z-index 10
          puts it above klinecharts' own canvases (z-index 2) so the rings sit on top
          of the lines. pointer-events:none so clicks/hover reach the chart below. */}
      {/* The H position bracket (spine + %/R:R badges). Its own canvas under the
          selection overlay (z-index 9) so it's above klinecharts' lines but the
          indicator-selection handles still draw on top. pointer-events:none — purely
          decorative; the draggable lines underneath stay the interactive surface. */}
      {/* Period-start separator (dashed line + date pill). z-index 8: above
          klinecharts' candles (z2) but below the bracket (z9) and selection (z10)
          overlays. pointer-events:none — purely a marker. */}
      <canvas
        ref={sepCanvasRef}
        data-testid="range-separator"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 8,
          pointerEvents: "none",
        }}
      />
      <canvas
        ref={bracketCanvasRef}
        data-testid="position-bracket"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 9,
          pointerEvents: "none",
        }}
      />
      <canvas
        ref={selCanvasRef}
        data-testid="selection-overlay"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 10,
          pointerEvents: "none",
        }}
      />
      {/* Data-unavailable banner: no candles after a grace period (broker maintenance,
          auth failure, offline, or an unknown epic). Generic on purpose — a 401 can't
          be told apart from expired creds, so we don't claim a specific cause. */}
      {noData && (
        <div className="chart-nodata" role="status">
          <div className="chart-nodata-card">
            <svg
              className="chart-nodata-icon"
              viewBox="0 0 24 24" width="28" height="28" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="chart-nodata-title">No data to display</span>
            <span className="chart-nodata-hint">
              Couldn’t load {symbol.epic} — the broker may be temporarily unavailable.
            </span>
            {loadError &&
              (loadError.length <= 90 ? (
                // Short enough to read inline.
                <span className="chart-nodata-err">{loadError}</span>
              ) : (
                // Long / multi-line detail — collapse behind a toggle.
                <div className="chart-nodata-details">
                  <button
                    type="button"
                    className="chart-nodata-toggle"
                    aria-expanded={errorOpen}
                    onClick={() => setErrorOpen((o) => !o)}
                  >
                    {errorOpen ? "Hide error details" : "Show error details"}
                  </button>
                  {errorOpen && <pre className="chart-nodata-errbox">{loadError}</pre>}
                </div>
              ))}
            <span className="chart-nodata-retry">
              <span className="chart-nodata-spinner" aria-hidden="true" />
              Retrying automatically…
            </span>
          </div>
        </div>
      )}

      {/* Curve-end key-parameter labels (DOM pills, crisp text) for the selected/
          highlighted indicator. z-index 11 sits just above the handle overlay. */}
      <CurveLabels handleRef={curveLabelsRef} />
      {/* Top-left legend as crisp DOM (the candle/OHLC row + one row per candle-pane
          indicator), replacing klinecharts' blurry canvas legend. Row membership is
          React state (signature-gated); values update imperatively via the handle. */}
      <ChartLegend
        getChart={getChart}
        controller={controller}
        ctx={{
          symbol: symbol.epic,
          period: period.label,
          precision,
          // The socket connects to OUR backend, so status alone stays "live"
          // through a market close — gate the dot on the market being open too.
          live: status === "live" && !marketClosed,
          broker: brokerLabel(brokerId),
        }}
        rows={legendRows}
        collapsed={legendCollapsed}
        onToggleCollapsed={toggleLegendCollapsed}
        subPanes={subPaneLegends}
        selectedName={selectedName}
        highlightedName={curveHoverNameState}
        handleRef={legendHandleRef}
        onToggleVisible={onLegendToggleVisible}
        onOpenSettings={onLegendOpenSettings}
        onRemove={onLegendRemove}
        onSelectRow={onLegendSelectRow}
        onOpenMenu={onLegendOpenMenu}
        onMove={reorderPaneByName}
        onStartReorder={startPaneReorderDrag}
        onOpenDetails={() => setDetailsOpen(true)}
        cacheBadge={cacheBadge}
        onOpenCacheStats={() => setCacheStatsOpen(true)}
        // Clicking the symbol name swaps the instrument (TradingView-style). The
        // wrap's onPointerDownCapture has already focused this cell, so the shared
        // symbol-search modal targets this cell's symbol.
        onChangeSymbol={requestSymbolSearch}
      />

      {detailsOpen && (
        <InstrumentDetailsModal
          epic={symbol.epic}
          brokerId={brokerId}
          title={symbol.name ?? symbol.epic}
          onClose={() => setDetailsOpen(false)}
        />
      )}

      {cacheStatsOpen && (
        <CandleCacheStatsModal
          epic={symbol.epic}
          resolution={period.resolution}
          priceSide={priceSide}
          brokerId={brokerId}
          title={`${symbol.name ?? symbol.epic} cache stats`}
          onClose={() => setCacheStatsOpen(false)}
        />
      )}

      {indMenu && (
        <ContextMenu
          x={indMenu.x}
          y={indMenu.y}
          items={indicatorMenuItems(indMenu.paneId, indMenu.name)}
          onClose={() => setIndMenu(null)}
        />
      )}

      {chartMenu && (
        <ContextMenu
          x={chartMenu.x}
          y={chartMenu.y}
          items={[
            {
              label: "Paste",
              icon: MenuIcons.paste,
              // Mirror the Ctrl/Cmd+V handler: a copied drawing or indicator can be
              // on the clipboard, so try drawing first and fall back to indicator.
              onClick: () =>
                void pasteDrawing().then((did) => {
                  if (!did) void pasteIndicator();
                }),
            },
            { label: "Settings", icon: MenuIcons.settings, onClick: () => openSettings() },
          ]}
          onClose={() => setChartMenu(null)}
        />
      )}

      {axisMenu && (
        <ContextMenu
          x={axisMenu.x}
          y={axisMenu.y}
          items={[
            {
              label: "Scale price chart only",
              icon: scaleOnly ? MenuIcons.apply : undefined,
              onClick: toggleScalePriceOnly,
            },
          ]}
          onClose={() => setAxisMenu(null)}
        />
      )}

      {priceTag && (
        <div
          className={`price-tag ${status === "live" ? `live ${priceTag.dir}` : "stale"}`}
          style={{ top: priceTag.y, width: priceTag.w }}
        >
          <span className="pt-price">
            {(lastPrice ?? priceTag.price).toFixed(precision)}
          </span>
          {priceTag.countdown && <span className="pt-cd">{priceTag.countdown}</span>}
        </div>
      )}

      {/* Live ask (buy) and bid (sell) axis labels, TradingView two-tone: a solid
          colored side tag + the price on a light tint of the same color. Colors
          come from the global bid/ask style (labels stay opaque; opacity is for
          the lines only). */}
      {askTag && (
        <div className="ba-tag" style={{ top: askTag.y }}>
          <span className="ba-side" style={{ background: bidAskStyle.askColor }}>Ask</span>
          <span
            className="ba-price"
            style={{ width: askTag.w, background: hexToRgba(bidAskStyle.askColor, 0.16), color: bidAskStyle.askColor }}
          >
            {askTag.price.toFixed(precision)}
          </span>
        </div>
      )}
      {bidTag && (
        <div className="ba-tag" style={{ top: bidTag.y }}>
          <span className="ba-side" style={{ background: bidAskStyle.bidColor }}>Bid</span>
          <span
            className="ba-price"
            style={{ width: bidTag.w, background: hexToRgba(bidAskStyle.bidColor, 0.16), color: bidAskStyle.bidColor }}
          >
            {bidTag.price.toFixed(precision)}
          </span>
        </div>
      )}

      {alertTags.map((t) => {
        // Hide an alert's axis tag when it shares the live-price row and isn't
        // selected: the live price pill owns that row on hover/idle. The alert tag
        // is WIDER than the price pill (its bell protrudes left), so even at a lower
        // z-index its left edge shows past the pill and reads as overlapping it. This
        // is the counterpart to redraw()'s rule that hides the price pill when an
        // alert IS selected on that row — together: not-selected ⇒ price wins the row,
        // selected ⇒ the alert wins it. (When the alert is selected and overlaps,
        // priceTag is already null, so the band test below is moot.) The band matches
        // redraw's priceObscured: half the price pill (40px with countdown, else 20)
        // plus half an alert tag (10).
        if (
          !t.selected &&
          priceTag &&
          Math.abs(t.y - priceTag.y) <= (priceTag.countdown ? 20 : 10) + 10
        ) {
          return null;
        }
        return (
        <div key={t.id} className={`alert-tag${t.selected ? " selected" : ""}`} style={{ top: t.y }} title="Price alert">
          {/* Inline SVG bell (currentColor → amber via .at-bell) so the tag stays in
              the monochrome SVG-icon language, not a colored 🔔 emoji. */}
          <span className="at-bell" aria-hidden="true">
            <BellIcon size={11} />
          </span>
          <span className="at-price">{t.level.toFixed(precision)}</span>
        </div>
        );
      })}

      {/* TV-style descriptive pill on the line itself — shown while the line is
          hovered/selected (or the pill itself is hovered). Follows the cursor's x
          (positioned imperatively) and carries the delete affordance. */}
      {visibleTags.map((t) => {
          const remaining =
            t.expiresAt != null ? formatRemaining(t.expiresAt - nowTick) : null;
          const isOnce = t.trigger === "once";
          return (
          <div
            key={t.id}
            ref={registerPill}
            data-alert-id={t.id}
            className={`alert-pill${t.selected ? " selected" : ""}`}
            // Seed `left` from the last imperative position so a re-render (e.g.
            // moving the cursor onto the sidebar) doesn't reset a frozen pill to 0.
            style={{ top: t.y, left: pillLeftRef.current.get(t.id) ?? undefined }}
            onMouseEnter={() => setPillHoverId(t.id)}
            onMouseLeave={() => setPillHoverId((cur) => (cur === t.id ? null : cur))}
            // Double-click the pill body -> edit modal (matches the alert line).
            onDoubleClick={() => alertEditRequest.set({ id: t.id })}
          >
            <span className="ap-text">
              {symbol.epic} {CONDITION_LABELS[t.condition]} {t.level.toFixed(precision)}
            </span>
            {/* Clickable one-time (1×) ↔ permanent (∞) toggle. Always present. */}
            <button
              className={`ap-trigger ${isOnce ? "once" : "every"}`}
              title={isOnce ? "One-time alert — click to make permanent" : "Permanent alert — click to make one-time"}
              aria-label={isOnce ? "One-time alert" : "Permanent alert"}
              onClick={() => overlays.toggleAlertTrigger(t.id)}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {isOnce ? "1×" : "∞"}
            </button>
            {remaining && (
              <span className="ap-remaining" title="Time until this alert expires">
                {remaining}
              </span>
            )}
            <button
              className="ap-del"
              title="Delete alert"
              onClick={() => {
                requestConfirm({
                  message: `Delete alert ${CONDITION_LABELS[t.condition]} ${t.level.toFixed(precision)} on ${symbol.epic}?`,
                  onConfirm: () => {
                    overlays.remove(t.id);
                    setPillHoverId((cur) => (cur === t.id ? null : cur));
                  },
                });
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
          );
        })}

      {/* The ACTIVE line's pill (entry / SL / TP — only one shows). It carries the
          symbol + level; the entry pill adds uPnL + close, the SL/TP pills add the P/L
          that level would realise if hit + remove. ANY pill shows Apply/Discard when
          ITS OWN line has a staged drag. Anchored at the line's y, frozen x. */}
      {tradePills.map((p) => {
        const prec = precisionRef.current;
        const isEntry = p.field === "price";
        const pendKey = p.field === "tp" ? "takeProfit" : p.field; // pendingEdits key
        const label = isEntry
          ? `${tradeLabel(p.kind, p.side)} ${p.qty} @ ${p.level.toFixed(prec)}`
          : `${p.field === "stop" ? "SL" : "TP"} ${p.level.toFixed(prec)}`;
        const sign = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
        // Remove this SL/TP line: commit the level cleared right away (an explicit
        // action, like delete), then focus the entry pill since this line is gone.
        const removeLevel = async () => {
          const t = tradesRef.current.find((x) => x.id === p.tradeId);
          if (!t) return;
          const merged = mergeTradeLevels(t, pendingRef.current[t.id] ?? {});
          if (p.field === "stop") merged.stop = null;
          else merged.takeProfit = null;
          try {
            await applyEditedLevels(t, merged, getTradesAccount());
            discardPendingEdit(t.id);
            refreshTrades();
            setTradeSelected(t.id, "price");
          } catch (err) {
            toast(err instanceof Error ? err.message : "Remove failed");
          }
        };
        return (
          <div
            key={`${p.tradeId}:${p.field}`}
            className={`trade-pill tp-line-${p.field}${p.changed ? " has-changes" : ""}`}
            style={{ top: p.y, left: tradePillLeftRef.current ?? undefined }}
          >
            <span className="tp-sym">{p.epic}</span>
            <span className="tp-text">{label}</span>
            {p.pl != null && (
              <span
                className={`tp-upnl ${p.pl >= 0 ? "pos" : "neg"}`}
                title={isEntry ? "Unrealised P&L" : "P&L if this level is hit"}
              >
                {sign(p.pl)}
              </span>
            )}
            {p.changed && (
              <>
                <button
                  className="tp-btn tp-apply"
                  title="Apply changes"
                  onClick={async () => {
                    const t = tradesRef.current.find((x) => x.id === p.tradeId);
                    if (!t) return;
                    const merged = mergeTradeLevels(t, pendingRef.current[t.id] ?? {});
                    try {
                      await applyEditedLevels(t, merged, getTradesAccount());
                      discardPendingEdit(t.id); // committed → clear the staged copy
                      refreshTrades();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : "Apply failed");
                    }
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
                <button
                  className="tp-btn tp-discard"
                  title="Discard changes"
                  onClick={() => discardPendingField(p.tradeId, pendKey)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </>
            )}
            {/* Close (entry) / remove (SL·TP) only when the line ISN'T mid-edit — while
                a drag is staged the pill shows just Apply (✓) / Discard (✕). */}
            {!p.changed && (isEntry ? (
              <button
                className="tp-btn tp-close"
                title={p.kind === "order" ? "Cancel order" : "Close position"}
                onClick={() => {
                  const t = tradesRef.current.find((x) => x.id === p.tradeId);
                  if (!t) return;
                  const isOrder = t.kind === "order";
                  const f = (n: number) => n.toFixed(prec);
                  const details: NonNullable<Parameters<typeof requestConfirm>[0]["details"]> = [
                    { label: "Symbol", value: t.epic },
                    { label: "Side", value: tradeLabel(t.kind, t.side) },
                    { label: "Quantity", value: String(t.quantity) },
                    { label: isOrder ? "Limit" : "Avg fill", value: f(t.priceLevel) },
                  ];
                  if (t.takeProfit != null) details.push({ label: "Take profit", value: f(t.takeProfit) });
                  if (t.stop != null) details.push({ label: "Stop loss", value: f(t.stop) });
                  if (!isOrder && t.upnl != null) {
                    details.push({
                      label: "Realized P&L",
                      value: sign(t.upnl),
                      tone: t.upnl >= 0 ? "pos" : "neg",
                    });
                  }
                  requestConfirm({
                    title: isOrder ? "Cancel order" : "Close position",
                    message: isOrder
                      ? `Cancel this ${tradeLabel(t.kind, t.side)} order on ${t.epic}?`
                      : `Close this ${tradeLabel(t.kind, t.side)} position on ${t.epic} at market?`,
                    confirmLabel: isOrder ? "Cancel order" : "Close position",
                    details,
                    onConfirm: async () => {
                      try {
                        if (isOrder) await cancelWorkingOrder(t.id, getTradesAccount());
                        else await closePosition(t.id, getTradesAccount());
                        setTradeSelected(null);
                        refreshTrades();
                      } catch (err) {
                        toast(err instanceof Error ? err.message : "Action failed");
                      }
                    },
                  });
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            ) : (
              <button
                className="tp-btn tp-remove"
                title={p.field === "stop" ? "Remove stop loss" : "Remove take profit"}
                onClick={removeLevel}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            ))}
          </div>
        );
      })}

      <div
        ref={plusBtnRef}
        className="axis-plus"
        style={{ display: "none" }}
        title="Add alert / draw at this price"
        // Moving the cursor onto the "+" makes klinecharts drop the line's hover
        // (it's a DOM sibling over the canvas). Keep the active alert's pill shown
        // (and following) while parked here, mirroring the pill's own hover guard.
        onMouseEnter={() => {
          if (lastActivePillIdRef.current) setPillHoverId(lastActivePillIdRef.current);
        }}
        onMouseLeave={() =>
          setPillHoverId((cur) => (cur === lastActivePillIdRef.current ? null : cur))
        }
        onClick={() => {
          const el = containerRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const top = parseFloat(plusBtnRef.current?.style.top || "0");
          setPlusMenu({ x: rect.right - 12, y: rect.top + top, price: plusPriceRef.current });
        }}
      >
        <span className="axis-plus-icon">
          {/* SVG plus (not the "+" glyph) so it's perfectly centered in the circle. */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
        <span className="axis-plus-price" ref={plusPriceLabelRef} />
      </div>


      {plusMenu && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          items={[
            {
              label: `Add alert at ${plusMenu.price.toFixed(precision)}`,
              // Create immediately, inheriting the user's alert defaults (no modal).
              // Matches TV's quick "add alert here" — editable afterwards (dbl-click).
              onClick: () => {
                const ad = loadSettings().alertDefaults;
                overlays.addAlert(plusMenu.price, {
                  condition: ad.condition,
                  trigger: ad.trigger,
                  message: "",
                  expiresAt: resolveExpiry(ad.expiry, Date.now()),
                  notify: ad.notify,
                });
              },
            },
            {
              label: `Draw horizontal line at ${plusMenu.price.toFixed(precision)}`,
              onClick: () =>
                overlays.addDrawing("horizontalStraightLine", [{ value: plusMenu.price }]),
            },
          ]}
          onClose={() => {
            setPlusMenu(null);
            if (plusBtnRef.current) plusBtnRef.current.style.display = "none";
          }}
        />
      )}
    </div>
  );
}
