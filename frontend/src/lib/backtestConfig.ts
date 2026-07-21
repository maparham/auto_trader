// Shared rule-strategy schema: the transport shape coded/expression rows travel
// in (RuleGroup/BacktestConfig), plus the risk/scaling ATR-length helpers the
// series builder and warm-up math consume. Rules author as CodeMirror
// expressions (`Rule.expr`); the structured operand model is gone.

export type Combine = "AND" | "OR";

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
  // The CodeMirror rule expression — the whole rule. (The former structured
  // left/op/right operand model has been removed.)
  expr?: string;
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
 * or paste one copied from another side. Expression rows are flat value objects,
 * so a shallow spread is a full copy. */
export function cloneRule(rule: Rule): Rule {
  return { expr: rule.expr, enabled: rule.enabled, count: rule.count };
}

/** A rule group with its disabled rules dropped — what actually gets sent to the
 * engine. An all-disabled group becomes empty (that side simply never triggers,
 * same as no rules).
 *
 * `count` is normalized to match the UI's own semantics (undefined / 1 both read
 * as "fire on the first occurrence"): the backend requires `count >= 1`, so a
 * stale `count: 0` — which the CountField displays as blank "1st" but never
 * rewrites — must be omitted rather than sent, or the whole request 422s. */
export function activeGroup(group: RuleGroup): RuleGroup {
  return {
    combine: group.combine,
    rules: group.rules
      .filter((r) => r.enabled !== false)
      .map((r) => (r.count != null && r.count >= 1 ? r : { ...r, count: undefined })),
  };
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
// already warm at the window's first bar (D6 in the plan) — "minimal" = just
// enough for the longest indicator in the config (default), "bars" = a
// user-typed count, "full" = all available history.
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

// Per-fill slippage model. `kind: "fixed"` charges `value` price units on every
// fill; `kind: "atr"` charges `value + atrMult * ATR(14)` of the fill bar, so
// fast markets cost more. The backend rejects a bare numeric slippage (422); the
// loader coerces a legacy stored number into the fixed model (normalizeBacktestConfig).
export type SlippageModel = { kind: "fixed" | "atr"; value: number; atrMult: number };

export interface Costs {
  quantity: number;
  commissionPerSide: number;
  slippage: SlippageModel;
  // Full bid/ask spread in price units (buys fill half a spread above the mid,
  // sells half below). Instrument-level, broker-prefilled via the cost profile.
  spread: number;
  // Financing charged per night a position is held, as a percent of entry
  // notional. Negative is a credit. Long/short differ.
  finLongDailyPct: number;
  finShortDailyPct: number;
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
  // "Same for long & short" SL/TP sync — absent means ON (read via
  // riskSync.ts's riskSyncOn, same `!== false` convention as the switches
  // above). Frontend-only: BacktestRequest never carries it.
  riskSynced?: boolean;
  longScaling?: ScalingConfig;
  shortScaling?: ScalingConfig;
  costs: Costs;
  // Strategy source: point-and-click rules (default) or a coded backend/strategies
  // .py file. `codedStrategy` is that file's name; only read when mode === "coded".
  mode?: "rules" | "coded";
  codedStrategy?: string;
  // Sub-window robustness override for sweeps: split the range into this many
  // equal windows when scoring consistency. Undefined = auto (from range length).
  robustWindows?: number;
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

/** The longest ATR length referenced anywhere in the config — the number of bars
 * of warm-up the slowest ATR risk/scaling series needs before it produces a
 * value. Expression rows contribute their warm-up separately (backtestWindow's
 * exprWarmupBars). */
export function longestIndicatorLength(cfg: BacktestConfig): number {
  return Math.max(1, ...riskAtrLengths(cfg), ...scalingAtrLengths(cfg));
}

export function defaultBacktestConfig(): BacktestConfig {
  // The main backtest groups edit as expressions, so each default rule seeds an
  // `{ expr, enabled }` row the CodeMirror editor shows.
  const cross = (fn: "crossAbove" | "crossBelow"): RuleGroup => ({
    combine: "AND",
    rules: [{ expr: `${fn}(EMA(9), EMA(21))`, enabled: true }],
  });
  return {
    range: { mode: "bars", bars: 500, history: "minimal" },
    longEntry: cross("crossAbove"),
    longExit: cross("crossBelow"),
    shortEntry: cross("crossBelow"),
    shortExit: cross("crossAbove"),
    longEnabled: true,
    shortEnabled: true,
    costs: {
      quantity: 1,
      commissionPerSide: 0,
      slippage: { kind: "fixed", value: 0, atrMult: 0 },
      spread: 0,
      finLongDailyPct: 0,
      finShortDailyPct: 0,
      startingCash: 10_000,
    },
  };
}

/** Fold a stored config forward to the current shape. The ONE permitted legacy
 * coercion (spec-mandated): a previously persisted NUMERIC `slippage` becomes the
 * fixed model `{ kind: "fixed", value: n, atrMult: 0 }`, so older panels don't
 * break. Missing new cost fields (spread, financing) fill from the defaults.
 * Everything else is passed through untouched. */
export function normalizeBacktestConfig(cfg: BacktestConfig): BacktestConfig {
  const d = defaultBacktestConfig().costs;
  const c = (cfg.costs ?? d) as Partial<Costs> & { slippage?: number | SlippageModel };
  const slippage: SlippageModel =
    typeof c.slippage === "number"
      ? { kind: "fixed", value: c.slippage, atrMult: 0 }
      : c.slippage ?? d.slippage;
  return {
    ...cfg,
    costs: {
      quantity: c.quantity ?? d.quantity,
      commissionPerSide: c.commissionPerSide ?? d.commissionPerSide,
      slippage,
      spread: c.spread ?? d.spread,
      finLongDailyPct: c.finLongDailyPct ?? d.finLongDailyPct,
      finShortDailyPct: c.finShortDailyPct ?? d.finShortDailyPct,
      startingCash: c.startingCash ?? d.startingCash,
    },
  };
}
