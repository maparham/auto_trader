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

interface Marker {
  time: number;
  side: "buy" | "sell";
  price: number;
  reason: string;
  leg: "long" | "short";
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
}

export async function runBacktest(req: BacktestRequest): Promise<BacktestResult> {
  const res = await fetch(`${BASE}/api/backtest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `request failed (${res.status})`));
  return res.json();
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
