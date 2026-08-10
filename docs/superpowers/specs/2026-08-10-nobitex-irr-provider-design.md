# Nobitex IRR market-data provider — design

Date: 2026-08-10
Status: approved (design discussed and approved in session; follows the oanor
provider pattern from 2026-08-10-oanor-irr-provider-design.md)

## Goal

Second Iranian-market data source: Nobitex (Iran's largest crypto exchange)
crypto/IRR pairs — most importantly USDT/IRR as a live, intraday, deep-history
proxy for the rial-dollar rate (tracks the bazaar dollar within ~1%). Data-only
broker "nobitex"; no execution. Complements oanor (bazaar cash rates + gold):
Nobitex adds intraday granularity, ~8 years of daily history, real traded
volume and a genuine bid/ask.

## Upstream API facts (verified live 2026-08-10)

- Public, documented, no API key. Base `https://apiv2.nobitex.ir`.
- OHLC: `GET /market/udf/history?symbol=USDTIRT&resolution=<r>&from=<ts>&to=<ts>`
  (TradingView UDF: parallel arrays t/o/h/l/c/v, `"s":"ok"` or `"no_data"`).
  Resolutions: 1, 5, 15, 30, 60, 180, 240, 360, 720, 1D, 2D, 3D.
- **500-bar cap per request**, keeping the most recent bars of the range —
  requests must be chunked to ≤500 bars each or older data silently drops.
- Daily bars anchor at Tehran midnight (20:30 UTC) — restamp to UTC midnight
  of the Tehran calendar date (same normalization idea as yfinance session
  days). Intraday timestamps are true epoch seconds — keep as-is.
- **Prices are in toman**; `GET /market/stats?srcCurrency=usdt&dstCurrency=rls`
  is in rial with real `bestBuy`/`bestSell` (factor exactly 10). We normalize
  everything to RIAL (×10 on candles) so Nobitex series are directly comparable
  with oanor's IRR series. Volume stays in base-asset units.
- ~495 pairs; symbols are `<BASE>IRT` (USDTIRT, BTCIRT, …).
- History depth: daily from ~2018, hourly from ~2019. 24/7 market.

## Components

`backend/auto_trader/brokers/nobitex.py` — `NobitexBroker(MarketDataBroker)`:

- `broker_id "nobitex"`, no streaming, registers unconditionally (no creds),
  like dukascopy/yfinance.
- Native resolutions: MINUTE→1, MINUTE_5→5, MINUTE_15→15, MINUTE_30→30,
  HOUR→60, HOUR_4→240, DAY→1D (restamped). WEEK: folded locally from restamped
  dailies via the shared daily→weekly fold. Other resolutions: none exist.
- `get_candles`: chunk [start,end] into ≤450-bar windows, fetch UDF, ×10,
  drop the still-forming trailing bar (t + res > now), dedupe seam bars,
  ascending.
- `get_recent_candles`: now-window sized `count × res × 1.2 + 1 day`, tail
  `count` (24/7 market — modest padding suffices).
- `get_quote`: `/market/stats` bestBuy/bestSell ×10 → real (bid, ask). This
  broker CAN price paper trading, unlike oanor/dukascopy/yfinance.
- Catalogue: curated list of major IRT pairs (USDT, BTC, ETH, TRX, XRP, DOGE,
  SOL, TON, SHIB…) with display names + precision 0 (rial); uncurated epics
  pass through verbatim (yfinance precedent). `pricePrecision: 0`.
- Throttle 0.35s between requests; httpx.AsyncClient; HTTP errors propagate to
  the circuit breaker; `"s":"no_data"` → [].

Shared fold refactor: move oanor's `_fold_weekly` to
`core/candle_aggregate.fold_days_to_weeks(daily, now=None)` (public), reuse
from both brokers. Existing oanor tests keep covering it.

Wiring: `register(registry)` + one `build_registry()` line; BROKER_HEALTH
`"nobitex": 30.0`; frontend label `nobitex: "Nobitex (IRR crypto)"`.

## Testing

`backend/tests/test_broker_nobitex.py`, mocked HTTP via module-level
`_api_get` seam (oanor pattern): UDF parsing (×10, forming-bar drop,
daily restamp), chunking math, WEEK fold, quote bid/ask ×10, no_data → [],
catalogue passthrough, registry registration. No live calls in CI.

## Out of scope (YAGNI)

Streaming/websocket, execution/auth'd endpoints, TMN display units, orderbook
depth, non-IRT quote pairs, Wallex (revisit if Nobitex proves insufficient).
