// Per-indicator input schema that drives the "Inputs" tab of the indicator
// settings modal (TradingView-style gear). klinecharts built-ins only expose a
// flat `calcParams: number[]` with no field names, so this table gives those
// params human labels. The descriptor is intentionally richer than Tier 1 needs
// (it can express `select` dropdowns and values that live in `extendData`, not
// just `calcParams`) so the Tier 2 custom indicators — EMA/MA with Source /
// Offset / smoothing — and the MTF "Timeframe" control plug in without a
// reshape. Anything not listed here falls back to generic numeric inputs read
// from the live indicator's calcParams (see `resolveInputs`).

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
  tip?: string;
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
}

interface IndicatorMetaDef {
  inputs: IndicatorInputDef[];
  // Human-friendly name + one-line description shown in the indicator menu's
  // info tooltip. Optional: indicators without these fall back to the raw code.
  title?: string;
  desc?: string;
}

/** Chunk inputs for the settings modal: CONSECUTIVE inputs sharing a non-empty
 * `group` come out together (max two to a row), everything else alone.
 *
 * Consecutive, not "all with this group", so a group cannot silently reorder
 * the panel. A group left with one member after showWhen filtering renders as
 * an ordinary full-width row. */
export function groupInputs(
  inputs: IndicatorInputDef[],
): IndicatorInputDef[][] {
  const out: IndicatorInputDef[][] = [];
  for (const inp of inputs) {
    const last = out[out.length - 1];
    if (inp.group && last && last.length === 1 && last[0].group === inp.group)
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
    ],
    title: "Pivot Bands",
    desc: "Two step-lines tracking confirmed fractal swing highs and lows separately (a dynamic support/resistance channel). Strength sets the bars required on each side of a pivot. Mode carries either the last pivot or the average of the last K pivots forward; the line only steps when a new pivot confirms (N bars late, no repaint).",
  },
  PIVOT_ANALYSIS: {
    inputs: [
      {
        ...num(0, "Length"),
        tip: "Bars required on each side of a swing. Higher value marks only the more prominent pivots (and confirms them later).",
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
    desc: "Marks each confirmed fractal swing high/low, connects it to the previous same-type pivot with a Δ% / Δt label, and (optionally) carries the latest pivot high/low forward as a level line. Length sets the bars required on each side of a swing; pivots confirm that many bars late (no repaint). Pivot high/low, Δ% and Δt are available as rule operands.",
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
        tip: "Max number of lines drawn per side, nearest to price first, counted after merging. Raising it also keeps more lines in play, which can change the prices this indicator reports.",
      },
      {
        ...num(15, "Min Back Clearance"),
        default: 10,
        suffix: "bars",
        tip: "Bars before a line's first anchor that price must leave clear, on the line's own side. Zero accepts any pair, which lets a line start at a pivot the trend had already left behind.",
      },
      {
        ...num(0, "Min Pivot Length"),
        group: "pivot",
        suffix: "bars",
        tip: "Min number of bars a pivot must beat on each side before it counts as a turning point. Higher values keep fewer pivots and confirm them later.",
      },
      {
        ...num(10, "Max Pivot Pairs"),
        group: "pivot",
        suffix: "pairs",
        default: 20,
        tip: "Max number of earlier pivots a new pivot tries to draw a line with. Counted in pivots, not bars, so filtering pivots out lets the same slots reach further back.",
      },
      {
        ...num(1, "Max Pierce", { min: 0, step: 0.05 }),
        group: "tol",
        suffix: "ATR",
        tip: "The furthest a wick may poke past a line without breaking it, in ATR(14). Zero means any poke through breaks it.",
      },
      {
        ...num(2, "Max Touch Gap", { min: 0.05, step: 0.05 }),
        group: "tol",
        suffix: "ATR",
        tip: "The furthest a pivot may sit from a line and still count as touching it, in ATR(14).",
      },
      {
        ...num(3, "Min Touches", { min: 2 }),
        group: "major",
        suffix: "pivots",
        tip: "Min number of pivots that must touch a line before it counts as a real trendline. Two is just the pair that drew it, so Min Span does most of the filtering.",
      },
      {
        ...num(11, "Max Touches", { min: 0 }),
        group: "major",
        default: 0,
        suffix: "pivots",
        tip: "Max number of pivots that may touch a line before it stops counting as a trendline. Zero means no limit. A line that keeps collecting touches is usually a flat shelf half the swings in a range graze.",
      },
      {
        ...num(4, "Min Span"),
        group: "span",
        suffix: "bars",
        tip: "Min number of bars a line must span before it counts as a real trendline. It keeps short, meaningless lines off the chart.",
      },
      {
        ...num(12, "Max Span", { min: 0 }),
        group: "span",
        default: 0,
        suffix: "bars",
        tip: "Max number of bars a line may span before it stops counting as a trendline. Zero means no limit. Useful when only the recent structure matters and a line reaching back years is noise.",
      },
      {
        ...num(5, "Max Projection"),
        group: "life",
        suffix: "bars",
        tip: "Max number of bars an unbroken line keeps running past its last touch before it retires. Once price breaks a line, Max Break Hold takes over.",
      },
      {
        ...num(6, "Max Break Hold"),
        group: "life",
        suffix: "bars",
        tip: "Max number of bars a broken line stays on the chart, dashed, after price cuts through it. Long enough to watch for a retest.",
      },
      {
        ...num(8, "Min Pivot Size", { min: 0, step: 0.1 }),
        group: "size",
        suffix: "ATR",
        // Charts created before this param existed store only eight
        // calcParams, so the slot reads undefined and the box would render
        // empty. Same 0 parseTrendlinesConfig already substitutes.
        default: 0,
        tip: "Min size of the leg from a pivot back to the last pivot on the other side, in ATR(14). Zero accepts every turn, and raising it drops the small wobbles.",
      },
      {
        ...num(9, "Min Pivot Reach", { min: 0 }),
        group: "size",
        suffix: "bars",
        default: 0,
        tip: "Min number of bars a pivot must beat to its left before it counts as a turning point. Set it above Min Pivot Length to have any effect, since a pivot already beats that many.",
      },
      {
        ...num(14, "Min Slope", { min: 0, step: 0.01 }),
        group: "slope",
        default: 0,
        suffix: "ATR/bar",
        tip: "Min steepness a line must have, in ATR(14) of price per bar. Zero means no floor. A line flat enough to be a horizontal shelf is not a trendline, and the S/R Levels indicator draws those properly.",
      },
      {
        ...num(13, "Max Slope", { min: 0, step: 0.01 }),
        group: "slope",
        default: 0,
        suffix: "ATR/bar",
        tip: "Max steepness a line may have, in ATR(14) of price per bar. Zero means no limit. A steep line outruns price and is never touched again, which is what a fan off one sharp pivot keeps producing.",
      },
      {
        key: "nearPrice",
        label: "Only lines near price",
        // Everything from here down is render-only: nothing a rule reads can
        // move. The heading is what lets the four tips stop saying so.
        section: "Drawing",
        type: "boolean",
        source: "extend",
        field: "nearPrice",
        default: true,
        tip: "Hides lines that have run far from the current price. The nearest on each side always stays.",
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
        key: "dedupe",
        label: "Merge similar lines",
        group: "merge",
        type: "boolean",
        source: "extend",
        field: "dedupe",
        default: true,
        tip: "One pivot often starts several lines that sit almost on top of each other. This keeps the closest and gives the freed slots to lines with a different shape.",
      },
      {
        key: "dedupeAtr",
        label: "Merge Tolerance",
        group: "merge",
        type: "number",
        source: "extend",
        field: "dedupeAtr",
        default: 1,
        min: 0,
        step: 0.25,
        suffix: "ATR",
        tip: "How far apart two lines through the same pivot may sit at the last bar and still count as one. Lower keeps more of them separate.",
      },
      {
        key: "extend",
        label: "Extend",
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
    ],
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
