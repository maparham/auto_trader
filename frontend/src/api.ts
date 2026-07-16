// Typed client for the Auto Trader backend.

import type { RuleGroup, Costs, RiskConfig, ScalingConfig, RecurrenceMask } from "./lib/backtestConfig";
import { API_BASE as BASE, errorDetail } from "./lib/http";
import type { EvaluateRequest, EvaluateResult } from "./lib/liveTypes";

export interface Candle {
  time: number; // unix seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// One passing rule's comparison at the signal bar (mirrors the backend TermDTO).
// `left`/`right` are human labels WITHOUT the timeframe; `leftTf`/`rightTf` are the
// operand's effective Resolution string (null for a timeframe-less operand), which
// the popover prettifies to `@15m`.
export interface Term {
  left: string;
  lval: number | null;
  op: string;
  right: string;
  rval: number | null;
  leftTf: string | null;
  rightTf: string | null;
}

// --- bar inspector (session-only per-bar trace; see BacktestInspectorPanel) ---

// One rule's comparison at an inspected bar. Like Term but for EVERY rule (not
// just passing ones), so `passed` carries the raw result — failing terms show too.
export interface InspectorTerm {
  left: string;
  lval: number | null;
  op: string;
  right: string;
  rval: number | null;
  leftTf: string | null;
  rightTf: string | null;
  passed: boolean;
}

export interface BarGroupTrace {
  group: "longEntry" | "shortEntry" | "longExit" | "shortExit";
  combine: string;
  terms: InspectorTerm[];
  passed: boolean;
}

// The engine's per-bar snapshot: all four rule groups + the outcome and gate
// flags. `action` is opened/suppressed/none; `reason` explains a suppression.
export interface BarTrace {
  time: number; // bar open time, unix seconds
  groups: BarGroupTrace[];
  action: "opened" | "suppressed" | "none";
  reason: string | null;
  inPositionLong: boolean;
  inPositionShort: boolean;
  windowActive: boolean;
  warmedUp: boolean;
  spacingOk: boolean | null;
}

export interface Marker {
  time: number;
  side: "buy" | "sell";
  price: number;
  reason: string;
  leg: "long" | "short";
  // Signal-candle provenance (rule-based fills only). `signal_time` is the bar the
  // signal fired on (unix seconds); `terms` the passing rules' captured values.
  // Absent/empty for a mechanical stop/target/session/range-end fill.
  signal_time?: number | null;
  terms?: Term[];
  combine?: string | null; // firing group's "AND"/"OR" (how to read the passing-only terms)
}

interface Trade {
  side: string;
  quantity: number;
  entry_time: number;
  entry_price: number;
  exit_time: number;
  exit_price: number;
  pnl: number;
  leg: "long" | "short";
  reason: string;
  stop_initial: number | null;
  stop_final: number | null;
  target: number | null;
  // Canonical sub-bar exit time (epoch seconds) for an intra-bar stop/target,
  // resolved server-side. Null/absent -> use exit_time. Display only.
  exit_time_exact?: number | null;
  mae: number;
  mfe: number;
  mae_r: number | null;
  mfe_r: number | null;
  context: Record<string, string | number | null> | null;
  whatif?: Record<string, unknown> | null;
}

export interface EquityPoint {
  time: number;
  value: number;
}

// Trade-list metrics for one direction (long or short). Mirrors the backend's
// leg_metrics() dict; powers the LONG/SHORT rows of the TRADES panel table.
export interface LegMetrics {
  n_trades: number;
  win_rate: number;
  net_pnl: number;
  profit_factor: number | null;
  avg_win: number;
  avg_loss: number;
  avg_win_loss_ratio: number | null;
  largest_win: number;
  largest_loss: number;
  max_consec_losses: number;
  expectancy: number;
  max_consec_wins: number;
  avg_duration_bars: number;
}

export interface AnalysisHist {
  edges: number[];
  counts: number[];
}

export interface AnalysisRow {
  bucket: string;
  n: number;
  win_rate: number;
  expectancy: number;
  net_pnl: number;
  low_sample: boolean;
}

export interface WhatifRuleExitRow {
  reason: string;
  n: number;
  would_have_won: number;
  would_have_lost: number;
  undecided: number;
  net_delta_r: number;
}

export interface BacktestWhatif {
  rule_exit: {
    by_reason: WhatifRuleExitRow[];
    totals: Omit<WhatifRuleExitRow, "reason">;
  } | null;
  no_target: {
    n: number;
    would_have_stopped: number;
    survived: number;
    net_saved_r: number;
  } | null;
  stop_curve:
    | { frac: number; winners_killed: number; losers_cheapened: number; net_delta_r: number }[]
    | null;
  target_curve: { target_r: number; n_reached: number; pct_reached: number }[] | null;
  fill_delay: { n: number; avg_r: number; total_r: number } | null;
  limit_entry: {
    n: number;
    fill_rate: number;
    filled_net_delta_r: number;
    undecided: number;
    unfilled_foregone_r: number;
    unfilled_winners: number;
    net_verdict_r: number;
  } | null;
  breakeven_curve:
    | {
        frac: number;
        n_armed: number;
        n_fired: number;
        losers_rescued: number;
        winners_cut: number;
        net_delta_r: number;
      }[]
    | null;
}

export interface BarDynamicsMetrics {
  bars_held: number | null;
  bars_in_profit: number | null;
  bars_in_loss: number | null;
  body_through: number | null;
  wick_from_profit: number | null;
  wick_from_loss: number | null;
  longest_profit_streak: number | null;
  longest_loss_streak: number | null;
  bars_to_mfe: number | null;
  bars_to_mae: number | null;
  entry_crossings: number | null;
}

export interface LegAnalysis {
  n_trades: number;
  sl: {
    winners_mae_hist: AnalysisHist;
    losers_mae_hist: AnalysisHist;
    winners_near_stop_pct: number | null;
    n_with_r: number;
  };
  tp: {
    avg_winner_mfe_r: number | null;
    avg_winner_realized_r: number | null;
    median_left_on_table_r: number | null;
    pct_nontarget_exits_reached_target: number | null;
  };
  exit_reasons: AnalysisRow[];
  r_hist: AnalysisHist;
  context: Record<string, AnalysisRow[]>;
  hour_stats?: { hour: number; n: number; wins: number; sum_pnl: number }[];
  month_stats?: AnalysisRow[];
  bar_dynamics?: {
    n_winners: number;
    n_losers: number;
    n_total: number;
    winners: BarDynamicsMetrics;
    losers: BarDynamicsMetrics;
    total: BarDynamicsMetrics;
  };
  // Winner/loser trade counts bucketed by hold duration. bar_width is the bars
  // per bucket; bucket i spans held-bar counts [i*bar_width, (i+1)*bar_width).
  // Null for runs without bar stats.
  duration_hist?: {
    bar_width: number;
    winners: number[];
    losers: number[];
  } | null;
  whatif?: BacktestWhatif;
}

export interface BacktestAnalysis extends LegAnalysis {
  by_leg?: { long: LegAnalysis; short: LegAnalysis };
  // Rolling per-trade expectancy over an adaptive window, ordered by entry
  // time. Null when the run has too few trades to be meaningful.
  rolling?: { window: number; points: { t: number; expectancy: number }[] } | null;
}

export interface BacktestResult {
  epic: string;
  resolution: string;
  candles: Candle[];
  markers: Marker[];
  trades: Trade[];
  equity: EquityPoint[];
  summary: {
    net_pnl: number;
    n_trades: number;
    win_rate: number;
    max_drawdown: number;
  };
  metrics: {
    return_pct: number;
    profit_factor: number | null;
    expectancy: number;
    avg_win: number;
    avg_loss: number;
    avg_win_loss_ratio: number | null;
    largest_win: number;
    largest_loss: number;
    max_drawdown_pct: number;
    avg_duration_bars: number;
    max_consec_wins: number;
    max_consec_losses: number;
    sharpe?: number | null;
    sortino?: number | null;
    calmar?: number | null;
    cagr_pct?: number | null;
    sqn?: number | null;
    exposure_pct?: number | null;
  };
  // Per-direction trade-list breakdown for the TRADES panel table. Absent on
  // older cached payloads; the table zeroes the LONG/SHORT rows when missing.
  by_leg?: { long: LegMetrics; short: LegMetrics };
  // True when a coded strategy's own ctx.stop/target calls overrode the panel's
  // longRisk/shortRisk bracket for this run (Strategy tab transparency).
  fileBracketsOverridden?: boolean;
  // Per-bar inspector trace — present only when the request set `inspect` and the
  // strategy is rule-based. Session-only: held in memory, never persisted.
  bar_traces?: BarTrace[] | null;
  // Strategy-analysis payload (SL/TP efficiency, exit reasons, R distribution,
  // context breakdowns), all computed server-side. Absent on older cached runs.
  run_id?: string | null;
  analysis?: BacktestAnalysis | null;
  // Cost-sensitivity summary (single runs that opted in). net_pnl is the run's
  // net P&L at each cost multiple; breakeven_multiple is the interpolated
  // multiple where net crosses zero (null when still profitable at 3x).
  cost_sensitivity?: {
    multiples: number[];
    net_pnl: number[];
    breakeven_multiple: number | null;
  } | null;
}

export interface BacktestRequest {
  epic: string;
  resolution: string;
  candles: Candle[];
  series: Record<string, Array<number | null>>;
  longEntry: RuleGroup;
  longExit: RuleGroup;
  shortEntry: RuleGroup;
  shortExit: RuleGroup;
  longEnabled: boolean; // per-side master switch (a disabled side never trades)
  shortEnabled: boolean;
  longRisk?: RiskConfig; // optional price-level exits (stop/target/trailing)
  shortRisk?: RiskConfig;
  longScaling?: ScalingConfig;
  shortScaling?: ScalingConfig;
  costs: Costs;
  tradeFromTime: number; // unix seconds — the window's start (D6)
  mask?: RecurrenceMask; // recurrence/activity mask (resolved: no `session` field)
  codedStrategy?: string; // coded strategy filename — when set, rule groups are ignored (Strategy tab)
  // Broker/price side for backend-side HTF fetches (coded strategies' tf= calls).
  broker?: string;
  priceSide?: string;
  codedParams?: ParamValues; // panel-tuned ctx.param() overrides for `codedStrategy`
  inspect?: boolean; // opt into the per-bar inspector trace (bar_traces on the result)
  costSensitivity?: boolean; // opt into the 0x/2x/3x cost re-runs (cost_sensitivity on the result)
}

export async function runBacktest(req: BacktestRequest): Promise<BacktestResult> {
  // Temporary phase timing (perf investigation): split serialize / backend / parse.
  const t0 = performance.now();
  const body = JSON.stringify(req);
  const t1 = performance.now();
  const res = await fetch(`${BASE}/api/backtest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const t2 = performance.now();
  if (!res.ok) throw new Error(await errorDetail(res, `request failed (${res.status})`));
  const json = await res.json();
  const t3 = performance.now();
  console.info(
    `[backtest perf] request: serialize ${(t1 - t0).toFixed(0)}ms (${(body.length / 1048576).toFixed(2)} MB), ` +
      `backend+network ${(t2 - t1).toFixed(0)}ms, parse ${(t3 - t2).toFixed(0)}ms`,
  );
  return json;
}

export async function evaluateStrategy(req: EvaluateRequest): Promise<EvaluateResult> {
  const res = await fetch(`${BASE}/api/strategy/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `evaluate failed (${res.status})`));
  return res.json();
}

// --- coded strategies (backend/strategies/*.py) ------------------------------

// A coded strategy's ctx.param()-declared tunable, as exposed by the panel
// (mirrors the backend ParamSpecDTO). min/max/step/options/help are null when
// not applicable to the param's type.
export interface ParamSpec {
  name: string;
  label: string;
  type: "int" | "float" | "bool" | "choice";
  default: number | boolean | string;
  min: number | null;
  max: number | null;
  step: number | null;
  options: string[] | null;
  help: string | null;
}

export type ParamValues = Record<string, number | boolean | string>;

export interface StrategyInfo {
  filename: string;
  name: string;
  description: string;
  hedged: boolean;
  error: string | null;
  params: ParamSpec[];
}

export async function fetchStrategies(): Promise<StrategyInfo[]> {
  const res = await fetch(`${BASE}/api/strategies`);
  if (!res.ok) throw new Error(await errorDetail(res, `strategies failed (${res.status})`));
  return res.json();
}

export async function fetchStrategySource(filename: string): Promise<string> {
  const res = await fetch(`${BASE}/api/strategies/${encodeURIComponent(filename)}/source`);
  if (!res.ok) throw new Error(await errorDetail(res, `source failed (${res.status})`));
  const body = await res.json();
  return body.source;
}

// --- param sweeps -------------------------------------------------------------

export interface SweepRow {
  combo: Record<string, number | boolean | string>;
  metrics: {
    net_pnl: number;
    n_trades: number;
    win_rate: number;
    max_drawdown: number;
    profit_factor: number | null;
    avg_win_loss_ratio: number | null;
    return_pct: number;
    sharpe?: number | null;
    sqn?: number | null;
    // Injected client-side by withPlateau (lib/sweepPlateau.ts); never sent by
    // the backend. Null when the sweep has no numeric range axes.
    plateau_score?: number | null;
    // Sub-window robustness aggregates: present only when the sweep ran with
    // windows and the combo does not patch its own period.
    worst_window_pnl?: number;
    median_window_pnl?: number;
    pct_windows_profitable?: number;
    mean_window_pnl_minus_std?: number;
  } | null;
  // Per-window slice of this combo's run (entry-time attribution); null when
  // windows were not requested or the combo patches its own period.
  windows: { from: number; to: number; pnl: number; trades: number }[] | null;
  error: string | null;
}

export async function runSweepChunk(
  req: BacktestRequest,
  combos: Array<Record<string, number | boolean | string>>,
  // Position of this chunk in the whole sweep, for the backend log only
  // (advisory: the backend never validates or acts on them).
  progress?: { done: number; total: number },
  // Sub-window robustness bounds (epoch seconds, ascending); identical for
  // every chunk of one sweep so all rows slice the same windows.
  windows?: number[],
): Promise<SweepRow[]> {
  const res = await fetch(`${BASE}/api/backtest/sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, sweep: { combos, windows, ...progress } }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `sweep failed (${res.status})`));
  const json = await res.json();
  return json.rows as SweepRow[];
}
