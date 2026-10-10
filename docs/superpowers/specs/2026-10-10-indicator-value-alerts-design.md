# Indicator value alerts

Status: implemented 2026-10-13 (sub-project 1 of 3).

## Accepted deviations

The implementation departs from this document in a few places, each
accepted as a plan-level design choice during execution (ledger rulings
D1 to D5 and F17). The sections below still read as originally designed.

- **D1, kind protocol.** `AlertKind` exposes `series_needs` and
  `resolve(params, ctx)` rather than the exact methods sketched under
  "Types and contracts". The split of work is the same.
- **D2, frontend types.** `SavedAlert` stays the price-alert type; indicator
  alerts are a separate `IndicatorAlert` (with `params`) and `AnyAlert` is
  their union, instead of one unioned `SavedAlert` with an `indicator` field.
- **D3, chart bell.** The bell is a DOM pill at the right axis (the shared
  axis-tag path), not drawn in the MA draw callback. The visual intent is
  the same.
- **D4, alert lines.** Price and indicator alert lines share helper
  functions rather than a shared base class, because the overlay mixin chain
  does not admit one cleanly.
- **D5, retries and logging.** A failed history load retries on a fixed
  5 s interval rather than the feed's backoff, is logged once until it next
  succeeds, and a series reseeds on a bar GAP rather than on a feed
  reconnect.
- **F17, first seed.** A series' first seed (up to 2000 bars) runs as a
  background task, so it never stalls price alerts on the same feed.
- **Entry label.** The legend and menu entry reads "Add alert", not the
  "Add alert on <indicator label>" example under "Creating"; the dialog
  names the indicator.

## Context

Alerts today are price-level only (`kind = 'price_level'`), evaluated
server-side per tick by `core/alert_engine.py`. The 2026-09-06 backend alert
engine spec reserved a `kind` discriminator and JSON `params` for future
drawing and indicator kinds.

The user wants alerts on indicators and drawings. That splits into three
sub-projects, built in this order, each with its own spec and plan:

1. **Indicator value alerts (this spec).** Price vs an indicator line, and an
   indicator vs a number. Introduces moving levels, server-side candles and
   the once-per-bar rule.
2. Indicator event alerts: FVG formed/filled, SR level break, auto-trendline
   break, pivot and spike signals.
3. Drawing alerts: trend line / ray / extended line, horizontal line,
   parallel channel, rectangle; alert follows the drawing.

Sub-projects 2 and 3 reuse the candle builder and the per-kind resolver
introduced here.

## Goals

- Price crosses / is above / is below an indicator line, on the moving
  averages (EMA and MA templates).
- An indicator line crosses / is above / is below a number, on RSI, ATR
  and the moving averages.
- Native timeframes only: 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W.
- Per-alert evaluation timing: on bar close (default) or intrabar.
- "Every time" alerts fire at most once per bar, for price alerts too.
- Alerts keep firing with no browser open, like price alerts.
- The alert follows edits to its indicator's settings; removing the
  indicator asks whether to delete its alerts.

## Deferred to a follow-up

Cut from v1 to keep it small. Each shows as a disabled "Add alert" with a
tooltip ("Alerts on <X> are coming later"), so nothing fires wrongly in
the meantime. The design notes below are kept so the follow-up does not
start from zero.

1. **Non-native timeframes** (2H, 3m, 6H, ...). History exists only for
   the native resolutions (`Resolution`, MINUTE..WEEK,
   `core/models.py:18`). The follow-up reads the native base through
   `CANDLE_CACHE.recent` and folds it with `core/candle_aggregate.py`
   (`rule_for`, `fold`), the code the candles API uses, so buckets
   (including the daily 00:00 UTC reset) match the chart; seed and
   tail-refresh sizes scale by the fold ratio.
2. **Bollinger Bands and MACD.** Need `boll_series` and `macd_series` in
   `indicators/core.py`, multi-line support (`upper/middle/lower`,
   `macd/signal/hist`), and parity fixtures generated from klinecharts'
   own built-in `BOLL` and `MACD` calc functions. Validation: BOLL
   `[length 2..1000, mult 0.1..10]`, target=price allowed; MACD
   `[fast, slow, signal]` ints 1..1000 with fast < slow, value only,
   warm-up the slow EMA's figure plus the signal EMA's, running state the
   three EMAs. "MACD histogram crosses 0" is how MACD-crosses-signal is
   expressed.
3. **AVWAP.** Needs an explicit `config.anchor` (int ms > 0; missing is a
   422), `avwap_series` extended to take `source`, anchor inside the seeded
   history (older than the cap is a 422), cumulative sums as running state,
   and the zero-volume and quote-only rules below. Plain VWAP stays out
   even then (see Non-goals).

## Non-goals

- Indicator vs indicator (EMA 20 crosses EMA 50).
- Plain VWAP. The chart's `vwapFrom` accumulates from the first loaded bar
  with no session reset, so its value depends on how much history the chart
  happened to load and the server cannot reproduce it. AVWAP (deferred)
  covers the use case. Plain VWAP returns when it gets a defined anchor
  (session or explicit).
- Indicator configurations whose output the server does not reproduce (see
  "Alertable configurations"). Their "Add alert" entry is disabled with a
  tooltip naming the reason.
- Creating indicator alerts from the alert dialog's own picker. The entry
  point is the indicator itself.
- Drawing the indicator line in the Telegram chart image. The snapshot
  stays as today: price chart only, from the alert's `timeframe`.
- Event alerts and drawing alerts (sub-projects 2 and 3).
- The deferred items above.

## User experience

### Creating

- Right-clicking an indicator line, or clicking a bell button in the
  indicator's legend row, offers "Add alert on <indicator label>". It is
  shown for alertable types and disabled (with a tooltip giving the reason)
  for a non-alertable configuration of an alertable type.
- It opens the existing `AlertModal` in indicator mode, prefilled with the
  indicator's resolved identity (see Data model), its link, the chart's
  current timeframe, and the last value of the chosen line.

### The dialog in indicator mode

- **Target**: "Price vs line" or "Value vs number". Moving averages offer
  both; oscillators (RSI, ATR) offer only "Value vs number".
- **Line**: v1 indicators are all single-line, so no line picker yet
  (`line` is always `value`; the field exists for BOLL/MACD later).
- **Condition**: the existing five (crossing, crossing up, crossing down,
  greater, less).
- **Number**: shown for "Value vs number", prefilled with the line's current
  value.
- **Evaluate**: "On bar close" (default) or "As it happens". "As it
  happens" is disabled for volume-weighted MAs (VWMA, EVWMA) on quote-only
  brokers (see Feed data).
- **Trigger**: "Once" or "Once per bar". Message, expiry and notify are
  unchanged from price alerts.
- The timeframe is fixed at creation and shown read-only ("EMA 50 · 1H").
  A later chart timeframe change does not touch the alert.

### On the chart

- "Price vs line" alerts: a small bell marker on the indicator line at the
  right edge, in the main pane.
- "Value vs number" alerts: a dashed horizontal line at the number in the
  indicator's own pane (for example 70 in the RSI pane), reusing the alert
  line style. Dragging it updates the number.
- Markers only render on the chart cell the alert is linked to, and only
  while that cell shows the alert's broker, epic and timeframe. Price
  alerts keep today's ownership: drawn on every chart of their
  broker/epic, whatever the timeframe.

### Sync with the indicator

- Changing the linked instance's output-relevant settings re-resolves its
  identity and PATCHes each linked alert (one `PATCH /api/alerts/{id}` per
  alert; an instance rarely carries more than a few, so no bulk endpoint).
  If the new settings are not alertable, the confirm reads "These settings
  can't be alerted on. Delete its N alerts, or keep them on the old
  settings?"; keeping clears the link.
- Removing the instance opens a confirm: "Also delete its N alerts?" Yes
  deletes them; No leaves them running on their last settings with the link
  cleared.

### Panel and notifications

- The alerts panel row, the fired list and notifications read like "Price
  crossed above EMA 50 (1H) at 21,430" or "RSI 14 (1H) closed above 70".
- An alert that cannot evaluate shows "waiting for data": history failed
  to load, not enough bars to warm up, the market feed is down, or the
  series is reseeding (reconnect, gap, larger warm-up).
- Telegram chart snapshots work unchanged (price only, see Non-goals).

## Data model

### Alert params

New kind `indicator`. Example `params`:

```json
{
  "indicator": "MA",
  "calcParams": [50],
  "config": { "maType": "ema", "source": "close" },
  "line": "value",
  "timeframe": "HOUR",
  "target": "price",
  "value": null,
  "condition": "crossing_up",
  "trigger": "once",
  "evalOn": "close",
  "link": { "scope": "tab.t1.cell.c2", "instanceId": "EMA" }
}
```

- `indicator`: canonical identity, one of `MA, RSI, ATR` in v1
  (`AVWAP, BOLL, MACD` deferred).
  The EMA and MA chart templates both map to `MA`; the computed kind lives
  in `config.maType`, resolved at creation with `normalizeMaKind` against
  the template's default (so an "EMA" template with `maType: "sma"` is
  stored as `MA` / `sma`). The label is rebuilt from that (`maLegendLabel`).
- `config`: the output-relevant `extendData` fields, per indicator (see
  matrix). Nothing cosmetic is carried.
- `link`: `{scope, instanceId}`. `mintInstanceId`
  (`frontend/src/lib/indicators.ts:374`) gives the first instance of a type
  its bare name in every cell, so `instanceId` alone collides across cells;
  `scope` is the cell scope string the indicator's config is persisted
  under (`ns(scope, "indicators")`). Optional; cleared on "keep alerts".
- `timeframe`: required, canonicalized like price alerts, and must be
  native (`timeframe.is_native`): MINUTE, MINUTE_5, MINUTE_15, MINUTE_30,
  HOUR, HOUR_4, DAY, WEEK. Anything else, including `SECOND_*`, is a 422.
  On a non-native chart "Add alert" is disabled with "Alerts on this
  timeframe are coming later"; on a seconds chart it is hidden.
- `target`: `price` or `value`. `value`: finite number when
  `target = value`, else null.
- `evalOn`: `close` or `intrabar`.

### Validation matrix

| indicator | calcParams | config | lines | target=price |
|---|---|---|---|---|
| MA | `[length]`, int 1..1000 | `maType` in `ema, sma, vwma, evwma`; `source` in `close, open, high, low, hl2, hlc3, ohlc4` | `value` | yes |
| RSI | `[length]`, int 2..1000 | `source` as MA (default `close`) | `value` | no |
| ATR | `[length]`, int 1..1000 | `smoothing` in `rma, sma, ema, wma` (default `rma`) | `value` | no |

Strict typing as in the `price_level` branch (no bools or numeric strings;
finite numbers only). Anything outside the matrix is a 422 naming the field.
An alert whose warm-up exceeds the seed cap is also a 422 ("length too long
for alerts").

### Alertable configurations

The chart instance must reproduce on the server. Disabled (with tooltip) when:

- MA: `extendData.mtf.timeframe` is set (MTF line), `offset` is non-zero,
  or smoothing is not "none". The envelope bands are not offered as lines
  (the base line still is).
- Volume-weighted MAs (`vwma`/`evwma`) on a market whose recent bars all
  carry zero volume: Capital CFD and forex epics report `lastTradedVolume`
  0, so the line is meaningless there. Tooltip: "This
  market has no volume data."

The rules live in one shared definition per side
(`indicators/alertable.py`, new; `lib/alertableIndicators.ts`, new) with a
test asserting the type lists, lines and config keys match.

### Types and contracts

`frontend/src/lib/alertsApi.ts`: `SavedAlert` becomes a union on `kind`:

```ts
type SavedAlert = PriceAlert | IndicatorAlert;
interface PriceAlert { kind: "price_level"; id; level; condition; trigger; message; expiresAt?; notify?; createdAt?; startAtCreation?; timeframe? }
interface IndicatorAlert { kind: "indicator"; id; condition; trigger; message; expiresAt?; notify?; createdAt?; indicator: IndicatorAlertParams; status?: "ok" | "waiting_for_data" }
```

Rows from the backend with no `kind` are read as `price_level`, so existing
stored alerts and code paths keep working. No indicator rows exist before
this ships, so the indicator params have no legacy defaults; the backend
validates them on every write.

`triggered` history: `level` stores the line value at fire time for
`target = price`, the number for `target = value`; `price` stores the price
(or the closed bar's close, see Evaluation). `_list_triggered_sync`
(`core/alert_store.py:304`) adds `alert_json` to its SELECT and the route
returns it parsed as `alert`, so the fired list can label indicator rows.
No schema migration (the column exists).

`__alerts__:fired` payload (`_fire`, `core/alert_engine.py:634`) keeps every
current key and adds:

- `label`: display label, e.g. `"EMA 50 (1H)"`, `"RSI 14 (1H)"`. Price alerts: absent.
- `target`: `"price" | "value"` (indicator only).
- `subject`: the compared value at fire time (price, or the line value
  for `target = value`).
- `evalOn`: `"close" | "intrabar"` (indicator only).

`level` keeps its meaning above. `_fire` today reads `params["level"]`,
which indicator alerts do not have, and `triggered.level` is NOT NULL
(`core/alert_store.py:51`), so `_fire` takes the resolved `(subject, level)`
pair from the evaluator as arguments and writes those for both kinds
(price-level passes `(price, params.level)`, so its rows are unchanged).
Telegram and push text use `label` when present.

## Backend architecture

New files: `core/alert_bars.py` (thin: forming bar, bar clock, refcounted
series registry; no storage or fetching of its own),
`core/alert_indicators.py`, `indicators/alertable.py`. Changed: `core/alert_engine.py`,
`core/alert_eval.py`, `core/alert_store.py`, `api/routers/alerts.py`,
`indicators/core.py`, the broker stream adapters' bar type (no new fields,
just passed through).

### Feed data

Today `_stream_feed` calls `on_tick(broker, epic, bar.candle.close, bar.bid,
bar.ask)` (`core/alert_engine.py:372`), dropping OHLC and volume, and every
stream is requested as `"mid"`.

- The engine passes the whole sample: `on_tick(broker, epic, mid, bid, ask,
  *, t_ms=None, bar=None)` keeps its positional signature (every existing
  caller and test still works) and gains keyword-only `t_ms` (sample time,
  default now) and `bar` (the stream's 1-minute `Candle`, with OHLC and
  volume). Stream feeds pass both; poll feeds pass `t_ms` only.
  Price-level evaluation reads `mid/bid/ask` exactly as today.
- **Forming bar.** Built from samples. For a bid or ask price side the
  forming bar's OHLC is the mid OHLC shifted by the latest half-spread
  (`bid - mid` or `ask - mid`). This only feeds intrabar evaluation.
- **Closed bars always come from the candle cache.** Seeding and every
  bar-close tail refresh go through `CANDLE_CACHE.recent(key, res_seconds,
  count, fetch_recent)` (`core/candle_cache.py:790`), keyed by
  `(broker, epic, resolution, price_side)`, with the broker's
  `get_recent_candles` as `fetch_recent`. That is the same path and SQLite
  cache the charts read, so the server sees the bars the chart sees
  (including read-time repair), and an alert series and an open chart on
  the same market share fetches. It gives correct side, OHLC and real
  volume for every broker, poll or stream, and for every indicator. If the
  call reports `degraded` (broker fetch failed, cached bars served) or
  raises, the series stays at the previous close, goes `waiting_for_data`,
  and the bar close is retried with the feed's backoff; no alert evaluates
  a closed bar built from samples. `CandleAccumulator` is not involved: it
  is view-driven deep backfill, which alerts do not need.
- **Quote-only brokers** (poll feeds) have no live volume, so the forming
  bar's volume is unknown. Volume-weighted outputs (VWMA, EVWMA) on
  those brokers allow only `evalOn = close`: the dialog disables "As it
  happens" and the API 422s `intrabar` for them.
- Indicator series are native timeframes only in v1 (non-native deferred).
- One `BarSeries` per (broker, epic, resolution, price side), shared and
  refcounted; dropped when its last alert goes. On feed reconnect or a
  skipped period it reseeds before evaluating further closes.

### Seeding

- Seed size: `min(max(warmup over the series' alerts) + 50, 2000)`, via
  `CANDLE_CACHE.recent`. Adding an alert with a larger warm-up reseeds the
  series. Warm-up above 1950 bars is rejected at create.
- Readiness is defined per indicator, by what makes the server's value
  equal the chart's:
  - Window kinds (MA `sma`/`vwma`): exact once `length` bars exist.
  - ATR: exact once `length + 1` bars exist (Wilder seed needs a prior
    close).
  - Recursive kinds (MA `ema`/`evwma`, RSI) depend on where the series
    starts, and the chart starts them at its first loaded bar, so the two
    only agree after the start's influence decays. Ready once the decay
    term is below 0.1% of the value: for an EMA with `alpha = 2/(n+1)`
    that is `ceil(ln(0.001) / ln(1 - alpha))` bars (about `3.45 * n`);
    RSI uses Wilder's `alpha = 1/n` (about `6.9 * n`); EVWMA uses its own
    decay from volume. The parity tests check values within that tolerance, not
    bit-equal, for these kinds.
- The seed formula above uses these figures as `warmup`.
- Until warm, the alert's status is `waiting_for_data` and it never fires.

### Indicator computation

- `core/alert_indicators.py` computes each distinct (series, indicator,
  calcParams, config) once per bar close (after the tail refresh) by
  calling the existing batch function over the closed bars, and caches the
  last value per line.
- Intrabar values call the same batch function over closed bars plus the
  forming bar, at most once per second per (series, indicator); samples in
  between reuse the last result. The series is capped at 2000 bars and the
  batch functions are single loops, so one call is well under a
  millisecond. This needs no second implementation of any indicator and no
  change to `indicators/core.py`, which backtests also use.
- Uses the existing `indicators/core.py` functions only: `ema_series`,
  `sma_series`, `vwma_series`, `evwma_series`, `price_of`, `rsi_series`,
  `atr_series`. No new indicator math in v1.
- Parity source of truth: MA kinds and sources from
  `lib/indicators/ma.ts`; RSI and ATR from their `lib/indicators/*.ts`
  templates.

### Evaluation

- Each kind supplies a resolver returning `(subject, level)` for a sample:
  `price_level` gives `(price, level)`; `indicator` gives `(price, line)`
  for `target = price` and `(line, value)` for `target = value`.
- **Intrabar** (`evalOn = intrabar`, and all price-level alerts): evaluated
  per sample against the forming bar. `prev` advances on every sample, as
  today.
- **On bar close** (`evalOn = close`): evaluated once per closed bar.
  `subject` for `target = price` is the closed bar's close; the line is its
  closed-bar value. The previous pair is the closed bar before it (close
  and line value from the hub), so ticks between closes never move the
  crossing baseline and a restart needs no saved baseline.
- `evaluate_alert` (`core/alert_eval.py`) takes `(prev_subject, prev_level,
  subject, level)` instead of price vs a fixed level. A crossing compares
  signs of the gaps: `before = sign(prev_subject - prev_level)`,
  `now = sign(subject - level)`. Crossing up is `before <= 0 < now`,
  crossing down `before >= 0 > now` (the `<=`/`>=` keep today's touch
  semantics). Because both sides move, this catches a rising line crossing
  a flat price, not just price crossing a flat line. `greater`/`less`
  compare `subject` with `level` on the current pair only.
- `_alert_sig` covers every param that changes the comparison (indicator,
  calcParams, config, line, target, value, timeframe, evalOn, condition,
  trigger), so an edit resets the baselines.
- `_fire` adds the payload keys listed under "Types and contracts".

### Once per bar

Replaces the 5 bps re-arm (`RE_ARM_FRACTION` and the `armed` band) for
`trigger = every`, on both kinds. This changes existing "every" price
alerts on deploy; their stored params are unchanged. Each uses the chart
timeframe it was saved with; alerts saved without one (older rows, or
created where no timeframe was passed) get 1-minute bars. The release
note says: "'Every time' alerts are now 'Once per bar': they fire at most
once per candle of the timeframe they were created on (1 minute if none
was recorded)."


- **One bar clock.** `period_start(time_ms, resolution)` (new, in
  `core/alert_bars.py`) is the only definition of a bar. It wraps
  `candle_aggregate.bucket_open` with `rule_for(resolution)`, so bars align
  exactly as the candles API buckets them. The candle builder uses it to
  close bars; price-level alerts use it on the sample time. It is only a
  clock, so price alerts created on a non-native chart (2H) still get
  correct once-per-bar buckets in v1; only indicator series are
  native-only.
- **Timeframe fallback.** Price-level alerts use their `timeframe` param.
  Missing, or below 1 minute: 1 minute.
- **Rule.** After firing, the alert records `lastFiredBar` (the bar's open
  time) and ignores every sample in that bar. From the next bar on:
  - crossing conditions need a fresh cross (previous pair on one side,
    current on the other);
  - `greater`/`less` fire again on the first sample of each new bar where
    the condition holds, i.e. once per bar while true (user's choice;
    matches TradingView).
- `evalOn = close` is naturally once per bar.
- **Restarts.** `lastFiredBar` is not stored separately. On engine start it
  is rebuilt from the `triggered` table (latest fire time per alert, mapped
  through `period_start`), so a restart inside a bar cannot double-fire.
- UI: the trigger option reads "Once per bar", with an `InfoTip`:
  "Fires at most once per candle" / "Uses the alert's timeframe".
- `core/alert_eval.py`'s module docstring still calls it a port of
  `frontend/src/lib/alertEval.ts`, which no longer exists; it is rewritten
  to describe the module as the single implementation.

### Price side

Indicator series use the user's `priceSide` setting, the same one price
alerts already read from `STATE_STORE`, so the server's line matches the
chart. A `priceSide` change moves the user's alerts to the matching series.

### Status reporting

- Per-alert status: `ok` or `waiting_for_data`. It lives only in the
  engine (in memory, never in the alerts table). `GET /api/alerts` merges
  the engine's cached value in at read time, defaulting to
  `waiting_for_data` for an indicator alert the engine has not registered
  yet and omitting it for price alerts.
- A status change is broadcast on `__alerts__:changed` only after it has
  held for 10 seconds, so a brief reseed does not flicker the panel.

## Frontend changes

- `lib/alertsApi.ts`: the `SavedAlert` union, indicator params type, helpers
  to list alerts by `link`.
- `lib/alertableIndicators.ts` (new): alertable types, lines, the
  config-to-identity resolver and the "why not alertable" reasons.
- `AlertModal.tsx`: indicator mode (target, line, number, evaluate) and the
  "Once per bar" label.
- Indicator context menu and legend: "Add alert" entry and bell, disabled
  with a `Tooltip` reason when not alertable.
- Indicator settings save path: re-resolve identity, PATCH linked alerts,
  or confirm when the new settings are not alertable. Indicator removal:
  confirm, then delete or unlink.
- Chart rendering. `OverlayAlerts` (`lib/overlays/alerts.ts`) only manages
  price-pane horizontal lines keyed by price level, so it is not reused as
  is:
  - "Value vs number" lines: a new `OverlayIndicatorAlerts` class beside
    `OverlayAlerts`, creating the same klinecharts horizontal overlay with
    `paneId` set to the linked indicator's pane, styled with the shared
    `ALERT_LINE_*` constants. Drag and hit-testing reuse `useLineDrag`
    with the pane's y-axis; a drag PATCHes `value`.
  - "Price vs line" bells: drawn by the linked indicator's own draw
    callback (the MA templates already custom-draw), as a
    small bell glyph at the line's last plotted point, read from a per-cell
    map of linked alerts. No overlay, so it follows the line for free.
  - `OverlayAlerts` filters to `kind = price_level` so indicator alerts
    never render as price lines. Its signature comment at
    `lib/overlays/alerts.ts:286` (`level|condition|trigger`) is updated to
    point at the backend `_alert_sig`, which now covers indicator params.
- `AlertsSidebar.tsx` and `mobile/MobileAlertsView.tsx`: labels from
  params or the fired `alert`, and the waiting status.
- Tooltips use the shared `Tooltip`/`InfoTip`; no em dashes in UI text.

## Design principles: no duplication, SOLID

Duplication is removed where it saves real code or a second place to keep
in sync; small local repetition is fine when sharing would add coupling.

- **One indicator implementation per side.** Closed and intrabar values
  both come from the existing batch functions in `indicators/core.py`
  (intrabar = same call with the forming bar appended, throttled to once a
  second). No stepper or incremental copy of any indicator is written.
- **Open/closed alert kinds.** The engine depends on an `AlertKind`
  protocol (`validate(params)`, `series_needs(params)`,
  `resolve(params, ctx) -> (subject, level) | None`, `label(params)`,
  `sig(params)`), with a registry keyed by `kind`. `price_level` and
  `indicator` are two implementations; event and drawing alerts
  (sub-projects 2 and 3) add a kind without touching the engine, the
  evaluator or `_fire`. `_validate_params`' per-kind branches move into
  the kinds.
- **Single responsibility.** `alert_bars` owns bars and the bar clock,
  `alert_indicators` owns indicator state, `alert_eval` owns the
  crossing / once-per-bar decision, the engine only wires feeds to kinds
  and fires. None of them touches storage except through `AlertStore`.
- **One evaluator.** Price and indicator alerts go through the same
  `evaluate_alert` and once-per-bar rule; there is no indicator-specific
  firing path.
- **One label formatter per side.** The backend builds `label` once (in the
  kind) and every notifier (push, Telegram, fired payload) uses it. The
  frontend has one `alertLabel(alert)` used by the sidebar, mobile view,
  toasts and the modal title.
- **Shared alert-line base on the chart.** `OverlayIndicatorAlerts` and
  `OverlayAlerts` share an extracted base for create / style / select /
  drag / reconcile, parameterized by pane and by the value being dragged
  (price `level` or indicator `value`), instead of copying the 500-line
  class.
- **Modal composition.** `AlertModal` keeps the shared fields (condition,
  trigger, message, expiry, notify) and takes a small target section
  component (`PriceTarget`, `IndicatorTarget`), not a branch per field.
- **Parity harness.** One generic fixture runner per side reads every
  `indicator_parity/*.json`; adding an indicator adds a fixture, not a
  test file.
- **Deliberate duplicate.** The alertable-indicator definition exists on
  both sides (`indicators/alertable.py`, `lib/alertableIndicators.ts`)
  because the backend must validate independently and the two deploy
  separately; a committed-JSON parity test keeps them identical.

## Error handling

- Invalid params: 422 naming the field.
- History load failure: alert stays `waiting_for_data`, retried with the
  feed's backoff, logged once per series.
- Indicator computation exception: logged with the series key, series
  marked `waiting_for_data`; it never escapes into the feed loop.

## Testing

- Parity goldens: MA kinds and sources vs `ma.ts`; RSI and ATR vs their
  templates. Each is a committed JSON
  fixture (`backend/tests/fixtures/indicator_parity/*.json`: input candles,
  params, expected series) written by a frontend script and read by both a
  vitest test (the TS side still produces it) and a pytest test (Python
  matches it), so neither side needs the other's runtime in CI.
- `alert_bars`: `period_start` alignment vs the candles API (native, plus
  derived for the price-alert clock), seeding size, bar close on period
  roll, closed bars replaced from history, fetch failure holds the close,
  gap reseed, bid/ask shift of the forming bar.
- Intrabar throttle: at most one batch call per second per (series, indicator).
- `_fire` writes the line value into `triggered.level` for indicator alerts.
- Engine with synthetic data: close vs intrabar, separate close baseline,
  crossing needs two pairs, once per bar for both kinds, greater/less fire
  once per bar while true, warm-up blocks firing, sig change resets,
  `lastFiredBar` rebuilt from `triggered` after restart.
- API: validation matrix, non-native timeframe and `SECOND_*` refused,
  deferred indicator types refused, warm-up cap, intrabar refused for volume-weighted
  outputs on quote-only brokers, `list_triggered` returns `alert`.
- Alertable-set parity (Python vs TypeScript), via the same committed-JSON
  pattern.
- `backend/tests/test_alert_eval.py`: the re-arm cases
  (`test_every_rearm_after_clearing_level`,
  `test_greater_rearm_only_when_condition_false_again`,
  `test_less_rearm_above_level_plus_margin`,
  `test_zero_level_has_margin_floor`, `test_disarmed_does_not_fire`) are
  rewritten as once-per-bar cases; new cases for a moving line crossing a
  stationary price (up and down) and for touch-without-cross with both
  sides moving.
- Frontend (affected files only): modal indicator mode, disabled-entry
  reasons, link keyed by scope + instanceId, settings change and removal
  confirms.
- `scripts.alert_probe` gains `--indicator` to create a real indicator alert
  and watch it end to end.
