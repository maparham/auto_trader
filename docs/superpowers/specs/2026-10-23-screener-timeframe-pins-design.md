# Screener: timeframe pins, on one shared candle-sourcing service

## Goal

A screen can reference a higher timeframe than it runs on, by an `@tf` token
(`RSI.bullDiv@W`, `EMA(50)@D`) or by a chart pane pinned in its own settings
(FVG, TRENDLINES, PIVOT_BANDS, SR_LEVELS, AUTO_FIB, SLOPE carry a pin; RSI
does not), exactly as backtest rules can. The backend fetches those candles
for every screened symbol itself.

The enabling change is structural: "fetch the higher-timeframe candles a set
of expressions needs, and check there are enough of them" exists today as
several hand-rolled copies tied to request shapes the screener cannot use:
`expr_exec._ensure_htf` (backtest, sweep and WFO all go through it), the
evaluate and closeness loops in `routers/expr.py`, the coded-strategy
discovery loop in `routers/backtest.py`, and a `NeedTimeframe` loop in
`routers/strategy.py`. The first three move onto one service that the
screener also calls; the last two stay (see Out of scope).

Spelling note: a pin applies to a whole operand, so the output comes first:
`RSI.bullDiv@W`, `SLOPE.9@D`, `EMA(50)@W`. `RSI@W.bullDiv` is a parse error
today ("RSI has no named outputs") and stays one.

## Decisions

- **Higher or same timeframe only, unlike backtests.** A pin finer than the
  screen's timeframe (`@4H` on a 1D screen) is refused at compile time.
  Backtests and charts accept finer pins and read, for each base bar, the
  last finer bar closed at or before its open: on a daily bar that is one 4H
  bar out of six, the last of the previous day. That is not what anyone
  asking a screen for a 4H divergence means, and screens refuse every pin
  today, so nothing existing breaks. The useful form is the other way round:
  run the screen on 4H and pin `@D`. The refusal says so.
- **Same alignment as charts and backtests** (`indicators/mtf.align_htf_to_base`).
  A pin coarser than the base reads the last pinned bar CLOSED at or before
  the bar's open (month and non-native pins at their true close). A pin at
  the base's own timeframe reads that bar itself. A weekly value therefore
  holds for every daily bar of the following week, so `RSI.bullDiv@W > 0` on
  a 1D screen matches all week after a weekly divergence; no `count()` is
  needed.
- **The screener fetches; the backtest keeps accepting shipped candles.** The
  service takes an optional shipped map so a compute-only host still never
  reaches a broker. Request shapes do not change.
- **Caps:** at most 3 distinct pinned timeframes per screen, counted by
  canonical resolution (`1H` and `HOUR` are one), 422 otherwise.

## Backend

### `api/htf_source.py` (new)

The one place that turns "these expression trees reference these
timeframes" into candles.

```python
@dataclass(frozen=True)
class HtfNeed:
    tf: str      # as referenced ("W", "1H", or a pane's own pin)
    res: str     # canonical resolution ("WEEK"), the htf dict key
    tf_s: int    # nominal bar seconds
    need: int    # closed pinned bars required before the cutoff: deepest
                 # inner warm-up + 1 (the bar the first judged/traded bar reads)

def htf_needs(nodes: list[N.Node], instances) -> list[HtfNeed]
def warm_window(need: HtfNeed, from_ts: int, to_ts: int) -> tuple[int, int, int]
    # (from, to, bars) with (2 * need.need + 10) pinned bars of slack before from_ts
async def fetch_htf(need: HtfNeed, *, broker, epic, side, from_ts, to_ts,
                    degraded: dict | None = None) -> list[Candle]
def closed_before(bars, tf_s: int, cutoff_ts: int) -> int
class HtfShortfall(Exception): tf: str; closed: int; need: int
async def source_htf(nodes, instances, *, broker, epic, side, from_ts, to_ts,
                     cutoff_ts: int | None, shipped: dict[str, list[Candle]]) -> dict[str, list[Candle]]
```

- `htf_needs` is today's `_referenced_tfs` + `_tf_span` + `_tf_inner_warmup`
  combination, moved. `_tf_span` and `_tf_inner_warmup` move here;
  `expr_exec` re-exports both names unchanged (routers/expr.py and the tests
  import them from there). `_tf_span`'s 422 for an unsupported timeframe is
  unchanged.
- `fetch_htf` is a thin window fetch: it calls
  `deps._fetch_symbol_candles(broker, epic, need.res, bars, from_ts, to_ts, side)`
  module-qualified, with the seven positional arguments the existing
  `fake_fetch` test doubles accept, and passes `degraded=` ONLY when the
  caller gave one. It applies no window math itself; callers choose their
  window (evaluate's `fromTime - need * tf_s`, closeness's bare range) so
  their behaviour and tests do not change.
- `source_htf` uses `warm_window` for the needs `shipped` lacks, then checks
  `closed_before(bars, tf_s, cutoff_ts) >= need` for every need, shipped or
  fetched, raising `HtfShortfall`. `cutoff_ts=None` skips the check.

Callers:

- `expr_exec._ensure_htf` becomes a wrapper: `source_htf` with
  `cutoff_ts=req.tradeFromTime`, `shipped=htf`, mapping `HtfShortfall` to its
  existing 422 wording. It keeps its name, module and signature (a test
  monkeypatches `expr_exec._ensure_htf`).
- `routers/expr.py` evaluate and closeness replace their inline loops with
  `htf_needs` + `fetch_htf`, keeping their own windows exactly as today.

### Screener

- `compile_screen(expression, columns, indicators, resolution)` gains the
  base resolution. Checks, in order, each raising `ScreenSpecError` on the
  field being compiled:
  - an unresolvable timeframe: today's `_tf_span` wording, code
    `unsupported_timeframe`;
  - `tf_s < base_s`: code `screen_tf_lower`, "`@4H` is a lower timeframe
    than this screen's 1D. Run the screen on 4H and pin the higher timeframe
    instead." Pane form: "`FVG` is pinned to 4H in its settings, lower than
    this screen's 1D. Run the screen on 4H, or unpin it on the chart.";
  - more than 3 canonical resolutions across condition and columns: code
    `screen_tf_too_many`, "A screen can pin at most 3 timeframes."

  Spans: the `@tf` token's span for a token (`N.Tf` carries it), the whole
  expression for a pane pin, as today. `_refuse_unsupported` goes away.
- Warm-up uses the base resolution: `warmup_bars(node, resolution, instances)`.
  With `None` (today) a pinned term is charged in base bars, which would
  over-ask and skip young symbols; with the resolution a pinned term costs 0
  base bars, so `bars_needed` falls to the 300 floor for an all-pinned
  screen. `CompiledScreen.htf: list[HtfNeed]` comes from `htf_needs` over
  the condition plus every column node.
- `judge(cs, bars, resolution, htf)` passes `htf` to `compile_row` and
  `series_of`.
- `screen_jobs._one`, after the base bars and still inside the same
  `try`: for each need, acquire the per-broker semaphore per fetch
  (sequential acquisitions, never one hold spanning several awaits), and
  call the injectable `htf_loader(broker, epic, need, side, from_ts, to_ts)`
  with `from_ts = bars[0].time` and `to_ts = self._clock()`; the default
  loader is `warm_window` + `fetch_htf` with a `degraded` dict. A degraded
  pinned fetch skips the symbol with the existing "broker unavailable,
  cached bars only" reason. Then `closed_before(htf_bars, need.tf_s, cutoff)`
  with `cutoff = bars[-1].time` (the judged bar's open, matching the
  backtest's tradeFromTime rule) must reach `need.need`, else skip with
  "not enough @W history" (the referenced spelling). Any other exception
  (a derived pin on IG 422s, a compute host 503s) is already a skip through
  `_reason`. The forming pinned bar needs no handling: its close is after
  now, so the alignment gate never reads it.
- Base bars keep coming from `load_alert_bars`; pinned bars go through
  `_fetch_symbol_candles`'s window path, so derived pins (`@2D`) work where
  that path allows them.
- `ScreenRunBody` is unchanged; `_compile` passes `body.resolution.value`.

## Frontend

- `editorInstances(copy, chart, resolution)` keeps pinned panes whose pin
  is the base resolution or coarser (today it drops every pinned pane),
  comparing with `tfSeconds` (`lib/expr/catalog.ts`); a pin `tfSeconds`
  cannot read is dropped. A finer pin stays out, and the server's message
  explains why if typed by hand.
- `paneLabels` appends the pin itself, since `ExprInstance.detail` does not
  carry it: "FVG @W · min 0.25x ATR · newest 500/side".
- Condition InfoTip: replace "The timeframe sets which bars are used." with
  "The timeframe sets which bars are used. @W pins a higher one: the value is
  its last closed bar." and add "Pins must be the screen's timeframe or
  higher."
- No editor lint change: the parser already accepts `@tf`, and the
  resolution comparison is the server's. `ScreenDraft` is unchanged;
  `collectExprInstances` already ships a pane's `mtf` inside `extendData`.

## Errors

- Lower pin, unsupported timeframe, too many timeframes: 422 with the
  existing `{code, message, start, end, field, index}` shape.
- Not enough pinned history for a symbol: skip "not enough @W history".
  Degraded pinned fetch: the existing degraded reason.

## Testing

- `htf_source`: needs from tokens and from pane pins, condition plus
  columns; `warm_window` math; `closed_before` at the cutoff; `source_htf`
  does not refetch a shipped timeframe, raises `HtfShortfall` for a short
  shipped set, skips the check with `cutoff_ts=None`; `fetch_htf` calls
  `_fetch_symbol_candles` with seven positionals and no `degraded` kwarg by
  default.
- Existing backtest, sweep, evaluate and closeness tests pass unchanged
  (`test_expr_instances_route.py`, `test_api_expr.py`,
  `test_expr_closeness_router.py`, `test_api_backtest_remote_htf.py`,
  `test_api_backtest_cancel.py`).
- `screen_eval`: `EMA(5)@W > 0` on DAY compiles with one need and a 300-bar
  `bars_needed`; `@4H` on DAY refused with `screen_tf_lower` and the token's
  span; same-timeframe pin accepted; a pinned FVG above base accepted, below
  refused; 4 resolutions refused; `1H` and `HOUR` count once.
- `screen_jobs`: the htf loader receives the need and window; the judge
  receives the bars (`candle.close@W > 0` matches); shortfall and degraded
  skips; the broker cap bounds base and pinned fetches together.
- Frontend: `editorInstances` keeps a coarser pin and drops a finer one;
  `paneLabels` shows the pin; the panel sends a pinned pane's settings on
  Run.

## Out of scope

- Pins finer than the screen's timeframe (see Decisions).
- The coded-strategy discovery loop (`routers/backtest.py:_run_coded`) and
  the `NeedTimeframe` loop in `routers/strategy.py`: both learn timeframes by
  running a strategy, a different protocol.
- Per-symbol timeframe differences (every symbol uses the screen's).
