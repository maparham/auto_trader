// The master redraw loop for a ChartCore cell + the two self-drawn painters it
// drives (paintBracket, paintSeparator/fmtSeparatorLabel), extracted verbatim
// from ChartCore. `redraw` recomputes every axis/canvas overlay from the chart's
// current geometry (price/bid/ask pills, alert tags, trade pills, selection
// handles, crosshair link, backtest/exit aggregate pills, legend rows) and is
// wired to the 1s tick, scroll/zoom, live ticks and overlay changes.
//
// It is `(handle, deps)`-shaped: EVERY value the originals read from ChartCore's
// closure is supplied here via `handle.*` (identity-stable for the mount), a
// module import, or an explicit `deps` field (all refs — never value snapshots —
// so the memoized bodies keep the ORIGINAL dependency arrays: `paintBracket` is
// `[]`, `redraw` is `[paintBracket]`, correct only because every read is a ref).
//
// The three functions publish onto their bridge refs in render (before any effect
// runs) so the one-time init effect + other cross-boundary callers keep working:
// `handle.paintBracketRef.current = paintBracket`, `handle.paintSeparatorRef`,
// `handle.redrawRef` — the same staleness-proof ref-bridge as the other hooks.
import { useCallback } from "react";
import { DomPosition } from "klinecharts";
import {
  first,
  paintSelectionDots,
  buildCurveLabelPills,
  paintAnchorHandle,
  fmtCountdown,
} from "./chartPainters";
import {
  type LineCache,
  buildLineCache,
  avwapAnchorPixel,
  selectedAvwapId,
} from "./chartGeometry";
import { buildLegendRows, buildSubPaneLegends, type LegendRow, type SubPaneLegendData, type ChartLegendHandle } from "../ChartLegend";
import { getBacktestAggregate } from "../lib/backtest";
import { type AggPill } from "../BacktestAggMarkers";
import { type ExitPill } from "../TradeExitAggMarkers";
import { mergeTradeLevels, isBreakeven, isBreakevenTarget, getLivePrice, type OrderSide } from "../lib/trading";
import { type TradeLineField } from "../lib/signals";
import { bracketLabels } from "../lib/positionLines";
import { hexToRgba, DASH_DASHED, DASH_DOTTED } from "../lib/lineStyle";
import { isSynthetic } from "../lib/syntheticRegistry";
import { chartColors, type BidAskStyle, type Theme } from "../theme";
import { RESOLUTION_SECONDS, type LiveStatus } from "../lib/feed";
import { type AlertCondition, type AlertTrigger } from "../lib/persist";
import { type ExitCluster } from "../lib/tradeMarkers";
import type { CurveLabelsHandle } from "../CurveLabels";
import type { ChartHandle } from "./chartHandle";

// Module-const from ChartCore (.ba-tag height; stacks bid/ask clear of the price pill).
const BA_TAG_H = 18;
// Module-consts from ChartCore: the trade-line spine geometry.
const TRADE_SPINE_X = 92;
const TRADE_HANDLE_R = 4.5;

// The alert-tag element type (mirrors ChartCore's setAlertTags state element).
type AlertTag = {
  id: string;
  y: number;
  level: number;
  condition: AlertCondition;
  trigger: AlertTrigger;
  expiresAt: number | null;
  hovered: boolean;
  active: boolean;
  selected: boolean;
};

// The trade-pill element type (mirrors ChartCore's setTradePills state element).
// `redraw` reads `typeof tradePills` in ChartCore — that state value doesn't exist
// here, so the local `const pills` is typed against this explicit alias instead.
type TradePill = {
  tradeId: string;
  field: TradeLineField;
  y: number;
  kind: "position" | "order";
  side: OrderSide;
  qty: number;
  level: number;
  pl: number | null;
  changed: boolean;
  breakevenField?: "stop" | "takeProfit";
};

type PriceTag = {
  y: number;
  price: number;
  countdown: string | null;
  w: number;
  dir: "up" | "down";
} | null;
type BaTag = { y: number; price: number; w: number } | null;

export interface ChartPaintDeps {
  // State setters the redraw loop writes.
  setPriceTag: React.Dispatch<React.SetStateAction<PriceTag>>;
  setBidTag: React.Dispatch<React.SetStateAction<BaTag>>;
  setAskTag: React.Dispatch<React.SetStateAction<BaTag>>;
  setAlertTags: React.Dispatch<React.SetStateAction<AlertTag[]>>;
  setTradePills: React.Dispatch<React.SetStateAction<TradePill[]>>;
  setLegendRows: React.Dispatch<React.SetStateAction<LegendRow[]>>;
  setSubPaneLegends: React.Dispatch<React.SetStateAction<SubPaneLegendData[]>>;
  // Props / value the painters read (fmtSeparatorLabel/paintSeparator dep on these).
  timezone: string;
  theme: Theme;
  // ChartCore-local refs the moved bodies read (never value snapshots — so the
  // original memo dep arrays stay correct).
  containerRef: React.RefObject<HTMLDivElement | null>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  bracketCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  sepCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  selCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  bracketShownRef: React.MutableRefObject<boolean>;
  draggingTradeRef: React.MutableRefObject<string | null>;
  hoveredFieldRef: React.MutableRefObject<TradeLineField | null>;
  marketClosedRef: React.MutableRefObject<boolean>;
  statusRef: React.MutableRefObject<LiveStatus>;
  bidAskRef: React.MutableRefObject<import("../theme").BidAsk>;
  bidAskStyleRef: React.MutableRefObject<BidAskStyle>;
  lastPriceHiddenRef: React.MutableRefObject<boolean>;
  lastActivePillIdRef: React.MutableRefObject<string | null>;
  positionsHiddenRef: React.MutableRefObject<boolean>;
  snapViewRef: React.MutableRefObject<boolean>;
  sepCacheRef: React.MutableRefObject<{ ts: number; tz: string; theme: string; label: string; accent: string } | null>;
  lineCacheRef: React.MutableRefObject<LineCache[]>;
  plusCrosshairYRef: React.MutableRefObject<number | null>;
  syncCrosshairRef: React.MutableRefObject<boolean>;
  syncedTsRef: React.MutableRefObject<number | null>;
  crosshairLabelFmtRef: React.MutableRefObject<(ts: number) => string>;
  curveLabelsRef: React.RefObject<CurveLabelsHandle | null>;
  legendRowsSigRef: React.MutableRefObject<string>;
  subPaneLegendsSigRef: React.MutableRefObject<string>;
  legendHandleRef: React.RefObject<ChartLegendHandle | null>;
  legendBarIdxRef: React.MutableRefObject<() => number | null>;
  exitClustersRef: React.MutableRefObject<ExitCluster[]>;
  precisionRef: React.MutableRefObject<number>;
  themeRef: React.MutableRefObject<Theme>;
  anchorPxRef: React.MutableRefObject<{ x: number; y: number; ts: number; color: string } | null>;
  // Chart period (redraw reads period.label for the legend rows).
  period: { label: string };
}

export function useChartPaint(handle: ChartHandle, deps: ChartPaintDeps) {
  const {
    setPriceTag,
    setBidTag,
    setAskTag,
    setAlertTags,
    setTradePills,
    setLegendRows,
    setSubPaneLegends,
    timezone,
    theme,
    containerRef,
    wrapRef,
    bracketCanvasRef,
    sepCanvasRef,
    selCanvasRef,
    bracketShownRef,
    draggingTradeRef,
    hoveredFieldRef,
    marketClosedRef,
    statusRef,
    bidAskRef,
    bidAskStyleRef,
    lastPriceHiddenRef,
    lastActivePillIdRef,
    positionsHiddenRef,
    snapViewRef,
    sepCacheRef,
    lineCacheRef,
    plusCrosshairYRef,
    syncCrosshairRef,
    syncedTsRef,
    crosshairLabelFmtRef,
    curveLabelsRef,
    legendRowsSigRef,
    subPaneLegendsSigRef,
    legendHandleRef,
    legendBarIdxRef,
    exitClustersRef,
    precisionRef,
    themeRef,
    anchorPxRef,
    period,
  } = deps;

  const {
    chartRef,
    epicRef,
    draftRef,
    tradeUiRef,
    tradesRef,
    pendingRef,
    resRef,
    priceSideRef,
    bidRef,
    askRef,
    separatorTsRef,
    overlays,
    controller,
    aggMarkersRef,
    exitAggMarkersRef,
  } = handle;

  const { selectedIndicator, legendHoverName, curveHover } = controller;

  const paintBracket = useCallback(() => {
    if (isSynthetic(epicRef.current)) return; // analysis-only: no position connector
    const chart = chartRef.current;
    const canvas = bracketCanvasRef.current;
    const wrap = wrapRef.current;
    if (!chart || !canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    // Resolve the subject: the staged draft (this epic) first, else the click-selected
    // trade, else the hovered trade. Selection paints in the side colour with the focused
    // handle filled; a mere hover paints grey with just the hovered handle outlined.
    const epic = epicRef.current;
    const draft = draftRef.current;
    let entry: number | null = null, stop: number | null = null, tp: number | null = null;
    let selectMode = false; // neutral-coloured (selected/draft) vs grey (hover)
    let activeField: TradeLineField | null = null; // filled (select) / outlined (hover) handle
    if (draft && draft.epic === epic) {
      stop = draft.stop ?? null;
      tp = draft.takeProfit ?? null;
      entry = draft.type === "limit" ? draft.price ?? null : getLivePrice(epic) ?? null;
      selectMode = true;
    } else {
      const selId = tradeUiRef.current.selected;
      const hovId = tradeUiRef.current.hovered;
      // An active drag reveals the bracket too — in no-confirm mode a drag sets neither
      // selection nor hover. A drag is the live gesture, so it takes PRECEDENCE: dragging
      // trade B while trade A is selected must paint B's spine (which its now-full-width
      // line needs), not A's.
      const dragId = draggingTradeRef.current;
      const id = dragId ?? selId ?? hovId;
      const t = id ? tradesRef.current.find((x) => x.id === id && x.epic === epic) : null;
      if (t) {
        const merged = mergeTradeLevels(t, pendingRef.current[t.id] ?? {});
        entry = merged.price ?? t.priceLevel;
        stop = merged.stop;
        tp = merged.takeProfit;
        selectMode = id === dragId || id === selId;
        activeField = selId != null ? tradeUiRef.current.selectedField : hoveredFieldRef.current;
      }
    }

    // Nothing active (no entry anchor) → clear once and bail. The clientWidth/Height reads
    // below force a reflow, so the common nothing-active mousemove bails HERE first (cheap
    // ref reads) and only touches the canvas if it had drawn something that needs clearing.
    if (entry == null) {
      if (bracketShownRef.current) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
        bracketShownRef.current = false;
      }
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
    // Colour carries ONE meaning here — profit/loss: green = target leg, red = stop leg.
    // The position itself is de-hued to a neutral slate (it holds no direction the P/L
    // number doesn't already show), so the two accent colours read as accents, not blocks.
    const GREY = "#8a93a0", NEUTRAL = "#6b7280", SIDE = NEUTRAL;
    const roleOf = (f: TradeLineField) => (f === "stop" ? "#f23645" : f === "tp" ? "#089981" : NEUTRAL);
    const bx = TRADE_SPINE_X + 0.5; // crisp 1.5px stroke
    const lines = ([
      ["price", yOf(entry)],
      ["stop", yOf(stop)],
      ["tp", yOf(tp)],
    ] as [TradeLineField, number | null][]).filter((l): l is [TradeLineField, number] => l[1] != null);

    // Spine as a thin caliper linking the levels — a hairline stem with short tick end-caps,
    // which reads as the measurement the %/R:R badges describe. Only meaningful with ≥2 lines;
    // grey on hover, neutral on select.
    if (lines.length >= 2) {
      const ys = lines.map((l) => l[1]);
      const top = Math.min(...ys), bot = Math.max(...ys);
      ctx.lineWidth = 1;
      ctx.strokeStyle = selectMode ? SIDE : GREY;
      ctx.beginPath();
      ctx.moveTo(bx, top);
      ctx.lineTo(bx, bot);
      ctx.moveTo(bx - 3, top); ctx.lineTo(bx + 3, top); // end-caps
      ctx.moveTo(bx - 3, bot); ctx.lineTo(bx + 3, bot);
      ctx.stroke();
    }
    // %/R:R badges to the LEFT of the spine (unsigned magnitudes — colour carries meaning).
    const labels = bracketLabels({ entry, stop, tp });
    // Chip backdrop so the badge text reads over gridlines/candles.
    const surfaceBg = getComputedStyle(wrap).getPropertyValue("--surface").trim() || "#161a1f";
    // A quiet, BORDERLESS mono tag: surface backdrop + role-coloured text, right-aligned so it
    // ENDS just left of the spine. Borderless (a tier below the bordered pills) so the badges
    // read as annotation on the caliper, not objects competing with the readout.
    const badge = (y: number, text: string, color: string) => {
      ctx.save();
      ctx.font = '600 10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      const pw = Math.round(ctx.measureText(text).width) + 10, ph = 15;
      const left = Math.round(TRADE_SPINE_X - 10 - pw), top = Math.round(y - ph / 2);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(left, top, pw, ph, 3);
      else ctx.rect(left, top, pw, ph);
      ctx.fillStyle = surfaceBg;
      ctx.fill();
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, left + 5, y + 0.5);
      ctx.restore();
    };
    const badgeFor = (f: TradeLineField, y: number) => {
      const txt = f === "stop" ? (labels.slPct != null ? `SL ${labels.slPct.toFixed(2)}%` : null)
        : f === "tp" ? (labels.tpPct != null ? `TP ${labels.tpPct.toFixed(2)}%` : null)
        : (labels.rr != null ? `1:${labels.rr.toFixed(1)}` : null);
      if (txt == null) return;
      badge(y, txt, roleOf(f)); // price → neutral, stop → red, tp → green
    };
    // Handles — hover: only the hovered handle takes its role colour, rest grey; select:
    // all side colour, the focused one filled. Drawn after the spine so they sit on top.
    for (const [field, y] of lines) {
      badgeFor(field, y);
      const outline = selectMode ? SIDE : field === activeField ? roleOf(field) : GREY;
      ctx.beginPath();
      ctx.arc(TRADE_SPINE_X, y, TRADE_HANDLE_R, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = outline;
      // Hollow (surface backdrop) at rest; the selected/focused handle fills solid neutral.
      ctx.fillStyle = selectMode && field === activeField ? SIDE : surfaceBg;
      ctx.fill();
      ctx.stroke();
    }
  }, []);
  handle.paintBracketRef.current = paintBracket;

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
  handle.paintSeparatorRef.current = paintSeparator;

  const redraw = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) {
      setPriceTag(null);
      setAlertTags([]);
      handle.paintSeparatorRef.current();
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

    // Always-on clean pills: one per line (entry always; SL/TP when set) for EVERY
    // position/order on this cell's epic — identical whether selected or not. Levels
    // merge pending over server (so a dragged line is tracked); recomputed here so pills
    // follow their lines through scroll/zoom/live ticks. Hidden trades (eye icon) are
    // skipped unless hovered/selected; the master-hide toggle drops them all.
    const uiSel = tradeUiRef.current.selected;
    const uiHov = tradeUiRef.current.hovered;
    const hiddenSet = new Set(tradeUiRef.current.hidden);
    const pills: TradePill[] = [];
    if (!positionsHiddenRef.current && !snapViewRef.current) {
      for (const t of tradesRef.current) {
        if (t.epic !== epicRef.current) continue;
        if (hiddenSet.has(t.id) && t.id !== uiHov && t.id !== uiSel) continue;
        const pend = pendingRef.current[t.id] ?? {};
        const merged = mergeTradeLevels(t, pend);
        const priceLvl = merged.price ?? t.priceLevel;
        // A position's SL or TP sitting at entry merges into the entry line (stop wins
        // if both compute true — they can't validly). The merged field drives the "BE"
        // chip and which pending edit its Apply/Discard commits/clears.
        const stopBE = t.kind === "position" && isBreakeven(priceLvl, merged.stop, precisionRef.current);
        const tpBE = t.kind === "position" && isBreakevenTarget(priceLvl, merged.takeProfit, precisionRef.current);
        const beField = stopBE ? "stop" : tpBE ? "takeProfit" : undefined;
        const dir = t.side === "buy" ? 1 : -1;
        // P/L a level would realise if price reached it (from the fixed open level).
        const plAt = (lvl: number) => dir * t.quantity * (lvl - t.priceLevel);
        const common = { tradeId: t.id, kind: t.kind, side: t.side, qty: t.quantity };
        const yP = yOf(priceLvl);
        // Entry pill carries live uPnL for an open position; a resting order has none.
        // `changed` also lights up when a breakeven-staged SL/TP is pending (drag path):
        // the merged level's own pill is suppressed at breakeven, so its Apply/Discard
        // affordance must surface here, or a dragged-to-entry SL/TP would strand un-commit-able.
        if (yP != null)
          pills.push({ ...common, field: "price", y: yP, level: priceLvl, pl: t.kind === "position" ? t.upnl : null, changed: pend.price !== undefined || (beField != null && pend[beField] !== undefined), breakevenField: beField });
        if (merged.stop != null && !stopBE) {
          const y = yOf(merged.stop);
          if (y != null) pills.push({ ...common, field: "stop", y, level: merged.stop, pl: plAt(merged.stop), changed: pend.stop !== undefined });
        }
        if (merged.takeProfit != null && !tpBE) {
          const y = yOf(merged.takeProfit);
          if (y != null) pills.push({ ...common, field: "tp", y, level: merged.takeProfit, pl: plAt(merged.takeProfit), changed: pend.takeProfit !== undefined });
        }
      }
    }
    setTradePills(pills);

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
    legendHandleRef.current?.updateValues(legendBarIdxRef.current());
    // Higher-timeframe backtest markers: project each aggregate cluster's bar-high
    // anchor to a pixel and feed the DOM pill layer. Runs every redraw so the pills
    // track scroll/zoom/tick; getBacktestAggregate returns null (→ []) unless this
    // cell's backtest is being viewed on a coarser timeframe. Off-screen pills are
    // culled by x; y is clamped so a pill whose bar-high sits above the pane still
    // shows just inside the top.
    const agg = getBacktestAggregate(chart);
    if (agg) {
      const paneW = chart.getSize("candle_pane", DomPosition.Main)?.width ?? Infinity;
      const pills: AggPill[] = [];
      for (const cl of agg.clusters) {
        const px = first(
          chart.convertToPixel([{ timestamp: cl.barTs, value: cl.high }], {
            paneId: "candle_pane",
            absolute: true,
          }),
        );
        if (px.x == null || px.y == null || px.x < 0 || px.x > paneW) continue;
        pills.push({
          key: `agg:${cl.barTs}`,
          x: px.x,
          y: Math.max(px.y, 14),
          count: cl.trades.length,
          net: cl.net,
          trades: cl.trades.map((t) => t.trade),
          resolution: agg.result.resolution,
          fromMs: cl.fromTs,
          toMs: cl.toTs,
        });
      }
      aggMarkersRef.current?.setPills(pills);
    } else {
      aggMarkersRef.current?.setPills([]);
    }
    // Coarse-timeframe LIVE exit pills: project each per-bar cluster's bar-high
    // anchor to a pixel and feed the DOM pill layer, same as the backtest aggregate
    // above. exitClustersRef is non-empty only when this cell's journaled exits
    // collide on the current (coarser) timeframe (see drawTradeMarkers).
    const exitClusters = exitClustersRef.current;
    if (exitClusters.length > 0) {
      const paneW = chart.getSize("candle_pane", DomPosition.Main)?.width ?? Infinity;
      const exitPills: ExitPill[] = [];
      for (const cl of exitClusters) {
        const px = first(
          chart.convertToPixel([{ timestamp: cl.barTs, value: cl.high }], {
            paneId: "candle_pane",
            absolute: true,
          }),
        );
        if (px.x == null || px.y == null || px.x < 0 || px.x > paneW) continue;
        exitPills.push({
          key: `exit-agg:${cl.barTs}`,
          x: px.x,
          y: Math.max(px.y, 14),
          count: cl.exits.length,
          net: cl.net,
          exits: cl.exits,
        });
      }
      exitAggMarkersRef.current?.setPills(exitPills);
    } else {
      exitAggMarkersRef.current?.setPills([]);
    }
    // Keep the position bracket glued to its lines as geometry shifts (scroll/zoom/
    // tick/drag) — the cursor needn't move for the lines to.
    paintBracket();
    // Period-start separator follows the same geometry (via ref so it isn't a dep).
    handle.paintSeparatorRef.current();
  }, [paintBracket]);
  handle.redrawRef.current = redraw;

  return { paintBracket, paintSeparator, fmtSeparatorLabel, redraw };
}
