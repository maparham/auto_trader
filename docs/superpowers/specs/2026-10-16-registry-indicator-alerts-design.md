# Indicator alerts on the series registry

## Goal

Any custom indicator a backtest rule can reference can also carry an alert,
through the same code. No alert-only indicator logic on either side.
klinecharts built-ins (BOLL, MACD, KDJ, CCI, DMI, SAR, ...) are out of scope.

## Today

Two parallel systems describe "which outputs an indicator has, its config,
its warm-up, its values":

| | Backend | Frontend |
|---|---|---|
| Backtests / rules | `indicators/registry.py` `SERIES_INDICATORS` | `lib/exprInstances.ts` + `lib/indicators/*Outputs.ts` |
| Alerts | `indicators/alertable.py` `ALERTABLE` | `lib/alertableIndicators.ts` |

The alert copy re-implements validation, warm-up, labels and compute for MA,
RSI, ATR and TRENDLINES, and needs its own parity fixtures
(`tests/fixtures/indicator_parity/`, `alertableParity.test.ts`).

## Design

### 1. Alert params reference a registry instance

New `indicator` alert params:

```
{
  instance: { type, calcParams, extendData },   // the pane, verbatim
  output: str,                                   // one of spec.outputs(cfg)
  timeframe, target, value, evalOn, link         // unchanged meaning
}
```

`identity`, `line`, `config` and `priceTarget` go away. The backend parses
`instance` with `spec.parse_config(calcParams, extendData)`, the same call
`resolve_instances` makes for a backtest, so an alert and a rule on the same
pane always read the same series.

`sig()` (dedup and change detection) keys on `(type, parsed cfg, output,
timeframe, target, value, evalOn, condition, trigger)`. Config dataclasses are
frozen, so two panes whose raw extendData differ but parse the same are one
alert.

### 2. Registry spec grows four alert fields

`IndicatorSeriesSpec` gains, with defaults so unchanged entries keep working:

- `price_scale(cfg, output) -> bool`: the output lives on the price axis, so
  "Price crosses the curve" is offered. Default `False`.
- `label(cfg, output) -> str`: alert name for the list, toasts, push and
  Telegram ("RSI 14", "SR_LEVELS above", "TL nearest").
- `heavy: bool`: closed values compute off the event loop (today's
  TRENDLINES pool, generalized) and intrabar uses the last closed value
  instead of recomputing with the forming bar. Default `False`.
- `needs_volume(cfg) -> bool`: refuses intrabar on a quote-only feed (today's
  VWMA rule). Default `False`.

TRENDLINES keeps its held-line hooks (`resolve_close`, `level_sig`, the
`held`/`slope`/`a1`/`a2` side series) for the `tl_nearest` output only,
behind one optional spec field `alert_side_series(cfg, output, candles)`. No
other indicator uses it.

Warm-up: alerts read `spec.warmup(cfg, output)` for readiness and always
seed `SEED_CAP` bars, so values converge the way the chart's do. Refuse when
`spec.warmup > MAX_WARMUP`. The decay-based warm-up math in `alertable.py`
goes away.

Timeframe: `spec.timeframe(cfg)` (the pane's MTF pin) when set, else the
chart's. Non-native timeframes and the 1m refusal for TRENDLINES stay.

### 3. MA joins the registry

Existing MA/EMA alerts must survive, so phase 1 registers `MA` and `EMA` (one
spec, EMA defaulting `maType: ema`) over `slope.ma_base`, with the pane's
offset and smoothing (`smooth_series`) applied, which also lifts today's
"offset 0, no smoothing" alert refusals. Output name `ma`. `price_scale`
true. It becomes referenceable from rules as `MA.ma` too; the plan checks
`mintInstanceId`'s collision rule so existing EMA/MA instance ids do not get
renamed.

### 4. Frontend asks the backend, mirrors nothing

- `GET /api/alerts/indicators` returns the registry's alertable types once;
  the legend bell and indicator menu show "Add alert" for those types.
- `POST /api/alerts/describe {broker, epic, instance, chartTimeframe}`
  returns `{timeframe, outputs: [{name, label, priceScale}], lastValues,
  refusal?}`, computed by the same spec code over `CANDLE_CACHE`.
- `IndicatorAlertModal` builds from that: an output picker when there is more
  than one (SR above/below, pivot band hi/lo, fib levels, trendline ranks),
  the Compare dropdown only when the chosen output is `priceScale`, the value
  input prefilled from `lastValues[output]` once it arrives (unless typed).
  Refusals show as the existing inline reason.
- The alert list shows the server's `label`, not a frontend-built one.
- Deleted: `lib/alertableIndicators.ts`, `chart/indicatorAlertDraft.ts`'s
  `MAIN_LINE_KEY` lookup, `indicators/alertable.py`, the alertable parity
  fixtures and both parity tests.

### 5. Migration

One `alert_store` migration rewrites stored indicator alerts to the new
shape:

| Old `identity.indicator` | `instance` | `output` |
|---|---|---|
| MA (maType ema/sma/vwma/evwma, source) | `{type: "MA", calcParams: [n], extendData: {maType, source}}` | `ma` |
| RSI (source) | `{type: "RSI", calcParams: [n], extendData: {source}}` | `value` |
| ATR (smoothing) | `{type: "ATR", calcParams: [n], extendData: {smoothing}}` | `str(n)` |
| TRENDLINES | `{type: "TRENDLINES", calcParams: canonical, extendData: {}}` | `tl_nearest` |

`triggered` history rows keep their stored JSON as is (display only).

## Phases

1. **Registry alerts.** Sections 1 to 5. Result: MA/EMA, RSI, ATR,
   TRENDLINES, SLOPE, FVG, PIVOT_BANDS, PIVOT_ANALYSIS, SR_LEVELS, SPIKE and
   AUTO_FIB are alertable, with every output each pane exposes.
2. **Remaining custom indicators**, one registry entry plus its frontend
   `*Outputs.ts` each, which makes them available to rules and alerts at
   once: LR, VWAP, AVWAP, PREV_HL, PIVOT_BARS_SINCE, SLOPE_ACCEL (folded into
   SLOPE if its outputs already are), CANDLE_PATTERNS (`pattern_series`
   exists). SESSIONS and TIME_HIGHLIGHT have no numeric series and stay out.

## Behavior to pin in tests

- A migrated MA/RSI/ATR/TRENDLINES alert fires on the same bar it did before
  (golden values from the current `alertable.compute`).
- An alert and a backtest rule on the same pane read identical series.
- Step outputs (SR, pivot bands, fib levels) jumping between bars: close-mode
  cross is judged as today (prev close vs prev value, cur close vs cur
  value); documented, not special-cased.
- Duplicate check still 409s across the new shape, including two panes whose
  extendData differ only in fields the parser ignores.
- A pane edited so the alerted output no longer exists: the existing
  "delete or keep" prompt fires (`indicatorAlertSync.ts`), driven by
  `describe` instead of `checkAlertable`.
- Quote-only feed refuses intrabar on a `needs_volume` output.

## Out of scope

klinecharts built-in indicators; making the chart draw backend-computed
series (the TS/Python pair stays, pinned by the registry's existing parity
tests).
