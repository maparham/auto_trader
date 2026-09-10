// Per-indicator input schema that drives the "Inputs" tab of the indicator
// settings modal (TradingView-style gear). klinecharts built-ins only expose a
// flat `calcParams: number[]` with no field names, so this table gives those
// params human labels. The descriptor is intentionally richer than Tier 1 needs
// (it can express `select` dropdowns and values that live in `extendData`, not
// just `calcParams`) so the Tier 2 custom indicators — EMA/MA with Source /
// Offset / smoothing — and the MTF "Timeframe" control plug in without a
// reshape. Anything not listed here falls back to generic numeric inputs read
// from the live indicator's calcParams (see `resolveInputs`).

import { TRENDLINES_DEFAULTS } from "./indicators/trendlinesOutputs";

type IndicatorInputType = "number" | "select" | "boolean";

export interface IndicatorInputDef {
  key: string;
  label: string;
  type: IndicatorInputType;
  // Where the value is stored on the klinecharts Indicator:
  //  - "calcParam": calcParams[index]  (built-ins + most params)
  //  - "extend":    extendData[field]  (Tier 2 source/offset, MTF config)
  source: "calcParam" | "extend";
  index?: number;
  field?: string;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string | number; label: string }>;
  // Optional ⓘ info tip shown beside the input's label in the settings modal.
  // An array renders each entry as its own line — prefer that over one long
  // sentence when the tip explains more than one rule.
  tip?: string | string[];
  // Optional pairing: CONSECUTIVE inputs sharing a group are laid out two to a
  // row with their labels stacked above them, instead of one label-left,
  // control-right row each. Halves the width a label gets, so pair only inputs
  // whose labels are short and whose meanings are related.
  group?: string;
  // Render this control at the row's full remaining width rather than the fixed
  // 130px. For a select whose options are sentences, not words.
  wide?: boolean;
  // A unit shown to the RIGHT of the control instead of inside the label. Keeps
  // the label to the thing being set and the unit next to the number it applies
  // to, which is also what makes a paired label short enough to fit.
  suffix?: string;
  // Optional section heading rendered ABOVE this input, opening a run of
  // related controls (e.g. "Drawing" over the render-only options). The heading
  // belongs to the input that starts the section, so reordering the list moves
  // it with them.
  section?: string;
  // Optional conditional visibility: only render this input when another input's
  // (extend-stored) value is one of `equals`. Used e.g. to hide Pivot Bands'
  // "Window (K)" unless Mode is "avg". Honored by the generic Inputs renderer.
  showWhen?: { field: string; equals: Array<string | number> };
  // Carried by the FIRST member of a grouped pair whose two inputs are the min
  // and max of ONE concept (Touches, Span, Slope). The renderer collapses the
  // pair into a single "label [min] – [max] unit" row under this label and tip
  // instead of two labeled fields. The members keep their own labels for
  // aria/screen readers, and render as ordinary rows if the pair ever splits.
  range?: { label: string; tip: string | string[] };
  // The stored value 0 means "no limit" for this input: render an empty box
  // with an "∞" placeholder instead of a literal 0, and store 0 when cleared.
  // Display-only — the stored sentinel does not change.
  unbounded?: boolean;
}

// A named one-click starting point for an indicator's calcParams. `calcParams`
// is the FULL array (every slot), so applying a preset is deterministic:
// params a preset doesn't care about land on their defaults.
export interface IndicatorPresets {
  // Full default calcParams, used to fill slots a saved chart predates when
  // matching the live values against an option.
  base: number[];
  options: Array<{ name: string; calcParams: number[] }>;
}

interface IndicatorMetaDef {
  inputs: IndicatorInputDef[];
  // Human-friendly name + one-line description shown in the indicator menu's
  // info tooltip. Optional: indicators without these fall back to the raw code.
  title?: string;
  desc?: string;
  // Optional preset chips rendered above the inputs (only TRENDLINES today).
  presets?: IndicatorPresets;
}

/** Chunk inputs for the settings modal: CONSECUTIVE inputs sharing a non-empty
 * `group` come out together (max two to a row), everything else alone.
 *
 * Consecutive, not "all with this group", so a group cannot silently reorder
 * the panel. A group left with one member after showWhen filtering renders as
 * an ordinary full-width row.
 *
 * BOOLEANS PAIR WITHOUT A `group`, two to a row, wherever two of them land
 * next to each other. They earn it that a tagged pair does not: a switch and
 * its label take a fraction of a row, so a column of them wastes half the
 * modal and pushes the numbers that DO need the width off the bottom. Nothing
 * to tag per indicator, and nothing to keep in sync — the pairing follows
 * whatever order the meta already declares. A `group` tag still wins where one
 * is set, so a boolean deliberately paired with a non-boolean keeps that pair.
 *
 * A boolean opening a SECTION never pairs backwards: the heading belongs to
 * the row it introduces, and a chunk renders its heading from chunk[0], so
 * absorbing it into the row above would move the heading up with it. */
export function groupInputs(
  inputs: IndicatorInputDef[],
): IndicatorInputDef[][] {
  const out: IndicatorInputDef[][] = [];
  for (const inp of inputs) {
    const last = out[out.length - 1];
    if (inp.group && last && last.length === 1 && last[0].group === inp.group)
      last.push(inp);
    else if (
      !inp.group &&
      !inp.section &&
      inp.type === "boolean" &&
      last &&
      last.length === 1 &&
      !last[0].group &&
      last[0].type === "boolean"
    )
      last.push(inp);
    else out.push([inp]);
  }
  return out;
}

// Helper: a labeled numeric calcParam input.
function num(
  index: number,
  label: string,
  opts: { min?: number; max?: number; step?: number } = {},
): IndicatorInputDef {
  return {
    key: `p${index}`,
    label,
    type: "number",
    source: "calcParam",
    index,
    min: opts.min ?? 1,
    step: opts.step ?? 1,
    max: opts.max,
  };
}

// Named inputs for the indicators we expose most. Labels mirror what these
// params actually mean (verified against klinecharts' built-in defaults), so
// the modal reads like TradingView's rather than "Param 1 / Param 2". Built-ins
// not listed here still get a working Inputs tab via the generic fallback.

// Price-source options for the TV-style moving averages (mirrors mtf.PriceSource).
// Declared before INDICATOR_META so LR's Source `select` can reference it.
export const PRICE_SOURCES: Array<{ value: string; label: string }> = [
  { value: "open", label: "Open" },
  { value: "high", label: "High" },
  { value: "low", label: "Low" },
  { value: "close", label: "Close" },
  { value: "hl2", label: "(H + L)/2" },
  { value: "hlc3", label: "(H + L + C)/3" },
  { value: "ohlc4", label: "(O + H + L + C)/4" },
  { value: "hlcc4", label: "(H + L + C + C)/4" },
];

// Pivot Bands' Source options: the classic asymmetric "High / Low" default plus
// the shared single-series price sources (used for both lines when picked).
export const PIVOT_SOURCES: Array<{ value: string; label: string }> = [
  { value: "hl", label: "High / Low" },
  ...PRICE_SOURCES,
];

export const SMOOTHING_TYPES: Array<{ value: string; label: string }> = [
  { value: "none", label: "None" },
  { value: "sma", label: "SMA" },
  { value: "ema", label: "EMA" },
];

/** The ONE spelling of each SLOPE unit. The settings dropdown below is built
 * from it, and the expression editor's completion detail reads it directly, so
 * a pane's units read identically in both places. */
export const SLOPE_UNIT_LABEL: Record<string, string> = {
  pctHr: "% / hour",
  pctBar: "% / bar",
  priceBar: "Price / bar",
};

const SLOPE_UNIT_OPTIONS: Array<{ value: string; label: string }> =
  Object.entries(SLOPE_UNIT_LABEL).map(([value, label]) => ({ value, label }));

// TRENDLINES' default calcParams in slot order (the order documented in
// trendlinesOutputs.ts and mirrored by the backend parser). Built from
// TRENDLINES_DEFAULTS by name so the two cannot drift apart silently.
const TL = TRENDLINES_DEFAULTS;
const TL_DEFAULT_PARAMS: number[] = [
  TL.pivotLen, TL.violMult, TL.touchMult, TL.minTouches, TL.minSpanBars,
  TL.maxProjBars, TL.breakHoldBars, TL.maxLines, TL.minSwingAtr,
  TL.minSwingReach, TL.pairPivots, TL.maxTouches, TL.maxSpanBars,
  TL.maxSlopeAtr, TL.minSlopeAtr, TL.minBackBars, TL.mixedTouches,
  TL.maxTouchSpacing, TL.minTouchSpacing,
];

// A preset = the defaults with a sparse patch (by slot index) on top, so the
// unmentioned params reset to their defaults and the chips are deterministic.
function tlPreset(name: string, patch: Record<number, number>) {
  return { name, calcParams: TL_DEFAULT_PARAMS.map((v, i) => patch[i] ?? v) };
}

// Chip values: Balanced IS the defaults; Clean tightens the MAJOR gates (fewer,
// stricter lines — Min Swing Size 0.75 sits mid-way in the useful 0.5–1.0 band
// measured on the DXY fixture, see the TRENDLINES comment below); Busy loosens
// them and raises the per-side cap.
const TRENDLINES_PRESETS: IndicatorPresets = {
  base: TL_DEFAULT_PARAMS,
  options: [
    tlPreset("Clean", { 7: 2, 3: 3, 4: 40, 8: 0.75 }),
    tlPreset("Balanced", {}),
    tlPreset("Busy", { 7: 8, 4: 10 }),
  ],
};

const INDICATOR_META: Record<string, IndicatorMetaDef> = {
  CANDLE_PATTERNS: {
    inputs: [],
    title: "Candle Patterns",
    desc: "Marks candlestick patterns (engulfing, harami, stars, pins and more) on the chart. Each pattern is usable as a backtest rule condition.",
  },
  // EMA/MA are our TV-style single-line moving averages (see customIndicators);
  // their Source / Offset / Smoothing / Timeframe inputs are rendered by a
  // dedicated panel in the settings modal (they write extendData + drive an
  // async HTF fetch), so only Length is described here.
  MA: {
    inputs: [num(0, "Length")],
    title: "Moving Average",
    desc: "Average price over a window, smoothing trend direction. Equal weight to every bar.",
  },
  EMA: {
    inputs: [num(0, "Length")],
    title: "Exponential Moving Average",
    desc: "Moving average that weights recent bars more heavily, so it reacts faster than a simple MA.",
  },
  SMA: {
    inputs: [num(0, "Length"), num(1, "Weight")],
    title: "Smoothed Moving Average",
    desc: "A weighted moving average that distributes a configurable weight across the window.",
  },
  BBI: {
    inputs: [
      num(0, "Period 1"),
      num(1, "Period 2"),
      num(2, "Period 3"),
      num(3, "Period 4"),
    ],
    title: "Bull and Bear Index",
    desc: "The average of four moving averages of different lengths, used as a single trend line.",
  },
  BOLL: {
    inputs: [num(0, "Length"), num(1, "StdDev", { step: 0.1 })],
    title: "Bollinger Bands",
    desc: "A moving average with bands set a number of standard deviations away, tracking volatility.",
  },
  MACD: {
    inputs: [
      num(0, "Fast Length"),
      num(1, "Slow Length"),
      num(2, "Signal Smoothing"),
    ],
    title: "Moving Average Convergence Divergence",
    desc: "The gap between a fast and slow EMA plus a signal line and histogram, for momentum.",
  },
  RSI: {
    // Single Length, TradingView-style. klinecharts' RSI ships with three lengths,
    // but we create it with calcParams [14] (see DEFAULT_CALC_PARAMS in indicators.ts)
    // so only one line is drawn; the modal mirrors that with one input.
    inputs: [num(0, "Length")],
    title: "Relative Strength Index",
    desc: "Momentum oscillator (0–100) measuring the speed of gains vs losses; flags overbought/oversold. Optional divergence detection marks price/RSI divergences on the plot.",
  },
  KDJ: {
    inputs: [num(0, "Length"), num(1, "K Smoothing"), num(2, "D Smoothing")],
    title: "KDJ Stochastic",
    desc: "A stochastic oscillator with an extra J line, highlighting momentum turns and divergence.",
  },
  WR: {
    inputs: [num(0, "Length 1"), num(1, "Length 2"), num(2, "Length 3")],
    title: "Williams %R",
    desc: "Momentum oscillator showing the close relative to the high–low range; flags overbought/oversold.",
  },
  CCI: {
    inputs: [num(0, "Length")],
    title: "Commodity Channel Index",
    desc: "Measures how far price has strayed from its average, identifying cyclical extremes.",
  },
  DMI: {
    inputs: [num(0, "Length"), num(1, "ADX Smoothing")],
    title: "Directional Movement Index",
    desc: "+DI and −DI directional lines with an ADX line gauging trend strength.",
  },
  VOL: {
    inputs: [num(0, "MA 1"), num(1, "MA 2"), num(2, "MA 3")],
    title: "Volume",
    desc: "Traded volume per bar with up to three moving averages overlaid.",
  },
  BIAS: {
    inputs: [num(0, "Length 1"), num(1, "Length 2"), num(2, "Length 3")],
    title: "Bias Ratio",
    desc: "The percentage deviation of price from its moving average, at three lengths.",
  },
  SAR: {
    inputs: [num(0, "Min AF"), num(1, "Max AF"), num(2, "Limit")],
    title: "Parabolic SAR",
    desc: "Trailing stop-and-reverse dots that follow the trend and flip when it reverses.",
  },
  // VWAP has no parameters; AVWAP's only param is an anchor timestamp that is set
  // by clicking a bar (not a numeric field), so both expose no Inputs rows.
  VWAP: {
    inputs: [],
    title: "Volume Weighted Average Price",
    desc: "The session's average price weighted by volume: a common intraday fair-value benchmark.",
  },
  AVWAP: {
    inputs: [],
    title: "Anchored VWAP",
    desc: "A VWAP measured from a bar you pick, anchoring fair value to a chosen event.",
  },
  ATR: {
    inputs: [
      num(0, "Length"),
      {
        key: "smoothing",
        label: "Smoothing",
        type: "select",
        source: "extend",
        field: "smoothing",
        default: "rma",
        tip: "Moving average applied to the true range. RMA (Wilder) is TradingView's default; SMA/EMA/WMA match Pine's ta.sma/ta.ema/ta.wma.",
        options: [
          { value: "rma", label: "RMA" },
          { value: "sma", label: "SMA" },
          { value: "ema", label: "EMA" },
          { value: "wma", label: "WMA" },
        ],
      },
      {
        key: "pctSource",
        label: "% Source",
        type: "select",
        source: "extend",
        field: "pctSource",
        default: "close",
        tip: "Bar price the legend's ATR% readout is measured against (ATR ÷ price × 100).",
        options: PRICE_SOURCES,
      },
    ],
    title: "Average True Range",
    desc: "Average of the true range over the window: volatility in price units. Referenceable in backtest rules as an instance (e.g. ATR1.14).",
  },
  // Linear Regression Channel (TV "LR"): window Length + channel Deviations
  // (calcParams), and a price Source dropdown stored on extendData.
  LR: {
    inputs: [
      num(0, "Length"),
      num(1, "Deviations", { min: 0, step: 0.1 }),
      {
        key: "source",
        label: "Source",
        type: "select",
        source: "extend",
        field: "source",
        default: "close",
        options: PRICE_SOURCES,
      },
    ],
    title: "Linear Regression Channel",
    desc: "A best-fit regression line through price with channel bands a number of deviations away.",
  },
  // Previous Minute/Hour/Day/Week/Interval High/Low. The per-boundary lookback length +
  // aggregation function live on a dedicated PREV_HL panel in the settings modal
  // (Inputs tab), so this `inputs` list stays empty; each line toggles from Style.
  PREV_HL: {
    inputs: [],
    title: "Previous Period High/Low",
    desc: "Two kinds of high/low reference lines: a rolling trailing range (previous N bars/minutes/hours/days/weeks, sliding) and anchored previous-period lines (previous trading day and week). Each aggregates by max/min, average, or median. Toggle and style each in the modal.",
  },
  PIVOT_BANDS: {
    inputs: [
      {
        ...num(0, "Strength"),
        tip: "Bars required on each side of a swing. Higher value filters out less prominent (weaker) pivots.",
      },
      {
        key: "mode",
        label: "Mode",
        type: "select",
        source: "extend",
        field: "mode",
        default: "last",
        options: [
          { value: "last", label: "Last pivot" },
          { value: "avg", label: "Average of last K" },
        ],
        tip: "Last pivot: carry the latest swing forward. Average of last K: carry the mean of the last K swings.",
      },
      {
        ...num(1, "Window (K)"),
        showWhen: { field: "mode", equals: ["avg"] },
        tip: "Number of recent pivots to average.",
      },
      {
        key: "source",
        label: "Source",
        type: "select",
        source: "extend",
        field: "source",
        default: "hl",
        options: PIVOT_SOURCES,
        tip: "Price the swings are detected on. High / Low uses highs for the upper line and lows for the lower line; any other source uses that single series for both lines.",
      },
      {
        key: "showBarsSince",
        label: "Bars since pivot pane",
        type: "boolean",
        source: "extend",
        field: "showBarsSince",
        default: false,
        tip: "Adds a pane below counting the bars since the last confirmed swing high and swing low. The count runs from the swing bar, so it never reads below Strength.",
      },
    ],
    title: "Pivot Bands",
    desc: "Two step-lines tracking confirmed fractal swing highs and lows separately (a dynamic support/resistance channel). Strength sets the bars required on each side of a pivot. Mode carries either the last pivot or the average of the last K pivots forward; the line only steps when a new pivot confirms (N bars late, no repaint). Both pivot prices and the bars since each side's last pivot are available as rule operands, the counts whether or not their pane is shown.",
  },
  PIVOT_ANALYSIS: {
    inputs: [
      {
        ...num(0, "Pivot High Length"),
        tip: "Bars required on each side of a swing high. Higher value marks only the more prominent highs (and confirms them later).",
      },
      {
        ...num(1, "Pivot Low Length"),
        tip: "Bars required on each side of a swing low. Higher value marks only the more prominent lows (and confirms them later).",
      },
      {
        ...num(2, "Min Δ% High", { min: 0, step: 0.1 }),
        tip: "A swing high only counts if it's at least this far (%) from the prior counted swing high. 0 = off.",
      },
      {
        ...num(3, "Min Δ% Low", { min: 0, step: 0.1 }),
        tip: "A swing low only counts if it's at least this far (%) from the prior counted swing low. 0 = off.",
      },
      {
        key: "showLevels",
        label: "Previous H/L lines",
        type: "boolean",
        source: "extend",
        field: "showLevels",
        default: true,
        tip: "Carry the most recent confirmed pivot high and low forward as level lines.",
      },
    ],
    title: "Pivots High/Low [LuxAlgo]",
    desc: "Marks each confirmed fractal swing high/low, connects it to the previous COUNTED same-type pivot with a Δ% / Δt label, and (optionally) carries the latest pivot high/low forward as a level line. Pivot High/Low Length set the bars required on each side of a swing on each side independently; pivots confirm that many bars late (no repaint). Min Δ% filters out swings too small to count, per side. Pivot high/low, Δ% and Δt are available as rule operands.",
  },
  SR_LEVELS: {
    inputs: [
      {
        ...num(0, "Pivot Length"),
        tip: "Bars required on each side of a swing before it counts as a pivot. Higher value uses only the more prominent swings (and confirms them later).",
      },
      {
        ...num(1, "Zone Width (×ATR)", { min: 0.05, step: 0.05 }),
        tip: "Cluster tolerance and zone half-height as a multiple of ATR(14). Pivots within this distance of a level merge into it.",
      },
      {
        ...num(2, "Min Touches"),
        tip: "Pivots a zone needs before it is drawn as a major level.",
      },
      {
        ...num(3, "Max Levels"),
        tip: "Keep only this many of the strongest (most-touched, most recent) levels.",
      },
      {
        ...num(4, "Window (bars)"),
        tip: "A level goes stale once its last touch is older than this many bars.",
      },
      {
        key: "showMidline",
        label: "Center line",
        type: "boolean",
        source: "extend",
        field: "showMidline",
        default: false,
        tip: "Draw a dashed line through each zone's center price.",
      },
    ],
    title: "Support / Resistance Levels",
    desc: "Clusters confirmed fractal swing highs and lows into major support/resistance zones. Each zone's price is the average of its touches; opacity and the ×N tag show touch count. Zones below the current close tint green (support), above tint red (resistance). Nearest support and resistance are available as rule operands. Pivots confirm Pivot Length bars late (no repaint).",
  },
  SPIKE: {
    inputs: [
      {
        ...num(0, "Spike Window"),
        suffix: "bars",
        tip: "Bars the spike leg may take. A spike arms when the high rises Min Rise above the lowest low of this trailing window.",
      },
      {
        ...num(1, "Min Rise", { min: 0.1, step: 0.1 }),
        suffix: "%",
        tip: "Rise (%) from the window low that arms a spike. Higher values keep only the steeper, near-vertical moves.",
      },
      {
        ...num(2, "Flat Bars"),
        tip: "Consecutive bars holding the flat band that confirm the consolidation.",
      },
      {
        ...num(3, "Flat Band", { min: 1, step: 1 }),
        suffix: "%",
        tip: "Consolidation band depth below the spike high, as a percent of the spike's height. Bars must hold inside it until the consolidation confirms; a dip below it before then voids the pattern.",
      },
      {
        ...num(4, "Max Pattern Age"),
        suffix: "bars",
        tip: "Pattern lifetime after the spike (or its last extension). An armed pattern older than this expires, freeing the next spike to start fresh instead of extending stale anchors.",
      },
      {
        ...num(5, "Max Retrace", { min: 1, step: 1 }),
        suffix: "%",
        tip: "Deepest allowed dip after the consolidation confirms, as a percent of the spike's height. A retrace below it invalidates the pattern: the bull continuation is no longer high-probability. Entry retrace bounds must sit inside this percentage.",
      },
      {
        key: "showStageLabels",
        label: "Stage labels",
        type: "boolean",
        source: "extend",
        field: "showStageLabels",
        default: true,
        tip: "Text on each pattern box naming its stage: spike, consolidating, latched, and why it ended.",
      },
    ],
    title: "Spike + Consolidation",
    desc: "Tracks a vertical spike followed by a flat, low-volatility consolidation, then measures the retrace: the setup behind a buy-the-dip entry. Draws a phase-shaded box while a pattern is live. Rule operands: spikeHigh, spikeLow, barsSinceSpike, consolOk (1 once the consolidation confirms), retracePct (current dip as % of spike height) and maxRetracePct (deepest dip since confirmation). The Flat Band is the pattern's hard floor: any dip below it, before or after confirmation, invalidates — as does a break below the spike low.",
  },
  FVG: {
    inputs: [
      {
        ...num(0, "Min Size (×ATR)", { min: 0, step: 0.05 }),
        tip: "Smallest gap kept, as a multiple of ATR(14) at the bar that confirmed it. Set to 0 to keep every gap.",
      },
      {
        ...num(1, "Window (bars)"),
        tip: "A gap expires this many bars after it formed, even if price never filled it.",
      },
      {
        ...num(2, "Max Gaps"),
        tip: "Keep only this many of the newest unfilled gaps on each side.",
      },
      {
        key: "showMidline",
        label: "Center line",
        type: "boolean",
        source: "extend",
        field: "showMidline",
        default: false,
        tip: "Draw a dashed line through each zone's midpoint (the 50% level, ICT's consequent encroachment).",
      },
      {
        key: "extendRight",
        label: "Extend to Right",
        type: "boolean",
        source: "extend",
        field: "extendRight",
        default: false,
        tip: "Continues each zone to the right edge of the chart. Off: zones stop at the last bar.",
      },
    ],
    title: "Fair Value Gaps",
    desc: "Marks 3-candle imbalances (a gap between the first bar's wick and the third bar's) as zones. A gap shrinks to its unfilled remainder as price trades back into it and disappears once price crosses its far edge, so only live imbalances stay on the chart. Bullish gaps tint green, bearish red. The nearest gap's edges on each side are available as rule operands. Gaps confirm on the third candle (no repaint).",
  },
  // TRENDLINES. Two gates decide whether a line is MAJOR (readable by a rule):
  // Min Touches and Min Span. Max Lines is not a third gate, but it is NOT
  // operand-neutral either: the emit path reads the live pool, and that pool is
  // capped at MAX_LIVE_MULT * maxLines per side by rank, so raising maxLines
  // widens the candidate set. Measured on the DXY fixture, maxLines 2 vs 3
  // changes the emitted value on 87 bars. The Max Lines tip must say that and
  // must never claim the operands are unaffected.
  //
  // Min Swing Size gates HARDER than any of them: it decides what counts as a
  // swing at all, so a rejected bar seeds no line and joins no pool. Default 0
  // (off), so nothing already saved moves. Measured on the same DXY fixture at
  // otherwise-default config, of 51 pivots it keeps 49 at 0.5, 40 at 0.75, 25
  // at 1.0 and 9 at 1.5, changing an emitted value on 19, 218, 337 and 442 of
  // 490 bars. 1.5 already starves the pane (it emits on 133 bars where the
  // others all emit on 442), so the useful band is 0.5 to 1.0.
  //
  // Min Back Clearance is the only gate here that ships ON (10 bars), because
  // it fixes a hole rather than adding taste: seeding validates a candidate
  // over (i1, i] and never looks BEFORE i1, so a pair whose angle has nothing
  // to do with the trend passes as long as its wrong side is in the past.
  // Saved charts DO move under it. It does not merely delete: the freed pairing
  // slots refill, so the detector picks a better first anchor for the same
  // trend. Measured on the DXY monthly fixture at otherwise-default config, the
  // live set goes 22 -> 23 lines while the worst clearance goes 5 bars -> 10,
  // and an emitted value moves on 239 of 490 bars.
  //
  // Min Swing Reach is the same gate on the TIME axis: a swing can be deep and
  // brief (a spike) or long and shallow (a drift), and one setting rejects
  // each. It reads LEFT reach only, because right reach keeps growing after
  // the pivot confirms and gating on it would repaint. Also default 0, and a
  // no-op at anything <= Pivot Length.
  TRENDLINES: {
    inputs: [
      {
        ...num(7, "Max Trendlines"),
        tip: [
          "Max lines drawn in total, nearest to price first, counted after merging.",
          "Lines this indicator currently reports always draw, even over the limit.",
          "Raising it also keeps more lines in play, which can change the prices this indicator reports.",
        ],
      },
      // The list below is RENDER order, resectioned to tell the detector's
      // story in reading order — what counts as a pivot, how a line hugs
      // price, which lines qualify, how long they live — while every slot
      // index stays put (indexes are storage, order is presentation).
      {
        ...num(0, "Min Pivot Length"),
        section: "Pivots",
        group: "pivot",
        suffix: "bars",
        tip: [
          "Bars a swing must beat on each side to count as a pivot.",
          "Higher keeps fewer pivots and confirms them later.",
        ],
      },
      {
        ...num(10, "Max Pivot Pairs"),
        group: "pivot",
        suffix: "pairs",
        default: 20,
        tip: [
          "How many earlier pivots a new pivot tries to pair a line with.",
          "Counted in pivots, not bars, so filtering pivots out lets the same slots reach further back.",
        ],
      },
      {
        ...num(8, "Min Pivot Size", { min: 0, step: 0.1 }),
        group: "size",
        suffix: "ATR",
        // Charts created before this param existed store only eight
        // calcParams, so the slot reads undefined and the box would render
        // empty. Same 0 parseTrendlinesConfig already substitutes.
        default: 0,
        tip: [
          "Min height of the swing from a pivot back to the last pivot on the other side, in ATR(14).",
          "Zero accepts every turn. Raising it drops the small wobbles.",
        ],
      },
      {
        ...num(9, "Min Pivot Reach", { min: 0 }),
        group: "size",
        suffix: "bars",
        default: 0,
        tip: [
          "Min bars a pivot must beat to its left to count as a turning point.",
          "Only matters above Min Pivot Length, since a pivot already beats that many.",
        ],
      },
      {
        ...num(1, "Max Pierce", { min: 0, step: 0.05 }),
        section: "Line Fit",
        group: "tol",
        suffix: "ATR",
        tip: [
          "How far a wick may poke past a line without breaking it, in ATR(14).",
          "Zero: any poke through breaks the line.",
        ],
      },
      {
        ...num(2, "Max Touch Gap", { min: 0, step: 0.05 }),
        group: "tol",
        suffix: "ATR",
        tip: [
          "How far a pivot may stop short of a line and still count as a touch, in ATR(14).",
          "Zero: only a pivot that reaches the line counts.",
        ],
      },
      {
        ...num(15, "Min Back Clearance"),
        default: 10,
        suffix: "bars",
        tip: [
          "Bars before a line's first anchor that price must leave clear, on the line's own side.",
          "Zero accepts any pair, even a line starting at a pivot the trend had already left behind.",
        ],
      },
      {
        ...num(3, "Min Touches", { min: 2 }),
        section: "Filters",
        group: "major",
        suffix: "pivots",
        range: {
          label: "Touches",
          tip: [
            "How many pivots must touch a line for it to count, at least and at most.",
            "Two is just the pair that drew it, so Span does most of the filtering.",
            "A line that keeps collecting touches is usually a flat shelf grazed by half the swings in a range.",
            "Empty right box: no limit.",
          ],
        },
        tip: [
          "Min pivots that must touch a line before it counts as a real trendline.",
          "Two is just the pair that drew it, so Min Span does most of the filtering.",
        ],
      },
      {
        ...num(11, "Max Touches", { min: 0 }),
        group: "major",
        default: 0,
        unbounded: true,
        suffix: "pivots",
        tip: [
          "Max pivots that may touch a line before it stops counting. Empty: no limit.",
          "A line that keeps collecting touches is usually a flat shelf grazed by half the swings in a range.",
        ],
      },
      {
        ...num(4, "Min Span"),
        group: "span",
        suffix: "bars",
        range: {
          label: "Span",
          tip: [
            "How many bars a line must cover, at least and at most.",
            "The floor keeps short, meaningless lines off the chart.",
            "The cap helps when only recent structure matters and a line reaching back years is noise.",
            "Empty right box: no limit.",
          ],
        },
        tip: [
          "Min bars a line must span to count as a real trendline.",
          "Keeps short, meaningless lines off the chart.",
        ],
      },
      {
        ...num(12, "Max Span", { min: 0 }),
        group: "span",
        default: 0,
        unbounded: true,
        suffix: "bars",
        tip: [
          "Max bars a line may span before it stops counting. Empty: no limit.",
          "Helps when only recent structure matters and a line reaching back years is noise.",
        ],
      },
      {
        ...num(18, "Min Touch Spacing", { min: 0 }),
        group: "spacing",
        default: 0,
        suffix: "bars",
        range: {
          // ONE WORD, like Touches, Span and Slope beside it. The range row
          // gives its label a narrow fixed column, and "Touch Spacing"
          // ellipsised to "Touch Spac..." there. The two inputs keep their full
          // names as their own labels, which is what the tip title and the
          // accessible names read.
          label: "Spacing",
          tip: [
            "How far apart two touches in a row must be, at least and at most.",
            "Span bounds the whole line; this bounds each gap inside it.",
            "The floor drops lines whose touches bunch together instead of testing the line at separate times.",
            "The cap drops lines whose touches sit far apart, like a pair anchored months before its next touch.",
            "Mixed touches count too, so a far-back opposite pivot can trip the cap.",
            "Empty right box: no limit.",
          ],
        },
        tip: [
          "Min bars between two touches in a row.",
          "Drops lines whose touches bunch together rather than testing the line at separate times.",
          "Below Min Pivot Length it does little unless Mix Low and High Pivots is on.",
        ],
      },
      {
        ...num(17, "Max Touch Spacing", { min: 0 }),
        group: "spacing",
        default: 0,
        unbounded: true,
        suffix: "bars",
        tip: [
          "Max bars between two touches in a row. Empty: no limit.",
          "Drops lines whose touches sit far apart, like a pair anchored months before its next touch.",
          "Mixed touches count too, so a far-back opposite pivot can trip it.",
        ],
      },
      {
        ...num(14, "Min Slope", { min: 0, step: 0.01 }),
        group: "slope",
        default: 0,
        suffix: "ATR/bar",
        range: {
          label: "Slope",
          tip: [
            "How steep a line must be and may be, in ATR(14) of price per bar.",
            "Zero floor accepts even flat lines; horizontal shelves are better drawn by S/R Levels.",
            "A line too steep outruns price and is never touched again, the classic fan off one sharp pivot.",
            "Empty right box: no limit.",
          ],
        },
        tip: [
          "Min steepness a line must have, in ATR(14) of price per bar. Zero: no floor.",
          "A line flat enough to be a horizontal shelf is not a trendline; the S/R Levels indicator draws those properly.",
        ],
      },
      {
        ...num(13, "Max Slope", { min: 0, step: 0.01 }),
        group: "slope",
        default: 0,
        unbounded: true,
        suffix: "ATR/bar",
        tip: [
          "Max steepness a line may have, in ATR(14) of price per bar. Empty: no limit.",
          "A line too steep outruns price and is never touched again, the classic fan off one sharp pivot.",
        ],
      },
      {
        key: "mixedTouches",
        label: "Mix Low and High Pivots",
        type: "boolean",
        source: "calcParam",
        index: 16,
        default: true,
        // `wide` so the full label shows: the shared two-column row ellipsises
        // it, and a checkbox needs no control column anyway.
        wide: true,
        tip: [
          "Support lines normally count only lows, resistance lines only highs.",
          "With this on, the opposite pivot also counts as a touch when it lands near the line. It confirms lines but never starts one.",
          "Near means within Max Pierce past the line, or Max Touch Gap short of it.",
          "The line draws from its earliest touch.",
        ],
      },
      {
        ...num(5, "Max Projection"),
        section: "Lifetime",
        group: "life",
        suffix: "bars",
        tip: [
          "Bars an unbroken line keeps running past its last touch before it retires.",
          "Once price breaks a line, Max Break Hold takes over.",
        ],
      },
      {
        ...num(6, "Max Break Hold"),
        group: "life",
        suffix: "bars",
        tip: [
          "Bars a broken line stays on the chart, dashed, after price cuts through it.",
          "Long enough to watch for a retest.",
        ],
      },
      {
        key: "extend",
        label: "Extend",
        // Everything from here down is render-only: nothing a rule reads can
        // move. The heading is what lets the four tips stop saying so. Extend
        // leads the section: it is the one drawing option that changes every
        // line on the pane, where the three below it choose which lines show.
        section: "Drawing",
        type: "select",
        source: "extend",
        field: "extend",
        default: "ray",
        wide: true,
        options: [
          { value: "ray", label: "→  Extend right" },
          { value: "extended", label: "↔  Extended both ways" },
          { value: "lastbar", label: "⇥  End at last bar" },
          { value: "segment", label: "•–•  Segment, stops at last touch" },
          { value: "apex", label: ">  Apex, stops at opposite line" },
          { value: "cross", label: "×  Cross, stops at any line" },
        ],
        tip: "Where a line stops on the right, and whether it runs back before its first anchor.",
      },
      {
        key: "declutter",
        label: "Declutter",
        type: "select",
        source: "extend",
        field: "declutter",
        default: "near",
        wide: true,
        options: [
          { value: "off", label: "Off" },
          { value: "near", label: "Only lines near price" },
          { value: "pivot", label: "One line per pivot" },
        ],
        tip: [
          "Only lines near price: removes distant lines.",
          "One line per pivot: keeps just the nearest line where several pass through the same swing.",
        ],
      },
      {
        key: "showPivots",
        label: "Show pivots",
        type: "boolean",
        source: "extend",
        field: "showPivots",
        default: true,
        tip: [
          "Marks every swing that passed the pivot settings with a small arrow: up under a low, down over a high.",
          "This is the raw input the lines are built from, so it shows exactly what the pivot settings admit, including pivots no drawn line uses.",
        ],
      },
      {
        key: "showLinePivots",
        label: "Mark line pivots",
        type: "boolean",
        source: "extend",
        field: "showLinePivots",
        default: false,
        tip: [
          "Marks the swings the drawn lines rest on, anchors and touches, with a hollow arrow.",
          "Only lines actually on the chart count, so a line dropped by Max lines or Declutter marks nothing.",
          "With Show pivots on too, a line's pivot takes the hollow arrow instead of the filled one.",
        ],
      },
      {
        key: "hideBroken",
        label: "Hide broken lines",
        type: "boolean",
        source: "extend",
        field: "hideBroken",
        default: false,
        tip: "Hides the dashed lines price has already cut through.",
      },
      {
        key: "dimBroken",
        label: "Dim broken lines",
        type: "boolean",
        source: "extend",
        field: "dimBroken",
        default: false,
        tip: [
          "Fades a broken line as well as dashing it.",
          "Off by default: the dashes and break dot already mark it, and a broken line is exactly where a retest happens.",
        ],
      },
      {
        key: "dimOpacity",
        label: "Dim opacity",
        type: "number",
        source: "extend",
        field: "dimOpacity",
        default: 60,
        min: 10,
        max: 100,
        step: 5,
        suffix: "%",
        tip: [
          "How faded a dimmed line paints, for every reason a line dims.",
          "Floored at 10%: hiding lines is the job of Declutter and Hide broken lines.",
        ],
      },
      {
        key: "dimTouches",
        // Reads as a phrase the number and suffix complete ("Dim after
        // touching 5 pivots"), the same shape the row below it and Merge
        // Lines within use.
        label: "Dim after touching",
        wide: true,
        type: "number",
        source: "extend",
        field: "dimTouches",
        default: 0,
        min: 0,
        suffix: "pivots",
        tip: [
          "Fades a line once price has touched it this many times. Zero never dims.",
          "A level with history then reads at a glance instead of by its ×N tag.",
          "It only fades; Max Touches is what removes a line, and if that is set lower this never fires.",
        ],
      },
      {
        key: "dimStaleBars",
        // The row reads as a phrase the number completes ("Dim if untouched
        // for 40 bars"), which is why the count is not in the suffix: "bars
        // untouched" is wider than the suffix column and clipped to "bars
        // untouc" in the panel.
        label: "Dim if untouched for",
        wide: true,
        type: "number",
        source: "extend",
        field: "dimStaleBars",
        default: 0,
        min: 0,
        suffix: "bars",
        tip: [
          "Fades a line untouched for this many bars, counted from its last touch. Zero never dims.",
          "A forgotten level stops competing with a live one.",
          "It only fades; Max Projection is what drops a stale line entirely.",
        ],
      },
      {
        key: "dedupeAtr",
        label: "Merge Lines within",
        // The label runs to a phrase the number completes ("Merge Lines
        // within 1 ATR"), so `wide` keeps its ⓘ beside the label rather than at
        // the end of the row (see controlFor's number branch). The control
        // still sits in the same column as every other one.
        wide: true,
        // The tolerance IS the switch: 0 merges nothing, which is why the
        // "Merge similar lines" checkbox that used to sit beside this box is
        // gone (it wrote the same off state twice).
        //
        // "One line per pivot" IS this pass with no tolerance at all, so under
        // it the box is inert: hidden rather than left there doing nothing. It
        // comes back with the other two choices.
        showWhen: { field: "declutter", equals: ["off", "near"] },
        type: "number",
        source: "extend",
        field: "dedupeAtr",
        default: 1,
        min: 0,
        step: 0.25,
        suffix: "ATR",
        tip: [
          "One pivot often starts several near-identical lines; this keeps the closest and frees slots for lines with a different shape.",
          "Distance is measured at the last bar. Zero merges nothing.",
        ],
      },
    ],
    presets: TRENDLINES_PRESETS,
    title: "Trendlines",
    desc: "Sloping support and resistance drawn from confirmed pivot highs and lows, keeping only the lines no candle has cut through. The lines nearest price are drawn and tagged with how many times price touched them. A broken line turns dashed and marks where it broke, so you can watch for a retest. Pivots confirm a few bars late, so nothing repaints.",
  },
  SESSIONS: {
    inputs: [],
    title: "Trading Sessions",
    desc: "Shades the FX trading sessions (Sydney, Tokyo, London, New York) across the time axis in a compact strip. Overlapping sessions split the row. Edit, add, recolor, or retime each session in the settings.",
  },
  TIME_HIGHLIGHT: {
    inputs: [],
    title: "Time Highlight",
    desc: "Highlights candles that fall inside time-of-day windows, in your device's local timezone. Each window can shade a translucent background band, recolor its candles, or both. Add, retime, recolor, or restyle each window in the settings.",
  },
  SLOPE: {
    // MA Lengths (calcParams, a variable-length list up to 5) and Smoothing
    // (extendData.smoothing = {type, length}) can't be expressed by this fixed
    // schema — both are rendered by dedicated controls in the SLOPE branch of
    // IndicatorSettings.tsx instead. Only the plain selects stay here.
    inputs: [
      {
        key: "maType",
        label: "MA Type",
        type: "select",
        source: "extend",
        field: "maType",
        default: "ema",
        tip: "EMA reacts faster to recent price; SMA weights every bar equally. VWMA and EVWMA weight bars by traded volume (EVWMA is LazyBear's elastic version).",
        options: [
          { value: "ema", label: "EMA" },
          { value: "sma", label: "SMA" },
          { value: "vwma", label: "VWMA" },
          { value: "evwma", label: "EVWMA" },
        ],
      },
      {
        key: "units",
        label: "Units",
        type: "select",
        source: "extend",
        field: "units",
        default: "pctHr",
        tip: "Slope scale. % / hour is time-normalized and comparable across timeframes; % / bar and price / bar are per bar.",
        options: SLOPE_UNIT_OPTIONS,
      },
      {
        key: "source",
        label: "Source",
        type: "select",
        source: "extend",
        field: "source",
        default: "close",
        tip: "Price the moving average is built from (close, HL2, …).",
        options: PRICE_SOURCES,
      },
    ],
    title: "MA Slope",
    desc: "Rate of change of an EMA or SMA over a lookback period (%/hr, %/bar, or price/bar).",
  },
};

// Friendly name + description for klinecharts built-ins that DON'T need a custom
// `inputs` schema (they use the generic numeric fallback) but should still read as
// full names in the menu. Kept separate from INDICATOR_META so that map stays
// focused on input schemas; indicatorInfo() consults META first, then this.
const INDICATOR_INFO: Record<string, { title: string; desc: string }> = {
  AO: {
    title: "Awesome Oscillator",
    desc: "The gap between a 5- and 34-period median-price SMA, gauging momentum as a histogram.",
  },
  AVP: {
    title: "Average Price",
    desc: "The running average of price, a simple smoothed reference line.",
  },
  BRAR: {
    title: "BRAR",
    desc: "Sentiment gauge: AR measures intraday popularity and BR opening-gap energy, for buying vs selling pressure.",
  },
  CR: {
    title: "CR Energy",
    desc: "An energy/strength index built around the typical price's midpoint, with moving-average bands.",
  },
  DMA: {
    title: "Different of Moving Average",
    desc: "The difference between two moving averages of different lengths, plus its own average line.",
  },
  EMV: {
    title: "Ease of Movement",
    desc: "Relates price change to volume, showing how easily price moves on light vs heavy trading.",
  },
  MTM: {
    title: "Momentum",
    desc: "Price change over a fixed look-back, the raw measure of trend speed.",
  },
  OBV: {
    title: "On Balance Volume",
    desc: "A running total that adds volume on up bars and subtracts it on down bars, tracking accumulation.",
  },
  PSY: {
    title: "Psychological Line",
    desc: "The percentage of up bars over a window, a sentiment oscillator.",
  },
  PVT: {
    title: "Price and Volume Trend",
    desc: "A cumulative volume line weighted by each bar's percentage price change.",
  },
  ROC: {
    title: "Rate of Change",
    desc: "The percentage change in price over a look-back period, a momentum oscillator.",
  },
  TRIX: {
    title: "Triple Exponential Average",
    desc: "The rate of change of a triple-smoothed EMA, filtering out minor price noise.",
  },
  VR: {
    title: "Volume Ratio",
    desc: "Compares volume on up bars vs down bars over a window, a volume-based sentiment gauge.",
  },
};

/** Friendly name + one-line description for an indicator code, for the menu row
 *  label and tooltip. Reads INDICATOR_META first (catalogued indicators with input
 *  schemas), then INDICATOR_INFO (label-only built-ins), then falls back to the
 *  raw code with no description. */
export function indicatorInfo(name: string): { title: string; desc: string } {
  const meta = INDICATOR_META[name];
  if (meta?.title) return { title: meta.title, desc: meta.desc ?? "" };
  const info = INDICATOR_INFO[name];
  if (info) return info;
  return { title: name, desc: "" };
}

/**
 * The input descriptors to render for an indicator. Uses the named metadata when
 * present; otherwise synthesizes generic numeric inputs from the live indicator's
 * current calcParams so every indicator — including ones we haven't catalogued —
 * gets a functional Inputs tab.
 */
// Our custom single-line moving averages get the dedicated MA inputs panel.
export function isMovingAverage(name: string): boolean {
  return name === "EMA" || name === "MA";
}

export function resolveInputs(
  name: string,
  liveCalcParams: unknown[] | undefined,
): IndicatorInputDef[] {
  const meta = INDICATOR_META[name];
  if (meta) return meta.inputs;
  const params = liveCalcParams ?? [];
  return params.map((_, i) =>
    num(i, params.length > 1 ? `Param ${i + 1}` : "Length"),
  );
}

/** The preset chips (if any) for an indicator's Inputs tab. */
export function presetsFor(name: string): IndicatorPresets | undefined {
  return INDICATOR_META[name]?.presets;
}
