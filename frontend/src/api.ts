// Typed client for the Auto Trader backend.

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export interface Candle {
  time: number; // unix seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Marker {
  time: number;
  side: "buy" | "sell";
  price: number;
  reason: string;
}

export interface Trade {
  side: string;
  quantity: number;
  entry_time: number;
  entry_price: number;
  exit_time: number;
  exit_price: number;
  pnl: number;
}

export interface EquityPoint {
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

export interface BacktestParams {
  epic: string;
  resolution: string;
  bars: number;
  fast: number;
  slow: number;
}

export async function runBacktest(p: BacktestParams): Promise<BacktestResult> {
  const qs = new URLSearchParams({
    epic: p.epic,
    resolution: p.resolution,
    bars: String(p.bars),
    fast: String(p.fast),
    slow: String(p.slow),
  });
  const res = await fetch(`${BASE}/api/backtest?${qs}`);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail ?? `request failed (${res.status})`);
  }
  return res.json();
}
