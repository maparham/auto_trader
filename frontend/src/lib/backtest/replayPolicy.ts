// What the backtest panel does when replay starts or stops, and which
// backtest actions replay blocks. Pure decisions, no chart access.


/** What a SERIES-LOAD path should do with the shared backtest panel.
 *
 * A cell's saved backtest is normally (re)published whenever its series loads
 * (`rehydrateBacktest`). While that cell is REPLAYING it must not be: the whole
 * run would go onto the panel — every trade the strategy is about to take with
 * its P&L, the run's final net P&L, and `period` as a real calendar range
 * straight through a masked session. A replaying cell's backtest belongs to the
 * progressive reveal (chart/useReplay + lib/replayReveal), which publishes only
 * the slice that has already happened.
 *
 * "clear" rather than "leave" when this chart owned the panel: the load path
 * tears its artifacts down BEFORE the bars land, so what the signal still holds
 * is a result nothing on this chart is drawing any more. Leaving it would keep
 * the pre-session run visible behind the session. Callers must therefore capture
 * `stalePanelOwner` with `ownsBacktestPanel` before that teardown.
 *
 * A caller that has torn nothing down (the cross-tab push handler in App) passes
 * `stalePanelOwner: false`: whatever this chart owns there is the reveal's own
 * live slice, and clearing it would blank a session mid-flight. */
export type BacktestPanelAction = "rehydrate" | "clear" | "leave";
export function backtestPanelActionForReplay(args: {
  replaying: boolean;
  stalePanelOwner: boolean;
}): BacktestPanelAction {
  if (!args.replaying) return "rehydrate";
  return args.stalePanelOwner ? "clear" : "leave";
}

/** Why the backtest panel must refuse an action on a REPLAYING cell, or null
 * when it may go ahead. The reason is USER-FACING copy: the same string
 * disables the control (so nothing looks live that isn't) and explains a
 * refusal that got as far as the run, which is why it lives here rather than
 * being written out twice at two call sites.
 *
 * A SIBLING of backtestPanelActionForReplay above, not an extension of it: that
 * one answers "what should a load or a cross-tab push do with a result that
 * already exists", which has three outcomes and a panel-ownership input. This
 * answers "may the user start something", which has two outcomes and neither
 * input. Folding them together would mean one function with a mode flag and
 * two disjoint halves.
 *
 * The two actions:
 *
 * - "run" — a backtest, sweep or walk-forward started from this tab. All three
 *   enter through BacktestButton's run(), so one guard there covers them (and
 *   the agent bridge, which reaches the same request signal). A run publishes
 *   its whole fresh result including `period` as a real calendar range — the
 *   exact field lib/replayReveal drops, because BacktestPanel renders it
 *   unmasked — and then pages real post-cursor history into the chart and fits
 *   the view to the full traded span. This is the third mouth on that leak; the
 *   load effect (chart/useLiveMarketData) and the cross-tab push (App) are the
 *   two already closed, both via backtestPanelActionForReplay.
 *
 * - "render-wfo" — the walk-forward results panel's scheme picker, whose render
 *   tears down the progressive reveal and repaints the chart with fold bands
 *   over real calendar dates. The refusal is only spoken (a toast): the picker
 *   is a row in a results table, not a button with a disabled state, and the
 *   gate itself lives in renderWfoArtifacts so both of its callers get it.
 *
 * - "pick-range" — the chart range picker. Dragging across a replaying chart
 *   converts pixels back to the BAR's real epoch and drops it into two
 *   datetime-local inputs, printing the exact real date and time of the bars
 *   under the cursor with the session still running and resumable. The chart's
 *   own axis reads "Day 3 09:30"; the picker would read the truth. */
export type BacktestReplayAction = "run" | "pick-range" | "render-wfo";
export function backtestActionBlockedByReplay(args: {
  replaying: boolean;
  action: BacktestReplayAction;
}): string | null {
  if (!args.replaying) return null;
  switch (args.action) {
    case "run":
      return "Chart replay is running: exit the session to run a backtest, sweep or walk-forward.";
    case "render-wfo":
      return "Chart replay is running: exit the session to show walk-forward folds on the chart.";
    case "pick-range":
      return "Chart replay is running: the chart's dates are hidden, so a range cannot be picked from it.";
  }
}
