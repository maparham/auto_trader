// Progressive strategy reveal for chart replay: the cell's SAVED backtest,
// filtered to what has happened at the cursor. Markers pop in as bars arrive,
// dock rows appear as trades close, and the equity curve draws up to the cursor.
//
// Filtering matters beyond the drawing: renderArtifacts already skips fills
// outside the loaded bar window, but the trades panel and the summary chip read
// the PUBLISHED result — an unfiltered publish would list the future's trades
// and, worse, show the run's final P&L in a blind session.
//
// Backend times are unix SECONDS; the cursor is ms.
//
// --- the predicate, and why it is not `time <= cursor` -----------------------
//
// `cursorMs` is the CLOSE of the newest revealed bar (replayBars' definition),
// never a bar's timestamp. Every time a backtest result carries — a marker's
// `time`, a trade's `entry_time`/`exit_time`, an equity point's `time` — is a bar
// OPEN (drawMarkers: "fill timestamps land on the native timeframe's bar opens";
// the engine appends `EquityPoint(bar.time, equity)`). So `time <= cursorMs`
// admits exactly one bar too many: the bar the cursor is ABOUT to reveal. That is
// the fill that has not printed, the trade that closes NEXT, and the equity point
// one step ahead of the candle on screen — a one-bar crystal ball in a feature
// whose whole purpose is not having one.
//
// The guard is therefore "the bar this datum belongs to has CLOSED":
//
//     time * 1000 + nativeMs <= cursorMs
//
// `nativeMs` is the BACKTEST's bar width, not the chart's. On the run's own
// timeframe the two forms coincide (both reduce to `time * 1000 < cursorMs`,
// since a cursor is always on the bar grid). They diverge when the backtest is
// COARSER than the chart being replayed — a 1H fill stamped 10:00 was decided on
// the whole 10:00-11:00 hour, so a 15m cursor stepping past 10:00 must not reveal
// it 45 minutes early. Same shape as mtfCoordinator's clampHtfBars, and for the
// same reason: a datum whose input window extends past the cursor may not paint.
//
// `nativeMs` comes from `revealBarMs` below rather than `nominalMsFor`, because
// a nominal width is not safe here: see that function's note.
import type { StoredBacktestResult } from "./persist";
import { RESOLUTION_SECONDS } from "./feed";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// The calendar-derived resolutions, at their true MAXIMUM width rather than the
// nominal one RESOLUTION_SECONDS carries. This is the whole point of the table:
// a nominal that is too NARROW reveals a fill early, which is the only direction
// that matters here.
const CALENDAR_MAX_MS: Record<string, number> = {
  MONTH: 31 * DAY_MS, // nominal 30d; a 31-day month is longer
  MONTH_2: 62 * DAY_MS, // nominal 60d
  MONTH_3: 92 * DAY_MS, // nominal 90d; a 92-day quarter is longer
  YEAR: 366 * DAY_MS, // nominal 365d; a leap year is longer
};

/**
 * How wide the reveal must ASSUME a `resolution`'s bar is: an upper bound, never
 * the nominal width.
 *
 * `nominalMsFor` (and `RESOLUTION_SECONDS` under it) is built for scroll-back
 * window math, where being a little off is free. Here it is not: the guard is
 * `time + barMs <= cursor`, so a width that is too NARROW lets a fill through
 * before its bar has closed — exactly the lookahead this module exists to
 * prevent. And the table's approximations all err narrow, not wide: MONTH is 30
 * days against a 31-day month, MONTH_3 is 90 against a 92-day quarter, YEAR is
 * 365 against a leap year. A MONTH-resolution backtest replayed on a finer chart
 * could reveal a fill up to two days early.
 *
 * So: calendar buckets are padded to their real maximum, and everything a day or
 * wider gets another hour on top, because such a bucket can absorb a DST
 * transition that makes the real bar an hour longer than its nominal width (the
 * same asymmetry `nominalBarHours` documents from the other side).
 *
 * An UNRECOGNISED resolution returns Infinity, so nothing is ever revealed. That
 * is deliberate and it is the fail-safe direction: if we cannot say when this
 * result's bars close, we cannot say that any of its fills has happened. A
 * corrupt or legacy record shows an empty reveal rather than a leaking one.
 */
export function revealBarMs(resolution: string): number {
  const calendarMax = CALENDAR_MAX_MS[resolution];
  const nominalMs = (RESOLUTION_SECONDS[resolution] ?? 0) * 1000;
  if (calendarMax == null && nominalMs <= 0) return Infinity;
  const width = calendarMax ?? nominalMs;
  return width >= DAY_MS ? width + HOUR_MS : width;
}

/** One backtest trade that is OPEN at the cursor: its entry bar has closed, its
 * exit bar has not. Deliberately not a `Trade` — every field a Trade carries
 * about the way it ENDS is the answer to the exercise the user is sitting in,
 * so the shape names what may be shown and nothing else.
 *
 * `stop` is the trade's INITIAL stop, never `stop_final`: the final one is where
 * the trail had walked to by the exit, i.e. tomorrow's stop drawn today. */
export interface OpenStrategyTrade {
  // This trade's index in the RUN's trade list. Keys the marker click's zone
  // toggle: an index is stable while the cursor moves (a list position filtered
  // per-cursor is not), and unique even for two trades opened on the same bar.
  index: number;
  leg: "long" | "short";
  quantity: number;
  entryTime: number; // epoch SECONDS, as the backtest stores it
  entryPrice: number;
  stop: number | null;
  target: number | null;
}

/** The run's trades that are still open at `cursorMs` — usually one, but a
 * strategy may hold several. Same "has this datum's bar closed?" predicate as
 * the slice above, applied to the ENTRY (it has happened) and negated on the
 * EXIT (it has not).
 *
 * Kept as its own field rather than folded into `trades` on purpose: an open
 * trade has no P&L, so it must never reach the summary/metrics maths, and the
 * panel's selection is an INDEX into `trades` — a pseudo-row would silently
 * renumber every marker and dash the user can click. */
export function openTradesAtCursor(
  result: StoredBacktestResult,
  cursorMs: number,
): OpenStrategyTrade[] {
  const nativeMs = revealBarMs(result.resolution);
  const closed = (timeSec: number) => timeSec * 1000 + nativeMs <= cursorMs;
  return result.trades
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => closed(t.entry_time) && !closed(t.exit_time))
    .map(({ t, index }) => ({
      index,
      leg: t.leg,
      quantity: t.quantity,
      entryTime: t.entry_time,
      entryPrice: t.entry_price,
      stop: t.stop_initial ?? null,
      target: t.target ?? null,
    }));
}

export function filterResultToCursor(
  result: StoredBacktestResult,
  cursorMs: number,
): StoredBacktestResult {
  // The run's own bar width: what "this datum's bar has closed" is measured in.
  const nativeMs = revealBarMs(result.resolution);
  const closed = (timeSec: number) => timeSec * 1000 + nativeMs <= cursorMs;

  const markers = result.markers.filter((m) => closed(m.time));
  // A trade only becomes a RESULT when it closes; an open one has no P&L yet.
  const trades = result.trades.filter((t) => closed(t.exit_time));
  const equity = result.equity.filter((p) => closed(p.time));
  // A strategy-declared region is a WINDOW, so it is only known once it has
  // ended: its right edge is an outcome, not a configuration. Filtering on
  // `to_time` rather than `from_time` is what keeps a half-formed region off the
  // chart — strategyZoneSpan draws on a PARTIAL overlap and does not clamp its
  // right edge, so a region straddling the cursor would otherwise paint into the
  // blank space to the right of the newest candle.
  const regions = result.regions?.filter((r) => closed(r.to_time));

  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.value);
    maxDd = Math.max(maxDd, peak - p.value);
  }
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const losses = trades.length - wins;
  const first = equity[0]?.value ?? 0;
  const last = equity[equity.length - 1]?.value ?? first;

  return {
    ...result,
    markers,
    trades,
    equity,
    regions,
    // Carried BESIDE `trades`, never inside it: an open trade has no P&L, so it
    // must not reach the summary/metrics maths below, and the panel's selection
    // is an index into `trades` — a pseudo-row there would renumber every marker
    // and dash the user can click. drawMarkers reads it to give the open trade's
    // entry marker its click (the windowed R/R zone, clamped to the cursor).
    openTrades: openTradesAtCursor(result, cursorMs),
    summary: {
      net_pnl: netPnl,
      n_trades: trades.length,
      win_rate: trades.length ? wins / trades.length : 0,
      max_drawdown: maxDd,
    },
    // Running values only. The fields that need whole-run context
    // (avg_duration_bars, sharpe/sortino/calmar/cagr/sqn/exposure) are omitted
    // rather than carried over: a run-level figure next to a partial trade list
    // is exactly the spoiler this feature exists to avoid.
    metrics: {
      return_pct: first ? ((last - first) / first) * 100 : 0,
      profit_factor: grossLoss > 0 ? grossWin / grossLoss : null,
      expectancy: trades.length ? netPnl / trades.length : 0,
      avg_win: wins ? grossWin / wins : 0,
      avg_loss: losses ? -grossLoss / losses : 0,
      avg_win_loss_ratio: losses && wins && grossLoss > 0 ? grossWin / wins / (grossLoss / losses) : null,
      largest_win: trades.reduce((a, t) => Math.max(a, t.pnl), 0),
      largest_loss: trades.reduce((a, t) => Math.min(a, t.pnl), 0),
      max_drawdown_pct: first ? (maxDd / first) * 100 : 0,
      avg_duration_bars: 0,
      max_consec_wins: 0,
      max_consec_losses: 0,
    },
    // Everything below is a WHOLE-RUN artifact that would ride the spread above
    // and hand the user the answer. Dropped, not filtered — none of them can be
    // recomputed from a partial slice, and a stale one is worse than none:
    //
    //  - by_leg          the run's LONG/SHORT breakdown, straight to the panel table.
    //  - analysis        SL/TP efficiency, exit-reason mix, R distribution: the
    //                    panel has a live "analysis" tab, so it is one click away.
    //  - cost_sensitivity  net_pnl at each cost multiple, i.e. the final P&L three
    //                    times over.
    //  - baselines       buy-and-hold over the run's window. The worst of the set:
    //                    it does not merely spoil the STRATEGY's outcome, it says
    //                    what PRICE did after the cursor.
    //  - run_id / fileBracketsOverridden  harmless on their own, but they address
    //                    the whole run; a partial slice is not that run.
    //
    // `period` goes too, and that one is a deliberate departure from the plan.
    // Its on-chart band is indeed only the CONFIGURED trading window and reveals
    // nothing about price — but BacktestPanel renders the same field as
    // `formatPeriodDateRange(period.fromMs, period.toMs)`, a real calendar range
    // that does NOT go through useBarTimeLabel. Publishing it during a masked
    // session prints the very dates the mask exists to hide. Masking that label
    // belongs to Task 8's surface; until it exists, the reveal does not ship the
    // field. The cost is the trading-window shading, which is a nicety.
    by_leg: undefined,
    period: undefined,
    analysis: undefined,
    cost_sensitivity: undefined,
    baselines: undefined,
    run_id: undefined,
    fileBracketsOverridden: undefined,
  };
}
