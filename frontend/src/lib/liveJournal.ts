/** Per-strategy trade journal: the engine's closed trades plus the same metrics
 *  the backtest reports (net P&L, n trades, win rate, max drawdown), so live
 *  performance is directly comparable to the backtested result. Persisted
 *  device-locally, keyed globally (v1 runs one strategy at a time in the panel). */
import { Signal } from "./signals";

export interface JournalTrade {
  ts: number; // close time, unix seconds
  epic: string;
  leg: "long" | "short";
  entry: number;
  exit: number;
  quantity: number;
  pnl: number; // realized, instrument currency (price units × qty)
}

const KEY = "auto-trader.live.journal";

function load(): JournalTrade[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as JournalTrade[]) : [];
  } catch {
    return [];
  }
}

let trades = load();
export const journalSignal = new Signal<JournalTrade[]>(trades);

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(trades));
  } catch {
    /* best-effort */
  }
  journalSignal.set(trades);
}

export function recordClose(t: JournalTrade): void {
  trades = [...trades, t].slice(-500);
  persist();
}

export function clearJournal(): void {
  trades = [];
  persist();
}

export interface JournalMetrics {
  net: number;
  count: number;
  winRate: number;
  maxDD: number;
}

/** Backtest-parity metrics over a set of closed trades. maxDD is the deepest
 *  peak-to-trough dip of the cumulative-P&L equity curve (<= 0). */
export function journalMetrics(ts: JournalTrade[]): JournalMetrics {
  const net = ts.reduce((s, t) => s + t.pnl, 0);
  const wins = ts.filter((t) => t.pnl > 0).length;
  const winRate = ts.length ? wins / ts.length : 0;
  let peak = 0;
  let cum = 0;
  let maxDD = 0;
  for (const t of ts) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    maxDD = Math.min(maxDD, cum - peak);
  }
  return { net, count: ts.length, winRate, maxDD };
}
