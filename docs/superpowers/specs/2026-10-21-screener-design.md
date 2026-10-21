# Screener

Status: design, 2026-10-21.

## Goal

Answer one question across many charts: which of my symbols match this
condition right now? Two kinds of screen share one panel and one condition
language:

1. **Condition screens.** A symbol list plus a timeframe plus a rule
   expression (`rsi(14) < 30 and close > ema(200)`), judged on each symbol's
   last closed bar.
2. **Line screens.** The same, judged against lines the user already set up
   on their own charts: hand-drawn lines and the lines of Trendlines
   instances they tuned. A line screen runs over "my charts that carry
   lines", not over a symbol list.

Both can be mixed in one expression, e.g.
`close > ema(200) and low <= drawn and close > drawn`.

## Non-goals

- Fundamentals (P/E, market cap, earnings), news, economic calendar.
- Whole-broker universes (every yfinance stock). Later, once candle fetching
  is budgeted for it.
- Real-time intrabar screening. Screens judge the last CLOSED bar only.
- Screen alerts ("tell me when a symbol starts matching"). The alert engine
  is the natural home; separate spec.
- Line terms in backtests, sweeps and WFO. A hand-drawn line is drawn after
  the fact, so backtesting against it is lookahead by construction. The
  validator refuses line terms outside a screen.
- Running Trendlines with default settings on a chart where the user never
  added it. Trendlines needs per-chart tuning to be meaningful, so only
  instances the user set up count.
- Agent bridge actions (`screen.run`). Follow-up once the HTTP surface
  settles.

## Where the inputs come from

### Symbol lists (condition screens)

A screen stores its own symbol list (broker + epics). The panel offers
"add from Favorites" (the broker's existing `/api/favorites` list) and the
normal symbol search to build it. No separate watchlist feature.

### Charts (line screens)

The backend already holds every workspace key in `core/state_store.py`
(opaque JSON per localStorage key). A new reader,
`core/screen_sources.py`, walks the user's saved layouts there: the layout
index (`layouts`), each body (`layout.<id>`), and for every cell its epic,
timeframe, `indicators` scope and `drawings.<epic>` scope. It yields one
`ChartSource` per cell:

```
ChartSource(layout_id, layout_name, cell_scope, broker, epic, resolution,
            log_scale, trendlines: [TrendlinesConfig, ...],
            drawn: [DrawnLine, ...])
```

`state_store` stays opaque for every other caller: this module is the only
place that parses workspace JSON on the server, and it tolerates any shape
it does not recognise by skipping that cell (counted, never raised).

All saved layouts count, not only the tabs open in a browser. The unsaved
device-local workspace does not, since the server never sees it.

## Line sources

### Drawn lines

From each cell's saved drawings, keep the line types and skip hidden ones
(`visible === false`):

| overlay | extent |
|---|---|
| `segment` | between its two anchors only |
| `rayLine` | from the first anchor onward |
| `straightLine` | both directions |
| `horizontalStraightLine`, `priceLine` | horizontal, both directions |

Anything else (fibs, boxes, trade drawings) is ignored.

Each line is converted to the bar-space form the `line` alert kind already
uses (`alert_kinds.LineKind`, spec 2026-10-16-trendline-alerts-design.md):
`level(j) = pRef + slope * (j - jRef)`, with `j` a position in the server's
candle series for the cell's timeframe and positions found by open time.
Anchors are (timestamp, price) points, so the conversion is: locate both
anchor bars by open time, slope = price difference over bar difference. A
segment whose last bar is before the evaluated bar does not count; a ray
whose start is after it does not count.

On a log-scale cell the line is straight in log price, so the projection
runs on `ln(price)` and exponentiates back. Drawings follow the cell's
CURRENT timeframe, which is what the user sees on that chart.

A drawn line with an anchor time outside the server's candle series (older
than the series start) cannot be placed in bar space, so it is skipped and
counted in the result's `skipped` list with reason `anchor outside
history`.

### Trendlines lines

For each Trendlines instance in a cell, the backend runs
`compute_trendlines` with that instance's parsed config (the same
`parse_trendlines_config` the alert hub uses) and takes every live line at
the evaluated bar, not only the nearest. Lines are judged as the indicator
showed them at that bar: a line confirmed later cannot make an earlier bar
match.

### History and caching belong to the instance

The screener adds no cap of its own. Two changes inside the Trendlines
compute path serve the screener, the alerts and any future caller equally:

1. **Bounded compute.** `lookback_bars` already drops lines older than the
   window but the loop still walks every bar. With `lookback_bars > 0` the
   compute starts at `last - lookback_bars - warmup`, where `warmup` covers
   ATR(14) and pivot confirmation for that config. Output for the bars that
   remain must equal the full-history output; a test asserts this on
   recorded series. With `lookback_bars == 0` it walks full history, as the
   chart does.
2. **Instance cache.** A process-wide cache in `indicators/trendlines.py`
   (or a small sibling module) keyed by
   `(broker, epic, resolution, config_key, last_closed_open_time)` holding
   the live lines. The alert hub's per-close compute and the screener read
   it, so one chart is computed once per bar. LRU-bounded; entries for a
   superseded last bar are dropped on the next write for that key.

Measured cost today (default config, synthetic daily candles, one core):
0.1 s at 500 bars, 0.8 s at 2,000, 2.7 s at 5,000. Drawn lines, EMA/RSI/ATR
and per-line checks are milliseconds or less.

## The condition language

Additions to `strategy/expr` (parser, validate, evaluate, registry):

- **Line terms.** `drawn` (hand-drawn lines), `tl` (Trendlines lines),
  `line` (either). Each takes an optional side: `.support` (line below the
  bar's close) or `.resistance` (above). A line term evaluates to that
  line's price at the bar.
- **One line per evaluation.** An expression that references line terms is
  evaluated once per candidate line, every line term in it bound to that
  same line. The chart matches if any line satisfies it, and the result
  names that line. Mixing two different sources in one expression
  (`drawn` and `tl` together) is a validate error: write `line` instead.
- **`abs(x)`**, needed for distance checks
  (`abs(close - drawn) < 0.5 * atr(14)`).
- "Fired within the last N bars" needs nothing new: `count(cond, N) >= 1`.

Line terms are legal only in a screen. The backtest, sweep and WFO paths
reject them with a 422 that says so.

Example screens:

```
close > ema(200) and low <= drawn and close > drawn          # pullback to drawn support in uptrend
crossAbove(close, tl.resistance) and slope(ema(200), 10) > 0  # Trendlines breakout with trend
abs(drawn - ema(200)) < atr(14) and abs(close - drawn) < 0.5 * atr(14)  # confluence zone
```

## Running a screen

`POST /api/screens/run` takes a screen (inline or by id) and returns a job
id; `GET /api/screens/jobs/{id}` returns progress and, when done, results.
It reuses the sweep job machinery (`api/sweep_jobs.py`'s ProcessPool runner
and progress model) rather than a new pool.

Per target (one symbol for a condition screen, one `ChartSource` for a
line screen):

1. Candles via `CANDLE_CACHE` for the target's broker, epic and timeframe,
   enough for the expression's warm-up (`strategy/expr/warmup.py`) and, for
   `tl`, the instance's bounded compute.
2. Compile the expression once per screen (`compile_row`), evaluate on the
   last closed bar.
3. For line terms, gather the target's candidate lines, evaluate per line.
4. Emit a row on match.

A screen whose expression has no line terms runs over its symbol list. One
that has line terms runs over every `ChartSource` that carries at least one
line of the referenced source; its symbol list is ignored (the panel says
so).

Result:

```
{ matches: [ { broker, epic, resolution, layout_name?, cell_scope?,
               bar_time, columns: {name: value},
               line?: { source: "drawn"|"tl", side, price, dist_atr,
                        drawing_id? } } ],
  skipped: [ { epic, cell_scope?, reason } ],
  stats: { targets, matched, skipped, ms } }
```

Failures per target (no candles, broker down, unparsable drawing) land in
`skipped` with a reason; they never fail the run.

## Columns and sorting

A screen may list extra expressions as named columns (`RSI = rsi(14)`,
`From high % = (close / highest(high, 252) - 1) * 100`), evaluated on the
same bar for matched rows. Results sort by any column, by line distance, or
by symbol.

## Storage

`core/screen_store.py`, its own SQLite file (`SCREEN_DB`), per user, the
same pattern as `pattern_preset_store.py`. A screen is
`{id, name, broker, resolution, symbols, expression, columns, created_at,
updated_at}`. CRUD at `/api/screens`. Results are not stored; the panel
keeps the last run in memory.

## UI

A new right-docked Screener panel, registered with `lib/sidePanels.ts`
(`claimSidePanel`) like the others, opened from the toolbar.

- Top: saved-screen picker, name, timeframe, symbol list (hidden with a
  note for line screens), expression box (`RuleExpressionInput`, with the
  line terms in its palette), columns, Run.
- Progress while running (same `RunBar` the backtest uses).
- Result table: one row per match, sortable columns, a `skipped` count that
  expands to reasons.
- Clicking a row opens that symbol (condition screens) or that exact layout
  cell (line screens) and highlights the matching line for a few seconds.
- "Backtest these" on a condition screen opens the backtest panel with the
  expression as the entry rule and the matched symbols as the target. Not
  offered when the expression has line terms.
- Tooltips via `Tooltip` / `InfoTip`; no `title=`. Muted toggle states.

Demo visitors do not get the panel (it needs the user's saved state and a
write-free compute budget).

## Error handling

- Expression errors: 422 with span, shown inline by `RuleExpressionInput`
  as the backtest panel does.
- Line terms with no qualifying charts: the run returns zero targets and the
  panel says "No saved charts carry drawn lines" (or Trendlines).
- A second run while one is in flight for the same user: rejected, as for
  sweeps.

## Testing

- `screen_sources`: layouts with mixed cells, hidden drawings, unknown
  overlay types, malformed JSON, a cell whose epic has no candles.
- Drawn-line projection: segment/ray extents, horizontal lines, log scale,
  anchors across a weekend gap (bar space, not clock time), anchor outside
  history.
- Trendlines bounded compute equals full compute over the surviving bars,
  on recorded series and several configs; cache hit on the second call,
  invalidation on a new bar; the alert hub reads the same cache.
- Expr: line terms parse, `.support`/`.resistance`, one-line binding, mixed
  sources rejected, `abs`, line terms rejected on backtest/sweep/WFO routes.
- Job: matches, skipped reasons, stats; one-run-per-user guard.
- Frontend: panel claims the side-panel slot, row click navigates to the
  right cell, "Backtest these" hidden for line screens. Run only the
  affected test files.
