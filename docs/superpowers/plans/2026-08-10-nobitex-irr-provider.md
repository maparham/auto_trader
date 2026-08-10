# Nobitex IRR Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Nobitex crypto/IRR pairs (USDT/IRR foremost) as data-only broker "nobitex" with intraday+daily candles, real bid/ask quotes, and rial-normalized prices.

**Architecture:** `backend/auto_trader/brokers/nobitex.py` modeled on `oanor.py`/`yfinance.py`. UDF history endpoint chunked at ≤450 bars/request; prices ×10 (toman→rial); daily bars restamped Tehran-midnight→UTC-midnight; WEEK folded from dailies via a shared helper extracted from oanor.

**Tech Stack:** Python 3.12, httpx, pytest (sync tests + `asyncio.run`, monkeypatched `_api_get` seam).

**Spec:** `docs/superpowers/specs/2026-08-10-nobitex-irr-provider-design.md`

## Global Constraints

- Base `https://apiv2.nobitex.ir`; no auth; throttle ≥0.35s between requests.
- UDF `/market/udf/history` params `symbol,resolution,from,to`; response arrays t/o/h/l/c/v; `"s":"no_data"` → empty. **500-bar/request cap keeping the newest bars — chunk at 450.**
- All prices ×10 → RIAL. Volume unscaled. Only closed bars returned.
- Daily (1D) bars arrive at Tehran midnight (20:30/21:30 UTC); restamp to UTC midnight of the Tehran calendar date (Tehran = UTC+3:30, no DST since 2022).
- Tests: sync defs with `asyncio.run(...)`; mock via module `_api_get`; run `cd backend && python -m pytest`.

### Task 1: Extract shared daily→weekly fold

Move `_fold_weekly` from `oanor.py` to `core/candle_aggregate.py` as public `fold_days_to_weeks(daily: list[Candle], now: datetime | None = None) -> list[Candle]` (same body/docstring, adjusted). `oanor.py` imports and uses it. Existing oanor WEEK tests must stay green unchanged. Commit.

### Task 2: UDF parsing + chunking helpers

In new `nobitex.py`: `_RESOLUTIONS: dict[Resolution, str]` (MINUTE→"1" … HOUR_4→"240", DAY→"1D"); `_udf_to_candles(payload: dict, resolution: Resolution, now=None) -> list[Candle]` (×10, volume unscaled, drop forming bar, DAY restamped via Tehran offset 3:30, ascending, no_data → []); `_chunks(start_ts: int, end_ts: int, res_seconds: int, max_bars: int = 450)` yielding (from,to) spans. TDD, commit.

### Task 3: NobitexBroker candles + quote

`_api_get(client, path, params)` seam; `NobitexBroker` with throttle (0.35s), `get_candles` (chunk+fetch+dedupe; WEEK = daily fetch + `fold_days_to_weeks`), `get_recent_candles` (window count×res×1.2+1d, tail), `get_quote` (`/market/stats?srcCurrency=<base lower>&dstCurrency=rls` → bestBuy/bestSell ×10 as (bid, ask); missing → (None,None)), `aclose`. TDD, commit.

### Task 4: Catalogue

Curated `_INSTRUMENT_LIST` (USDTIRT "Tether USDT/IRR", BTCIRT, ETHIRT, XRPIRT, DOGEIRT, TRXIRT, SOLIRT, TONIRT, ADAIRT, LTCIRT — name, kind "crypto", precision 0); rows shaped like oanor `_market_row` (pricePrecision key). `all_markets`, `search_markets` (filter curated), `get_market_meta`/`get_market_detail` (curated hit or verbatim minimal row — yfinance precedent, never None for meta). TDD, commit.

### Task 5: Wiring

`register(registry)` (unconditional); `build_registry()` line + import; BROKER_HEALTH `"nobitex": 30.0` in `api/deps.py`; frontend label `nobitex: "Nobitex (IRR crypto)"` in `trading.ts`; registry test `"nobitex" in build_registry().data` + dataOnly pseudo-account. Note: `tests/test_registry.py` exact-set assertions must add "nobitex" (it registers unconditionally, like yfinance). TDD, commit.

### Task 6: Verification

Full backend suite green; live smoke `curl localhost:8000/api/candles?broker=nobitex&epic=USDTIRT&resolution=DAY&bars=30` after reload; Chrome check optional.
