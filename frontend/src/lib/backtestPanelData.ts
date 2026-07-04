import type { BacktestResult } from "../api";

export interface MetricRow {
  label: string;
  value: string;
  tone: "pos" | "neg" | "";
}

export interface TradeRow {
  i: number;
  side: string;
  leg: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  durationBars: number;
  reason: string;
}

function formatSignedMoney(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  return sign + Math.abs(value).toFixed(2);
}

function getTone(value: number | null): "pos" | "neg" | "" {
  if (value === null) return "";
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "";
}

export function metricRows(res: BacktestResult): MetricRow[] {
  const rows: MetricRow[] = [];

  // Net P&L
  rows.push({
    label: "Net P&L",
    value: formatSignedMoney(res.summary.net_pnl),
    tone: getTone(res.summary.net_pnl),
  });

  // Return %
  rows.push({
    label: "Return %",
    value: res.metrics.return_pct.toFixed(2) + "%",
    tone: getTone(res.metrics.return_pct),
  });

  // Trades
  rows.push({
    label: "Trades",
    value: String(res.summary.n_trades),
    tone: "",
  });

  // Win rate
  rows.push({
    label: "Win rate",
    value: Math.round(res.summary.win_rate * 100) + "%",
    tone: "",
  });

  // Profit factor
  rows.push({
    label: "Profit factor",
    value: res.metrics.profit_factor !== null ? res.metrics.profit_factor.toFixed(2) : "—",
    tone: res.metrics.profit_factor !== null ? getTone(res.metrics.profit_factor) : "",
  });

  // Expectancy
  rows.push({
    label: "Expectancy",
    value: res.metrics.expectancy.toFixed(2),
    tone: getTone(res.metrics.expectancy),
  });

  // Avg win
  rows.push({
    label: "Avg win",
    value: res.metrics.avg_win.toFixed(2),
    tone: getTone(res.metrics.avg_win),
  });

  // Avg loss
  rows.push({
    label: "Avg loss",
    value: res.metrics.avg_loss.toFixed(2),
    tone: getTone(res.metrics.avg_loss),
  });

  // Avg win/loss
  rows.push({
    label: "Avg win/loss",
    value: res.metrics.avg_win_loss_ratio !== null ? res.metrics.avg_win_loss_ratio.toFixed(2) : "—",
    tone: res.metrics.avg_win_loss_ratio !== null ? getTone(res.metrics.avg_win_loss_ratio) : "",
  });

  // Largest win
  rows.push({
    label: "Largest win",
    value: res.metrics.largest_win.toFixed(2),
    tone: getTone(res.metrics.largest_win),
  });

  // Largest loss
  rows.push({
    label: "Largest loss",
    value: res.metrics.largest_loss.toFixed(2),
    tone: getTone(res.metrics.largest_loss),
  });

  // Max drawdown
  rows.push({
    label: "Max drawdown",
    value: res.summary.max_drawdown.toFixed(2),
    tone: getTone(res.summary.max_drawdown),
  });

  // Max drawdown %
  rows.push({
    label: "Max drawdown %",
    value: res.metrics.max_drawdown_pct.toFixed(2) + "%",
    tone: getTone(res.metrics.max_drawdown_pct),
  });

  // Avg duration
  rows.push({
    label: "Avg duration",
    value: res.metrics.avg_duration_bars.toFixed(1) + " bars",
    tone: "",
  });

  // Max consec wins
  rows.push({
    label: "Max consec wins",
    value: String(res.metrics.max_consec_wins),
    tone: "",
  });

  // Max consec losses
  rows.push({
    label: "Max consec losses",
    value: String(res.metrics.max_consec_losses),
    tone: "",
  });

  return rows;
}

export function tradeRows(res: BacktestResult, resSeconds: number): TradeRow[] {
  return res.trades.map((trade, i) => {
    const pnlPct = trade.entry_price * trade.quantity === 0
      ? 0
      : (trade.pnl / (trade.entry_price * trade.quantity)) * 100;

    const durationBars = resSeconds === 0
      ? 0
      : (trade.exit_time - trade.entry_time) / resSeconds;

    return {
      i,
      side: trade.side,
      leg: trade.leg,
      entryTime: trade.entry_time,
      entryPrice: trade.entry_price,
      exitTime: trade.exit_time,
      exitPrice: trade.exit_price,
      pnl: trade.pnl,
      pnlPct,
      durationBars,
      reason: trade.reason,
    };
  });
}

export function sortTradeRows(
  rows: TradeRow[],
  key: keyof TradeRow,
  dir: "asc" | "desc"
): TradeRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const aVal = a[key];
    const bVal = b[key];

    // Compare the key values
    let cmp = 0;
    if (aVal < bVal) cmp = -1;
    else if (aVal > bVal) cmp = 1;

    // Apply direction
    if (dir === "desc") cmp = -cmp;

    // Tiebreak by index
    if (cmp === 0) {
      cmp = a.i < b.i ? -1 : a.i > b.i ? 1 : 0;
    }

    return cmp;
  });
  return copy;
}
