# Dukascopy as a deep-history data source

Date: 2026-07-15
Status: Implemented (see addendum at end)

## Problem

Our brokers (Capital, IG, MT5/AvaTrade) only retain a rolling window of
low-timeframe candles. A 1-minute series may only reach back days to weeks, so
backtests and sweeps that want years of 1m history have nothing to run on: the
old bars were never available to us and are gone from the broker.

Dukascopy Bank publishes free historical tick data back to ~2003 for FX,
metals, and indices, aggregatable to 1-minute (and higher) bars. We want that
depth available as a first-class data source: chartable (pan back years) and
usable for backtests/sweeps, without disturbing the live brokers.

The backend already has a broker-agnostic, persistent closed-bar cache
(`core/candle_cache.py`, keyed `(broker, epic, resolution, side)`, with a
coverage-safe `backfill_below` walk) and a documented broker-extension path
("implement the ABCs + `register()`, no route/wiring edits"). This design plugs
Dukascopy into both.

## Chosen approach

A new **read-only `dukascopy` data broker** registered alongside the others.
This was chosen over the alternative of seeding Dukascopy history *under* an
existing broker's cache key (the "blend into my live broker" option), because:

- The cache is keyed by `(broker, epic, resolution, side)`, so a `dukascopy`
  broker gets its own namespace for free: no collision with Capital/IG/MT5 rows,
  clean provenance.
- It rides the existing extension path with no route edits.
- It avoids a **feed seam**. Blending would union two different price feeds under
  one `[oldest, newest]` coverage watermark, corrupting the single-oldest/newest
  contiguity model and showing a visible price discontinuity where Dukascopy
  history meets the broker's recent bars.

The unavoidable tradeoff the user accepted: **Dukascopy's price series is not
your broker's.** For FX majors and metals the OHLC differ only by fractions of a
pip (structurally faithful). For index CFDs (a broker's US500/US30 cash CFD) the
pricing, session boundaries, and dividend handling differ meaningfully, so those
backtests are approximate and stop/target levels won't map 1:1. Indices are
still in v1 scope by user decision, but the catalogue marks them approximate.

## Non-goals / decisions

- **Data-only broker.** `supports_streaming = False`; `get_quote` returns
  `(None, None)`. Consequences, accepted explicitly:
  - No live ticks (the live dot stays off for this source).
  - **Cannot back paper trading.** The paper executor prices simulated fills off
    `get_quote`; with no quote, paper trading on the `dukascopy` source does not
    work. This is a history/chart/backtest source only.
- **Sub-minute is out of scope.** Seconds resolutions are served from
  `TICK_STORE`, not this cache. `dukascopy` supports `MINUTE` and above only.
- **`mid` is synthesized.** Dukascopy exposes BID and ASK only. `price_side="mid"`
  fetches both sides and averages `(bid + ask) / 2`, cached under `side="mid"` so
  the double-fetch cost is paid once per series. (Alternative considered:
  default mid to bid and skip the second fetch. Rejected: for the small extra
  cost we keep mid honest, and the cache amortizes it.)
- **`volume` is tick-count volume**, not traded size. Do not trust it as
  contract/lot volume anywhere it surfaces.
- **No pruning/retention** (same as candle-cache v1). Disk growth is bounded by
  the number of series actually pulled.
- **No new frontend feature.** The source appears in the existing data-source
  selector and symbol-search modal through broker-agnostic paths; the only edit
  is a static selector label.

## Architecture

### New module: `auto_trader/brokers/dukascopy.py`

`DukascopyBroker(MarketDataBroker)` implemented against the `dukascopy-python`
library (see Dependency below). A `register(registry)` adds it under id
`"dukascopy"`, and `build_registry()` calls it, matching every other broker.

```
DukascopyBroker
  get_candles(epic, resolution, start, end, price_side="mid") -> list[Candle]
      epic       -> INSTRUMENT_* constant   (via _INSTRUMENTS table)
      resolution -> INTERVAL_* constant      (via _INTERVALS table)
      price_side -> OFFER_SIDE_BID / _ASK    ("mid" = fetch both, average)
      run dukascopy_python.fetch(...) inside asyncio.to_thread (it is sync)
      -> DataFrame(timestamp, open, high, low, close, volume)
      -> list[Candle], ascending, UTC, forming/partial handling left to cache

  get_recent_candles(epic, resolution, count, price_side="mid") -> list[Candle]
      compute start = now - count * resolution.seconds (with slack), call
      get_candles(start, now), return the last `count`.

  get_quote(epic) -> (None, None)            # historical-only

  # catalogue surface, all driven by the _INSTRUMENTS table:
  search_markets(query, limit)  -> filtered rows [{epic, name, status, type}]
  all_markets()                 -> all rows
  get_market_meta(epic)         -> {precision, status, ...}
  get_market_detail(epic)       -> best-effort detail dict
```

`fetch()` handles bi5 download, LZMA decompression, tick->bar aggregation, and
per-instrument price scaling internally, so the classic "wrong decimal factor"
scaling bug is the library's concern, not ours.

### Instrument mapping table (`_INSTRUMENTS`)

A curated, static table is the single source of truth for what this broker
offers and how each epic maps to Dukascopy:

```
epic        library constant                       name              precision  type
"EURUSD"    INSTRUMENT_FX_MAJORS_EUR_USD           "EUR/USD"         5          fx
"GBPUSD"    INSTRUMENT_FX_MAJORS_GBP_USD           "GBP/USD"         5          fx
"USDJPY"    INSTRUMENT_FX_MAJORS_USD_JPY           "USD/JPY"         3          fx
...         (FX majors)
"XAUUSD"    INSTRUMENT_METALS_XAU_USD              "Gold"            3          metal
"XAGUSD"    INSTRUMENT_METALS_XAG_USD              "Silver"          4          metal
"US500"     INSTRUMENT_...USA_500_...              "S&P 500"         2          index (approx)
"US30"      INSTRUMENT_...USA_30_...               "Dow 30"          1          index (approx)
...         (key indices)
```

Our epics are chosen to read naturally in the symbol picker (`EURUSD`,
`XAUUSD`, `US500`). The exact library constant names are resolved against the
installed `dukascopy-python` at implementation time from
`dukascopy_python.instruments` (this table lists intent; the constant strings
are filled from the real module). Index rows carry a `approx: True` flag surfaced
as a note in the catalogue/meta so the UI can hint that index pricing differs
from broker CFDs.

### Resolution mapping (`_INTERVALS`)

```
MINUTE    -> INTERVAL_MIN_1
MINUTE_5  -> INTERVAL_MIN_5
MINUTE_15 -> INTERVAL_MIN_15
MINUTE_30 -> INTERVAL_MIN_30
HOUR      -> INTERVAL_HOUR_1
HOUR_4    -> INTERVAL_HOUR_4      (or aggregate from HOUR_1 if absent)
DAY       -> INTERVAL_DAY_1
WEEK      -> INTERVAL_WEEK_1      (or aggregate from DAY_1 if absent)
```

An unsupported resolution raises a clear error; an unknown epic raises a clear
error. (Both are `ValueError`-class, surfaced by the route as a 4xx, never a
silent empty result.)

### On-demand path (free)

Because `dukascopy` is a registered data broker, `api/deps.py` already routes
chart and backtest requests through
`CANDLE_CACHE.window(key, ..., fetch_range=broker.get_candles)` and
`CANDLE_CACHE.recent(...)`. Small gaps and moderate ranges "just work": the
cache backfills below oldest through `get_candles` and serves the rest from
sqlite. No new route wiring.

### Bulk prefill CLI: `backend/scripts/dukascopy_import.py`

Deep 1m history is tens of thousands of per-hour files; pulling it purely
on-demand would hold the per-series cache lock for a very long time on first
load. The CLI decouples the slow bulk pull from the request path:

```
uv run python -m scripts.dukascopy_import EURUSD MINUTE --from 2015-01-01 \
    [--side mid] [--to <date>]
```

It reuses the existing coverage-safe machinery rather than writing rows itself:

1. Establish a forward anchor block: `CANDLE_CACHE.recent(key, res, count, fetch_recent)`
   (so coverage exists to anchor below), mirroring `candle_accumulator`.
2. Walk down: `CANDLE_CACHE.backfill_below(key, res, broker.get_candles,
   target_oldest_ts=<from>)`, which pages toward the target, stores every closed
   bar, and is coverage-safe by construction (oldest lowered only to real bars).

Runs outside the API process, so the deep pull never blocks the UI; the chart
later reads instantly from the warmed cache. Progress is logged per step; a
`--to` bound is optional (defaults to now).

### Frontend

Near-zero. Add a static `"dukascopy" -> "Dukascopy (history)"` entry to the
selector's per-id label map (the registry's `describe()` already lists the
broker in `data`). Symbol search, precision, and charting all flow through the
existing broker-agnostic catalogue/candle paths.

## Dependency

Add `dukascopy-python` (MIT, v4.0.1, released 2025-04-28, requires Python
>=3.10; ours is 3.12) to `pyproject.toml`. It transitively pulls in **pandas**,
which is a new backend dependency (we currently have numpy but not pandas). This
is the only new dependency and is contained to this feature's fetch path.

## Error handling

- Unknown epic / unsupported resolution -> `ValueError`, surfaced as a 4xx.
- A library/network failure inside `fetch` propagates as an exception; the cache
  already falls back to any cached bars on a raising fetch (`window`/`recent`
  `except` paths) and only re-raises when nothing is cached.
- Empty result for a covered-but-closed window is handled by the cache's
  existing empty-fetch coverage marking (no infinite re-fetch of holes).
- `backfill_below` already returns `"error"` (floor left unset) on a raising
  fetch, so a transient Dukascopy outage during a deep pull stops cleanly and
  can be resumed by re-running the CLI.

## Testing

- **Broker unit tests** (mirror existing `tests/` broker patterns): monkeypatch
  `dukascopy_python.fetch` with a small fake DataFrame and assert:
  - OHLCV -> `Candle` mapping, ascending order, `time` tz-aware UTC.
  - `price_side="mid"` averages bid and ask (two fake fetches).
  - resolution/epic mapping to the right library constants.
  - unknown epic and unsupported resolution each raise `ValueError`.
  - `get_recent_candles` tails `get_candles` and returns exactly `count`.
  - `get_quote` returns `(None, None)`.
- **CLI test**: drive `dukascopy_import` against a fake broker + in-memory cache,
  assert it seeds a forward block then backfills to the target and that stored
  coverage reaches `--from`.
- No live-network test in CI (Dukascopy is external); the fake-`fetch` seam keeps
  tests hermetic. A manual smoke pull of one instrument is a release check, not a
  CI gate.

## Out of scope / future

- Live streaming (`live_fetch`) and paper trading on this source.
- Auto-selecting Dukascopy history to backfill a *different* broker's chart
  (the rejected blend option) if a future feature wants deep history under the
  live feed, it needs a separate provenance/seam design.
- A UI trigger for the bulk import (CLI-only in v1).

## Implementation addendum (2026-07-15)

Built and verified end-to-end in the running app. Two things went beyond the
original spec:

### Added scope: selectable data-only broker

The spec assumed the frontend needed only a selector label. That was wrong: the
workspace broker selector builds its list from `describe().exec` (trading
accounts), and backtests run against the active workspace broker, so a data-only
broker with no executor was unreachable from the UI. To deliver "charted +
backtested":

- The backend `describe()` now emits a synthetic pseudo-account for any data
  broker with no executor: `{key: "dukascopy:data", broker, env: "data",
  isRealMoney: false, dataOnly: true}`. This lets the account-keyed frontend
  select it and keeps `activeAccount = "dukascopy:data"` from being bounced.
- Frontend `isDataOnlyBroker(brokerId)` (fed from `/api/brokers`) gates every
  trading surface: the order ticket, live-trading panel, and their toolbar
  toggles are hidden; the trades feed is not pointed at the account; and the
  dock shows a "read-only data source, no trading" note instead of a misleading
  paper account strip.

### Known limitation: cold on-demand loads can exceed the 10s frontend timeout

Dukascopy history comes from per-hour files, and a cold fetch (especially `mid`,
which is two fetches) can take longer than the chart's 10s request timeout, so
an uncached symbol first renders empty. The prefill CLI is the intended path:
prefill a symbol/resolution once, then the chart reads instantly from the cache
(verified: EURUSD HOUR prefilled, then charted with full history). Follow-up
worth considering: surface a "prefill this symbol" hint when a data-only source
has no cached data for the requested series, rather than a silent empty chart.

### Verified in-app (Dukascopy selected)

- Appears in the broker selector; selecting it swaps to its own workspace with
  no crash.
- Symbol search lists the catalogue (EURUSD → EUR/USD, fx) scoped to the source.
- EURUSD 1H renders real cached history (~1.14); no console errors.
- The backtest panel is reachable with Dukascopy active; a run over the
  prefilled EURUSD 1H window (Jun 2026) produced 123 trades with a full
  performance breakdown and no error (no 422 from the no-executor account).
- Order ticket, live panel, and their toolbar toggles are hidden; live-stream
  absence is a handled warning, not a crash.
- Switching back to Capital.com restores the full trading workspace.
