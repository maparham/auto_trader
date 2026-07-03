// Typed client for the Auto Trader backend.

import type { RuleGroup, Costs } from "./lib/backtestConfig";
import { API_BASE as BASE, errorDetail } from "./lib/http";

interface Candle {
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
  costs: Costs;
  tradeFromTime: number; // unix seconds — the window's start (D6)
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
