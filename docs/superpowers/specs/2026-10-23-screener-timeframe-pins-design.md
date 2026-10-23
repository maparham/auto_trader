# Screener: timeframe pins, on one shared candle-sourcing service

## Goal

A screen can reference a higher timeframe than it runs on, by an `@tf` token
(`RSI@W.bullDiv`, `EMA(50)@D`) or by a chart pane pinned in its own settings,
exactly as backtest rules can. The backend fetches those candles for every
screened symbol itself.

The enabling change is structural: the "fetch the higher-timeframe candles a
set of expressions needs, and check there are enough of them" logic exists
today as four hand-rolled copies in the backtest, sweep/WFO, evaluate and
closeness paths, all tied to request shapes the screener cannot use. It
becomes one service both the backtest routes and the screener call.

## Decisions

- **Higher or same timeframe only.** A pin lower than the screen's timeframe
  (`@4H` on a 1D screen) is refused at compile time. Every surface in the app
  aligns a pinned series by "the last pinned bar that CLOSED at or before this
  bar's open" (`indicators/mtf.align_htf_to_base`), so a 4H pin on a daily bar
  would read one 4H bar out of six, the last one of the previous day. That is
  not what anyone asking for a 4H divergence means. The useful form is the
  other way round: run the screen on 4H and pin `@D`. The refusal says so.
- **Same alignment as charts and backtests.** No new semantics: the pinned
  value on the judged bar is the last closed pinned bar before that bar's
  open. A weekly value therefore holds for every daily bar of the following
  week, so `RSI@W.bullDiv > 0` on a 1D screen matches all week after a
  weekly divergence; no `count()` is needed.
- **The screener fetches, the backtest keeps accepting shipped candles.** The
  service takes an optional shipped map so a compute-only host still never
  reaches a broker. Nothing changes in the request shapes.
- **Caps:** at most 3 distinct pinned timeframes per screen (each one is a
  fetch per symbol), 422 otherwise.

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

def htf_needs(nodes, instances) -> list[HtfNeed]
def fetch_window(need, from_ts, to_ts) -> tuple[int, int, int]   # (from, to, bars): 2x need + 10 bars of slack before from_ts
async def fetch_htf(need, *, broker, epic, side, from_ts, to_ts, degraded=None) -> list[Candle]
def closed_before(bars, tf_s, cutoff_ts) -> int
class HtfShortfall(Exception): tf, closed, need
async def source_htf(nodes, instances, *, broker, epic, side, from_ts, to_ts,
                     cutoff_ts, shipped) -> dict[str, list[Candle]]
```

`htf_needs` is the existing `_referenced_tfs` + `_tf_span` +
`_tf_inner_warmup` combination, moved; `_tf_span`'s 422 for an unsupported
timeframe is unchanged. `source_htf` fetches every need the `shipped` map
lacks, then checks `closed_before(bars, tf_s, cutoff_ts) >= need` for every
need, shipped or fetched, and raises `HtfShortfall` otherwise. `cutoff_ts=None`
skips the check (the evaluate and closeness routes never had one and plot
`None` over an unwarmed span instead).

Callers migrated:

- `expr_exec._ensure_htf` becomes a wrapper: `source_htf` with
  `cutoff_ts=req.tradeFromTime`, `shipped=htf`, mapping `HtfShortfall` to its
  existing 422 wording. Backtest, sweep and WFO go through it, as today.
- `routers/expr.py` evaluate and closeness loops call `htf_needs` +
  `fetch_htf` (no cutoff), replacing their inline loops.
- The coded-strategy discovery loop in `routers/backtest.py` stays: it
  learns the timeframes by running the strategy, a different protocol.

### Screener

- `compile_screen(expression, columns, indicators, resolution)` gains the
  base resolution. It keeps refusing nothing by default: every referenced
  timeframe (token or pane pin) must resolve, and its `tf_s` must be `>=`
  the base's, else `ScreenSpecError` on the right field:
  "`@4H` is a lower timeframe than this screen's 1D. Run the screen on 4H and
  pin the higher timeframe instead." (pane form: "`RSI` is pinned to 4H in
  its settings, lower than this screen's 1D. ..."). More than 3 distinct
  timeframes: "A screen can pin at most 3 timeframes." `CompiledScreen.htf`
  holds the `HtfNeed` list.
- `judge(cs, bars, resolution, htf)` passes `htf` to `compile_row` and
  `series_of`.
- `screen_jobs._one`: after the base bars, one `fetch_htf` per need under
  the same per-broker semaphore, with `from_ts = bars[0].time`,
  `to_ts = now`, through an injectable `htf_loader` (default wraps
  `fetch_htf`; tests pass a table). A degraded fetch skips the symbol with
  the existing "broker unavailable, cached bars only" reason. The cutoff is
  the judged bar's open (`bars[-1].time`); a shortfall skips the symbol with
  "not enough W history". The forming pinned bar needs no special handling:
  alignment only reads bars closed at or before the judged bar's open.
- `ScreenRunBody` is unchanged; `_compile` passes `body.resolution.value`.

## Frontend

- `editorInstances(copy, chart, resolution)` keeps pinned panes whose pin
  is the base resolution or higher (today it drops every pinned pane), so
  the editor offers and lints them. A lower pin stays out, and the server's
  message explains why if typed by hand. Pane labels show the pin:
  "RSI @W · length 14 · pivots 5/5 · divergence on" (the
  `ExprInstance.timeframe` the detail line already carries).
- Condition InfoTip gains "Pin a higher timeframe with @W, or pick a chart
  indicator pinned to one." The timeframe line reads "The timeframe sets which
  bars are used; a pinned value is the last closed bar of its timeframe."
- No editor lint change: the parser already accepts `@tf`, and the
  resolution comparison is the server's.
- `ScreenDraft` is unchanged.

## Errors

- Lower pin, unsupported timeframe, more than 3 timeframes: 422 with the
  existing `{code, message, start, end, field, index}` shape, span on the
  `@tf` token (or the whole expression for a pane pin, as today).
- Not enough pinned history for a symbol: skip reason "not enough W
  history"; degraded pinned fetch: the existing degraded reason.

## Testing

- `htf_source`: needs from tokens and from pane pins; window math; shortfall
  raised at the cutoff and not without one; shipped bars are not refetched;
  a shipped set that is too short still raises.
- Backtest: `tests/test_expr_instances_route.py` passes unchanged (pinned
  sufficiency, shipped HTF, compute-only refusal).
- `screen_eval`: `@W` on DAY compiles with one need; `@4H` on DAY refused
  with the wording; same-timeframe pin accepted; pinned pane above base
  accepted, below refused; 4 timeframes refused.
- `screen_jobs`: the htf loader is called with the window; the judge
  receives the bars (a `candle.close@W > 0` screen matches); shortfall and
  degraded skips; the broker cap bounds base and pinned fetches together.
- Frontend: `editorInstances` keeps a higher pin and drops a lower one;
  label shows the pin; panel sends a pinned pane's settings on Run.

## Out of scope

- Pins lower than the screen's timeframe (see Decisions).
- Moving the coded-strategy discovery fetch onto the service.
- Per-symbol timeframe differences (every symbol uses the screen's).
