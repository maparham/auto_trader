# oanor IRR Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add oanor's Iran Rial Market API as a data-only `MarketDataBroker` ("oanor") serving daily IRR bazaar candles + latest-price quotes, gated on `OANOR_API_KEY`, plus a live-evaluation probe script.

**Architecture:** One new broker module `backend/auto_trader/brokers/oanor.py` modeled on `yfinance.py` (data-only, no streaming, no executor). Native resolution is DAY (single `/v1/history?limit=365` call per fetch); WEEK is folded locally from daily via `core/candle_aggregate.fold`; all other resolutions return `[]`. A pydantic `OanorSettings` block gates registration in `build_registry()`. The existing candle cache accumulates history beyond oanor's rolling 365-day window.

**Tech Stack:** Python 3.12, httpx.AsyncClient, pydantic-settings, pytest (+pytest-asyncio), stdlib only otherwise.

**Spec:** `docs/superpowers/specs/2026-08-10-oanor-irr-provider-design.md`

## Global Constraints

- Upstream: base URL `https://api.oanor.com/irr-api`, auth header `x-oanor-key`, history endpoint `GET /v1/history?symbol=<s>&limit=<1..365>` returns **newest-first** daily rows with Gregorian `date` "YYYY/MM/DD" strings; prices are IRR integers.
- Free tier is 2 req/s — the broker must throttle client-side (min 0.6s between requests).
- Broker id is exactly `"oanor"`. Cache namespacing depends on it; never change casing.
- Only CLOSED bars may be returned (the cache persists whatever the broker returns): drop any daily bar whose day hasn't completed in UTC, and any folded week whose bucket hasn't ended.
- No live network calls in tests — monkeypatch the module-level `_api_get` seam.
- Run backend tests from `backend/`: `python -m pytest tests/<file> -v`. (Frontend test baseline has known failures on main — irrelevant here; don't touch them.)
- All timestamps tz-aware UTC; `Candle.time` is bar open time.

---

### Task 1: OanorSettings config block

**Files:**
- Modify: `backend/auto_trader/config.py` (append after `mt5_settings = MTSettings()`)
- Modify: `backend/.env.example` (append)
- Test: `backend/tests/test_broker_oanor.py` (new file)

**Interfaces:**
- Produces: `from auto_trader.config import oanor_settings` — `OanorSettings` with fields `api_key: str = ""`, `base_url: str = "https://api.oanor.com/irr-api"`, method `has() -> bool`. Env vars `OANOR_API_KEY`, `OANOR_BASE_URL`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_broker_oanor.py`:

```python
"""Unit tests for the oanor IRR data-only broker. All network calls are mocked."""

from datetime import datetime, timezone

import pytest

from auto_trader.core.models import Resolution


def test_oanor_settings_gate():
    from auto_trader.config import OanorSettings

    assert OanorSettings(api_key="", _env_file=None).has() is False
    s = OanorSettings(api_key="oanor_live_xyz", _env_file=None)
    assert s.has() is True
    assert s.base_url == "https://api.oanor.com/irr-api"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: FAIL with `ImportError: cannot import name 'OanorSettings'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/auto_trader/config.py` (after `mt5_settings = MTSettings()`), matching the file's existing style:

```python
# oanor (oanor.com) serves Iran's free-market (bazaar) rial/gold prices — daily
# OHLC history (max 365 rows/symbol) and a latest-price endpoint. Registers as
# the data-only "oanor" broker; only when the API key is set (see `has`), so an
# absent key never shows a dead entry in the broker selector.
class OanorSettings(BaseSettings):
    """oanor API credentials (env-prefixed OANOR_).

    `api_key` comes from https://www.oanor.com/developer/keys (free tier: 2,000
    calls/month at 2 req/s). `base_url` exists for tests/self-hosted gateways."""

    model_config = SettingsConfigDict(
        env_prefix="OANOR_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    api_key: str = ""
    base_url: str = "https://api.oanor.com/irr-api"

    def has(self) -> bool:
        """True only when the API key is set (gates registration)."""
        return bool(self.api_key)


oanor_settings = OanorSettings()
```

Append to `backend/.env.example`:

```bash
# --- oanor (Iranian rial bazaar rates + gold, https://www.oanor.com) ---------
# Data-only broker "oanor": daily IRR OHLC history (max 365 rows/symbol) and
# latest bazaar prices. Key from https://www.oanor.com/developer/keys.
# Free tier: 2,000 calls/month, 2 req/s. Leave unset to disable the broker.
#OANOR_API_KEY=oanor_live_xxxxxxxxxxxx
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/config.py backend/.env.example backend/tests/test_broker_oanor.py
git commit -m "feat(oanor): OanorSettings config block gating the IRR data broker"
```

---

### Task 2: Row parsing — oanor history rows → Candles

**Files:**
- Create: `backend/auto_trader/brokers/oanor.py`
- Test: `backend/tests/test_broker_oanor.py` (append)

**Interfaces:**
- Produces (module-level in `auto_trader.brokers.oanor`):
  - `_parse_date(s: str) -> datetime` — "2026/06/10" → `datetime(2026, 6, 10, tzinfo=timezone.utc)`; raises `ValueError` on garbage.
  - `_rows_to_candles(rows: list[dict], now: datetime | None = None) -> list[Candle]` — newest-first oanor rows (keys `date/open/high/low/close`) → ascending closed `Candle`s (volume 0.0). Drops rows with missing/zero OHLC and any bar whose day hasn't completed (`time + 1 day > now`).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_broker_oanor.py`:

```python
def _row(date, o=1785100, h=1785200, low=1757800, c=1758050):
    return {"date": date, "open": o, "high": h, "low": low, "close": c,
            "date_jalali": "1405/03/20"}


def test_parse_date_gregorian_slash_format():
    from auto_trader.brokers.oanor import _parse_date

    assert _parse_date("2026/06/10") == datetime(2026, 6, 10, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        _parse_date("1405/13/40")


def test_rows_to_candles_ascending_closed_only():
    from auto_trader.brokers.oanor import _rows_to_candles

    now = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)
    rows = [_row("2026/06/10"), _row("2026/06/09"), _row("2026/06/08")]  # newest-first
    candles = _rows_to_candles(rows, now=now)
    # 06-10 is still forming at noon UTC → dropped; remainder ascending
    assert [c.time.day for c in candles] == [8, 9]
    c = candles[-1]
    assert (c.open, c.high, c.low, c.close, c.volume) == (
        1785100.0, 1785200.0, 1757800.0, 1758050.0, 0.0)


def test_rows_to_candles_drops_zero_and_missing_ohlc():
    from auto_trader.brokers.oanor import _rows_to_candles

    now = datetime(2026, 6, 20, tzinfo=timezone.utc)
    rows = [
        _row("2026/06/09", o=0),                      # zero open → dropped
        {"date": "2026/06/08", "open": 1, "high": 2},  # missing low/close → dropped
        _row("2026/06/07"),
    ]
    candles = _rows_to_candles(rows, now=now)
    assert [c.time.day for c in candles] == [7]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: new tests FAIL with `ModuleNotFoundError: auto_trader.brokers.oanor`

- [ ] **Step 3: Write minimal implementation**

Create `backend/auto_trader/brokers/oanor.py`:

```python
"""oanor (oanor.com) — Iran's free-market (bazaar) rial & gold prices as a
read-only data broker.

Iran's official rate is fixed and unused in practice; the real economy trades
on the open bazaar rate, which is what oanor exposes (source: tgju.org).
Instruments: foreign currencies vs IRR (usd, eur, gbp, aed, try …) and Iran's
gold market (ounce, 18k/24k gram, mesghal, Emami/Bahar Azadi coins).

Upstream constraints that shape this module: daily granularity only, max 365
rows of history per symbol, 2 req/s on the free tier (client-side throttle).
Data-only, same shape as the Dukascopy/yfinance sources: no stream, no
executor. Cache namespace ("oanor", epic, resolution, side) isolates its
series; the cache accumulates history beyond oanor's rolling 1-year window.

DAY is the only native resolution; WEEK is folded locally from daily bars;
anything finer returns []. get_quote returns (close, close) — bazaar prices
have no bid/ask spread, the daily close is treated as mid.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

import httpx

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.core.candle_aggregate import BucketRule, bucket_end, fold
from auto_trader.core.models import Candle, Resolution

_BASE_URL = "https://api.oanor.com/irr-api"
_MAX_ROWS = 365  # upstream hard cap on /v1/history limit
_MIN_REQUEST_INTERVAL = 0.6  # free tier allows 2 req/s; stay politely under
_SYMBOLS_TTL = 3600.0  # catalogue changes rarely; cache /v1/symbols in-process
_DAY = timedelta(days=1)
_WEEK_RULE = BucketRule(Resolution.DAY, "week", 1)


def _parse_date(s: str) -> datetime:
    """oanor Gregorian date "2026/06/10" → UTC-midnight datetime (bar open)."""
    return datetime.strptime(s, "%Y/%m/%d").replace(tzinfo=timezone.utc)


def _rows_to_candles(rows: list[dict], now: datetime | None = None) -> list[Candle]:
    """Newest-first oanor history rows → ascending closed Candles.

    Rows with missing/zero OHLC are dropped (upstream padding, not real
    sessions), as is any bar whose day hasn't completed yet — only closed bars
    may reach the candle cache."""
    if now is None:
        now = datetime.now(timezone.utc)
    out: list[Candle] = []
    for row in rows:
        try:
            t = _parse_date(row["date"])
            o = float(row["open"])
            h = float(row["high"])
            low = float(row["low"])
            c = float(row["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (o and h and low and c):
            continue
        if t + _DAY > now:
            continue  # still-forming daily bar
        out.append(Candle(time=t, open=o, high=h, low=low, close=c, volume=0.0))
    out.sort(key=lambda c: c.time)
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/oanor.py backend/tests/test_broker_oanor.py
git commit -m "feat(oanor): history row parsing (newest-first daily rows -> closed Candles)"
```

---

### Task 3: OanorBroker — candles, weekly fold, quote

**Files:**
- Modify: `backend/auto_trader/brokers/oanor.py` (append)
- Test: `backend/tests/test_broker_oanor.py` (append)

**Interfaces:**
- Consumes: `_rows_to_candles`, `_parse_date` from Task 2; `fold`/`bucket_end`/`BucketRule` from `auto_trader.core.candle_aggregate`.
- Produces:
  - `async _api_get(client: httpx.AsyncClient, path: str, params: dict) -> dict` — module-level HTTP seam; tests monkeypatch `oanor._api_get`.
  - `class OanorBroker(MarketDataBroker)` — `__init__(self, api_key: str, base_url: str = _BASE_URL)`; `get_candles`, `get_recent_candles`, `get_quote` per the base ABC; `async aclose()`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_broker_oanor.py`:

```python
def _history_payload(dates):
    return {"status": "ok", "success": True,
            "data": {"symbol": "usd", "name": "US Dollar", "unit": "IRR",
                     "source": "tgju.org", "count": len(dates),
                     "history": [_row(d) for d in dates]}}


def _patch_api(monkeypatch, payloads):
    """Replace the HTTP seam; records (path, params) calls, pops payloads FIFO."""
    from auto_trader.brokers import oanor

    calls = []

    async def fake_api_get(client, path, params):
        calls.append((path, dict(params)))
        return payloads.pop(0)

    monkeypatch.setattr(oanor, "_api_get", fake_api_get)
    return calls


@pytest.fixture
def broker():
    from auto_trader.brokers.oanor import OanorBroker

    return OanorBroker(api_key="oanor_test_key")


async def test_get_candles_daily_slices_window(monkeypatch, broker):
    calls = _patch_api(monkeypatch, [_history_payload(
        ["2026/06/10", "2026/06/09", "2026/06/08", "2026/06/07"])])
    start = datetime(2026, 6, 8, tzinfo=timezone.utc)
    end = datetime(2026, 6, 9, tzinfo=timezone.utc)
    candles = await broker.get_candles("usd", Resolution.DAY, start, end)
    assert [c.time.day for c in candles] == [8, 9]
    assert calls == [("/v1/history", {"symbol": "usd", "limit": 365})]


async def test_get_candles_week_folds_daily(monkeypatch, broker):
    # Mon 2026-05-04 .. Sun 2026-05-17: two complete ISO weeks
    days = [f"2026/05/{d:02d}" for d in range(4, 18)]
    _patch_api(monkeypatch, [_history_payload(list(reversed(days)))])
    start = datetime(2026, 5, 1, tzinfo=timezone.utc)
    end = datetime(2026, 6, 1, tzinfo=timezone.utc)
    candles = await broker.get_candles("usd", Resolution.WEEK, start, end)
    assert len(candles) == 2
    assert all(c.time.weekday() == 0 for c in candles)  # week opens on Monday


async def test_get_candles_intraday_returns_empty(monkeypatch, broker):
    calls = _patch_api(monkeypatch, [])
    out = await broker.get_candles(
        "usd", Resolution.HOUR,
        datetime(2026, 6, 1, tzinfo=timezone.utc),
        datetime(2026, 6, 2, tzinfo=timezone.utc))
    assert out == [] and calls == []  # no wasted API call


async def test_get_recent_candles_tails_count(monkeypatch, broker):
    _patch_api(monkeypatch, [_history_payload(
        ["2026/06/09", "2026/06/08", "2026/06/07", "2026/06/06"])])
    candles = await broker.get_recent_candles("usd", Resolution.DAY, 2)
    assert [c.time.day for c in candles] == [8, 9]


async def test_get_quote_returns_close_as_mid(monkeypatch, broker):
    payload = {"status": "ok", "success": True,
               "data": {"symbol": "usd", "close": 1758050, "open": 1785100,
                        "high": 1785200, "low": 1757800, "date": "2026/06/10"}}
    calls = _patch_api(monkeypatch, [payload])
    assert await broker.get_quote("usd") == (1758050.0, 1758050.0)
    assert calls == [("/v1/price", {"symbol": "usd"})]


async def test_get_quote_malformed_payload_is_none_none(monkeypatch, broker):
    _patch_api(monkeypatch, [{"status": "ok", "data": {}}])
    assert await broker.get_quote("usd") == (None, None)


async def test_http_errors_propagate(monkeypatch, broker):
    from auto_trader.brokers import oanor

    async def boom(client, path, params):
        raise httpx.HTTPStatusError(
            "429", request=httpx.Request("GET", "https://x"),
            response=httpx.Response(429))

    import httpx
    monkeypatch.setattr(oanor, "_api_get", boom)
    with pytest.raises(httpx.HTTPStatusError):
        await broker.get_candles(
            "usd", Resolution.DAY,
            datetime(2026, 6, 1, tzinfo=timezone.utc),
            datetime(2026, 6, 2, tzinfo=timezone.utc))
```

Note: move the `import httpx` to the top of the test file with the other imports (shown inline above only for locality). Async tests follow the repo's existing pytest-asyncio configuration — check `backend/pyproject.toml`/`pytest.ini` for `asyncio_mode = auto`; if it isn't auto, decorate the async tests with `@pytest.mark.asyncio` exactly as `test_broker_yfinance.py` does.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: FAIL with `ImportError: cannot import name 'OanorBroker'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/auto_trader/brokers/oanor.py`:

```python
async def _api_get(client: httpx.AsyncClient, path: str, params: dict) -> dict:
    """One authenticated GET → parsed JSON. Module-level so tests monkeypatch it.
    HTTP errors (429 rate cap, 5xx) propagate into the caller's circuit
    breaker — a partial/failed fetch must never read as "no data" or the cache
    would mark the range covered-empty."""
    resp = await client.get(path, params=params)
    resp.raise_for_status()
    return resp.json()


class OanorBroker(MarketDataBroker):
    """Read-only daily IRR bazaar candles + latest price from oanor. Data-only:
    no stream, no executor. price_side ignored (single bazaar rate = mid)."""

    supports_streaming = False

    def __init__(self, api_key: str, base_url: str = _BASE_URL) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"x-oanor-key": api_key},
            timeout=15.0,
        )
        # Serialize requests and space them under the free tier's 2 req/s cap.
        self._throttle = asyncio.Lock()
        self._last_request = 0.0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, params: dict) -> dict:
        async with self._throttle:
            wait = self._last_request + _MIN_REQUEST_INTERVAL - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await _api_get(self._client, path, params)
            finally:
                self._last_request = time.monotonic()

    async def _fetch_daily(self, epic: str) -> list[Candle]:
        payload = await self._get("/v1/history", {"symbol": epic, "limit": _MAX_ROWS})
        rows = (payload.get("data") or {}).get("history") or []
        return _rows_to_candles(rows)

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        if resolution not in (Resolution.DAY, Resolution.WEEK):
            return []  # daily feed: nothing finer exists upstream
        daily = await self._fetch_daily(epic)
        if resolution is Resolution.WEEK:
            now_ts = int(datetime.now(timezone.utc).timestamp())
            series = [
                c for c in fold(daily, _WEEK_RULE)
                # drop the still-forming trailing week: only closed bars cache
                if bucket_end(int(c.time.timestamp()), _WEEK_RULE) <= now_ts
            ]
        else:
            series = daily
        return [c for c in series if start <= c.time <= end]

    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """One /v1/history call already returns the full available depth, so
        'recent N' is just the tail of the same fetch."""
        if count <= 0 or resolution not in (Resolution.DAY, Resolution.WEEK):
            return []
        now = datetime.now(timezone.utc)
        candles = await self.get_candles(
            epic, resolution, datetime(1970, 1, 1, tzinfo=timezone.utc), now, price_side
        )
        return candles[-count:]

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Latest bazaar price as (close, close): the feed publishes one rate,
        no bid/ask spread. Lets watchlists show a live-ish IRR level; fills
        simulated off it carry no spread cost."""
        payload = await self._get("/v1/price", {"symbol": epic})
        close = (payload.get("data") or {}).get("close")
        if not close:
            return (None, None)
        return (float(close), float(close))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/oanor.py backend/tests/test_broker_oanor.py
git commit -m "feat(oanor): OanorBroker daily candles, local weekly fold, quote"
```

---

### Task 4: Instrument catalogue from /v1/symbols

**Files:**
- Modify: `backend/auto_trader/brokers/oanor.py` (extend `OanorBroker.__init__` + append methods)
- Test: `backend/tests/test_broker_oanor.py` (append)

**Interfaces:**
- Consumes: `OanorBroker._get`, `_SYMBOLS_TTL` from Task 3/2.
- Produces: `search_markets(query, limit=20)`, `all_markets()`, `get_market_meta(epic)`, `get_market_detail(epic)` — rows shaped `{"epic", "name", "status": "TRADEABLE", "type", "pricePrecision", "note"}` (the `pricePrecision` key is what the /api/market route + frontend read; `"precision"` would be silently dropped).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_broker_oanor.py`:

```python
_SYMBOLS_PAYLOAD = {"status": "ok", "success": True, "data": {
    "count": 3, "source": "tgju.org", "symbols": [
        {"name": "US Dollar", "unit": "IRR", "symbol": "usd", "category": "currency"},
        {"name": "Gold Ounce (global)", "unit": "USD", "symbol": "ounce", "category": "gold"},
        {"name": "Emami Coin", "unit": "IRR", "symbol": "coin_emami", "category": "gold"},
    ]}}


async def test_all_markets_from_symbols_endpoint(monkeypatch, broker):
    calls = _patch_api(monkeypatch, [_SYMBOLS_PAYLOAD])
    rows = await broker.all_markets()
    assert [r["epic"] for r in rows] == ["usd", "ounce", "coin_emami"]
    usd = rows[0]
    assert usd["name"] == "US Dollar" and usd["type"] == "currency"
    assert usd["status"] == "TRADEABLE"
    assert usd["pricePrecision"] == 0        # IRR prices are integers
    assert rows[1]["pricePrecision"] == 2    # ounce is USD-denominated, decimal
    # second call served from the in-process cache — one HTTP hit total
    await broker.all_markets()
    assert len(calls) == 1


async def test_search_markets_filters_catalogue(monkeypatch, broker):
    _patch_api(monkeypatch, [_SYMBOLS_PAYLOAD])
    rows = await broker.search_markets("coin")
    assert [r["epic"] for r in rows] == ["coin_emami"]


async def test_market_meta_and_detail(monkeypatch, broker):
    _patch_api(monkeypatch, [_SYMBOLS_PAYLOAD])
    meta = await broker.get_market_meta("usd")
    assert meta is not None and meta["pricePrecision"] == 0
    assert await broker.get_market_detail("nope") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: the three new tests FAIL (`all_markets` returns `[]` — base-class default)

- [ ] **Step 3: Write minimal implementation**

In `OanorBroker.__init__`, add:

```python
        self._symbols_cache: list[dict] | None = None
        self._symbols_cached_at = 0.0
```

Append methods to `OanorBroker`:

```python
    @staticmethod
    def _market_row(sym: dict) -> dict:
        # IRR prices are integers; the global gold ounce is USD with decimals.
        precision = 0 if sym.get("unit") == "IRR" else 2
        return {
            "epic": sym["symbol"],
            "name": sym.get("name") or sym["symbol"],
            "status": "TRADEABLE",  # history is always fetchable; no session gate
            "type": sym.get("category") or "currency",
            "pricePrecision": precision,
            "note": "",
        }

    async def _symbols(self) -> list[dict]:
        now = time.monotonic()
        if self._symbols_cache is None or now - self._symbols_cached_at > _SYMBOLS_TTL:
            payload = await self._get("/v1/symbols", {})
            raw = (payload.get("data") or {}).get("symbols") or []
            self._symbols_cache = [self._market_row(s) for s in raw if s.get("symbol")]
            self._symbols_cached_at = now
        return self._symbols_cache

    async def all_markets(self) -> list[dict]:
        return list(await self._symbols())

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        ql = query.strip().lower()
        rows = [
            r for r in await self._symbols()
            if ql in r["epic"].lower() or ql in r["name"].lower()
        ]
        return rows[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        for row in await self._symbols():
            if row["epic"] == epic:
                return row
        return None

    async def get_market_detail(self, epic: str) -> dict | None:
        return await self.get_market_meta(epic)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/oanor.py backend/tests/test_broker_oanor.py
git commit -m "feat(oanor): instrument catalogue from /v1/symbols with in-process cache"
```

---

### Task 5: Wiring — register(), build_registry, broker-health timeout, frontend label

**Files:**
- Modify: `backend/auto_trader/brokers/oanor.py` (append `register`)
- Modify: `backend/auto_trader/brokers/registry.py` (`build_registry`, ~line 104)
- Modify: `backend/auto_trader/api/deps.py:78` (`BROKER_HEALTH`)
- Modify: `frontend/src/lib/trading.ts` (~line 92, `BROKER_LABELS`)
- Test: `backend/tests/test_broker_oanor.py` (append)

**Interfaces:**
- Consumes: `OanorBroker` (Task 3), `oanor_settings` (Task 1), `BrokerRegistry.add_data`.
- Produces: `oanor.register(registry, *, api_key: str, base_url: str = _BASE_URL) -> OanorBroker`; broker id `"oanor"` present in `build_registry()` output iff `oanor_settings.has()`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_broker_oanor.py`:

```python
def test_register_adds_data_only_broker():
    from auto_trader.brokers.oanor import OanorBroker, register
    from auto_trader.brokers.registry import BrokerRegistry

    registry = BrokerRegistry()
    broker = register(registry, api_key="k")
    assert isinstance(broker, OanorBroker)
    assert registry.get_data("oanor") is broker
    assert broker.broker_id == "oanor"
    # data-only: synthetic pseudo-account, flagged dataOnly, no real executor
    desc = registry.describe()
    row = next(a for a in desc["exec"] if a["broker"] == "oanor")
    assert row.get("dataOnly") is True


def test_build_registry_gates_on_key(monkeypatch):
    from auto_trader.brokers import registry as registry_mod
    from auto_trader import config

    monkeypatch.setattr(config, "oanor_settings", config.OanorSettings(api_key="", _env_file=None))
    assert "oanor" not in registry_mod.build_registry().data

    monkeypatch.setattr(config, "oanor_settings", config.OanorSettings(api_key="k", _env_file=None))
    assert "oanor" in registry_mod.build_registry().data
```

Note: if `build_registry()` requires unavailable external state in the test env, mirror however `backend/tests/test_registry.py` constructs it (fixtures/mocks) rather than inventing a new pattern — read that file first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: FAIL with `ImportError: cannot import name 'register'`

- [ ] **Step 3: Write the implementation**

Append to `backend/auto_trader/brokers/oanor.py`:

```python
def register(registry, *, api_key: str, base_url: str = _BASE_URL) -> OanorBroker:
    """Register the read-only oanor IRR data broker. Data-only: no executor, so
    it appears as a chart/backtest source but not a tradeable account."""
    broker = OanorBroker(api_key, base_url)
    registry.add_data("oanor", broker)
    return broker
```

In `build_registry()` (`backend/auto_trader/brokers/registry.py`): add `oanor` to the broker-module import line, import the settings inside the function body the way `ig_settings`/`mt5_settings` are, and append after the mt5 block:

```python
    # oanor: Iranian free-market (bazaar) rial/gold daily history + latest price.
    # Data-only, like dukascopy/yfinance, but needs an API key — registered only
    # when OANOR_API_KEY is set, so an absent key never shows a dead entry.
    from auto_trader.config import oanor_settings

    if oanor_settings.has():
        oanor.register(
            registry,
            api_key=oanor_settings.api_key,
            base_url=oanor_settings.base_url,
        )
```

(Import `oanor` alongside the others: `from auto_trader.brokers import capital, dukascopy, ig, mt5, oanor, yfinance`. Keep the `from auto_trader.config import oanor_settings` import inside `build_registry` — module-level attribute access is what lets the gating test monkeypatch `config.oanor_settings`; import the module and read the attribute: `from auto_trader import config` … `config.oanor_settings` — match how the test patches it.)

In `backend/auto_trader/api/deps.py:78` extend the timeout map:

```python
BROKER_HEALTH = BrokerHealth(per_key_timeout={"mt5": 90.0, "dukascopy": 45.0, "oanor": 20.0})
```

In `frontend/src/lib/trading.ts` `BROKER_LABELS` (after the dukascopy line):

```typescript
  // Read-only Iranian bazaar rates + gold (oanor.com). Charts/backtests only.
  oanor: "oanor (IRR bazaar)",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py tests/test_registry.py -v`
Expected: PASS (including the pre-existing registry suite)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/oanor.py backend/auto_trader/brokers/registry.py backend/auto_trader/api/deps.py frontend/src/lib/trading.ts backend/tests/test_broker_oanor.py
git commit -m "feat(oanor): register data-only broker gated on OANOR_API_KEY"
```

---

### Task 6: Evaluation probe script

**Files:**
- Create: `backend/scripts/oanor_probe.py`
- Test: `backend/tests/test_broker_oanor.py` (append)

**Interfaces:**
- Consumes: `oanor_settings` (Task 1), `_api_get`-style raw payload shape (Task 3).
- Produces: `analyze_history(rows: list[dict]) -> dict` (pure, tested) with keys `count, first, last, span_days, gap_days, max_gap, weekday_rows (dict weekday-name -> int), zero_rows, dup_dates`; CLI `python -m scripts.oanor_probe [symbols...]` printing a per-symbol report.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_broker_oanor.py`:

```python
def test_probe_analyze_history_gaps_and_dups():
    from scripts.oanor_probe import analyze_history

    rows = [_row("2026/06/10"), _row("2026/06/09"), _row("2026/06/09"),
            _row("2026/06/05"), _row("2026/06/04", o=0)]
    report = analyze_history(rows)
    assert report["count"] == 5
    assert report["first"] == "2026-06-04" and report["last"] == "2026-06-10"
    assert report["gap_days"] == 3      # 06-06, 06-07, 06-08 missing
    assert report["max_gap"] == 3
    assert report["dup_dates"] == ["2026-06-09"]
    assert report["zero_rows"] == 1
```

Note: if `backend/scripts/` isn't importable from tests (check how `test_dukascopy_import.py` imports the import script), mirror that file's import mechanism exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py::test_probe_analyze_history_gaps_and_dups -v`
Expected: FAIL with import error

- [ ] **Step 3: Write the implementation**

Create `backend/scripts/oanor_probe.py`:

```python
"""Probe oanor's IRR history quality before/after trusting it as a data source.

Usage (needs OANOR_API_KEY in backend/.env or the environment):

    cd backend && python -m scripts.oanor_probe            # default symbols
    cd backend && python -m scripts.oanor_probe usd ounce  # explicit symbols

For each symbol: pulls the full 365-row history and reports depth, date range,
calendar gaps (Iranian markets close Thu/Fri — expect a weekday pattern shifted
vs Sat/Sun), duplicate dates, and zero/missing OHLC rows. ~2 API calls/symbol.
"""

from __future__ import annotations

import asyncio
import sys
from collections import Counter
from datetime import date, datetime

import httpx

_DEFAULT_SYMBOLS = ["usd", "eur", "coin_emami", "gram_18k"]
_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _parse(row: dict) -> date | None:
    try:
        return datetime.strptime(row["date"], "%Y/%m/%d").date()
    except (KeyError, TypeError, ValueError):
        return None


def analyze_history(rows: list[dict]) -> dict:
    """Pure quality report over raw /v1/history rows (any order)."""
    dated = sorted((d, r) for r in rows if (d := _parse(r)) is not None)
    days = [d for d, _ in dated]
    seen: Counter = Counter(days)
    gaps = []
    for a, b in zip(days, days[1:]):
        delta = (b - a).days
        if delta > 1:
            gaps.append(delta - 1)
    zero_rows = sum(
        1
        for _, r in dated
        if not all(float(r.get(k) or 0) for k in ("open", "high", "low", "close"))
    )
    return {
        "count": len(rows),
        "first": days[0].isoformat() if days else None,
        "last": days[-1].isoformat() if days else None,
        "span_days": (days[-1] - days[0]).days + 1 if days else 0,
        "gap_days": sum(gaps),
        "max_gap": max(gaps, default=0),
        "weekday_rows": {_WEEKDAYS[i]: c for i, c in sorted(
            Counter(d.weekday() for d in set(days)).items())},
        "zero_rows": zero_rows,
        "dup_dates": sorted(d.isoformat() for d, c in seen.items() if c > 1),
    }


async def _probe(symbols: list[str]) -> None:
    from auto_trader.config import oanor_settings

    if not oanor_settings.has():
        sys.exit("OANOR_API_KEY not set (backend/.env) — get one at "
                 "https://www.oanor.com/developer/keys")
    async with httpx.AsyncClient(
        base_url=oanor_settings.base_url,
        headers={"x-oanor-key": oanor_settings.api_key},
        timeout=30.0,
    ) as client:
        for i, symbol in enumerate(symbols):
            if i:
                await asyncio.sleep(0.6)  # free tier: 2 req/s
            resp = await client.get("/v1/history", params={"symbol": symbol, "limit": 365})
            if resp.status_code != 200:
                print(f"\n== {symbol}: HTTP {resp.status_code} — {resp.text[:200]}")
                continue
            data = (resp.json().get("data") or {})
            report = analyze_history(data.get("history") or [])
            print(f"\n== {symbol} ({data.get('name')}, unit {data.get('unit')}, "
                  f"source {data.get('source')})")
            for key, value in report.items():
                print(f"  {key:13} {value}")


def main() -> None:
    asyncio.run(_probe(sys.argv[1:] or _DEFAULT_SYMBOLS))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the full suite**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/oanor_probe.py backend/tests/test_broker_oanor.py
git commit -m "feat(oanor): history-quality probe script (gaps, dups, zero rows)"
```

---

### Task 7: Full verification sweep

**Files:** none new.

- [ ] **Step 1: Run the broker-adjacent backend suites**

Run: `cd backend && python -m pytest tests/test_broker_oanor.py tests/test_registry.py tests/test_broker_yfinance.py tests/test_dukascopy_broker.py tests/test_candle_cache.py -v`
Expected: all PASS

- [ ] **Step 2: Run the whole backend suite**

Run: `cd backend && python -m pytest -q`
Expected: no NEW failures vs main's baseline (frontend baseline failures are a separate known issue and live in the frontend suite, not here).

- [ ] **Step 3: Commit any fixes, then final commit if needed**

```bash
git add -A && git commit -m "test(oanor): verification sweep fixes"  # only if fixes were needed
```
