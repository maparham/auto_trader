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

The alert copy already reuses the compute functions (`ma_base`,
`rsi_series`, `atr_smoothed_series`), but re-implements validation, refusals,
warm-up and labels for MA, RSI, ATR and TRENDLINES, mirrored again in
TypeScript and pinned by its own parity fixtures
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

On create, the backend stores `instance` CANONICALIZED: a new spec field
`canonical(cfg) -> {calcParams, extendData}` rebuilds the payload from the
parsed config (the pattern `trendlines_config_params` already follows), so
ignored extendData keys and int/float spellings are gone before anything
compares it.

`sig()` (dedup and change detection) is the JSON of `(type, canonical
instance, output, timeframe, target, value, evalOn, condition, trigger)`. Two
panes whose raw extendData differ only in fields the parser ignores are
therefore one alert, and a PATCH that saves an alert's own params never 409s
against itself (the existing `skip_id`).

PATCH: `instance` and `output` are replaced whole, never deep-merged. The
store's shallow `{**params, **patch.params}` merge already does this for a
top-level `instance` key; the plan pins it with a test (a re-synced pane must
not keep a stale extendData key from before).

### 2. Registry spec grows alert fields

`IndicatorSeriesSpec` gains, with defaults so unchanged entries keep working:

- `alert_outputs(cfg) -> dict[str, "level" | "event"]`: which outputs an
  alert may watch, and how. A `level` output takes the normal conditions
  (crossing, greater, ...). An `event` output is a 0/1 impulse series (RSI
  divergences, SPIKE stage flags, FVG/pattern hits): crossing a 0/1 step has
  no meaning, so it takes a single condition, "fires when it happens"
  (value becomes 1 on a closed bar), close mode only. Outputs left out are
  not alertable. Default: no outputs, so a spec opts in explicitly rather
  than every output becoming alertable by accident.
- `alert_refusal(cfg, timeframe) -> str | None`: the per-indicator reasons an
  alert is refused, moved verbatim from `checkAlertable` / `validate_indicator`
  so they live in ONE place: a pin that differs from the alert timeframe
  ("Alerts follow the line's pinned timeframe"), TRENDLINES on 1m, a length
  whose warm-up exceeds `MAX_WARMUP`, an unsupported price source. Generic
  refusals (seconds and non-native timeframes, missing volume) stay in the
  alert kind, once, for every indicator. Default `None`.
- `price_scale(cfg, output) -> bool`: the output lives on the price axis, so
  "Price crosses the curve" is offered. Default `False`.
- `label(cfg, output) -> str`: alert name for the list, toasts, push and
  Telegram ("RSI 14", "SR_LEVELS above", "TL nearest").
- `heavy: bool`: closed values compute off the event loop (today's
  TRENDLINES pool, generalized). Default `False`.
- `needs_volume(cfg) -> bool`: a validate-time refusal of intrabar on a
  quote-only feed (today's VWMA/EVWMA rule in `IndicatorKind.validate`,
  unchanged in when it runs). Default `False`.

Intrabar, per output, unchanged from today where today exists:

- Light specs recompute with the forming bar appended, at most once a
  second (`_INTRABAR_SECONDS`), exactly as MA/RSI/ATR do now.
- TRENDLINES `tl_nearest` keeps projecting the held line (`v + s`). Its
  held-line hooks (`resolve_close`, `level_sig`, the `held`/`slope`/`a1`/`a2`
  side series) move behind one optional spec field
  `alert_side_series(cfg, output, candles)`; no other indicator uses it.
- Other heavy outputs (SR_LEVELS, PIVOT_BANDS, AUTO_FIB, FVG, TRENDLINES
  ranks) are step levels that only change on a close, so intrabar reads the
  last closed value; no recompute per tick.

Warm-up: readiness is `spec.warmup(cfg, output)`, the registry's "first
honest value" count, and the hub seeds `min(SEED_CAP, max(need + 50,
ALERT_SEED_FLOOR))` bars, with `ALERT_SEED_FLOOR` (500) giving recursive
averages (EMA, RMA) room to converge the way today's decay counts did. The
decay math in `alertable.py` goes away. A migrated alert may therefore see a
value that differs in the far decimals from today's; the golden tests below
compare with a tolerance, not exact equality.

Timeframe: `spec.timeframe(cfg)` (the pane's MTF pin) when set, else the
chart's. Non-native timeframes and the 1m refusal for TRENDLINES stay.

### 3. MA joins the registry

Existing MA/EMA alerts must survive, so phase 1 registers `MA` and `EMA` (one
spec, EMA defaulting `maType: ema`) over `slope.ma_base`, with the pane's
offset and smoothing (`smooth_series`) applied, which also lifts today's
"offset 0, no smoothing" alert refusals. Output name `ma`. `price_scale`
true.

Instance ids: `mintInstanceId` (`frontend/src/lib/indicators.ts`) refuses the
bare name for a type that is in `EXPR_INSTANCE_TYPES` and is also an expr
function name (that is why a new ATR pane mints `ATR1`). EMA and MA are expr
functions, so MA/EMA must NOT join `EXPR_INSTANCE_TYPES`: they are registered
on the backend (for alerts) but stay out of the rule editor's instance list,
where rules keep spelling them `EMA(9)`. New panes keep minting `EMA`/`MA`,
and existing `link.instanceId`s stay valid. Alertability on the frontend
comes from the backend's list (section 4), not from `EXPR_INSTANCE_TYPES`, so
the two sets are free to differ.

### 4. Frontend asks the backend, mirrors nothing

- `GET /api/alerts/indicators` returns the registry's alertable types once;
  the legend bell and indicator menu show "Add alert" for those types.
- `POST /api/alerts/describe {broker, epic, instance, chartTimeframe}`
  returns `{timeframe, outputs: [{name, label, kind: "level"|"event",
  priceScale}], lastValues, refusal?, needsVolume}`. `lastValues` comes from
  the alert hub itself (`IndicatorHub`: same loader, same seed size, same
  spec call), joining an existing series when one is live, so the prefilled
  number is the one the engine will evaluate. It never computes over a
  different window.
- `IndicatorAlertModal` builds from that: an output picker when there is more
  than one (SR above/below, pivot band hi/lo, fib levels, trendline ranks),
  the Compare dropdown only when the chosen output is `priceScale`, the
  sentence row collapses to "<output> happens" for an `event` output, the
  value input prefilled from `lastValues[output]` once it arrives (unless
  typed). Refusals show as the existing inline reason. "As it happens" is
  disabled for an event output, and for a `needsVolume` one on a quote-only
  feed (today's `volumeWeighted` check, now server-said).
- `priceTarget`, `priceOnly` and `volumeWeighted` in the modal are replaced by
  `priceScale`, the TRENDLINES "price only" case being simply "this output is
  priceScale and has no value form" (`alert_outputs` marks `tl_nearest`
  price-only).
- The alert list shows the server's `label`, not a frontend-built one.
- `chart/indicatorAlertDraft.ts` shrinks to "this pane's `{type,
  calcParams, extendData}` + link + chart timeframe"; it no longer reads the
  klinecharts result (whose keys, `ma`/`val`/`atr`, are not registry output
  names), since `describe` supplies the values.
- Deleted: `lib/alertableIndicators.ts`, `indicators/alertable.py`, the
  alertable parity fixtures and both alertable parity tests. The registry's
  own parity tests (outputs, warm-ups) stay and are the only guard needed,
  because the frontend no longer mirrors any alert rule.

### 5. Migration

One `alert_store` migration rewrites stored indicator alerts to the new
shape:

| Old `identity.indicator` | `instance` | `output` |
|---|---|---|
| MA (maType ema/sma/vwma/evwma, source) | `{type: "MA", calcParams: [n], extendData: {maType, source}}` | `ma` |
| RSI (source) | `{type: "RSI", calcParams: [n], extendData: {source}}` | `value` |
| ATR (smoothing) | `{type: "ATR", calcParams: [n], extendData: {smoothing}}` | `str(n)` |
| TRENDLINES | `{type: "TRENDLINES", calcParams: canonical, extendData: {}}` | `tl_nearest` |

Migrated `instance`s go through `canonical()` like a fresh create. RSI's
`lookbackLeft`/`lookbackRight` and ATR's `pctSource` take their defaults;
neither changes the migrated output (`value`, `str(n)`).

`triggered` history rows keep their stored JSON. Anything that reads an
alert back OUT of a triggered row to act on it (re-arm, "edit this alert")
goes through one `upgrade_params(kind, params)` helper, the same function the
migration uses, so an old-shape row is upgraded on read rather than failing.

## Phases

1. **Registry alerts.** Sections 1 to 5. Result: MA/EMA, RSI, ATR,
   TRENDLINES, SLOPE, FVG, PIVOT_BANDS, PIVOT_ANALYSIS, SR_LEVELS, SPIKE and
   AUTO_FIB are alertable, on the outputs each spec's `alert_outputs` opts in.
2. **Remaining custom indicators**, one registry entry plus its frontend
   `*Outputs.ts` each, which makes them available to rules and alerts at
   once: LR, VWAP, AVWAP, PREV_HL, PIVOT_BARS_SINCE, SLOPE_ACCEL (folded into
   SLOPE if its outputs already are), CANDLE_PATTERNS (`pattern_series`
   exists). SESSIONS and TIME_HIGHLIGHT have no numeric series and stay out.

## Behavior to pin in tests

- A migrated MA/RSI/ATR/TRENDLINES alert reads the same series as before
  within a 1e-6 relative tolerance over a 2000-bar fixture (golden values
  captured from the current `alertable.compute` before it is deleted), and
  fires on the same bar on those fixtures.
- An alert and a backtest rule on the same pane read identical series.
- Step outputs (SR, pivot bands, fib levels) jumping between bars: a
  close-mode cross is prev close vs prev value, cur close vs cur value, the
  same rule as every other level output; documented, not special-cased.
- An `event` output fires once on the closed bar where it becomes 1, never
  on "crossing", and refuses intrabar.
- Duplicate check 409s on the new shape, including two panes whose
  extendData differ only in fields the parser ignores, and `3` vs `3.0` in
  calcParams; self-PATCH never 409s.
- PATCH replacing `instance` drops extendData keys the old one had.
- A new EMA/MA pane still mints the bare `EMA`/`MA` id.
- `describe`'s `lastValues[output]` equals the hub's value for the same key.
- A triggered row in the old shape upgrades on read.
- A pane edited so the alerted output no longer exists: the existing
  "delete or keep" prompt fires (`indicatorAlertSync.ts`), driven by
  `describe` instead of `checkAlertable`.
- Quote-only feed refuses intrabar on a `needs_volume` output.

## Out of scope

klinecharts built-in indicators; making the chart draw backend-computed
series (the TS/Python pair stays, pinned by the registry's existing parity
tests).
