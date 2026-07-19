# yfinance historical data source

**Date:** 2026-07-19
**Status:** Approved

## Goal

Add Yahoo Finance (via the `yfinance` package) as a credential-free, data-only
market data source, following the existing Dukascopy pattern. Motivation:
decades of daily history for backtesting (existing brokers cap out much
earlier), plus access to US stocks/ETFs and crypto the CFD brokers don't cover.

Not a broker: no execution, no live stream, no quotes.

## Scope

- New `backend/auto_trader/brokers/yfinance.py` with
  `YFinanceBroker(MarketDataBroker)`, `broker_id="yfinance"`,
  `supports_streaming=False`.
- Registered data-only via `registry.add_data("yfinance", broker)` in
  `build_registry()` (`brokers/registry.py`). No config/env needed.
- `yfinance` added to `backend/pyproject.toml` dependencies.

Everything downstream is untouched and comes for free: sqlite candle cache
(keyed by broker, so data is namespace-isolated), `/api/candles`, circuit
breaker, and the frontend's data-only pseudo-account handling.

## Symbols

- Curated `InstrumentInfo`-style map (mirroring `dukascopy.py`) covering:
  - Existing app epics mapped to Yahoo tickers: `EURUSD` → `EURUSD=X`,
    `US500` → `^GSPC`, `GOLD` → `GC=F`, and the rest of the current epic set
    where a sensible Yahoo equivalent exists.
  - Core US stocks/ETFs: AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, SPY, QQQ,
    IWM, DIA (final list at implementation time).
  - Major crypto: `BTC-USD`, `ETH-USD`, `SOL-USD`.
- Fallback: an epic not in the curated map is passed to Yahoo verbatim as the
  ticker. Anything surfaced by search therefore fetches without needing a map
  entry.
- Precision/kind per instrument in the curated map; searched (uncurated)
  instruments get a default precision (2) unless Yahoo metadata provides
  better.

## Search

- `search_markets(term)` backed by Yahoo's search endpoint (yfinance
  `Search`/`Lookup`), returning rows in the same shape Dukascopy emits
  (including `pricePrecision`), so the app's market search shows Yahoo results
  under the yfinance data account.
- `all_markets()` returns the curated list. Catalogue meta/detail methods
  return curated info when known, minimal info otherwise.

## Candles

- `get_candles` / `get_recent_candles` fetch via yfinance download with
  `auto_adjust=True` (split/dividend-adjusted — chosen for correct
  long-horizon backtests).
- `Resolution` → Yahoo interval map: MINUTE→1m, MINUTE_5→5m, MINUTE_15→15m,
  MINUTE_30→30m, HOUR→1h, DAY→1d, WEEK→1wk. HOUR_4 has no Yahoo interval:
  fetch 1h and resample to 4h UTC-aligned buckets in the broker.
- Yahoo intraday windows are hard limits (1m ≈ 30 days, 1h ≈ 730 days):
  requests beyond the window return whatever Yahoo has, possibly empty. Daily
  and weekly go back decades. No workarounds attempted.
- `price_side` is ignored (Yahoo data is trade/last-based; treated as mid,
  same as Dukascopy).
- `get_quote` returns `(None, None)`.
- Timestamps normalized to UTC; only rows Yahoo marks complete are returned
  (last, possibly-forming bar dropped for intraday/daily-today so the closed-
  bar-only cache invariant holds).

## Errors

Yahoo failures and rate limits propagate as exceptions or empty results into
the existing per-broker circuit breaker. No custom retry/backoff.

## Testing

- Unit tests (mocked yfinance): resolution mapping, epic→ticker mapping and
  verbatim fallback, DataFrame→`Candle` conversion (UTC, ordering, forming-bar
  drop), search row shape.
- One network-gated live smoke test (skipped by default) fetching a few daily
  candles for `EURUSD=X`.
