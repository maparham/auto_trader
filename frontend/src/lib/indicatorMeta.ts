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
    inputs: [num(0, "Period 1"), num(1, "Period 2"), num(2, "Period 3"), num(3, "Period 4")],
    title: "Bull and Bear Index",
    desc: "The average of four moving averages of different lengths, used as a single trend line.",
  },
  BOLL: {
    inputs: [num(0, "Length"), num(1, "StdDev", { step: 0.1 })],
    title: "Bollinger Bands",
    desc: "A moving average with bands set a number of standard deviations away, tracking volatility.",
  },
  MACD: {
    inputs: [num(0, "Fast Length"), num(1, "Slow Length"), num(2, "Signal Smoothing")],
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
    desc: "The session's average price weighted by volume — a common intraday fair-value benchmark.",
  },
  AVWAP: {
    inputs: [],
    title: "Anchored VWAP",
    desc: "A VWAP measured from a bar you pick, anchoring fair value to a chosen event.",
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
        tip: "Bars required each side of a swing. Higher value filters out less prominent (weaker) pivots.",
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
    desc: "Two step-lines tracking confirmed fractal swing highs and lows separately — a dynamic support/resistance channel. Strength sets the bars required on each side of a pivot. Mode carries either the last pivot or the average of the last K pivots forward; the line only steps when a new pivot confirms (N bars late, no repaint).",
  },
  PIVOT_ANALYSIS: {
    inputs: [
      {
        ...num(0, "Length"),
        tip: "Bars required each side of a swing. Higher value marks only the more prominent pivots (and confirms them later).",
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
    desc: "Marks each confirmed fractal swing high/low, connects it to the previous same-type pivot with a Δ% / Δt label, and (optionally) carries the latest pivot high/low forward as a level line. Length sets the bars required each side of a swing; pivots confirm that many bars late (no repaint). Pivot high/low, Δ% and Δt are available as rule operands.",
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
        key: "maType", label: "MA Type", type: "select",
        source: "extend", field: "maType", default: "ema",
        tip: "EMA reacts faster to recent price; SMA weights every bar equally. VWMA and EVWMA weight bars by traded volume (EVWMA is LazyBear's elastic version).",
        options: [
          { value: "ema", label: "EMA" },
          { value: "sma", label: "SMA" },
          { value: "vwma", label: "VWMA" },
          { value: "evwma", label: "EVWMA" },
        ],
      },
      {
        key: "units", label: "Units", type: "select",
        source: "extend", field: "units", default: "pctHr",
        tip: "Slope scale. % / hour is time-normalized and comparable across timeframes; % / bar and price / bar are per bar.",
        options: [
          { value: "pctHr", label: "% / hour" },
          { value: "pctBar", label: "% / bar" },
          { value: "priceBar", label: "Price / bar" },
        ],
      },
      {
        key: "source", label: "Source", type: "select",
        source: "extend", field: "source", default: "close",
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
  return params.map((_, i) => num(i, params.length > 1 ? `Param ${i + 1}` : "Length"));
}
