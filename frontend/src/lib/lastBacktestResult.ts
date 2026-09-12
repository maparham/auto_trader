// The most recent COMPLETED backtest result, held outside backtestResultSignal
// on purpose: that signal is cleared on ✕ / symbol switch / timeframe change
// (see BacktestPanel's "Clear backtest" and BacktestButton's teardown), so by
// the time an admin opens Settings to publish a demo backtest it can already
// be null. This module remembers the last one regardless, so "capture what I
// was just looking at" keeps working after the panel itself moves on.
//
// Set once, at BacktestButton's single completed-run publish site (the same
// spot that feeds backtestResultSignal); read by Settings' demo publishing UI.
import type { StoredBacktestResult } from "./persist";

let last: StoredBacktestResult | null = null;

export function setLastBacktestResult(result: StoredBacktestResult): void {
  last = result;
}

export function getLastBacktestResult(): StoredBacktestResult | null {
  return last;
}
