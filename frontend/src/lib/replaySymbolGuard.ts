// Which cells a symbol change is about to land on.
//
// A replay cursor addresses ONE instrument's bars, so changing a cell's symbol
// ends any session it holds (chart/useReplay's symbol-change guard) and drops
// the persisted record with it — the practice book, the cursor, and on a blind
// session the only place the hidden dates were ever written down. App asks
// before doing that, and this is the "about to" half of the question: ask only
// about cells that will ACTUALLY change, or the dialog fires on clicks that
// would have cost nothing (re-picking the symbol a cell already shows, turning
// symbol-sync on when every cell already agrees) and is quickly learned as
// noise.
//
// Pure and separate from App so the set can be pinned by tests: App itself has
// no unit harness, and getting this wrong is silent in both directions — too
// wide is a nuisance dialog, too narrow loses a session with no warning.

export interface SymbolCell {
  id: string;
  symbol: { epic: string };
}

/**
 * The cells whose epic changes when `nextEpic` is applied.
 *
 * `broadcast` is symbol-sync (TradingView's "link"): on, the change lands on
 * every cell in the tab; off, only the focused one. Cells already showing
 * `nextEpic` are excluded either way — including the focused cell, so
 * re-selecting the symbol a chart already shows is never a loss.
 */
export function cellsChangingSymbol(
  cells: readonly SymbolCell[],
  opts: { focusedId: string; broadcast: boolean; nextEpic: string },
): string[] {
  return cells
    .filter((c) => opts.broadcast || c.id === opts.focusedId)
    .filter((c) => c.symbol.epic !== opts.nextEpic)
    .map((c) => c.id);
}

/** The ask, phrased for however many sessions are actually at stake. */
export function replayLossMessage(count: number): string {
  return count > 1
    ? `${count} charts are running a replay session. Switching symbol ends them and discards their practice trades.`
    : "This chart is running a replay session. Switching symbol ends it and discards its practice trades.";
}
