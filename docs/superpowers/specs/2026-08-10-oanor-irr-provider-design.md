# oanor IRR market-data provider — design

Date: 2026-08-10
Status: approved (design discussed and approved in session)

## Goal

Add Iranian free-market (bazaar) exchange-rate and gold data to auto_trader as a
data-only broker, backed by oanor's Iran Rial Market API
(https://www.oanor.com/api/irr-api). Covers daily charting/backtesting history
and latest-price lookups. No execution side.

## Upstream API facts

- Base URL `https://api.oanor.com/irr-api`, auth header `x-oanor-key`.
- `GET /v1/history?symbol=<s>&limit=<1..365>` — daily OHLC, newest-first,
  Gregorian `date` ("2026/06/10") + `date_jalali`, IRR integer prices.
- `GET /v1/price?symbol=<s>` — latest daily bar with change/change_pct.
- `GET /v1/symbols` — ~21 instruments: currencies vs IRR (usd, eur, gbp, aed,
  try, cad, aud, chf, cny, rub…) and gold (ounce, gram_18k, gram_24k, mesghal,
  coin_emami, coin_bahar, half/quarter/gerami coins). Upstream source tgju.org.
- Free tier: 2,000 calls/month, 2 req/s, hard 429s.
- Constraints that shape the design: **daily granularity only**, **max 365 rows
  of history per symbol**.

## Components

### 1. Probe script (evaluation)

`backend/scripts/oanor_probe.py` — needs `OANOR_API_KEY`. Pulls `/v1/symbols`
plus `limit=365` history for representative instruments (usd, eur, coin_emami,
gram_18k) and reports: rows returned, date range, gap days, weekend/holiday
pattern, zero/stale/duplicate bars, Jalali↔Gregorian consistency. Output is a
human-readable report; used to judge source quality before/after integration.

### 2. Broker

`backend/auto_trader/brokers/oanor.py` — `OanorBroker(MarketDataBroker)`:

- `broker_id = "oanor"`, `display_name = "oanor (IRR bazaar)"`,
  `supports_streaming = False`.
- Epics are oanor symbols verbatim (`usd`, `coin_emami`, …).
- `get_candles(epic, resolution, start, end)`: only `DAY` is native. One
  `/v1/history` call with `limit=365` (single call covers the maximum window),
  parse newest-first rows into ascending UTC `Candle`s (midnight UTC
  timestamps, volume 0), slice to `[start, end]`. Non-daily resolutions return
  `[]` (yfinance precedent); weekly/monthly views are folded by the existing
  `candle_aggregate` layer.
- `get_recent_candles(epic, resolution, count)`: same fetch, tail `count`.
- `get_quote(epic)`: `/v1/price`, returns `(close, close)` — the feed has no
  bid/ask spread; close is treated as mid.
- `search_markets`/`all_markets`/`get_market_meta`/`get_market_detail`: served
  from `/v1/symbols` (cached in-process ~1h). `get_market_detail` reports
  `pricePrecision: 0` (IRR prices are integers).
- HTTP via the project's existing async client pattern; requests carry
  `x-oanor-key`; a simple client-side throttle keeps under 2 req/s; 429/4xx
  surface as the same error types other brokers raise.
- History floor: when a `get_candles` window starts before the oldest row oanor
  can return, the broker just returns what it has; the candle cache's
  `reached_floor` backfill state stops repeated below-floor requests. The local
  cache accumulates history beyond oanor's rolling 1-year window over time.

### 3. Config

`OanorSettings` in `backend/auto_trader/config.py` (pydantic-settings, env
prefix `OANOR_`, `.env` in `backend/`): `OANOR_API_KEY`, optional
`OANOR_BASE_URL` override; `has()` gate. Module singleton `oanor_settings`.
`backend/.env.example` documents the key and the free-tier limits.

### 4. Wiring

- `oanor.py` exposes `register(registry)`; `build_registry()` calls it; it
  registers `registry.add_data("oanor", …)` only when `oanor_settings.has()`.
- `api/deps.py` `BROKER_HEALTH` gets `"oanor": 20.0` per-key timeout.
- Frontend label maps (`App.tsx` / `lib/trading.ts`) get the `oanor` entry the
  same way dukascopy/yfinance appear.

## Error handling

- Missing key → provider simply not registered (matches other gated brokers).
- HTTP errors / 429 / malformed rows → raise the same broker error types the
  route layer already maps; no partial-bar persistence (cache only stores
  closed daily bars, and today's still-forming bar is excluded by the same
  closed-bar rule the cache applies).
- Rows with missing/zero OHLC are dropped with a log line, not stored.

## Testing

- `backend/tests/test_broker_oanor.py`, mirroring `test_broker_yfinance.py`:
  mocked HTTP fixtures from real response shapes (history, price, symbols);
  covers parsing (newest-first → ascending, date parsing, window slicing),
  non-daily → `[]`, quote, symbols listing, error paths (429, bad JSON).
- Registry test: `oanor` registered iff key set.
- No live network calls in CI. Live verification via the probe script.

## Out of scope (YAGNI)

- Streaming/ticks (feed is daily), execution, toman display units, Jalali-date
  UI, the `/v1/gold` and `/v1/currencies` batch endpoints (per-symbol history +
  price suffice), paid-tier rate handling.
