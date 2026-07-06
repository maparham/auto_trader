// Shared rule-strategy schema: the same shape the backend's OperandDTO/RuleDTO/
// RuleGroupDTO mirror, plus the seriesName contract both sides derive from so
// serialization and validation can never disagree (see the backend endpoint's
// D4 check in app.py).

export type IndicatorKind = "EMA" | "SMA" | "AVWAP" | "RSI" | "VOL" | "VOLMA";
export type PriceField = "close" | "open" | "high" | "low";
export type Operator = "crossesAbove" | "crossesBelow" | "crosses" | "gt" | "lt" | "gte" | "lte";
export type Combine = "AND" | "OR";

// `slope`, when set, turns an indicator/price operand into the tangent rate of
// change of its underlying curve, in percent per HOUR over a `len`-bar lookback:
//   (v[i] − v[i−len]) / |v[i−len]| / (len × barHours) × 100
// The run is elapsed time (len bars × the operand-timeframe's hours-per-bar), so
// the value is %/hr regardless of timeframe — a 5-min and a 15-min slope compare
// directly. It's part of the series key (seriesName) so a curve and its slope, and
// two different lookbacks, are distinct series. A sloped operand ALWAYS keys a
// series (even price, which normally has none). const/entry can't be sloped.
export interface SlopeSpec { len: number }

export type Operand =
  // `timeframe` (absent ⇒ the run's base timeframe) lets a single rule reference
  // an indicator computed on a higher timeframe than the backtest steps on — the
  // frontend fetches that timeframe, computes the indicator on it, and forward-
  // fills the values onto the base bars (no lookahead). It's part of the series
  // key (seriesName) so `EMA_9` and `EMA_9@HOUR` are distinct series.
  | { kind: "indicator"; indicator: IndicatorKind; length?: number; anchor?: number; timeframe?: string; slope?: SlopeSpec }
  | { kind: "price"; field: PriceField; slope?: SlopeSpec }
  | { kind: "const"; value: number }
  // The open position's entry (fill) price. Only meaningful in an exit rule while
  // a position is held; parameterless. Has no series (read off the position).
  | { kind: "entry" };

/** The slope lookback for an operand, or null if it isn't sloped. */
export function slopeLen(op: Operand): number | null {
  return (op.kind === "indicator" || op.kind === "price") && op.slope ? op.slope.len : null;
}

export type StopKind = "none" | "pct" | "price" | "atr" | "trailPct" | "trailAtr";
export type TargetKind = "none" | "pct" | "price" | "atr";

// value: pct percent OR absolute price. mult/length: ATR multiple + Wilder length.
export interface StopSpec { kind: StopKind; value?: number; mult?: number; length?: number }
export interface TargetSpec { kind: TargetKind; value?: number; mult?: number; length?: number }

// Price-level exits for one side. Coexists with that side's rule-exit group;
// whichever triggers first closes the position. Optional on BacktestConfig so
// presets saved before this existed load as "no stop / no target".
export interface RiskConfig { stop: StopSpec; target: TargetSpec }

export type SpacingKind = "pct" | "atr";
export interface SpacingSpec { kind: SpacingKind; value?: number; mult?: number; length?: number }
export interface ScalingConfig { maxConcurrent: number; spacing?: SpacingSpec }

export interface Rule {
  left: Operand;
  op: Operator;
  right: Operand;
  // A disabled rule is kept (editable) but excluded from the run — like a parked
  // side, but per rule. Absent ⇒ enabled (backward-safe for old presets).
  enabled?: boolean;
  // "Nth time" modifier: fire on the Nth bar since entry the base comparison is
  // true (cumulative). Exit-only; absent/≤1 ⇒ fire on first occurrence.
  count?: number;
}

export interface RuleGroup {
  combine: Combine;
  rules: Rule[];
}

/** A fresh, independent copy of a rule — used to duplicate a rule within a group
 * or paste one copied from another side. Operands are flat value objects, so a
 * shallow spread of each is a full deep copy; sharing them instead would let an
 * edit to the original mutate the duplicate (and vice versa). */
export function cloneRule(rule: Rule): Rule {
  return { left: cloneOperand(rule.left), op: rule.op, right: cloneOperand(rule.right), enabled: rule.enabled, count: rule.count };
}

/** Deep copy of an operand. Operands are otherwise flat value objects, but a
 * sloped operand nests a `slope` object, so a bare spread would share it. */
function cloneOperand(op: Operand): Operand {
  const copy = { ...op };
  if ((copy.kind === "indicator" || copy.kind === "price") && copy.slope) copy.slope = { ...copy.slope };
  return copy;
}

/** A rule group with its disabled rules dropped — what actually gets sent to the
 * engine. An all-disabled group becomes empty (that side simply never triggers,
 * same as no rules). */
export function activeGroup(group: RuleGroup): RuleGroup {
  return { combine: group.combine, rules: group.rules.filter((r) => r.enabled !== false) };
}

export type RangeMode = "bars" | "lastDay" | "lastWeek" | "lastMonth" | "lastYear" | "custom";

export type SessionPreset = "NYSE" | "London" | "Frankfurt" | "Tokyo" | "Sydney" | "Crypto";

/** A clock window, minutes from midnight in the mask's tz. Half-open [start,end); wraps when end<start. */
export interface DayTimeWindow { startMin: number; endMin: number }

/** Phone-alarm-style activity mask. A bar is active iff it passes EVERY enabled
 * filter. `session`, when set, is a UI convenience that resolveMask() inlines
 * into timeOfDay+tz before the predicate runs and before POST — the backend
 * never sees `session`. Absent/`enabled:false` ⇒ every bar active. */
export interface RecurrenceMask {
  enabled: boolean;
  daysOfWeek?: number[];    // JS getDay 0=Sun..6=Sat; absent/empty = all
  monthsOfYear?: number[];  // 1=Jan..12=Dec; absent/empty = all
  daysOfMonth?: number[];   // 1..31; absent/empty = all
  timeOfDay?: DayTimeWindow;
  session?: SessionPreset;
  tz?: string;              // IANA; default "UTC"
  // Force-flat open positions at each session close. Default off: entries stay
  // gated to windows but an open position runs across boundaries to its
  // stop/target/range end. Only meaningful when `enabled`.
  flattenAtClose?: boolean;
}
// How far back to load candles before the trading window so indicators are
// already warm at the window's first bar (D6 in the plan) — "full" = all
// available history (default), "bars" = a user-typed count, "minimal" = just
// enough for the longest indicator in the config.
export type HistoryDepth = "full" | "bars" | "minimal";

export interface RangeConfig {
  mode: RangeMode;
  bars?: number;
  fromMs?: number;
  toMs?: number;
  history?: HistoryDepth;
  historyBars?: number;
  mask?: RecurrenceMask;
  // The timeframe the backtest runs on. Absent means "follow the active chart
  // timeframe" (the historical behavior) — a concrete resolution string (e.g.
  // "HOUR") overrides the chart and runs the backtest on that timeframe instead.
  resolution?: string;
}

export interface Costs {
  quantity: number;
  commissionPerSide: number;
  slippage: number;
  startingCash: number;
}

export interface BacktestConfig {
  range: RangeConfig;
  longEntry: RuleGroup;
  longExit: RuleGroup;
  shortEntry: RuleGroup;
  shortExit: RuleGroup;
  // Per-side master switches. A disabled side never trades even if its rule
  // groups are populated (the user keeps the rules while the side is parked).
  // Optional on purpose: a preset saved before these existed loads with the
  // field absent, so the undefined case is real — every read guards with
  // `!== false` so an absent flag trades rather than silently parking the side.
  longEnabled?: boolean;
  shortEnabled?: boolean;
  longRisk?: RiskConfig;
  shortRisk?: RiskConfig;
  longScaling?: ScalingConfig;
  shortScaling?: ScalingConfig;
  costs: Costs;
}

/** The payload key an operand's series lives under, or null if it has no
 * series (price/const are read straight off the candle). AVWAP is keyed by its
 * anchor (epoch-ms) so distinct anchors are distinct series; VOL has no length;
 * EMA/SMA/RSI/VOLMA are keyed by `${indicator}_${length}`. */
export function seriesName(op: Operand): string | null {
  let base: string;
  if (op.kind === "indicator") {
    if (op.indicator === "VOL") base = "VOL";
    else if (op.indicator === "AVWAP") base = `AVWAP_${op.anchor ?? 0}`;
    else base = `${op.indicator}_${op.length}`;
  } else if (op.kind === "price" && op.slope) {
    // A plain price has no series (read off the candle); a SLOPED price does — its
    // slope needs v[i−N] so it can't come from a single bar. Keyed by the field.
    base = op.field;
  } else {
    return null;
  }
  // A slope suffix (`~len`) comes BEFORE the timeframe suffix (`@tf`); the backend
  // derives this key identically (rule.py:series_name) — keep the two in lockstep,
  // ordering included, or the endpoint's D4 key check fails.
  const sl = slopeLen(op);
  if (sl !== null) base = `${base}~${sl}`;
  // A per-operand timeframe qualifies the key so a base-timeframe indicator and
  // the same indicator on a higher timeframe are stored/looked-up separately.
  // Absent ⇒ base timeframe ⇒ the bare key (byte-for-byte compatible with older
  // presets and with same-timeframe operands).
  const tf = op.kind === "indicator" ? op.timeframe : undefined;
  return tf ? `${base}@${tf}` : base;
}

/** Every indicator operand referenced by any of the four rule groups, deduped by
 * series name, so the caller computes each series once regardless of how many
 * rules use it. */
export function collectSeriesOperands(cfg: BacktestConfig): Operand[] {
  const seen = new Map<string, Operand>();
  for (const group of [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit]) {
    for (const rule of group.rules) {
      for (const op of [rule.left, rule.right]) {
        const name = seriesName(op);
        if (name !== null && !seen.has(name)) seen.set(name, op);
      }
    }
  }
  return [...seen.values()];
}

const ATR_KINDS = new Set(["atr", "trailAtr"]);

/** Every distinct ATR length referenced by either side's stop or target, so the
 * caller computes each `ATR_{n}` series once. Non-ATR kinds contribute nothing. */
export function riskAtrLengths(cfg: BacktestConfig): number[] {
  const lengths = new Set<number>();
  for (const risk of [cfg.longRisk, cfg.shortRisk]) {
    if (!risk) continue;
    for (const spec of [risk.stop, risk.target]) {
      if (ATR_KINDS.has(spec.kind) && spec.length != null) lengths.add(spec.length);
    }
  }
  return [...lengths];
}

/** Every distinct ATR length referenced by either side's spacing spec, so the
 * caller computes each `ATR_{n}` series once. Non-ATR kinds contribute nothing. */
export function scalingAtrLengths(cfg: BacktestConfig): number[] {
  const out = new Set<number>();
  for (const sc of [cfg.longScaling, cfg.shortScaling]) {
    if (sc?.spacing?.kind === "atr" && sc.spacing.length != null) out.add(sc.spacing.length);
  }
  return [...out];
}

/** The longest indicator length referenced anywhere in the config — the number
 * of bars of warm-up the slowest indicator needs before it produces a value. */
export function longestIndicatorLength(cfg: BacktestConfig): number {
  return Math.max(
    1,
    // A sloped operand needs `len` extra bars beyond its base indicator's length
    // before it has a value (it reads v[i] and v[i−len]).
    ...collectSeriesOperands(cfg).map(
      (op) => (op.kind === "indicator" ? op.length ?? 1 : 1) + (slopeLen(op) ?? 0),
    ),
    ...riskAtrLengths(cfg),
    ...scalingAtrLengths(cfg),
  );
}

export function defaultBacktestConfig(): BacktestConfig {
  const cross = (op: Operator): RuleGroup => ({
    combine: "AND",
    rules: [
      {
        left: { kind: "indicator", indicator: "EMA", length: 9 },
        op,
        right: { kind: "indicator", indicator: "EMA", length: 21 },
      },
    ],
  });
  return {
    range: { mode: "bars", bars: 500, history: "full" },
    longEntry: cross("crossesAbove"),
    longExit: cross("crossesBelow"),
    shortEntry: cross("crossesBelow"),
    shortExit: cross("crossesAbove"),
    longEnabled: true,
    shortEnabled: true,
    costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
  };
}
