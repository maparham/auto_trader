// Pure candlestick-pattern detector shared by the chart template (Task 2) and
// the backtest rule-operand builder. NO klinecharts runtime import lives here:
// backtestConfig.ts pulls these exports and must not drag klinecharts into that
// import cycle. Task 2 adds the chart template to this same file.

export type PatternPolarity = "bull" | "bear" | "neutral";

export interface CandlePatternDef {
  id: string;
  label: string;
  short: string;
  fn: string; // camelCase predicate name used in rule expressions
  polarity: PatternPolarity;
  toggle: string;
}

// Structural bar shape (avoids importing a klinecharts KLineData type).
export interface PatternBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

// Canonical registry. Array index === operand `line` index and is immutable:
// it must NEVER depend on which patterns are enabled.
export const CANDLE_PATTERN_DEFS: readonly CandlePatternDef[] = [
  { id: "bull_engulfing", label: "Bullish Engulfing", short: "Engulf", fn: "bullEngulfing", polarity: "bull", toggle: "engulfing" },
  { id: "bear_engulfing", label: "Bearish Engulfing", short: "Engulf", fn: "bearEngulfing", polarity: "bear", toggle: "engulfing" },
  { id: "pin_top", label: "Pin Top", short: "Pin", fn: "pinTop", polarity: "bear", toggle: "pin_top" },
  { id: "pin_bottom", label: "Pin Bottom", short: "Pin", fn: "pinBottom", polarity: "bull", toggle: "pin_bottom" },
  { id: "doji", label: "Doji", short: "Doji", fn: "doji", polarity: "neutral", toggle: "doji" },
  { id: "inside", label: "Inside Bar", short: "Inside", fn: "insideBar", polarity: "neutral", toggle: "inside" },
  { id: "outside", label: "Outside Bar", short: "Outside", fn: "outsideBar", polarity: "neutral", toggle: "outside" },
  { id: "bull_harami", label: "Bullish Harami", short: "Harami", fn: "bullHarami", polarity: "bull", toggle: "harami" },
  { id: "bear_harami", label: "Bearish Harami", short: "Harami", fn: "bearHarami", polarity: "bear", toggle: "harami" },
  { id: "piercing_line", label: "Piercing Line", short: "Pierce", fn: "piercingLine", polarity: "bull", toggle: "piercing" },
  { id: "dark_cloud_cover", label: "Dark Cloud Cover", short: "Dark Cloud", fn: "darkCloudCover", polarity: "bear", toggle: "piercing" },
  { id: "morning_star", label: "Morning Star", short: "M Star", fn: "morningStar", polarity: "bull", toggle: "star" },
  { id: "evening_star", label: "Evening Star", short: "E Star", fn: "eveningStar", polarity: "bear", toggle: "star" },
  { id: "bull_belt_hold", label: "Bullish Belt Hold", short: "Belt", fn: "bullBeltHold", polarity: "bull", toggle: "belt_hold" },
  { id: "bear_belt_hold", label: "Bearish Belt Hold", short: "Belt", fn: "bearBeltHold", polarity: "bear", toggle: "belt_hold" },
  { id: "three_white_soldiers", label: "Three White Soldiers", short: "3 Soldiers", fn: "threeWhiteSoldiers", polarity: "bull", toggle: "soldiers" },
  { id: "three_black_crows", label: "Three Black Crows", short: "3 Crows", fn: "threeBlackCrows", polarity: "bear", toggle: "soldiers" },
  { id: "three_stars_south", label: "Three Stars in the South", short: "3 Stars S", fn: "threeStarsSouth", polarity: "bull", toggle: "stars_south" },
  { id: "stick_sandwich", label: "Stick Sandwich", short: "Sandwich", fn: "stickSandwich", polarity: "bull", toggle: "sandwich" },
  { id: "bull_meeting_line", label: "Bullish Meeting Line", short: "Meet", fn: "bullMeetingLine", polarity: "bull", toggle: "meeting_line" },
  { id: "bear_meeting_line", label: "Bearish Meeting Line", short: "Meet", fn: "bearMeetingLine", polarity: "bear", toggle: "meeting_line" },
  { id: "bull_kicking", label: "Bullish Kicking", short: "Kick", fn: "bullKicking", polarity: "bull", toggle: "kicking" },
  { id: "bear_kicking", label: "Bearish Kicking", short: "Kick", fn: "bearKicking", polarity: "bear", toggle: "kicking" },
  { id: "ladder_bottom", label: "Ladder Bottom", short: "Ladder", fn: "ladderBottom", polarity: "bull", toggle: "ladder" },
];

export const ANY_BULL_LINE = 24;
export const ANY_BEAR_LINE = 25;

// Human labels for the 16 settings toggle groups. Ids/order are derived from
// CANDLE_PATTERN_DEFS (below) so they can never drift out of canonical order.
const TOGGLE_LABELS: Readonly<Record<string, string>> = {
  engulfing: "Engulfing",
  pin_top: "Pin Top",
  pin_bottom: "Pin Bottom",
  doji: "Doji",
  inside: "Inside Bar",
  outside: "Outside Bar",
  harami: "Harami",
  piercing: "Piercing / Dark Cloud",
  star: "Morning / Evening Star",
  belt_hold: "Belt Hold",
  soldiers: "Soldiers / Crows",
  stars_south: "Three Stars in the South",
  sandwich: "Stick Sandwich",
  meeting_line: "Meeting Line",
  kicking: "Kicking",
  ladder: "Ladder Bottom",
};

// 16 unique toggle groups, in first-appearance (canonical) order.
export const CANDLE_PATTERN_TOGGLES: ReadonlyArray<{ id: string; label: string }> = (() => {
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string }> = [];
  for (const def of CANDLE_PATTERN_DEFS) {
    if (seen.has(def.toggle)) continue;
    seen.add(def.toggle);
    out.push({ id: def.toggle, label: TOGGLE_LABELS[def.toggle] ?? def.toggle });
  }
  return out;
})();

// --- Rule-operand interface -------------------------------------------------
// The expression catalog builds its predicate entries from this map, so the
// names it offers can never drift from the detector. NAMES are all lib/expr/
// needs: rules are evaluated on the BACKEND (strategy/expr/evaluate.py calling
// indicators/candle_patterns.py), so there is deliberately no TS function here
// that computes a pattern's series for a rule — the frontend would have no
// caller for one.

export const PATTERN_PREDICATE_FNS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  CANDLE_PATTERN_DEFS.forEach((def, i) => {
    out[def.fn] = i;
  });
  out.bullPattern = ANY_BULL_LINE;
  out.bearPattern = ANY_BEAR_LINE;
  return out;
})();

// eps[i] = 0.05 * SMA14 of true range up to and including bar i; while fewer
// than 14 TRs exist, fall back to 1e-4 * close (index data has no fixed tick).
// Exported for the test suite's independent oracle assertions only.
export function epsSeries(bars: readonly PatternBar[]): number[] {
  const eps: number[] = new Array(bars.length);
  let sum = 0;
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const pc = i > 0 ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    trs.push(tr);
    sum += tr;
    if (trs.length > 14) sum -= trs[trs.length - 15];
    eps[i] = trs.length >= 14 ? 0.05 * (sum / 14) : 1e-4 * b.close;
  }
  return eps;
}

const eq = (a: number, b: number, e: number) => Math.abs(a - b) <= e;

// Memo of the last detection per bars-array reference. One backtest build calls
// detectAllPatterns once per pattern operand over the SAME candles array, and the
// chart calc re-runs on every klinecharts tick — both hit this cache. klinecharts
// mutates its dataList in place (forming-bar updates, appends), so a hit is only
// valid when the length AND the last bar's OHLC are unchanged; interior mutation
// with an identical last bar is not a case any caller produces.
interface DetectCacheEntry {
  n: number;
  lastOpen: number;
  lastHigh: number;
  lastLow: number;
  lastClose: number;
  hits: Array<Set<string>>;
}
const detectCache = new WeakMap<object, DetectCacheEntry>();

/**
 * hits[i] = Set of matched pattern ids at bar i, across ALL patterns with no
 * enable filtering. Unlike the backend `classify_candle` (first-match, single
 * label), every matching pattern is reported because operands are independent.
 * Memoized per bars reference (see DetectCacheEntry); treat the result as
 * read-only.
 */
export function detectAllPatterns(bars: readonly PatternBar[]): Array<Set<string>> {
  const n = bars.length;
  const last = n > 0 ? bars[n - 1] : null;
  const cached = detectCache.get(bars as object);
  if (
    cached &&
    cached.n === n &&
    (last === null ||
      (cached.lastOpen === last.open &&
        cached.lastHigh === last.high &&
        cached.lastLow === last.low &&
        cached.lastClose === last.close))
  ) {
    return cached.hits;
  }
  const eps = epsSeries(bars);
  const hits: Array<Set<string>> = new Array(n);

  for (let i = 0; i < n; i++) {
    const set = new Set<string>();
    hits[i] = set;
    const e = eps[i];

    // Pine-style back-indexers: [0]=current bar i, [1]=i-1, ...; only valid
    // for offsets <= i (each pattern below gates on the offsets it uses).
    const o = (k: number) => bars[i - k].open;
    const h = (k: number) => bars[i - k].high;
    const l = (k: number) => bars[i - k].low;
    const c = (k: number) => bars[i - k].close;

    // --- Analysis-7 (ported verbatim from classify_candle; first-match dropped) ---
    const bar = bars[i];
    const body = Math.abs(bar.close - bar.open);
    const rng = bar.high - bar.low;

    if (i >= 1) {
      const prev = bars[i - 1];
      const pBodyHi = Math.max(prev.open, prev.close);
      const pBodyLo = Math.min(prev.open, prev.close);
      const bBodyHi = Math.max(bar.open, bar.close);
      const bBodyLo = Math.min(bar.open, bar.close);
      const prevDown = prev.close < prev.open;
      const prevUp = prev.close > prev.open;

      if (bar.close > bar.open && prevDown && bBodyLo <= pBodyLo && bBodyHi >= pBodyHi) set.add("bull_engulfing");
      if (bar.close < bar.open && prevUp && bBodyLo <= pBodyLo && bBodyHi >= pBodyHi) set.add("bear_engulfing");

      // pin_top / pin_bottom keep the backend's prev-and-rng>0 guard nesting.
      if (rng > 0) {
        const upperWick = bar.high - Math.max(bar.open, bar.close);
        const lowerWick = Math.min(bar.open, bar.close) - bar.low;
        if (upperWick >= 2 * body && Math.min(bar.open, bar.close) <= bar.low + rng / 3) set.add("pin_top");
        if (lowerWick >= 2 * body && Math.max(bar.open, bar.close) >= bar.high - rng / 3) set.add("pin_bottom");
      }

      if (bar.high < prev.high && bar.low > prev.low) set.add("inside");
      if (bar.high > prev.high && bar.low < prev.low) set.add("outside");
    }

    // doji sits outside the prev block in classify_candle.
    if (rng > 0 && body <= 0.1 * rng) set.add("doji");

    // --- TV ports (e = eps[i]); each guarded by its own lookback ---
    if (i >= 2) {
      // Harami
      if (o(1) > c(1) && c(1) < c(2) && o(0) > c(1) && o(0) < o(1) && c(0) > c(1) && c(0) < o(1) && h(0) < h(1) && l(0) > l(1) && c(0) >= o(0)) set.add("bull_harami");
      if (o(1) < c(1) && c(1) > c(2) && o(0) < c(1) && o(0) > o(1) && c(0) < c(1) && c(0) > o(1) && h(0) < h(1) && l(0) > l(1) && c(0) <= o(0)) set.add("bear_harami");
      // Piercing / Dark Cloud
      if (c(2) > c(1) && o(0) < l(1) && c(0) > (o(1) + c(1)) / 2 && c(0) < o(1)) set.add("piercing_line");
      if (c(2) < c(1) && o(0) > h(1) && c(0) < (o(1) + c(1)) / 2 && c(0) > o(1)) set.add("dark_cloud_cover");
      // Stick Sandwich
      if (o(2) > c(2) && o(1) > c(2) && o(1) < c(1) && o(0) > c(1) && o(0) > c(0) && eq(c(0), c(2), e)) set.add("stick_sandwich");
      // Meeting Line
      if (o(2) > c(2) && o(1) > c(1) && eq(c(1), c(0), e) && o(0) < c(0) && o(1) >= h(0)) set.add("bull_meeting_line");
      if (o(2) < c(2) && o(1) < c(1) && eq(c(1), c(0), e) && o(0) > c(0) && o(1) <= l(0)) set.add("bear_meeting_line");
    }

    // Belt Hold (avg(close,open) comparison reduces to close vs open); needs [1]
    if (i >= 1) {
      if (c(1) < o(1) && l(1) > o(0) && c(1) > o(0) && eq(o(0), l(0), e) && c(0) > o(0)) set.add("bull_belt_hold");
      if (c(1) > o(1) && h(1) < o(0) && c(1) < o(0) && eq(o(0), h(0), e) && c(0) < o(0)) set.add("bear_belt_hold");
      // Kicking
      if (o(1) > c(1) && eq(o(1), h(1), e) && eq(c(1), l(1), e) && o(0) > o(1) && eq(o(0), l(0), e) && eq(c(0), h(0), e) && c(0) - o(0) > o(1) - c(1)) set.add("bull_kicking");
      if (o(1) < c(1) && eq(o(1), l(1), e) && eq(c(1), h(1), e) && o(0) < o(1) && eq(o(0), h(0), e) && eq(c(0), l(0), e) && o(0) - c(0) > c(1) - o(1)) set.add("bear_kicking");
    }

    if (i >= 3) {
      // Morning / Evening Star
      if (c(3) > c(2) && c(2) < o(2) && o(1) < c(2) && c(1) < c(2) && o(0) > o(1) && o(0) > c(1) && c(0) > c(2) && o(2) - c(2) > c(0) - o(0)) set.add("morning_star");
      if (c(3) < c(2) && c(2) > o(2) && o(1) > c(2) && c(1) > c(2) && o(0) < o(1) && o(0) < c(1) && c(0) < c(2) && c(2) - o(2) > o(0) - c(0)) set.add("evening_star");
      // Soldiers / Crows (avg comparisons reduce to close vs open)
      if (c(3) < o(3) && o(2) < c(3) && c(2) > o(2) && o(1) > o(2) && o(1) < c(2) && c(1) > o(1) && o(0) > o(1) && o(0) < c(1) && c(0) > o(0) && h(1) > h(2) && h(0) > h(1)) set.add("three_white_soldiers");
      if (c(3) > o(3) && o(2) > c(3) && c(2) < o(2) && o(1) < o(2) && o(1) > c(2) && c(1) < o(1) && o(0) < o(1) && o(0) > c(1) && c(0) < o(0) && l(1) < l(2) && l(0) < l(1)) set.add("three_black_crows");
      // Three Stars in the South
      if (o(3) > c(3) && o(2) > c(2) && eq(o(2), h(2), e) && o(1) > c(1) && o(1) < o(2) && o(1) > c(2) && l(1) > l(2) && eq(o(1), h(1), e) && o(0) > c(0) && o(0) < o(1) && o(0) > c(1) && eq(o(0), h(0), e) && eq(c(0), l(0), e) && c(0) >= l(1)) set.add("three_stars_south");
    }

    if (i >= 4) {
      // Ladder Bottom
      if (o(4) > c(4) && o(3) > c(3) && o(3) < o(4) && o(2) > c(2) && o(2) < o(3) && o(1) > c(1) && o(1) < o(2) && o(0) < c(0) && o(0) > o(1) && l(4) > l(3) && l(3) > l(2) && l(2) > l(1)) set.add("ladder_bottom");
    }
  }

  if (last !== null) {
    detectCache.set(bars as object, {
      n,
      lastOpen: last.open,
      lastHigh: last.high,
      lastLow: last.low,
      lastClose: last.close,
      hits,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Chart template (Task 2). Figure-less MAIN-pane overlay, modelled on
// timeHighlight.ts: `series: 'price'`, `figures: []`, `calc` stores per-bar
// state on indicator.result and `draw` paints pure pixels (returning true so
// klinecharts skips its default figure loop). All klinecharts imports are
// TYPE-ONLY so this file still pulls no klinecharts runtime — preserving the
// backtestConfig.ts import-cycle invariant noted at the top of the file.
// ---------------------------------------------------------------------------
import type {
  Indicator,
  IndicatorTemplate,
  IndicatorDrawParams,
  KLineData,
} from "klinecharts";

export interface CandlePatternsExtend {
  disabled?: Record<string, boolean>; // by TOGGLE id; absent/false = enabled
  showLabels?: boolean; // default true
  bullColor?: string; // default "#1FADA2"
  bearColor?: string; // default "#F35A54"
  neutralColor?: string; // default "#787B86"
  hideLegendValue?: boolean;
}

// Canonical line INDICES (into CANDLE_PATTERN_DEFS) of the ENABLED matches at
// this bar. Empty/absent when no enabled pattern hit.
export interface CandlePatternsPoint {
  hits?: number[];
}

// Single source of truth for the marker colors — the draw falls back to these
// and the settings panel shows them as the current value when extendData is empty.
export const DEFAULT_BULL_COLOR = "#1FADA2";
export const DEFAULT_BEAR_COLOR = "#F35A54";
export const DEFAULT_NEUTRAL_COLOR = "#787B86";

// Marker geometry (pixels).
const TRI_HALF_WIDTH = 6; // half base width of the polarity triangle
const TRI_HEIGHT = 8; // triangle height
const TRI_GAP = 4; // gap between the bar wick and the triangle
const LABEL_FONT = "10px sans-serif";
const LABEL_LINE_HEIGHT = 11;
// Horizontal breathing room between two neighbouring labels, in pixels.
const LABEL_PAD = 2;

// Text width per label string, memoized. The draw runs on every repaint and
// scans the WHOLE data list (not just the visible window), so on a few thousand
// bars this would otherwise be thousands of measureText calls per frame. LABEL_FONT
// is constant and `short` comes from a fixed set of 24, so one measurement each
// is enough — the cache is keyed by the string alone.
const labelWidths = new Map<string, number>();

// Widest line of a stack, halved — its span is [x - halfWidth, x + halfWidth].
// ctx.font is set before any call, so measureText reflects LABEL_FONT.
function stackHalfWidth(ctx: CanvasRenderingContext2D, defs: CandlePatternDef[]): number {
  let w = 0;
  for (const def of defs) {
    let width = labelWidths.get(def.short);
    if (width === undefined) {
      width = ctx.measureText(def.short).width;
      labelWidths.set(def.short, width);
    }
    if (width > w) w = width;
  }
  return w / 2;
}

/**
 * Greedy left-to-right label placement. `items` are the label stacks of one
 * vertical band (below-group OR above-group — the two bands never collide with
 * each other), in ascending x, each with the half-width of its widest line.
 * A stack is kept when its span clears the last KEPT stack's right edge by
 * `pad`; otherwise it is dropped whole, so a multi-line stack never paints a
 * partial set of pattern names. Replaces the old blanket bar-space gate, which
 * hid every label at klinecharts' default 10px/bar zoom.
 */
export function pickLabelSlots(
  items: readonly { x: number; halfWidth: number }[],
  pad: number = LABEL_PAD,
): boolean[] {
  const keep: boolean[] = new Array(items.length);
  let lastRight = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const left = items[i].x - items[i].halfWidth;
    const ok = left >= lastRight + pad;
    keep[i] = ok;
    if (ok) lastRight = items[i].x + items[i].halfWidth;
  }
  return keep;
}

// Per-bar enabled-hit indices. A pattern is enabled when its def's TOGGLE is not
// disabled; the stored value is the def's canonical index (immutable regardless
// of which toggles are on). Iterates in canonical order so labels stack stably.
export function computeCandlePatterns(
  dataList: readonly PatternBar[],
  ext: CandlePatternsExtend,
): CandlePatternsPoint[] {
  const disabled = ext.disabled ?? {};
  const all = detectAllPatterns(dataList);
  return all.map((set) => {
    const hits: number[] = [];
    for (let idx = 0; idx < CANDLE_PATTERN_DEFS.length; idx++) {
      const def = CANDLE_PATTERN_DEFS[idx];
      if (disabled[def.toggle]) continue;
      if (set.has(def.id)) hits.push(idx);
    }
    return hits.length ? { hits } : {};
  });
}

// Paint polarity triangles + stacked labels onto the candle pane. For each bar
// with enabled hits: bull hits get one filled up-triangle below the bar low with
// labels stacked downward; bear + neutral hits get one down-triangle above the
// bar high with labels stacked upward. Label color follows each hit's polarity.
// The above-group triangle uses bearColor when any bear hit is present, else
// neutralColor (a pure-doji bar gets no red marker). Labels are suppressed only
// when showLabels === false; at tight zoom pickLabelSlots drops whichever stacks
// would overlap their left neighbour, so names stay readable instead of
// vanishing wholesale. Triangles always paint. Pure pixel space; returns true so
// klinecharts draws no figures.
function drawCandlePatterns(
  params: IndicatorDrawParams<CandlePatternsPoint, unknown, unknown>,
): boolean {
  const { ctx, chart, indicator, xAxis, yAxis } = params;
  const ext = (indicator.extendData ?? {}) as CandlePatternsExtend;
  const bullColor = ext.bullColor ?? DEFAULT_BULL_COLOR;
  const bearColor = ext.bearColor ?? DEFAULT_BEAR_COLOR;
  const neutralColor = ext.neutralColor ?? DEFAULT_NEUTRAL_COLOR;
  const showLabels = ext.showLabels !== false;
  const points = indicator.result ?? [];
  const kLineDataList = chart.getDataList();

  // Label stacks queued during the triangle pass — one list per vertical band,
  // in ascending x. Drawn after the loop so pickLabelSlots sees each band whole.
  interface LabelStack {
    x: number;
    halfWidth: number;
    y: number; // baseline anchor of the stack's first line
    defs: CandlePatternDef[];
  }
  const belowLabels: LabelStack[] = [];
  const aboveLabels: LabelStack[] = [];

  ctx.save();
  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  // Iterate the full result (off-screen bars draw off-canvas, harmlessly) —
  // same convention as timeHighlight/RSI/Sessions draws.
  for (let i = 0; i < points.length; i++) {
    const hits = points[i].hits;
    if (!hits || hits.length === 0) continue;
    const k = kLineDataList[i];
    if (!k) continue;
    const x = xAxis.convertToPixel(i);

    // Split enabled hits into the below-group (bull) and above-group (bear +
    // neutral), preserving canonical order.
    const below: CandlePatternDef[] = [];
    const above: CandlePatternDef[] = [];
    let aboveHasBear = false;
    for (const idx of hits) {
      const def = CANDLE_PATTERN_DEFS[idx];
      if (!def) continue;
      if (def.polarity === "bull") below.push(def);
      else {
        above.push(def);
        if (def.polarity === "bear") aboveHasBear = true;
      }
    }

    // Bull group: up-triangle below the low, labels stacked downward.
    if (below.length) {
      const lowY = yAxis.convertToPixel(k.low);
      const apexY = lowY + TRI_GAP; // apex points up, toward the bar
      const baseY = apexY + TRI_HEIGHT;
      ctx.fillStyle = bullColor;
      ctx.beginPath();
      ctx.moveTo(x, apexY);
      ctx.lineTo(x - TRI_HALF_WIDTH, baseY);
      ctx.lineTo(x + TRI_HALF_WIDTH, baseY);
      ctx.closePath();
      ctx.fill();
      if (showLabels) {
        belowLabels.push({ x, halfWidth: stackHalfWidth(ctx, below), y: baseY + 2, defs: below });
      }
    }

    // Bear + neutral group: down-triangle above the high, labels stacked upward.
    if (above.length) {
      const highY = yAxis.convertToPixel(k.high);
      const apexY = highY - TRI_GAP; // apex points down, toward the bar
      const baseY = apexY - TRI_HEIGHT;
      ctx.fillStyle = aboveHasBear ? bearColor : neutralColor;
      ctx.beginPath();
      ctx.moveTo(x, apexY);
      ctx.lineTo(x - TRI_HALF_WIDTH, baseY);
      ctx.lineTo(x + TRI_HALF_WIDTH, baseY);
      ctx.closePath();
      ctx.fill();
      if (showLabels) {
        aboveLabels.push({ x, halfWidth: stackHalfWidth(ctx, above), y: baseY - 2, defs: above });
      }
    }
  }

  // Bands are independent: a collision below never suppresses a label above.
  ctx.textBaseline = "top";
  const belowKeep = pickLabelSlots(belowLabels);
  for (let s = 0; s < belowLabels.length; s++) {
    if (!belowKeep[s]) continue;
    const stack = belowLabels[s];
    ctx.fillStyle = bullColor;
    let y = stack.y;
    for (const def of stack.defs) {
      ctx.fillText(def.short, stack.x, y);
      y += LABEL_LINE_HEIGHT;
    }
  }

  ctx.textBaseline = "bottom";
  const aboveKeep = pickLabelSlots(aboveLabels);
  for (let s = 0; s < aboveLabels.length; s++) {
    if (!aboveKeep[s]) continue;
    const stack = aboveLabels[s];
    let y = stack.y;
    for (const def of stack.defs) {
      ctx.fillStyle = def.polarity === "bear" ? bearColor : neutralColor;
      ctx.fillText(def.short, stack.x, y);
      y -= LABEL_LINE_HEIGHT;
    }
  }

  ctx.restore();
  return true;
}

// Figure-less candle-pane overlay. 'price' so it shares the candle price axis
// (yAxis.convertToPixel maps price→pixel); no figures and no numeric result
// values, so it never perturbs the price auto-range. calc stores per-bar enabled
// hits; draw paints the polarity markers.
export const CANDLE_PATTERNS_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Candle Patterns",
  series: "price",
  precision: 0,
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeCandlePatterns(dataList, (ind.extendData ?? {}) as CandlePatternsExtend),
  draw: (params) =>
    drawCandlePatterns(params as IndicatorDrawParams<CandlePatternsPoint, unknown, unknown>),
};
