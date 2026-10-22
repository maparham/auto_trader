# Screener

Status: design, 2026-10-21. Reviewed once; this revision folds in the
review and the user's rulings (log scale out, Trendlines at the alert
depth, side judged one bar back, no "Backtest these", three-part split).

## Goal

Answer one question across many symbols: which of them match this
condition right now? Built in three parts, each with its own plan:

- **Part A, condition screens** (this spec, in full): a symbol list, a
  timeframe and a rule expression judged on each symbol's last closed bar.
- **Part B, drawn lines** (outline below): the `drawn` term, matched
  against lines the user drew on their saved charts.
- **Part C, Trendlines lines** (outline below): the `tl` term, matched
  against the lines of Trendlines instances the user added to a chart.

## Part A: condition screens

### Non-goals

- Fundamentals, news, economic calendar.
- Whole-broker universes (every yfinance stock).
- Intrabar screening. The last CLOSED bar only.
- Screen alerts, agent bridge actions, multi-symbol backtests from results.
- Demo visitors (no panel) and impersonating admins (runs are POST and
  impersonation is GET-only, so the panel shows a read-only note).

### The condition language

Screens use the existing rule language unchanged except for one addition,
`abs(x)`. Real syntax (uppercase indicators, `candle.` fields):

```
RSI(14) < 30 and candle.close > EMA(200)
crossAbove(candle.close, EMA(50)) and slope(EMA(200), 10) > 0
count(crossAbove(candle.close, EMA(50)), 5) >= 1        # fired within the last 5 bars
abs(candle.close - EMA(200)) < ATR(14)                   # near the 200 EMA
```

`abs` lands on both sides of the language: backend `strategy/expr`
(parser, validate, evaluate) and frontend `lib/expr` (`grammar.lezer`,
`parser.ts`, `catalog.ts`), with new rows in `corpus.json` so the parity
test covers it. It is legal everywhere a number is (backtests too).

### Symbol lists

A screen stores its own list: one broker plus a list of epics, built in the
panel through the normal symbol search. Where the broker has favorites
(Capital today; `brokers/base.py` returns [] elsewhere) the panel also
offers "Add favorites". No separate watchlist feature.

### Storage

`core/screen_store.py`, its own SQLite file (`settings.screens_db_path`, env
`CAPITAL_SCREENS_DB_PATH`), per user, same pattern as `pattern_preset_store.py`. A screen is
`{id, name, broker, resolution, symbols, expression, columns, created_at,
updated_at}`; `columns` is a list of `{name, expression}`. CRUD at
`/api/screens`. Results are not stored; the panel keeps the last run in
memory.

### Running a screen

`POST /api/screens/run` takes a screen (inline or by id) and returns a job
id; `GET /api/screens/jobs/{id}` returns progress and, when done, the
result. A new small runner, `api/screen_jobs.py`, not the sweep runner
(that ships one candle set per job to process workers and sits behind the
sweep FairGate, so a screen would queue behind sweeps):

1. Parse and validate the expression and columns once. Errors 422 before
   any fetch.
2. Fetch candles in the main event loop through `CANDLE_CACHE.recent`,
   enough bars for the expression's warm-up (`strategy/expr/warmup.py`),
   with a per-broker concurrency cap (default 4; Capital already
   self-limits to 10 req/s). The forming bar is dropped so the last bar is
   closed.
3. Evaluate each symbol in a thread (`asyncio.to_thread`) with the compiled
   row, on the last bar only, then the columns on matched symbols.
4. Report progress per finished symbol.

One run per user at a time; a second is rejected, as for sweeps. Per-symbol
failures (no candles, broker error, not enough history for the warm-up)
land in `skipped` with a reason and never fail the run.

Result:

```
{ matches: [ { epic, bar_time, columns: {name: value} } ],
  skipped: [ { epic, reason } ],
  stats: { symbols, matched, skipped, ms } }
```

### UI

A new right-docked Screener panel. `"screener"` joins `SidePanelId` in
`lib/sidePanels.ts` and the panel calls `claimSidePanel` like the others;
opened from the toolbar.

- Top: saved-screen picker, name, broker, timeframe, symbol list,
  expression (`RuleExpressionInput`), columns, Run.
- While running: a small progress line (`n / total`, Cancel). RunBar is
  the backtest footer, not a progress bar, so it is not reused.
- Results: one row per match, sortable by any column or symbol; a skipped
  count that expands to reasons.
- Clicking a row opens that symbol on the focused chart at the screen's
  timeframe.
- Tooltips via `Tooltip` / `InfoTip`; muted toggle states.

### Testing

- `abs`: backend parse/validate/evaluate, frontend parser, corpus parity.
- Store CRUD and per-user isolation.
- Runner: matches on the last closed bar (forming bar excluded), columns,
  skipped reasons, warm-up shortfall, per-broker cap honoured, one run per
  user.
- Frontend: panel claims its slot, row click navigates, impersonation note.
  Run only the affected test files.

## Part B: drawn lines (outline)

Needs its own spec before planning. Settled so far:

- **Term.** `drawn`, a reserved word (checked before the instance-ref
  path, so `drawn.support` is not read as a pane named "drawn"), with
  `.support` / `.resistance`. Legal only in screens; backtest, sweep and
  WFO reject it (a drawn line is lookahead by construction).
- **Binding.** An expression with `drawn` is evaluated once per candidate
  line, every `drawn` bound to that line; the chart matches if any line
  does, and the row names it. Compile per line with a shared indicator
  memo, since `compile_row` precomputes line-free subtrees once.
- **Side.** Judged at the bar BEFORE the evaluated bar, so a cross up
  through a resistance line still counts as resistance. At earlier bars
  the term is the same line projected back; `None` before its start.
- **Source.** A server-side reader over the user's saved layouts in
  `state_store` (`auto-trader.b.<family>.layouts`, `.layout.<id>`, each
  cell's `drawings.<epic>`). To resolve: cells carry no broker and a family
  folds capital and capital-live; price side.
- **Line types.** `segment` (between anchors), `rayLine` (from first
  anchor), `straightLine` (both ways), `horizontalStraightLine` (both
  ways), `priceLine` (horizontal ray to the right). Decide
  `priceChannelLine`. Hidden test uses `extendData.userVisible` and the
  cell-timeframe `visibility`, not the saved `visible`. Horizontal lines
  need no bar mapping. Anchors map to bars like klinecharts does (floor,
  extrapolate past the data), in the cell's current timeframe.
- **Out:** log-scale charts (the setting is not saved).

## Part C: Trendlines lines (outline)

Needs its own spec before planning. Settled so far:

- **Term.** `tl`, same reservation, side and binding rules as `drawn`;
  `line` (either source) arrives with whichever part lands second.
- **Instances.** Only Trendlines instances present on a saved chart, with
  that instance's params from the `indicatorConfig` scope. An MTF-pinned
  instance (`extendData.mtf.timeframe`) is judged on its pinned timeframe.
- **Lines.** The lines the indicator draws at the evaluated bar (after its
  gate, merge, level selection and `max_lines`), not the raw live state.
- **Depth.** Computed over the last 2,000 bars, the alert hub's
  `SEED_CAP`. Stated as such: it can differ slightly from a chart that
  loaded more or less history.
- **Compute and cache.** In the main process's Trendlines compute pool, the
  one the alert hub uses, with one cache keyed like the hub's series
  (broker, epic, resolution, side, config, first/last/len stamp), so an
  alert and a screen on the same chart compute once per bar.
