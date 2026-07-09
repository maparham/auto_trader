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
}

interface EquityPoint {
  time: number;
  value: number;
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
  };
  // True when a coded strategy's own ctx.stop/target calls overrode the panel's
  // longRisk/shortRisk bracket for this run (Strategy tab transparency).
  fileBracketsOverridden?: boolean;
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
    return_pct: number;
  } | null;
  error: string | null;
}

export async function runSweepChunk(
  req: BacktestRequest,
  combos: Array<Record<string, number | boolean | string>>,
): Promise<SweepRow[]> {
  const res = await fetch(`${BASE}/api/backtest/sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, sweep: { combos } }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `sweep failed (${res.status})`));
  const json = await res.json();
  return json.rows as SweepRow[];
}
