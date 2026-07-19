# yfinance Data Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Yahoo Finance (`yfinance`) as a credential-free, data-only broker giving decades of daily history plus US stocks/ETFs and crypto, following the Dukascopy pattern.

**Architecture:** One new module `backend/auto_trader/brokers/yfinance.py` implementing the existing `MarketDataBroker` ABC, registered data-only in `build_registry()`. The broker-keyed sqlite candle cache, `/api/candles` route, circuit breaker, and frontend data-only account handling all work unchanged.

**Tech Stack:** Python 3.12, FastAPI backend, `yfinance` (sync, wrapped in `asyncio.to_thread`), pandas (comes with yfinance), pytest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-yfinance-data-source-design.md`
- Prices are split/dividend-adjusted: every fetch uses `auto_adjust=True`.
- Only closed bars may be returned (cache invariant): drop any bar whose `time + resolution.seconds > now`.
- All timestamps tz-aware UTC, candles ascending by time.
- `price_side` is ignored (Yahoo is last-trade data, treated as mid). `get_quote` returns `(None, None)`.
- Market rows must use the key `pricePrecision` (NOT `precision` — that key is silently dropped by the route).
- Epics not in the curated map pass through verbatim as Yahoo tickers.
- Run tests from `backend/` with `uv run pytest`.
- Commit directly to `main` after each task (user preference).

---

### Task 1: Dependency, module skeleton, symbol & interval maps

**Files:**
- Modify: `backend/pyproject.toml` (dependencies list, after `"dukascopy-python>=4.0.1",`)
- Create: `backend/auto_trader/brokers/yfinance.py`
- Create: `backend/tests/test_broker_yfinance.py`

**Interfaces:**
- Produces: `InstrumentInfo` dataclass; `_INSTRUMENT_LIST`, `_INSTRUMENTS` (epic→info), `_ticker_for(epic) -> str`, `_interval_for(resolution) -> str` (raises `ValueError` on unsupported), `_INTERVALS` map. Task 2–4 build on these exact names.

- [ ] **Step 1: Add dependency**

In `backend/pyproject.toml` add to `dependencies`:

```toml
    "yfinance>=0.2.50",
```

Run: `cd /Users/mahmoudparham/auto_trader/backend && uv sync --extra dev`
Expected: resolves and installs yfinance (+ pandas).

- [ ] **Step 2: Write failing tests for the maps**

Create `backend/tests/test_broker_yfinance.py`:

```python
"""Unit tests for the yfinance data-only broker. All network calls are mocked."""

import pytest

from auto_trader.core.models import Resolution


def test_curated_epics_map_to_yahoo_tickers():
    from auto_trader.brokers.yfinance import _ticker_for

    assert _ticker_for("EURUSD") == "EURUSD=X"
    assert _ticker_for("US500") == "^GSPC"
    assert _ticker_for("XAUUSD") == "GC=F"
    assert _ticker_for("BTCUSD") == "BTC-USD"
    assert _ticker_for("AAPL") == "AAPL"


def test_uncurated_epic_passes_through_verbatim():
    from auto_trader.brokers.yfinance import _ticker_for

    assert _ticker_for("SHOP") == "SHOP"  # not in the curated map


def test_interval_map_covers_all_resolutions_except_hour4_directly():
    from auto_trader.brokers.yfinance import _INTERVALS, _interval_for

    assert _interval_for(Resolution.MINUTE) == "1m"
    assert _interval_for(Resolution.HOUR) == "1h"
    assert _interval_for(Resolution.DAY) == "1d"
    assert _interval_for(Resolution.WEEK) == "1wk"
    # HOUR_4 is synthesized from 1h, not fetched directly
    assert Resolution.HOUR_4 not in _INTERVALS
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.brokers.yfinance'`

- [ ] **Step 4: Create the module skeleton**

Create `backend/auto_trader/brokers/yfinance.py`:

```python
"""Yahoo Finance historical candles as a read-only data broker.

Free deep history: daily/weekly bars back decades for FX, indices, futures,
US stocks/ETFs and crypto. Intraday is capped by Yahoo (1m ~30 days,
1h ~730 days); requests beyond the window simply return what Yahoo has.

Data-only, same shape as the Dukascopy source: no stream, no quote, no
executor. Cache namespace ("yfinance", epic, resolution, side) keeps its
series isolated from the live brokers.

Prices are split/dividend-adjusted (auto_adjust=True) so long stock
backtests see a continuous series. price_side is ignored: Yahoo publishes
last-trade data, which we treat as mid.

Epics not in the curated catalogue pass through verbatim as Yahoo tickers,
so anything surfaced by search_markets fetches without a map entry.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import yfinance as yf

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.core.models import Candle, Resolution


@dataclass(frozen=True)
class InstrumentInfo:
    epic: str  # our symbol, shown in the picker
    ticker: str  # Yahoo ticker
    name: str  # display name
    precision: int  # decimal places for price display
    kind: str  # "fx" | "metal" | "index" | "stock" | "etf" | "crypto"


# Curated catalogue. FX uses Yahoo's "=X" pairs, metals/indices use futures /
# cash-index tickers (closest to the CFD epics the app already trades).
_INSTRUMENT_LIST: list[InstrumentInfo] = [
    InstrumentInfo("EURUSD", "EURUSD=X", "EUR/USD", 5, "fx"),
    InstrumentInfo("GBPUSD", "GBPUSD=X", "GBP/USD", 5, "fx"),
    InstrumentInfo("USDJPY", "USDJPY=X", "USD/JPY", 3, "fx"),
    InstrumentInfo("AUDUSD", "AUDUSD=X", "AUD/USD", 5, "fx"),
    InstrumentInfo("USDCHF", "USDCHF=X", "USD/CHF", 5, "fx"),
    InstrumentInfo("USDCAD", "USDCAD=X", "USD/CAD", 5, "fx"),
    InstrumentInfo("NZDUSD", "NZDUSD=X", "NZD/USD", 5, "fx"),
    InstrumentInfo("XAUUSD", "GC=F", "Gold (COMEX)", 3, "metal"),
    InstrumentInfo("XAGUSD", "SI=F", "Silver (COMEX)", 4, "metal"),
    InstrumentInfo("US500", "^GSPC", "S&P 500", 2, "index"),
    InstrumentInfo("US30", "^DJI", "Dow 30", 1, "index"),
    InstrumentInfo("US100", "^NDX", "Nasdaq 100", 1, "index"),
    InstrumentInfo("AAPL", "AAPL", "Apple", 2, "stock"),
    InstrumentInfo("MSFT", "MSFT", "Microsoft", 2, "stock"),
    InstrumentInfo("NVDA", "NVDA", "NVIDIA", 2, "stock"),
    InstrumentInfo("AMZN", "AMZN", "Amazon", 2, "stock"),
    InstrumentInfo("GOOGL", "GOOGL", "Alphabet", 2, "stock"),
    InstrumentInfo("META", "META", "Meta", 2, "stock"),
    InstrumentInfo("TSLA", "TSLA", "Tesla", 2, "stock"),
    InstrumentInfo("SPY", "SPY", "SPDR S&P 500 ETF", 2, "etf"),
    InstrumentInfo("QQQ", "QQQ", "Invesco QQQ ETF", 2, "etf"),
    InstrumentInfo("IWM", "IWM", "iShares Russell 2000 ETF", 2, "etf"),
    InstrumentInfo("BTCUSD", "BTC-USD", "Bitcoin", 2, "crypto"),
    InstrumentInfo("ETHUSD", "ETH-USD", "Ethereum", 2, "crypto"),
    InstrumentInfo("SOLUSD", "SOL-USD", "Solana", 2, "crypto"),
]
_INSTRUMENTS: dict[str, InstrumentInfo] = {i.epic: i for i in _INSTRUMENT_LIST}

# HOUR_4 deliberately absent: Yahoo has no 4h interval, we fetch 1h and
# resample (see _resample_4h).
_INTERVALS: dict[Resolution, str] = {
    Resolution.MINUTE: "1m",
    Resolution.MINUTE_5: "5m",
    Resolution.MINUTE_15: "15m",
    Resolution.MINUTE_30: "30m",
    Resolution.HOUR: "1h",
    Resolution.DAY: "1d",
    Resolution.WEEK: "1wk",
}

_DEFAULT_PRECISION = 2  # searched/uncurated instruments


def _ticker_for(epic: str) -> str:
    info = _INSTRUMENTS.get(epic)
    # Verbatim fallback: any Yahoo ticker found via search works without a
    # catalogue entry.
    return info.ticker if info is not None else epic


def _interval_for(resolution: Resolution) -> str:
    interval = _INTERVALS.get(resolution)
    if interval is None:
        raise ValueError(f"unsupported yfinance resolution: {resolution}")
    return interval
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: 3 PASS

- [ ] **Step 6: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock backend/auto_trader/brokers/yfinance.py backend/tests/test_broker_yfinance.py
git commit -m "feat(yfinance): dependency, instrument catalogue, interval map"
```

---

### Task 2: DataFrame → Candle conversion, forming-bar drop, 4h resample

**Files:**
- Modify: `backend/auto_trader/brokers/yfinance.py` (append)
- Modify: `backend/tests/test_broker_yfinance.py` (append)

**Interfaces:**
- Consumes: `_INTERVALS` from Task 1.
- Produces: `_df_to_candles(df, resolution, now=None) -> list[Candle]` (UTC, ascending, forming bar dropped); `_resample_4h(df)` (1h OHLCV frame → 4h frame, UTC epoch-aligned). Task 3 calls both.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_broker_yfinance.py`:

```python
from datetime import datetime, timezone

import pandas as pd


def _frame(times, tz="UTC"):
    """Minimal Yahoo-style OHLCV frame (capitalized columns, tz-aware index)."""
    idx = pd.DatetimeIndex(pd.to_datetime(times)).tz_localize(tz)
    n = len(times)
    return pd.DataFrame(
        {
            "Open": [1.0 + i for i in range(n)],
            "High": [2.0 + i for i in range(n)],
            "Low": [0.5 + i for i in range(n)],
            "Close": [1.5 + i for i in range(n)],
            "Volume": [100.0] * n,
        },
        index=idx,
    )


def test_df_to_candles_converts_and_sorts_utc():
    from auto_trader.brokers.yfinance import _df_to_candles

    df = _frame(["2020-01-02", "2020-01-01"])
    now = datetime(2020, 6, 1, tzinfo=timezone.utc)
    candles = _df_to_candles(df, Resolution.DAY, now=now)
    assert [c.time for c in candles] == [
        datetime(2020, 1, 1, tzinfo=timezone.utc),
        datetime(2020, 1, 2, tzinfo=timezone.utc),
    ]
    assert candles[0].open == 2.0 and candles[0].volume == 100.0


def test_df_to_candles_converts_exchange_tz_to_utc():
    from auto_trader.brokers.yfinance import _df_to_candles

    df = _frame(["2020-01-01 09:30"], tz="America/New_York")
    now = datetime(2020, 6, 1, tzinfo=timezone.utc)
    (c,) = _df_to_candles(df, Resolution.MINUTE_30, now=now)
    assert c.time == datetime(2020, 1, 1, 14, 30, tzinfo=timezone.utc)


def test_df_to_candles_drops_forming_bar():
    from auto_trader.brokers.yfinance import _df_to_candles

    df = _frame(["2020-01-01 10:00", "2020-01-01 11:00"])
    # 11:00 bar closes at 12:00, "now" is 11:30 → still forming, must drop
    now = datetime(2020, 1, 1, 11, 30, tzinfo=timezone.utc)
    candles = _df_to_candles(df, Resolution.HOUR, now=now)
    assert [c.time for c in candles] == [
        datetime(2020, 1, 1, 10, 0, tzinfo=timezone.utc)
    ]


def test_df_to_candles_empty_and_none():
    from auto_trader.brokers.yfinance import _df_to_candles

    assert _df_to_candles(None, Resolution.DAY) == []
    assert _df_to_candles(_frame([]), Resolution.DAY) == []


def test_resample_4h_epoch_aligned_ohlcv():
    from auto_trader.brokers.yfinance import _resample_4h

    hours = [f"2020-01-01 {h:02d}:00" for h in range(0, 8)]
    df = _frame(hours)
    out = _resample_4h(df)
    assert len(out) == 2
    assert out.index[0] == pd.Timestamp("2020-01-01 00:00", tz="UTC")
    assert out.index[1] == pd.Timestamp("2020-01-01 04:00", tz="UTC")
    first = out.iloc[0]
    assert first["Open"] == 1.0  # open of 00:00
    assert first["High"] == 5.0  # max high of 00..03 (2+3)
    assert first["Low"] == 0.5  # min low
    assert first["Close"] == 4.5  # close of 03:00 (1.5+3)
    assert first["Volume"] == 400.0  # summed
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: new tests FAIL with `ImportError: cannot import name '_df_to_candles'`

- [ ] **Step 3: Implement**

Append to `backend/auto_trader/brokers/yfinance.py`:

```python
def _df_to_candles(df, resolution: Resolution, now: datetime | None = None) -> list[Candle]:
    """Yahoo OHLCV frame (capitalized columns, index = bar open time) →
    ascending tz-aware-UTC Candles. Drops the still-forming last bar (any bar
    whose close time is in the future) so only closed bars reach the cache.
    NaN rows (Yahoo pads session gaps) are skipped."""
    if df is None or len(df) == 0:
        return []
    if now is None:
        now = datetime.now(timezone.utc)
    idx = df.index
    if idx.tz is None:
        idx = idx.tz_localize(timezone.utc)
    else:
        idx = idx.tz_convert(timezone.utc)
    bar = timedelta(seconds=resolution.seconds)
    out: list[Candle] = []
    for ts, row in zip(idx, df.itertuples(index=False)):
        o = float(row.Open)
        if o != o:  # NaN row
            continue
        t = ts.to_pydatetime()
        if t + bar > now:
            continue
        out.append(
            Candle(
                time=t,
                open=o,
                high=float(row.High),
                low=float(row.Low),
                close=float(row.Close),
                volume=float(getattr(row, "Volume", 0.0) or 0.0),
            )
        )
    out.sort(key=lambda c: c.time)
    return out


def _resample_4h(df):
    """1h Yahoo frame → 4h buckets, UTC epoch-aligned (00/04/08/.. opens),
    matching how the other brokers bucket HOUR_4. Empty buckets dropped."""
    if df is None or len(df) == 0:
        return df
    idx = df.index
    idx = idx.tz_localize(timezone.utc) if idx.tz is None else idx.tz_convert(timezone.utc)
    df = df.set_axis(idx)
    out = df.resample("4h", origin="epoch", label="left", closed="left").agg(
        {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    )
    return out.dropna(subset=["Open"])
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/yfinance.py backend/tests/test_broker_yfinance.py
git commit -m "feat(yfinance): frame->candle conversion, forming-bar drop, 4h resample"
```

---

### Task 3: Broker class — get_candles / get_recent_candles / get_quote

**Files:**
- Modify: `backend/auto_trader/brokers/yfinance.py` (append)
- Modify: `backend/tests/test_broker_yfinance.py` (append)

**Interfaces:**
- Consumes: `_ticker_for`, `_interval_for`, `_df_to_candles`, `_resample_4h`.
- Produces: `class YFinanceBroker(MarketDataBroker)` with `supports_streaming = False` and async `get_candles(epic, resolution, start, end, price_side="mid")`, `get_recent_candles(epic, resolution, count, price_side="mid")`, `get_quote(epic) -> (None, None)`. Fetching goes through module-level `_fetch_history(ticker, interval, start, end)` (sync; tests monkeypatch it).

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_broker_yfinance.py`:

```python
import asyncio


def test_get_candles_fetches_and_converts(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    calls = []

    def fake_fetch(ticker, interval, start, end):
        calls.append((ticker, interval, start, end))
        return _frame(["2020-01-01", "2020-01-02"])

    monkeypatch.setattr(yfb, "_fetch_history", fake_fetch)
    broker = yfb.YFinanceBroker()
    start = datetime(2020, 1, 1, tzinfo=timezone.utc)
    end = datetime(2020, 1, 3, tzinfo=timezone.utc)
    candles = asyncio.run(broker.get_candles("EURUSD", Resolution.DAY, start, end))
    assert calls == [("EURUSD=X", "1d", start, end)]
    assert len(candles) == 2
    assert candles[0].time == datetime(2020, 1, 1, tzinfo=timezone.utc)


def test_get_candles_hour4_fetches_1h_and_resamples(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    calls = []

    def fake_fetch(ticker, interval, start, end):
        calls.append(interval)
        return _frame([f"2020-01-01 {h:02d}:00" for h in range(8)])

    monkeypatch.setattr(yfb, "_fetch_history", fake_fetch)
    broker = yfb.YFinanceBroker()
    start = datetime(2020, 1, 1, tzinfo=timezone.utc)
    end = datetime(2020, 1, 2, tzinfo=timezone.utc)
    candles = asyncio.run(broker.get_candles("AAPL", Resolution.HOUR_4, start, end))
    assert calls == ["1h"]
    assert [c.time.hour for c in candles] == [0, 4]


def test_get_recent_candles_returns_last_n(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    def fake_fetch(ticker, interval, start, end):
        return _frame([f"2020-01-{d:02d}" for d in range(1, 21)])

    monkeypatch.setattr(yfb, "_fetch_history", fake_fetch)
    broker = yfb.YFinanceBroker()
    candles = asyncio.run(broker.get_recent_candles("AAPL", Resolution.DAY, 5))
    assert len(candles) == 5
    assert candles[-1].time == datetime(2020, 1, 20, tzinfo=timezone.utc)
    assert candles[0].time == datetime(2020, 1, 16, tzinfo=timezone.utc)


def test_get_recent_candles_zero_count():
    import auto_trader.brokers.yfinance as yfb

    assert asyncio.run(yfb.YFinanceBroker().get_recent_candles("AAPL", Resolution.DAY, 0)) == []


def test_get_quote_is_none_none():
    import auto_trader.brokers.yfinance as yfb

    assert asyncio.run(yfb.YFinanceBroker().get_quote("AAPL")) == (None, None)
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: new tests FAIL with `AttributeError` (no `_fetch_history` / `YFinanceBroker`)

- [ ] **Step 3: Implement**

Append to `backend/auto_trader/brokers/yfinance.py`:

```python
def _fetch_history(ticker: str, interval: str, start: datetime, end: datetime):
    """Synchronous Yahoo fetch, module-level so tests can monkeypatch it.
    auto_adjust=True: split/dividend-adjusted prices, per spec."""
    return yf.Ticker(ticker).history(
        start=start, end=end, interval=interval, auto_adjust=True, raise_errors=False
    )


class YFinanceBroker(MarketDataBroker):
    """Read-only historical candles from Yahoo Finance. Data-only: no stream,
    no quote. price_side ignored (last-trade data, treated as mid)."""

    supports_streaming = False

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        ticker = _ticker_for(epic)
        if resolution is Resolution.HOUR_4:
            # Yahoo has no 4h interval: fetch 1h and bucket. Extend the start
            # back one bucket so the first 4h bar isn't built from a partial
            # set of hours.
            df = await asyncio.to_thread(
                _fetch_history, ticker, "1h", start - timedelta(hours=4), end
            )
            df = _resample_4h(df)
            candles = _df_to_candles(df, resolution)
            return [c for c in candles if c.time >= start]
        interval = _interval_for(resolution)  # raises on unsupported resolution
        df = await asyncio.to_thread(_fetch_history, ticker, interval, start, end)
        return _df_to_candles(df, resolution)

    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Most-recent `count` bars. Yahoo has no 'recent N' primitive: fetch a
        window generously sized for weekends/holidays/short sessions and take
        the tail. One fetch — Yahoo requests are cheap, unlike Dukascopy."""
        if count <= 0:
            return []
        now = datetime.now(timezone.utc)
        span = timedelta(seconds=resolution.seconds * count * 3) + timedelta(days=7)
        candles = await self.get_candles(epic, resolution, now - span, now, price_side)
        return candles[-count:]

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Historical-only source: no live quote. Paper trading cannot price
        off this broker (documented limitation, same as Dukascopy)."""
        return (None, None)
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/yfinance.py backend/tests/test_broker_yfinance.py
git commit -m "feat(yfinance): candle fetching (incl. 4h synth) and recent-N"
```

---

### Task 4: Catalogue — market rows, all_markets, live search, meta/detail

**Files:**
- Modify: `backend/auto_trader/brokers/yfinance.py` (append methods inside `YFinanceBroker`, helpers at module level)
- Modify: `backend/tests/test_broker_yfinance.py` (append)

**Interfaces:**
- Consumes: `_INSTRUMENT_LIST`, `_INSTRUMENTS`, `_DEFAULT_PRECISION`.
- Produces: `YFinanceBroker.all_markets()`, `search_markets(query, limit=20)`, `get_market_meta(epic)`, `get_market_detail(epic)`; module-level `_search_yahoo(query, limit) -> list[dict]` (sync; tests monkeypatch it). Market rows: `{"epic", "name", "status", "type", "pricePrecision", "note"}`.

- [ ] **Step 1: Write failing tests**

Append to `backend/tests/test_broker_yfinance.py`:

```python
def test_all_markets_rows_use_price_precision_key():
    import auto_trader.brokers.yfinance as yfb

    rows = asyncio.run(yfb.YFinanceBroker().all_markets())
    assert len(rows) == len(yfb._INSTRUMENT_LIST)
    row = next(r for r in rows if r["epic"] == "EURUSD")
    assert row["pricePrecision"] == 5
    assert row["status"] == "TRADEABLE"
    assert "precision" not in row


def test_search_merges_curated_and_yahoo(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    def fake_search(query, limit):
        return [
            {"symbol": "SHOP", "shortname": "Shopify Inc.", "quoteType": "EQUITY"},
            {"symbol": "AAPL", "shortname": "Apple Inc.", "quoteType": "EQUITY"},
        ]

    monkeypatch.setattr(yfb, "_search_yahoo", fake_search)
    rows = asyncio.run(yfb.YFinanceBroker().search_markets("sho"))
    epics = [r["epic"] for r in rows]
    assert "SHOP" in epics  # from Yahoo
    shop = next(r for r in rows if r["epic"] == "SHOP")
    assert shop["pricePrecision"] == yfb._DEFAULT_PRECISION
    assert shop["name"] == "Shopify Inc."
    # AAPL is curated: appears once, not duplicated by the Yahoo hit
    assert epics.count("AAPL") <= 1


def test_search_survives_yahoo_failure(monkeypatch):
    import auto_trader.brokers.yfinance as yfb

    def boom(query, limit):
        raise RuntimeError("yahoo down")

    monkeypatch.setattr(yfb, "_search_yahoo", boom)
    rows = asyncio.run(yfb.YFinanceBroker().search_markets("EUR"))
    assert any(r["epic"] == "EURUSD" for r in rows)  # curated still works


def test_market_meta_curated_and_fallback():
    import auto_trader.brokers.yfinance as yfb

    broker = yfb.YFinanceBroker()
    meta = asyncio.run(broker.get_market_meta("US500"))
    assert meta["name"] == "S&P 500"
    fallback = asyncio.run(broker.get_market_meta("SHOP"))
    assert fallback["epic"] == "SHOP"
    assert fallback["pricePrecision"] == yfb._DEFAULT_PRECISION
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: new tests FAIL (`all_markets` returns `[]` from the ABC default / missing `_search_yahoo`)

- [ ] **Step 3: Implement**

Append to `backend/auto_trader/brokers/yfinance.py` — module-level helper:

```python
def _search_yahoo(query: str, limit: int) -> list[dict]:
    """Synchronous Yahoo symbol search, module-level so tests can monkeypatch.
    Returns yfinance Search quote dicts (symbol/shortname/quoteType/...)."""
    return yf.Search(query, max_results=limit).quotes
```

and methods inside `YFinanceBroker`:

```python
    def _market_row(
        self, epic: str, name: str, kind: str, precision: int, note: str = ""
    ) -> dict:
        return {
            "epic": epic,
            "name": name,
            "status": "TRADEABLE",  # history is always available; no session gate
            "type": kind,
            # `pricePrecision` is the key the /api/market route + frontend read;
            # "precision" would be silently dropped.
            "pricePrecision": precision,
            "note": note,
        }

    def _curated_row(self, info: InstrumentInfo) -> dict:
        return self._market_row(info.epic, info.name, info.kind, info.precision)

    async def all_markets(self) -> list[dict]:
        return [self._curated_row(i) for i in _INSTRUMENT_LIST]

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        """Curated matches first, then live Yahoo search results. A Yahoo
        outage degrades to curated-only rather than failing the search."""
        q = query.strip()
        ql = q.lower()
        rows = [
            self._curated_row(i)
            for i in _INSTRUMENT_LIST
            if ql in i.epic.lower() or ql in i.name.lower()
        ]
        seen = {r["epic"] for r in rows} | set(_INSTRUMENTS)
        if q:
            try:
                quotes = await asyncio.to_thread(_search_yahoo, q, limit)
            except Exception:
                quotes = []
            for quote in quotes:
                symbol = quote.get("symbol")
                if not symbol or symbol in seen:
                    continue
                seen.add(symbol)
                rows.append(
                    self._market_row(
                        symbol,
                        quote.get("shortname") or quote.get("longname") or symbol,
                        (quote.get("quoteType") or "").lower() or "stock",
                        _DEFAULT_PRECISION,
                    )
                )
        return rows[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        info = _INSTRUMENTS.get(epic)
        if info is not None:
            return self._curated_row(info)
        # Uncurated (searched) epic: minimal row so charts open without a
        # catalogue entry.
        return self._market_row(epic, epic, "stock", _DEFAULT_PRECISION)

    async def get_market_detail(self, epic: str) -> dict | None:
        return await self.get_market_meta(epic)
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/brokers/yfinance.py backend/tests/test_broker_yfinance.py
git commit -m "feat(yfinance): catalogue + live Yahoo symbol search"
```

---

### Task 5: Registration, gated live smoke test, full suite

**Files:**
- Modify: `backend/auto_trader/brokers/yfinance.py` (append `register`)
- Modify: `backend/auto_trader/brokers/registry.py` (in `build_registry()`: import line ~107, register next to dukascopy ~115)
- Modify: `backend/tests/test_broker_yfinance.py` (append)

**Interfaces:**
- Consumes: `BrokerRegistry.add_data(broker_id, broker)`; `build_registry()`.
- Produces: `register(registry) -> YFinanceBroker`; `"yfinance"` present in `build_registry().data`.

- [ ] **Step 1: Write failing test**

Append to `backend/tests/test_broker_yfinance.py`:

```python
import os


def test_registered_in_build_registry():
    from auto_trader.brokers.registry import build_registry

    registry = build_registry()
    from auto_trader.brokers.yfinance import YFinanceBroker

    assert isinstance(registry.data.get("yfinance"), YFinanceBroker)


@pytest.mark.skipif(
    not os.environ.get("YF_LIVE_TESTS"), reason="network test; set YF_LIVE_TESTS=1"
)
def test_live_daily_eurusd_smoke():
    """Gated live smoke: a few real daily candles for EURUSD=X."""
    import auto_trader.brokers.yfinance as yfb

    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    end = datetime(2024, 1, 15, tzinfo=timezone.utc)
    candles = asyncio.run(
        yfb.YFinanceBroker().get_candles("EURUSD", Resolution.DAY, start, end)
    )
    assert len(candles) >= 5
    assert all(0.8 < c.close < 1.5 for c in candles)
```

- [ ] **Step 2: Run test, verify it fails**

Run: `uv run pytest tests/test_broker_yfinance.py::test_registered_in_build_registry -v`
Expected: FAIL (`registry.data.get("yfinance")` is None)

- [ ] **Step 3: Implement registration**

Append to `backend/auto_trader/brokers/yfinance.py`:

```python
def register(registry) -> YFinanceBroker:
    """Register the read-only Yahoo Finance data broker. No credentials, always
    available. Data-only: no executor, so it appears as a chart/backtest source
    but not a tradeable account."""
    broker = YFinanceBroker()
    registry.add_data("yfinance", broker)
    return broker
```

In `backend/auto_trader/brokers/registry.py`, `build_registry()`:
- extend the import: `from auto_trader.brokers import capital, dukascopy, ig, mt5, yfinance`
- after `dukascopy.register(registry)` add:

```python
    # Yahoo Finance: decades of daily history + US stocks/ETFs/crypto. No
    # credentials, always available. Data-only, same shape as dukascopy.
    yfinance.register(registry)
```

- [ ] **Step 4: Run test, verify it passes**

Run: `uv run pytest tests/test_broker_yfinance.py -v`
Expected: all PASS, live smoke SKIPPED

- [ ] **Step 5: Run the gated live smoke once**

Run: `YF_LIVE_TESTS=1 uv run pytest tests/test_broker_yfinance.py::test_live_daily_eurusd_smoke -v`
Expected: PASS (needs network; if Yahoo is flaky, note it and move on — it's gated off by default)

- [ ] **Step 6: Run the full backend suite**

Run: `uv run pytest`
Expected: all PASS (registry-touching tests still green)

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/brokers/yfinance.py backend/auto_trader/brokers/registry.py backend/tests/test_broker_yfinance.py
git commit -m "feat(yfinance): register data-only broker in build_registry"
```
