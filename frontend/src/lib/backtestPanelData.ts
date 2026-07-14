import type { BacktestResult, LegMetrics } from "../api";

export interface MetricRow {
  label: string;
  value: string;
  tone: "pos" | "neg" | "";
}

export interface MetricGroup {
  title: string;
  rows: MetricRow[];
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

  // Profit factor — magnitude-only (always ≥0); >1 is good but sign vs 0 tells
  // nothing, so leave it uncoloured rather than always-green.
  rows.push({
    label: "Profit factor",
    value: res.metrics.profit_factor !== null ? res.metrics.profit_factor.toFixed(2) : "—",
    tone: "",
  });

  // Expectancy
  rows.push({
    label: "Expectancy",
    value: res.metrics.expectancy.toFixed(2),
    tone: getTone(res.metrics.expectancy),
  });

  // Per-trade magnitudes below are sign-fixed (a win is always ≥0, a loss ≤0),
  // so colouring them by sign is decoration, not information — leave them plain
  // and reserve tone for the metrics whose sign is a verdict (P&L, return,
  // expectancy). Drawdown especially must not read green just for being stored
  // positive — a drawdown is never good news.

  // Avg win
  rows.push({
    label: "Avg win",
    value: res.metrics.avg_win.toFixed(2),
    tone: "",
  });

  // Avg loss
  rows.push({
    label: "Avg loss",
    value: res.metrics.avg_loss.toFixed(2),
    tone: "",
  });

  // Avg win/loss
  rows.push({
    label: "Avg win/loss",
    value: res.metrics.avg_win_loss_ratio !== null ? res.metrics.avg_win_loss_ratio.toFixed(2) : "—",
    tone: "",
  });

  // Largest win
  rows.push({
    label: "Largest win",
    value: res.metrics.largest_win.toFixed(2),
    tone: "",
  });

  // Largest loss
  rows.push({
    label: "Largest loss",
    value: res.metrics.largest_loss.toFixed(2),
    tone: "",
  });

  // Drawdown — the run's max peak-to-trough equity drop (the tooltip spells this
  // out; the shorter label keeps the stat grid tidy).
  rows.push({
    label: "Drawdown",
    value: res.summary.max_drawdown.toFixed(2),
    tone: "",
  });

  // Drawdown %
  rows.push({
    label: "Drawdown %",
    value: res.metrics.max_drawdown_pct.toFixed(2) + "%",
    tone: "",
  });

  // Avg duration
  rows.push({
    label: "Avg duration",
    value: res.metrics.avg_duration_bars.toFixed(1) + " bars",
    tone: "",
  });

  // Win streak — the longest run of consecutive winning trades.
  rows.push({
    label: "Win streak",
    value: String(res.metrics.max_consec_wins),
    tone: "",
  });

  // Loss streak — the longest run of consecutive losing trades.
  rows.push({
    label: "Loss streak",
    value: String(res.metrics.max_consec_losses),
    tone: "",
  });

  return rows;
}

// The same metrics as metricRows(), arranged into the three questions a reader
// actually asks of a backtest — did it make money (Performance), how did the
// individual trades behave (Trades), and what would it have put you through
// (Risk & extremes). Grouping is the hierarchy the flat grid was missing; order
// within each group leads with the metric you'd read first.
const METRIC_GROUPS: { title: string; labels: string[] }[] = [
  { title: "Performance", labels: ["Net P&L", "Return %", "Profit factor", "Expectancy"] },
  { title: "Trades", labels: ["Trades", "Win rate", "Avg win", "Avg loss", "Avg win/loss", "Avg duration"] },
  { title: "Risk & extremes", labels: ["Drawdown", "Drawdown %", "Largest win", "Largest loss", "Win streak", "Loss streak"] },
];

// One brief line per metric — plain language, keyed by the metric's label.
// Kept as static copy (not derived) so the tooltip text lives beside the group
// definitions, away from the value/tone computation.
export const METRIC_INFO: Record<string, string> = {
  "Net P&L": "Total profit after costs, across all trades.",
  "Return %": "Net profit as a % of starting capital.",
  "Profit factor": "Gross profit divided by gross loss; above 1 is profitable.",
  "Expectancy": "Average profit or loss per trade.",
  "Trades": "Number of closed trades.",
  "Win rate": "Share of trades that closed in profit.",
  "Avg win": "Average size of a winning trade.",
  "Avg loss": "Average size of a losing trade.",
  "Avg win/loss": "Average win divided by average loss.",
  "Avg duration": "Average time a trade stayed open.",
  "Drawdown": "Largest equity drop from a high to a low.",
  "Drawdown %": "That drop as a % of the equity high.",
  "Largest win": "Biggest single winning trade.",
  "Largest loss": "Biggest single losing trade.",
  "Win streak": "Longest run of wins in a row.",
  "Loss streak": "Longest run of losses in a row.",
};

export function metricGroups(res: BacktestResult): MetricGroup[] {
  const byLabel = new Map(metricRows(res).map((r) => [r.label, r]));
  return METRIC_GROUPS.map((g) => ({
    title: g.title,
    rows: g.labels.map((label) => byLabel.get(label)).filter((r): r is MetricRow => r != null),
  }));
}

// --- Long/Short breakdown table --------------------------------------------

export interface LegCell {
  value: string;
  tone: "pos" | "neg" | "";
}

export interface LegColumn {
  label: string;
  info: string;
}

export interface LegTableRow {
  leg: string; // "ALL" | "LONG" | "SHORT"
  cells: LegCell[]; // aligned to columns by index
}

export interface LegTable {
  columns: LegColumn[];
  rows: LegTableRow[];
}

const ZERO_LEG: LegMetrics = {
  n_trades: 0, win_rate: 0, net_pnl: 0, expectancy: 0, profit_factor: null,
  avg_win: 0, avg_loss: 0, avg_win_loss_ratio: null,
  largest_win: 0, largest_loss: 0, max_consec_losses: 0, max_consec_wins: 0,
  avg_duration_bars: 0,
};

// The ALL row reuses the run-wide summary/metrics the panel already receives,
// reshaped into a LegMetrics so all three rows go through the identical
// formatters below.
function allLeg(res: BacktestResult): LegMetrics {
  return {
    n_trades: res.summary.n_trades,
    win_rate: res.summary.win_rate,
    net_pnl: res.summary.net_pnl,
    expectancy: res.metrics.expectancy,
    profit_factor: res.metrics.profit_factor,
    avg_win: res.metrics.avg_win,
    avg_loss: res.metrics.avg_loss,
    avg_win_loss_ratio: res.metrics.avg_win_loss_ratio,
    largest_win: res.metrics.largest_win,
    largest_loss: res.metrics.largest_loss,
    max_consec_losses: res.metrics.max_consec_losses,
    max_consec_wins: res.metrics.max_consec_wins,
    avg_duration_bars: res.metrics.avg_duration_bars,
  };
}

// One column per metric: label, tooltip, and how to render a LegMetrics into a
// cell. Only Net P&L carries sign tone — the per-trade magnitudes are sign-fixed
// (a win is always ≥0, a loss ≤0), so colouring them is decoration, matching the
// flat stat grid above.
const LEG_COLUMNS: { label: string; info: string; cell: (m: LegMetrics) => LegCell }[] = [
  { label: "Trades", info: "Number of closed trades.",
    cell: (m) => ({ value: String(m.n_trades), tone: "" }) },
  { label: "Win rate", info: "Share of trades that closed in profit.",
    cell: (m) => ({ value: Math.round(m.win_rate * 100) + "%", tone: "" }) },
  { label: "Net P&L", info: "Total profit after costs, across these trades.",
    cell: (m) => ({ value: formatSignedMoney(m.net_pnl), tone: getTone(m.net_pnl) }) },
  { label: "Expectancy", info: "Average profit per trade, winners and losers together.",
    cell: (m) => ({ value: m.expectancy.toFixed(2), tone: getTone(m.expectancy) }) },
  { label: "Profit factor", info: "Gross profit divided by gross loss; above 1 is profitable.",
    cell: (m) => ({ value: m.profit_factor !== null ? m.profit_factor.toFixed(2) : "—", tone: "" }) },
  { label: "Avg win", info: "Average size of a winning trade.",
    cell: (m) => ({ value: m.avg_win.toFixed(2), tone: "" }) },
  { label: "Avg loss", info: "Average size of a losing trade.",
    cell: (m) => ({ value: m.avg_loss.toFixed(2), tone: "" }) },
  { label: "Avg win/loss", info: "Average win divided by average loss.",
    cell: (m) => ({ value: m.avg_win_loss_ratio !== null ? m.avg_win_loss_ratio.toFixed(2) : "—", tone: "" }) },
  { label: "Largest win", info: "Biggest single winning trade.",
    cell: (m) => ({ value: m.largest_win.toFixed(2), tone: "" }) },
  { label: "Largest loss", info: "Biggest single losing trade.",
    cell: (m) => ({ value: m.largest_loss.toFixed(2), tone: "" }) },
  { label: "Win streak", info: "Longest run of consecutive winning trades. LONG and SHORT count only their own side, so one side's streak can exceed ALL.",
    cell: (m) => ({ value: String(m.max_consec_wins), tone: "" }) },
  { label: "Loss streak", info: "Longest run of consecutive losing trades. LONG and SHORT count only their own side (ignoring the other side's trades in between), so one side's streak can exceed ALL.",
    cell: (m) => ({ value: String(m.max_consec_losses), tone: "" }) },
  { label: "Avg duration", info: "Average time a trade stayed open.",
    cell: (m) => ({ value: m.avg_duration_bars.toFixed(1) + " bars", tone: "" }) },
];

// The TRADES panel table: ALL / LONG / SHORT rows sharing one set of metric
// columns, so the reader can compare each direction's contribution down a
// column. LONG/SHORT come from the backend's by_leg breakdown (zeroed if a run
// has no trades on that side, or on older payloads without by_leg).
export function legTable(res: BacktestResult): LegTable {
  // Spread over ZERO_LEG so any key missing from a leg is backfilled. A run with
  // no trades on a side has no by_leg entry at all; and a result cached before a
  // metric was added (e.g. expectancy, win streak) carries a partial leg object.
  // Both cases must render as zeros, not crash on a missing field.
  const legs: { leg: string; m: LegMetrics }[] = [
    { leg: "ALL", m: allLeg(res) },
    { leg: "LONG", m: { ...ZERO_LEG, ...res.by_leg?.long } },
    { leg: "SHORT", m: { ...ZERO_LEG, ...res.by_leg?.short } },
  ];
  return {
    columns: LEG_COLUMNS.map((c) => ({ label: c.label, info: c.info })),
    rows: legs.map(({ leg, m }) => ({ leg, cells: LEG_COLUMNS.map((c) => c.cell(m)) })),
  };
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
