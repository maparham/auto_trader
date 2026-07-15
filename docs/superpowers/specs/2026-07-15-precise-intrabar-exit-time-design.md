# Precise intra-bar exit time for backtest trades

Date: 2026-07-15
Status: Approved design, ready for implementation plan

## Problem

A backtest runs on the run timeframe's OHLC only (e.g. 1H). When a trade exits
via an intra-bar stop or target, the engine knows only that the run bar's
range pierced the level; it cannot know *when* inside the bar. So it stamps the
exit at the run bar's open time, the same timestamp as a same-bar entry.

Two visible symptoms follow:

1. **The selection overlay does not cover the trade's real duration.** The zone
   overlay (`drawSelectionZone`, `frontend/src/lib/backtest.ts`) floors a
   same-bar trade to exactly one *display* bar (`windowEnd = entryTs + barMs`,
   ~line 918). On a 1-minute chart that draws a 1-minute-wide overlay for a
   trade that was actually alive ~50 minutes.
2. **The results table shows the wrong exit time.** The Exit time column
   (`BacktestPanel.tsx`, `formatExpiryShort(row.exitTime * 1000)`) shows the run
   bar's open, so an entry and its same-bar stop read as the same time.

Worked example (the trade that prompted this), US100 1H, dukascopy bid:

- Entry bar `2026-07-06 01:00 UTC` (shown as `03:00` in the table, which renders
  at UTC+2). Open 29682.403, low 29518.198, stop 29533.99 (entry - 0.5%).
- The hour's low pierces the stop, so the engine exits at the stop and stamps
  the exit at `01:00`. Entry and exit collapse onto one timestamp.
- The cached 1-minute candles for that hour show the **first** minute whose low
  reaches the stop is **`01:50 UTC`** (low 29525.59), i.e. `03:50` in the table.
  The trade was really alive ~50 minutes.

The engine's math is correct against its 1H data; only the exit *time* is coarse.

## Goal

Give each intra-bar exit a canonical, fine-resolution exit time and use it in
two places:

- **Results table:** show the exact exit time (e.g. `03:50` instead of `03:00`).
- **Chart overlay:** draw the trade overlay to its real duration at any display
  timeframe.

### Overlay width rule (agreed)

The overlay covers **the minimal set of whole display-timeframe candles that
fully contains the trade's real alive interval `[entry, exact-exit]`.** Never
shorter than the real duration; at most one partial display candle of slack per
end. It recomputes per display timeframe (a coarser view is wider but still
minimal for that view). The right edge therefore rounds **up** to the close of
the display candle that contains the exact exit.

## Non-goals

- No tick-level precision. 1-minute is "exact" here: it is the finest cached
  resolution and the finest chart timeframe, and matches what the user reads off
  the chart. Tick precision (`tick_history.db`) is a possible later refinement.
- No new persisted "duration" metric beyond the exact exit time (a real duration
  is trivially derivable from it later; out of scope now).
- No change to any backtest number: entry price, exit price, and P&L are
  unchanged. Only the exit *time* gains resolution, and only for display.
- Non-intra-bar exits (rule / session close / range end) are untouched: they
  already fill at a real bar boundary, so their exit time is already exact.
- No migration. Runs persisted before this change carry no exact time; the
  frontend falls back to the bar-open time for those (see Fallbacks).

## Approach: compute on the backend (B)

The exact time must be a single canonical value because the results table is not
tied to any display timeframe. The backend already holds the 1-minute candles
locally (`candle_history.db`, `MINUTE` resolution is populated), so it can
compute the value with a trivial scan and ship back one timestamp per intra-bar
exit, with zero extra data transfer to the browser and zero browser compute.

Considered and rejected: computing on the frontend by pulling 1-minute candles
into the browser. The scan itself is negligible, but it would move finer-grained
candle data over the wire for every intra-bar exit and could not produce a
canonical table value when the chart is on a coarse timeframe. The backend has
the data in hand, so B is both cheaper and cleaner.

## Backend design

### New field

Add a nullable exact exit time (epoch seconds) that rides alongside `exit_time`:

- `Trade` dataclass (`backend/auto_trader/core/models.py`): add
  `exit_time_exact: int | None = None` (or a `datetime | None`; match the
  surrounding field types and convert at serialization, same as `exit_time`).
- `TradeDTO` (`backend/auto_trader/api/schemas.py`): add
  `exit_time_exact: int | None = None`.
- Router serialization (`backend/auto_trader/api/routers/backtest.py`, the
  `TradeDTO(...)` block ~line 322): pass it through, converting with the same
  `_ts` helper used for `exit_time`.
- Run store: it serializes the trade DTO, so the field persists automatically.
  Old rows simply lack the key.

### Resolver (pure, unit-testable)

A pure function with no I/O:

```
resolve_exit_time(
    *, leg, reason, exit_time, run_tf_seconds,
    stop_final, target, exit_price,
    minute_candles,   # ascending Candles inside the exit run bar
) -> int | None
```

- Returns `None` (leave `exit_time` as-is) when:
  - `reason` is not an intra-bar exit. Intra-bar reasons are `stop`, `trail`,
    `target`. Everything else (rule text, `session close`, `range end`) already
    sits on a bar boundary.
  - `run_tf_seconds <= 60`: the run is already at or below minute resolution, so
    there is nothing finer to resolve to.
  - `minute_candles` is empty (no finer data cached for that hour).
  - No minute candle in the exit bar satisfies the pierce (shouldn't happen if
    the engine exited here, but guard anyway).
- Otherwise picks the level and comparison, scans `minute_candles` ascending,
  and returns the **open timestamp of the first** candle that pierces:
  - `stop` / `trail`: `level = stop_final if not None else exit_price`.
    long -> first `low <= level`; short -> first `high >= level`.
  - `target`: `level = target if not None else exit_price`.
    long -> first `high >= level`; short -> first `low <= level`.

The first pierce is guaranteed to fall inside the exit run bar (earlier run bars
did not pierce, or the exit would have been earlier), so the scan only needs the
exit bar's minutes and needs no bounding logic beyond the window it is handed.

### Wiring

Add a pass next to the existing `enrich_trades(result.trades, candles)` call
(`backtest.py:316`). The new pass:

1. For each trade whose `reason_out` is an intra-bar exit, compute the exit run
   bar window `[exit_time, exit_time + run_tf_seconds)`.
2. Load `MINUTE` candles for that window from the candle store, for the **same
   broker and price side** the run used (so the level comparison matches the run
   data; in the worked example dukascopy bid, whose 01:50 low reproduces the
   engine's stop hit). Coalesce/lookup so repeated exit bars are not refetched.
3. Call `resolve_exit_time(...)` and set `trade.exit_time_exact`.

Keep the store access in the wiring layer; keep `resolve_exit_time` pure so it
tests without a database.

## Frontend design

### Results table

- `api.ts` `Trade`: add `exit_time_exact?: number | null`.
- `backtestPanelData.ts` (~line 331): carry `exitTimeExact: trade.exit_time_exact ?? null`
  onto the row alongside `exitTime`.
- `BacktestPanel.tsx` Exit time cell (~line 475): render
  `formatExpiryShort((row.exitTimeExact ?? row.exitTime) * 1000)`.
  Sorting by exit time should use the same effective value.

No visual flourish is required. The exact time simply replaces the bar-open time
for intra-bar exits; every other row is unchanged.

### Chart overlay

Introduce a small pure helper (in `lib/backtest.ts`, unit-tested):

```
overlayEndTs(exitExactMs, bars, barMs, entryTs): number
```

- `exitExactMs = (t.exit_time_exact ?? t.exit_time) * 1000`.
- Find the loaded display candle whose `[ts, nextTs)` window contains
  `exitExactMs`; round **up** to that candle's close boundary
  (`hitBar.ts + barMs`), so the overlay fully covers the hit candle.
- Floor at one display bar so a degenerate case stays visible:
  `max(entryTs + barMs, roundedUp)`.

Wire it into `drawSelectionZone` (replacing the `windowEnd` line ~918):

- `windowEnd = overlayEndTs(...)`.
- The zone's exit-price point timestamp uses `exitExactMs` (so the exit dot lands
  on the true hit candle).
- `scrollChartToTrade` frames `entryTs .. exitExactMs`.
- The transient hover `segment` overlay (~line 1364) uses `exitExactMs` for its
  exit point, so the hover line ends at the true hit candle instead of collapsing
  vertically on a same-bar trade.

This degenerates cleanly: display timeframe == run timeframe -> one bar (as
today); display coarser -> one coarse bar (as today); display finer -> true
sub-bar width.

### Reactivity

The round-up is display-timeframe dependent (`exit_time_exact` is canonical, but
which display candle it rounds up to changes with the timeframe). The selection
zone must therefore recompute when the display timeframe changes while a trade is
selected. Verify the existing redraw-on-data-reload path already re-runs
`drawSelectionZone` on a timeframe switch; if not, add that redraw. This is the
one behavior to confirm in the running app.

## Fallbacks

- `exit_time_exact` absent or null (old cached run, no minute data, run at/below
  minute resolution, non-intra-bar exit): the table shows `exit_time` and the
  overlay uses today's one-bar floor. Identical to current behavior, so nothing
  regresses.

## Edge cases

- **Gap through the level**: the run bar opens already past the stop/target
  (`exit_price == open`). The first minute candle pierces immediately, so the
  exact time equals the bar open and the overlay is ~one minute wide. Correct.
- **Multi-bar stop exit**: entry on run bar A, stop on a later run bar B. The
  resolver scans B's minutes; the overlay right edge refines to inside B. Works
  with no special-casing.
- **Run timeframe == MINUTE**: no finer resolution available; resolver returns
  None; minute-open time (already shown) is as exact as it gets.

## Testing

Backend (pure resolver, synthetic minute candles, no DB):
- same-bar long stop -> first `low <= stop` minute (01:50 in the worked example);
- short stop uses `high >= stop`;
- long/short target uses the opposite comparison;
- gap-through-open -> first minute;
- non-intra-bar reason -> None;
- empty minute candles -> None;
- `run_tf_seconds <= 60` -> None.

Frontend:
- `overlayEndTs`: same-bar stop on 1m bars rounds up to the hit candle's close;
  coarser timeframe -> one bar; missing exact time -> one-bar floor.
- table renders `exit_time_exact` when present, `exit_time` otherwise.

## Risks

- Broker/side mismatch when loading minute candles would compare against a
  different price series than the run used. The wiring must load `MINUTE`
  candles for the run's own broker and side.
- Minute coverage gaps for some epics/ranges yield None and the current
  behavior; acceptable and non-regressing.
