# Per-Trade Bar Dynamics: Design

**Problem:** The Analysis tab reports where trades ended (P&L, R distribution) and how far they ran (MAE/MFE), but not how each trade *behaved bar by bar* between entry and exit: how long it sat underwater, how long in profit, how often price crossed back through the entry, how often it retested entry with a wick. Traders want these bar-count statistics, each also shown as a wall-clock duration.

**Decision (user-approved):** Compute per-trade bar-count statistics incrementally in the engine (the same per-bar hook that already tracks MAE/MFE), persist them on each trade like `mae_r`, and aggregate them in the Analysis tab as a new "Bar dynamics" section: one row per metric, averaged over winners vs losers, with a wall-clock duration alongside each bar count.

## Metrics (per trade)

Measured over the trade's held bars: exactly the bars the engine's `_track_excursion` already sees for the open position (entry-fill bar through exit bar inclusive), so the window is identical to the existing MAE/MFE window. Entry price `E` is the fill price; "favorable" means up for a long, down for a short. Classification is by the bar's **close** relative to `E`.

| Field | Definition (long; mirrored for short) |
|---|---|
| `bars_held` | count of held bars (the denominator) |
| `bars_in_profit` | held bars whose close > E |
| `bars_in_loss` | held bars whose close < E |
| `body_through` | bars where the body straddles E: `min(open,close) < E < max(open,close)` |
| `wick_from_profit` | close > E and low <= E (retested entry from the profit side) |
| `wick_from_loss` | close < E and high >= E (retested entry from the loss side) |
| `longest_profit_streak` | longest run of consecutive profit-close bars |
| `longest_loss_streak` | longest run of consecutive loss-close bars |
| `bars_to_mfe` | bars from entry to the bar that set the favorable extreme (0 if price never went favorable) |
| `bars_to_mae` | bars from entry to the bar that set the adverse extreme (0 if price never went adverse) |
| `entry_crossings` | number of profit<->loss flips in the close-zone sequence (flat bars skipped); chop count |

Short-side mirroring: profit = close < E; the adverse wick is the high (`wick_from_profit` = close < E and high >= E), the favorable wick is the low (`wick_from_loss` = close > E and low <= E); the favorable extreme uses the bar low, the adverse extreme uses the bar high.

Flat bars (close == E, rare with floats) count toward neither zone and reset both streak counters. A wick count is a *retest*: a bar that closed in one zone and only pierced entry with a wick. A `body_through` bar (open and close on opposite sides of E) is a genuine cross, not a retest, so it is excluded from both wick counts: the wick conditions require the retest (`low <= E` for a long profit retest, etc.) AND `not (min(open,close) < E < max(open,close))`. `body_through` and the two wick counts are therefore mutually exclusive per bar. `entry_crossings` counts a flip even across an intervening flat bar (flats do not update the last-seen zone).

Derived at aggregation time (not stored per trade): `profit_time_pct` = `bars_in_profit / bars_held`.

## Architecture

### `BarStats` (new, `backend/auto_trader/core/models.py`)

A small `@dataclass(slots=True)` holding the eleven integer counters above plus private running state (`_cur_profit`, `_cur_loss`, `_prev_zone`, `_fav`, `_adv`, `_seeded`). One method:

```python
def update(self, entry: float, leg: str, bar: Candle) -> None
```

called once per held bar. It seeds `_fav`/`_adv` to `entry` on the first bar, then increments the counters per the definitions above. Keeping all per-bar logic in this one pure method makes it unit-testable in isolation with hand-built `Candle`s, without standing up the engine. It retains no candle slice (only small integer/float running state), so memory is O(1) per position regardless of trade length.

### Engine wiring (`backend/auto_trader/engine/backtest.py`)

- `Position` gains `bar_stats: BarStats = field(default_factory=BarStats)`.
- `_track_excursion(positions, side, bar)` calls `p.bar_stats.update(p.entry, side, bar)` for each open position, before it updates the adverse/favorable watermarks. This is already invoked once per bar per open position (line ~196), entry bar included, so the held-bar window matches MAE/MFE exactly.
- `_reduce` books the eleven counters from `p.bar_stats` onto the `Trade` it creates, next to `mae`/`mfe`. A partial close (scale-out) books a snapshot of the counters as of that exit bar, which is correct: each partial trade reports the dynamics up to its own exit.

### `Trade` / `TradeDTO`

`Trade` (`core/models.py`) and `TradeDTO` (`api/schemas.py`) each gain the eleven integer fields, defaulting to 0. The router's `TradeDTO(...)` construction (`routers/backtest.py` ~line 334) passes them through from the `Trade`. They flow into `t.model_dump()` and the run store exactly like `mae_r`, so stored runs carry them and the recompute path aggregates them with no schema change.

### Aggregation (`backend/auto_trader/engine/analysis.py`)

A new `_bar_dynamics(trades)` helper returns:

```python
{
  "n_winners": int,          # eligible winners (pnl > 0 and bars_held present)
  "n_losers": int,           # eligible losers (pnl < 0 and bars_held present)
  "winners": { <metric>: float | None, ..., "profit_time_pct": float | None },
  "losers":  { <metric>: float | None, ..., "profit_time_pct": float | None },
}
```

A trade is *eligible* when `t.get("bars_held") is not None`. Runs predating this feature lack the key, so they are skipped; if no trade is eligible, `n_winners == n_losers == 0` and both metric dicts are all-None (the frontend then hides the section). Each metric is the mean over its group; `profit_time_pct` is the mean of per-trade `bars_in_profit / bars_held` over trades with `bars_held > 0`. Empty group gives all-None. Wired into `compute_analysis` as `"bar_dynamics": _bar_dynamics(trades)`, sibling to `hour_stats` / `month_stats`.

### Frontend (`frontend/src`)

- `api.ts`: `BacktestAnalysis` gains `bar_dynamics?: { n_winners: number; n_losers: number; winners: BarDynamicsMetrics; losers: BarDynamicsMetrics }`, where `BarDynamicsMetrics` is an interface with the eleven metric keys plus `profit_time_pct`, each typed `number | null`.
- `BacktestAnalysisPanel` gains a `barSeconds?: number` prop (default 60). `BacktestPanel.tsx` already computes `resSeconds = RESOLUTION_SECONDS[result.resolution] ?? 60` (line ~186) and passes it: `<BacktestAnalysisPanel analysis={...} barSeconds={resSeconds} />`.
- A new "Bar dynamics" section renders on the **Placement** sub-tab (where the MAE/MFE excursion read-outs live), after the existing placement sections, collapsible under slug `bar-dynamics`. It renders only when `bar_dynamics && (n_winners + n_losers) > 0`.
- The section is a small table (a new lightweight component; the bucket-shaped `RowsTable` does not fit a metric x winners/losers layout): header `Metric | Winners | Losers`, one row per metric in a fixed display order. A frontend metric config lists each metric's label and kind (`duration` | `pct` | `count`). Duration-kind cells render `${avg.toFixed(1)} bars (${fmtDuration(avg, barSeconds)})`; pct cells render `fmtPct`; count cells render `avg.toFixed(1)`. A null average renders as "n/a".
- `fmtDuration(bars, barSeconds)` formats `bars * barSeconds` seconds compactly: `s`, `m`, `h m`, `d h`.

Metric display order and kinds: `bars_held` (duration), `bars_in_profit` (duration), `bars_in_loss` (duration), `profit_time_pct` (pct), `longest_profit_streak` (duration), `longest_loss_streak` (duration), `bars_to_mfe` (duration), `bars_to_mae` (duration), `body_through` (duration), `wick_from_profit` (duration), `wick_from_loss` (duration), `entry_crossings` (count).

## Testing

- **`BarStats.update`** (unit, pure): a crafted long sequence exercising profit/loss/flat closes, a body-through bar, a wick from each side, streaks, `entry_crossings`, and `bars_to_mfe`/`bars_to_mae`; a short sequence confirming the mirror. Assert every counter.
- **Engine integration:** a small `BacktestEngine(strategy).run(candles)` producing one trade; assert its `bars_held` equals the number of bars the position was open and that a hand-checkable counter (for example `bars_in_profit`) matches.
- **`_bar_dynamics`** (unit): winners/losers split, per-metric means, `profit_time_pct` mean, eligibility filter (a trade missing `bars_held` is excluded), all-None for an empty group.
- **Frontend:** the Bar dynamics section renders on Placement with metric rows and a duration string when `bar_dynamics` has trades; hidden when `n_winners + n_losers == 0`. `fmtDuration` unit cases (seconds, minutes, hours+minutes, days+hours).

## Constraints

- No em dash and no "--" as punctuation anywhere in code, comments, copy, or tests.
- Reuse existing shared components where they fit; the metric x winners/losers table is a justified new small component (RowsTable's bucket columns do not fit).
- Win/loss grouping is `pnl > 0` / `pnl < 0`, matching the rest of the Analysis tab.
- Adding fields to `Trade`, `TradeDTO`, and `Position` must default to 0 / a default factory so existing construction sites and tests are unaffected.
- Do not touch the unrelated in-flight files (`BacktestSettingsModal.tsx`, `backtestSchedule*`).
- Frontend typecheck via `npx tsc -b` (pre-existing errors only, zero new).
