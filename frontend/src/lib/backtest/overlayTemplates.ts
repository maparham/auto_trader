// The klinecharts overlay templates a backtest draws with (trade markers,
// signal glyphs, trade zones, strategy zones, period bands), their colours,
// and the lazy register-once guards.
import { registerOverlay, type Chart, type OverlayTemplate, type OverlayFigure } from "klinecharts";
import { chartColors } from "../../theme";
import { MARKER_PILL_STACK_STEP } from "./markerMath";

export const BUY_COLOR = "#26a69a";
export const SELL_COLOR = "#ef5350";
// Entry-line accent — matches PositionLines' PRICE_COLOR (the role-based
// entry/price blue) so the selected-trade overlay reads consistently with the
// live trade lines, without importing that module's private const.
const ACCENT_COLOR = "#2962ff";
// Neutral grey for the trading-period shading — deliberately off the green/red
// markers and the blue trade lines so an always-on layer doesn't compete.
const PERIOD_COLOR = "#59646f";

// Backtest fill marker (arrow + label). A hand-rolled take on klinecharts'
// built-in `simpleAnnotation` (minus its long stem line, which read as visual
// noise near the wicks) with ONE other deliberate difference: the figures do
// NOT set `ignoreEvent: true`. The built-in hardcodes `ignoreEvent: true` on
// its figures, which klinecharts' _createFigureEvents reads to strip ALL mouse
// events at the dispatch layer, so an overlay-level onClick/onMouseEnter/
// onMouseLeave could never fire (that's the bug this fixes).
// Leaving ignoreEvent unset lets figure hits route to the overlay handlers
// (see drawFigures -> _createFigureEvents -> onMouseEnter/onClick).
// Per-figure styles are omitted, so arrow + text inherit `defaultStyles[type]`
// merged with any overlay-level `styles` passed at createOverlay.
// Exported so the live trade-marker drawer (tradeMarkers.ts) reuses this exact
// overlay glyph rather than defining a parallel one — same arrow/pill geometry,
// same extendData contract (label / win / placement).
export const MARKER_OVERLAY = "backtestMarker";

// extendData for a `backtestMarker`: the label text plus the trade's outcome so
// the label pill can be win/loss colored (green won, red lost). `win` is null
// for a marker not tied to a trade — that keeps klinecharts' default blue pill.
export interface MarkerExtra {
  label: string;
  win: boolean | null;
  // Which side of the candle the pill hangs from (see markerPlacement). Absent
  // in older persisted results — treated as "above" (the historical default).
  placement?: "above" | "below";
  // Rendering variant. Absent/"backtest" → the classic stem + arrow + always-on
  // label pill (backtest fills). "live" → a compact arrow glyph only, anchored a
  // gap off the candle's extreme; its label is a DOM pill revealed on hover
  // (tradeMarkerHoverSignal), so the always-on furniture never covers candles.
  style?: "backtest" | "live";
  // Collision rank on this bar+placement (see nextMarkerStack): each level
  // pushes the pill one MARKER_PILL_STACK_STEP further from the candle. Absent
  // (older persisted overlays, live style) → 0.
  stack?: number;
}
function asMarkerExtra(v: unknown): MarkerExtra {
  return (typeof v === "object" && v !== null ? v : { label: "", win: null }) as MarkerExtra;
}

/** Gap between the candle's extreme and the glyph's apex, so it reads off the wick. */
export const LIVE_GLYPH_GAP = 6;
/** Apex-to-base height of the arrow. */
export const LIVE_GLYPH_H = 11;
/** Half the arrow's base width. */
export const LIVE_GLYPH_HALF_W = 6;
/** Outline weight — the glyph sits ON a candle, and a same-hued body against a
 *  same-hued candle disappears; the border is what keeps its silhouette. */
const LIVE_GLYPH_BORDER = 1.5;

/** The chart's backdrop, which is what the glyph's outline cuts it out of. Reads the
 *  custom `--chart-bg` wash when one is set (applyThemeToDocument writes it INLINE, so
 *  this stays a property read — no getComputedStyle on a per-frame path) and falls back
 *  to the theme's own background. A fixed colour would separate the glyph in one theme
 *  and do nothing in the other. */
function chartBackdrop(): string {
  const root = document.documentElement;
  const custom = root.style.getPropertyValue("--chart-bg").trim();
  if (custom) return custom;
  return chartColors[root.dataset.theme === "light" ? "light" : "dark"].bg;
}

/** The always-on live trade glyph: an arrow whose APEX points at its candle, plus a
 *  transparent finger-sized hit target over it (klinecharts' hit test on a small
 *  polygon is unreliable — same trick as the signal glyph).
 *
 *  Since trade lines are drawn only while a trade is engaged, this arrow is the sole
 *  standing mark of where a position opened, so it is sized and outlined to be read
 *  at a glance rather than to stay discreet. `dir` is +1 below the candle, -1 above.
 */
export function liveMarkerGlyph(o: {
  x: number;
  y: number;
  dir: 1 | -1;
  color: string;
}): OverlayFigure[] {
  const { x, y, dir, color } = o;
  const tip = y + dir * LIVE_GLYPH_GAP;
  const base = tip + dir * LIVE_GLYPH_H;
  return [
    {
      type: "circle",
      attrs: { x, y: tip + dir * (LIVE_GLYPH_H / 2), r: LIVE_GLYPH_H },
      styles: { style: 'fill', color: "rgba(0,0,0,0)" },
    },
    {
      type: "polygon",
      attrs: {
        coordinates: [
          { x, y: tip },
          { x: x - LIVE_GLYPH_HALF_W, y: base },
          { x: x + LIVE_GLYPH_HALF_W, y: base },
        ],
      },
      styles: {
        style: 'stroke_fill',
        color,
        borderColor: chartBackdrop(),
        borderSize: LIVE_GLYPH_BORDER,
      },
    },
  ];
}

const markerOverlay: OverlayTemplate = {
  name: MARKER_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 1) return [];
    const { label, win, placement, style, stack } = asMarkerExtra(overlay.extendData);
    const startX = coordinates[0].x;
    // "below" mirrors the historical "above" geometry through the anchor: the
    // arrow/pill grow downward and the pill's baseline flips so it hangs under
    // the fill instead of over it. `dir` is +1 downward, -1 upward.
    const dir = placement === "below" ? 1 : -1;

    if (style === "live") {
      // Compact glyph: just an arrow, sitting a fixed GAP off the candle's
      // extreme (the caller anchors this overlay at the bar low/high, so the gap
      // reads off the wick). The full label is a DOM pill shown on hover, so the
      // always-on marker never covers neighbouring candles. Arrow APEX points at
      // the candle; a transparent finger-sized hit target sits over it because
      // klinecharts' hit test on a tiny polygon is unreliable (same trick as the
      // signal glyph). Colour: entry = neutral blue, exit = win/loss.
      const glyphColor = win == null ? ACCENT_COLOR : win ? BUY_COLOR : SELL_COLOR;
      return liveMarkerGlyph({ x: startX, y: coordinates[0].y, dir, color: glyphColor });
    }

    // Backtest fills: a compact arrow + always-on label pill hugging the fill.
    // (Historically these hung off a 50px stem, which read as a stray vertical
    // line near the candle wicks — the arrow alone points at the fill price.)
    const arrowTipY = coordinates[0].y + dir * 6;
    const arrowEndY = arrowTipY + dir * 6;
    // The label renders as a filled pill via klinecharts' default overlay text
    // style (white text on a blue background). Override just the fill/border to
    // the win/loss color so a losing trade's marker reads red, a winner green.
    const pillColor = win == null ? undefined : win ? BUY_COLOR : SELL_COLOR;
    // The long/short direction rides INSIDE the label pill (markerPillLabel
    // prefixes an entry with ▲/▼), so it reads on every timeframe — the coarser
    // aggregate view has only the DOM pill, no arrowhead.
    return [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: startX, y: arrowTipY },
            { x: startX - 4, y: arrowEndY },
            { x: startX + 4, y: arrowEndY },
          ],
        },
      },
      {
        type: "text",
        attrs: {
          x: startX,
          // A colliding pill (same bar, same side — see nextMarkerStack) steps
          // one pill-height further from the candle per stack level, so both
          // labels stay readable instead of overprinting.
          y: arrowEndY + dir * (stack ?? 0) * MARKER_PILL_STACK_STEP,
          text: label,
          align: "center",
          baseline: placement === "below" ? "top" : "bottom",
        },
        ...(pillColor ? { styles: { backgroundColor: pillColor, borderColor: pillColor } } : {}),
      },
    ];
  },
};

let markerOverlayRegistered = false;
export function ensureMarkerOverlayRegistered(): void {
  if (markerOverlayRegistered) return;
  markerOverlayRegistered = true;
  registerOverlay(markerOverlay);
}

// The signal-candle glyph: a small subtle caret on the bar BEFORE a rule-based
// fill, pointing at the candle (long ⇒ below, short ⇒ above). Deliberately
// lighter/plainer than the B+/SL fill markers — it's a "why did this fire" hint,
// not a fill. Hovering opens the terms popover (see drawMarkers). A separate
// overlay from MARKER_OVERLAY because it anchors on a different bar (signal_time)
// with caret-only geometry and no win/loss pill.
export const SIGNAL_OVERLAY = "backtestSignal";
// Muted slate, distinct from the green/red fills and the blue trade lines.
const SIGNAL_COLOR = "#8a97a5";

export interface SignalMarkerExtra {
  placement: "above" | "below";
}
function asSignalMarkerExtra(v: unknown): SignalMarkerExtra {
  return (typeof v === "object" && v !== null ? v : { placement: "below" }) as SignalMarkerExtra;
}

const signalGlyphOverlay: OverlayTemplate = {
  name: SIGNAL_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 1) return [];
    const { placement } = asSignalMarkerExtra(overlay.extendData);
    const x = coordinates[0].x;
    // `dir` is +1 hanging below the candle (long) / -1 above it (short). The
    // caret's apex sits nearer the candle (`tip`), base further away, so it
    // reads as an arrow pointing at the signal bar.
    const dir = placement === "below" ? 1 : -1;
    const anchorY = coordinates[0].y;
    const tip = anchorY + dir * 4;
    const base = anchorY + dir * 11;
    return [
      // Transparent finger-sized hit target FIRST: the visible caret is a tiny
      // locked polygon, and klinecharts' hit test on such a small figure is
      // unreliable (the same reason aggregate pills went DOM). A ~9px transparent
      // circle over the caret gives the hover a dependable target at zero visual
      // cost; ignoreEvent stays unset so it routes to onMouseEnter/onMouseLeave.
      {
        type: "circle",
        attrs: { x, y: anchorY + dir * 7, r: 9 },
        styles: { style: 'fill', color: "rgba(0,0,0,0)" },
      },
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x, y: tip },
            { x: x - 5, y: base },
            { x: x + 5, y: base },
          ],
        },
        styles: { style: 'fill', color: SIGNAL_COLOR },
      },
    ];
  },
};

let signalGlyphOverlayRegistered = false;
export function ensureSignalGlyphOverlayRegistered(): void {
  if (signalGlyphOverlayRegistered) return;
  signalGlyphOverlayRegistered = true;
  registerOverlay(signalGlyphOverlay);
}

// klinecharts hard-sets the candle pane's cursor to 'crosshair' in its
// IndicatorWidget ctor, so a hovered clickable marker would otherwise give no
// affordance. Flip the pane cursor to 'pointer' while a trade-mapped marker is
// hovered (onMouseEnter) and restore 'crosshair' on leave — the pane's DOM is
// the element carrying the cursor style (setting the root container wouldn't
// override the child pane's own cursor).
export function setMarkerHoverCursor(chart: Chart, hovering: boolean): void {
  const dom = chart.getDom("candle_pane", 'main');
  if (dom) dom.style.cursor = hovering ? "pointer" : "crosshair";
}

// ---------------------------------------------------------------------------
// Aggregate markers (higher-timeframe view).
//
// On a timeframe COARSER than the backtest's own, an individual fill can't be
// anchored cleanly — many fills fall inside one bar and would collapse onto the
// same x. Instead we bucket each trade into the bar that contains its ENTRY and
// show ONE pill per bar with the trade count + net P&L. The pills are DOM, not
// klinecharts overlays (native hover/click events are reliable, whereas the
// overlay-event hit test on a tiny locked figure is flaky — the same reason the
// legend/curve labels are DOM). `renderArtifacts` just stashes the clusters on
// the chart's artifacts; ChartCore's redraw loop projects them to pixels each
// frame and feeds the <BacktestAggMarkers> layer, which owns the hover popover
// (backtestClusterHoverSignal) and the click→drill-in.

export const ZONE_OVERLAY = "tradeZone";

// extendData for a `tradeZone` overlay instance: everything createPointFigures
// needs BESIDES the pixel-projected points (below) — which fields to draw and
// the precomputed labels (tradeZones() output), plus win/loss for the
// entry→exit segment + exit dot color.
export interface ZoneExtra {
  hasReward: boolean;
  hasRisk: boolean;
  // A band drawn from the trade's realized excursion (MAE/MFE) rather than a
  // stop/target the strategy set — see tradeZones.ts. Rendered with a dashed
  // edge so it cannot be read as a level the strategy planned.
  rewardRealized: boolean;
  riskRealized: boolean;
  stopMoved: boolean;
  rewardPct: number | null;
  riskPct: number | null;
  // Pill texts, precomputed by zoneLabels so the realized tagging lives in one
  // pure, tested place instead of being re-derived inside createPointFigures.
  labels: { risk: string | null; reward: string | null; rr: string | null };
  rr: number | null;
  win: boolean;
}
function asZoneExtra(v: unknown): ZoneExtra {
  return v as ZoneExtra;
}

// Small filled pill (white text on a solid tag), matching the label style
// PositionLines' tradeLine/bracket pills use elsewhere on the chart.
function pillFigure(
  x: number,
  y: number,
  text: string,
  bg: string,
  align: "left" | "center" | "right" = "left",
): OverlayFigure {
  return {
    type: "text",
    attrs: { x, y, text, align, baseline: "middle" },
    styles: {
      color: "#ffffff",
      backgroundColor: bg,
      size: 11,
      family: "-apple-system, system-ui, sans-serif",
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 2,
      paddingBottom: 2,
      borderRadius: 3,
    },
    ignoreEvent: true,
  };
}

// The windowed risk/reward zone for the STICKILY selected trade (Phase 2 Task
// 2). A single custom overlay (registered once, like PositionLines'
// `tradeLine`) rather than several linked ones: klinecharts only hands
// createPointFigures the pixel coordinates for the overlay's OWN `points`, so
// every price level the drawing needs (entry, target, stop_initial,
// stop_final, exit) rides its own point — even ones that don't have a
// meaningful x (target/stop_initial/stop_final share the entry timestamp;
// only their y-pixel is read):
//   0 entry(entryTs, entry_price)      3 stopInitial(entryTs, stop_initial)
//   1 windowEnd(exitTs+pad, entry_price) 4 stopFinal(entryTs, stop_final)
//   2 target(entryTs, target)          5 exit(exitTs, exit_price)
// (points 2-4 fall back to entry_price when the level is absent — harmless
// since the figures that would read them are gated on hasReward/hasRisk/
// stopMoved instead.)
// Read-only backtest artifact: `lock: true` on creation AND every figure
// `ignoreEvent: true`, so it never intercepts clicks/crosshair — same
// discipline as the marker/highlight overlays above.
const tradeZoneOverlay: OverlayTemplate = {
  name: ZONE_OVERLAY,
  totalStep: 6,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    if (coordinates.length < 6) return [];
    const z = asZoneExtra(overlay.extendData);
    const [c0, c1, c2, c3, c4, c5] = coordinates;
    const figures: OverlayFigure[] = [];
    // The TP/SL edge pills sit just right of the window's right edge — flip to
    // the LEFT (mirrors PositionLines' bracket-pill flip) when that would spill
    // past the pane, so a trade near the right edge doesn't clip its labels.
    const flip = c1.x > bounding.width - 70;
    const edgeX = flip ? c1.x - 4 : c1.x + 4;
    const edgeAlign: "left" | "right" = flip ? "right" : "left";
    // Clamp the R:R pill so it can't clip above the pane top for an entry
    // near the very top of the visible price range.
    const rrY = Math.max(c0.y - 14, 10);
    if (z.hasReward) {
      figures.push({
        type: "rect",
        attrs: { x: c0.x, y: Math.min(c0.y, c2.y), width: c1.x - c0.x, height: Math.abs(c0.y - c2.y) },
        styles: { style: 'fill', color: `${BUY_COLOR}26` },
        ignoreEvent: true,
      });
    }
    if (z.hasRisk) {
      figures.push({
        type: "rect",
        attrs: { x: c0.x, y: Math.min(c0.y, c3.y), width: c1.x - c0.x, height: Math.abs(c0.y - c3.y) },
        styles: { style: 'fill', color: `${SELL_COLOR}26` },
        ignoreEvent: true,
      });
    }
    // A realized band gets a dashed edge at its level; a planned bracket's
    // edge stays implied by the fill, exactly as before. Together with the
    // MAE/MFE pill tag this is what keeps "what the trade did" visually
    // distinct from "what the strategy set".
    if (z.hasReward && z.rewardRealized) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: c0.x, y: c2.y }, { x: c1.x, y: c2.y }] },
        styles: { style: 'dashed', dashedValue: [4, 4], color: `${BUY_COLOR}80`, size: 1 },
        ignoreEvent: true,
      });
    }
    if (z.hasRisk && z.riskRealized) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: c0.x, y: c3.y }, { x: c1.x, y: c3.y }] },
        styles: { style: 'dashed', dashedValue: [4, 4], color: `${SELL_COLOR}80`, size: 1 },
        ignoreEvent: true,
      });
    }
    if (z.stopMoved) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: c0.x, y: c4.y }, { x: c1.x, y: c4.y }] },
        styles: { style: 'dashed', dashedValue: [4, 4], color: `${SELL_COLOR}80`, size: 1 },
        ignoreEvent: true,
      });
    }
    // entry -> exit (win/loss colored, like the transient highlight line).
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c5.x, y: c5.y }] },
      styles: { style: 'solid', color: z.win ? BUY_COLOR : SELL_COLOR, size: 1 },
      ignoreEvent: true,
    });
    // entry line (accent), spanning the window.
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c1.x, y: c0.y }] },
      styles: { style: 'solid', color: ACCENT_COLOR, size: 1.5 },
      ignoreEvent: true,
    });
    // entry / exit dots.
    figures.push({ type: "circle", attrs: { x: c0.x, y: c0.y, r: 3 }, styles: { style: 'fill', color: ACCENT_COLOR }, ignoreEvent: true });
    figures.push({ type: "circle", attrs: { x: c5.x, y: c5.y, r: 3 }, styles: { style: 'fill', color: z.win ? BUY_COLOR : SELL_COLOR }, ignoreEvent: true });
    // Labels: R:R centered above the entry line; +reward%/-risk% at the TP/SL edges.
    // zoneExtra always fills `labels` (it is recomputed from the trade on every
    // draw), so this fallback only covers an overlay whose extendData somehow
    // arrived without them — cheaper than dropping the pills entirely.
    const labels = z.labels ?? {
      risk: z.riskPct == null ? null : `-${z.riskPct.toFixed(1)}%`,
      reward: z.rewardPct == null ? null : `+${z.rewardPct.toFixed(1)}%`,
      rr: z.rr == null ? null : `R:R 1:${z.rr.toFixed(2)}`,
    };
    if (labels.rr != null) {
      figures.push(pillFigure((c0.x + c1.x) / 2, rrY, labels.rr, ACCENT_COLOR, "center"));
    }
    if (z.hasReward && labels.reward != null) {
      figures.push(pillFigure(edgeX, c2.y, labels.reward, BUY_COLOR, edgeAlign));
    }
    if (z.hasRisk && labels.risk != null) {
      figures.push(pillFigure(edgeX, c3.y, labels.risk, SELL_COLOR, edgeAlign));
    }
    return figures;
  },
};

let zoneOverlayRegistered = false;
export function ensureZoneOverlayRegistered(): void {
  if (zoneOverlayRegistered) return;
  zoneOverlayRegistered = true;
  registerOverlay(tradeZoneOverlay);
}

export const STRATEGY_ZONE_OVERLAY = "strategyZone";

// A strategy-attached trade zone (api.ts TradeZone — e.g. BB Regime's broken
// consolidation range): a shaded time×price rect with a small label pill, drawn
// only while its trade is stickily selected. Two points carry the geometry:
// 0 (from_time, top), 1 (to_time, bottom). Same read-only discipline as the
// risk/reward zone above (lock on create, every figure ignoreEvent).
const strategyZoneOverlay: OverlayTemplate = {
  name: STRATEGY_ZONE_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 2) return [];
    const [c0, c1] = coordinates;
    const x = Math.min(c0.x, c1.x);
    const y = Math.min(c0.y, c1.y);
    const label = typeof (overlay.extendData as { label?: unknown })?.label === "string"
      ? (overlay.extendData as { label: string }).label
      : "";
    const figures: OverlayFigure[] = [
      {
        type: "rect",
        attrs: { x, y, width: Math.abs(c1.x - c0.x), height: Math.abs(c1.y - c0.y) },
        styles: {
          style: 'stroke_fill',
          color: `${PERIOD_COLOR}1f`,
          borderColor: `${PERIOD_COLOR}66`,
          borderSize: 1,
        },
        ignoreEvent: true,
      },
    ];
    // Label only when the rect is wide enough to carry it — on a zoomed-out
    // view a run's many squeeze windows would otherwise stack dozens of
    // clipped pills; the shading alone marks the narrow ones.
    if (label && Math.abs(c1.x - c0.x) >= 48) {
      figures.push(pillFigure(x + 4, y - 10, label, PERIOD_COLOR, "left"));
    }
    return figures;
  },
};

let strategyZoneOverlayRegistered = false;
export function ensureStrategyZoneOverlayRegistered(): void {
  if (strategyZoneOverlayRegistered) return;
  strategyZoneOverlayRegistered = true;
  registerOverlay(strategyZoneOverlay);
}

export const PERIOD_OVERLAY = "backtestPeriod";

// The trading-period band: a faint full-pane-height rect in the price pane, and
// a matching faint rect in the X-axis pane (createXAxisFigures — the native way to
// draw on the time axis, so it pans/zooms with the axis). No text label — the
// shading alone marks the traded span, and a per-band label collided with the
// axis time ticks. Read-only: lock on create AND every figure ignoreEvent, so it
// never intercepts clicks or the crosshair — the cursor's time pill (klinecharts'
// crosshair label, drawn above the overlay layer) stays fully legible.
const periodOverlay: OverlayTemplate = {
  name: PERIOD_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const x0 = Math.min(coordinates[0].x, coordinates[1].x);
    const w = Math.abs(coordinates[1].x - coordinates[0].x);
    return [
      {
        type: "rect",
        attrs: { x: x0, y: 0, width: w, height: bounding.height },
        styles: { style: 'fill', color: `${PERIOD_COLOR}0f` }, // ~6%
        ignoreEvent: true,
      },
    ];
  },
  createXAxisFigures: ({ coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const x0 = Math.min(coordinates[0].x, coordinates[1].x);
    const x1 = Math.max(coordinates[0].x, coordinates[1].x);
    return [
      {
        type: "rect",
        attrs: { x: x0, y: 0, width: x1 - x0, height: bounding.height },
        styles: { style: 'fill', color: `${PERIOD_COLOR}33` }, // ~20%
        ignoreEvent: true,
      },
    ];
  },
};

let periodOverlayRegistered = false;
export function ensurePeriodOverlayRegistered(): void {
  if (periodOverlayRegistered) return;
  periodOverlayRegistered = true;
  registerOverlay(periodOverlay);
}
