# Dukascopy deep-history data source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `dukascopy` market-data broker that serves deep historical FX/metals/indices candles (via the `dukascopy-python` library) through the existing candle cache, chartable and backtestable, plus a CLI to bulk-prefill deep history.

**Architecture:** A new `DukascopyBroker(MarketDataBroker)` registered under id `"dukascopy"` gets its own cache namespace `("dukascopy", epic, resolution, side)`. It maps our epics/resolutions to `dukascopy_python` constants and wraps the library's synchronous `fetch()` in `asyncio.to_thread`. On-demand fetching flows for free through the existing `deps.py` → `CANDLE_CACHE.window/recent` wiring; a `scripts/dukascopy_import.py` CLI drives the existing coverage-safe `backfill_below` walk for deep bulk pulls.

**Tech Stack:** Python 3.12, FastAPI, stdlib sqlite candle cache, `dukascopy-python` (MIT, pulls in pandas), pytest.

**Spec:** `docs/superpowers/specs/2026-07-15-dukascopy-history-source-design.md`

## Global Constraints

- **New dependency:** `dukascopy-python` (MIT, >=4.0.1); transitively adds `pandas`. Only dependency added.
- **Data-only broker:** `supports_streaming = False`; `get_quote` returns `(None, None)`. It cannot back paper trading (documented limitation, not a bug to fix).
- **Sub-minute out of scope:** only `MINUTE` and above; seconds go to `TICK_STORE`, not this cache.
- **`mid` is synthesized:** Dukascopy exposes BID/ASK only; `price_side="mid"` fetches both and averages, cached under `side="mid"`.
- **`volume` is tick-count**, not traded size. Do not present it as contract/lot volume.
- **All timestamps tz-aware UTC.** `Candle.time` is the bar's OPEN time.
- **No em dashes / no "--"** in any UI copy, comments, or log strings (repo house rule): use colon/comma/period.
- **Commit after every task.** End commit bodies with the repo's two trailer lines (Co-Authored-By + Claude-Session), matching recent history.

## File Structure

- Create: `backend/auto_trader/brokers/dukascopy.py` — `DukascopyBroker`, `_INSTRUMENTS`/`_INTERVALS` maps, mapping helpers, `register()`.
- Create: `backend/scripts/dukascopy_import.py` — bulk prefill CLI.
- Create: `backend/tests/test_dukascopy_broker.py` — broker unit tests (mapping, candle build, mid, catalogue).
- Create: `backend/tests/test_dukascopy_import.py` — CLI test against a fake broker + temp cache.
- Modify: `backend/pyproject.toml` — add `dukascopy-python` dependency.
- Modify: `backend/auto_trader/brokers/registry.py:90-119` — register `dukascopy` in `build_registry()`.
- Modify: `frontend/src/lib/trading.ts:91-98` — add `dukascopy` label.
- Modify: `frontend/src/lib/trading.test.ts` — assert the new label.

---

### Task 1: Add dependency and pin the real library constants

Adds the dependency and creates `dukascopy.py` with verified instrument/interval/side maps and pure mapping helpers. The exact `INSTRUMENT_*` constant strings can only be confirmed against the installed package, so Step 2 enumerates them.

**Files:**
- Modify: `backend/pyproject.toml`
- Create: `backend/auto_trader/brokers/dukascopy.py`
- Test: `backend/tests/test_dukascopy_broker.py`

**Interfaces:**
- Consumes: `auto_trader.core.models.Resolution`, `Candle`; `auto_trader.brokers.base.MarketDataBroker`.
- Produces:
  - `_instrument_for(epic: str) -> str` — returns the `dukascopy_python.instruments` constant value; raises `ValueError` on unknown epic.
  - `_interval_for(resolution: Resolution) -> str` — returns the `dukascopy_python` interval constant value; raises `ValueError` on unsupported resolution.
  - `_offer_side_for(price_side: str) -> str | None` — `"bid"`/`"ask"` → the constant; `"mid"` → `None` (caller averages).
  - `_INSTRUMENTS: dict[str, InstrumentInfo]` where `InstrumentInfo` is a dataclass `(epic, constant, name, precision, kind, approx)`.

- [ ] **Step 1: Add the dependency and install**

Edit `backend/pyproject.toml`, add to the `dependencies` array (alongside `numpy>=2.0`):

```toml
    "dukascopy-python>=4.0.1",
```

Run: `cd backend && uv sync`
Expected: resolves and installs `dukascopy-python` and `pandas`.

- [ ] **Step 2: Enumerate the real constant names**

Run (from `backend/`):

```bash
uv run python -c "import dukascopy_python as d, dukascopy_python.instruments as i; \
print('INTERVALS:', [n for n in dir(d) if n.startswith('INTERVAL')]); \
print('SIDES:', [n for n in dir(d) if n.startswith('OFFER_SIDE')]); \
print('EURUSD?', [n for n in dir(i) if 'EUR_USD' in n]); \
print('GBPUSD?', [n for n in dir(i) if 'GBP_USD' in n]); \
print('USDJPY?', [n for n in dir(i) if 'USD_JPY' in n]); \
print('GOLD?', [n for n in dir(i) if 'XAU' in n or 'GOLD' in n]); \
print('SILVER?', [n for n in dir(i) if 'XAG' in n or 'SILVER' in n]); \
print('US500?', [n for n in dir(i) if '500' in n]); \
print('US30?', [n for n in dir(i) if 'USA_30' in n or 'US_30' in n or 'DOW' in n]); \
print('US100?', [n for n in dir(i) if '100' in n and ('USA' in n or 'NAS' in n or 'US' in n)])"
```

Record the exact names printed. The convention is `INSTRUMENT_<GROUP>_<SYMBOL>` (e.g. `INSTRUMENT_FX_MAJORS_EUR_USD`, `INSTRUMENT_METALS_XAU_USD`) and `INTERVAL_MIN_1 / _5 / _15 / _30`, `INTERVAL_HOUR_1 / _4`, `INTERVAL_DAY_1`, `INTERVAL_WEEK_1`. Use the ACTUAL printed names in Step 4; if a name differs from the convention, the printed value wins. If `INTERVAL_HOUR_4` or `INTERVAL_WEEK_1` is absent, note it: Task 2 Step 5 covers the fallback (aggregate is deferred; raise `ValueError` for now so it is explicit, not silently wrong).

- [ ] **Step 3: Write the failing test for the mapping helpers**

Create `backend/tests/test_dukascopy_broker.py`:

```python
"""Dukascopy broker: mapping helpers + candle building (no network).

The library's fetch() is monkeypatched everywhere; these tests never hit
Dukascopy. Constant VALUES are opaque strings from dukascopy_python, so we
assert against the library's own constants, not hardcoded strings.
"""

from __future__ import annotations

import pytest

import dukascopy_python
import dukascopy_python.instruments as dinstr

from auto_trader.brokers.dukascopy import (
    _instrument_for,
    _interval_for,
    _offer_side_for,
)
from auto_trader.core.models import Resolution


def test_instrument_for_known_epic():
    assert _instrument_for("EURUSD") == dinstr.INSTRUMENT_FX_MAJORS_EUR_USD


def test_instrument_for_unknown_epic_raises():
    with pytest.raises(ValueError, match="unknown"):
        _instrument_for("NOPE")


def test_interval_for_minute():
    assert _interval_for(Resolution.MINUTE) == dukascopy_python.INTERVAL_MIN_1


def test_interval_for_hour():
    assert _interval_for(Resolution.HOUR) == dukascopy_python.INTERVAL_HOUR_1


def test_offer_side_bid_ask_mid():
    assert _offer_side_for("bid") == dukascopy_python.OFFER_SIDE_BID
    assert _offer_side_for("ask") == dukascopy_python.OFFER_SIDE_ASK
    assert _offer_side_for("mid") is None
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py -v`
Expected: FAIL with `ModuleNotFoundError: auto_trader.brokers.dukascopy` (module not created yet).

- [ ] **Step 5: Create the module with maps and helpers**

Create `backend/auto_trader/brokers/dukascopy.py`. Use the ACTUAL constant names recorded in Step 2 for any that differ from the convention below:

```python
"""Dukascopy Bank historical candles as a read-only data broker.

Dukascopy publishes free deep history (back to ~2003) for FX, metals and
indices. Our brokers only keep a rolling window of low-timeframe bars, so this
source exists to give backtests and charts years of 1-minute (and higher) data.

Data-only: no live stream (supports_streaming stays False) and no quote, so it
cannot back paper trading. It rides the standard broker-extension path: implement
the ABCs + register(), no route edits. Its cache namespace is
("dukascopy", epic, resolution, side), isolated from the live brokers so the two
price feeds never blend under one coverage watermark.

The underlying dukascopy_python.fetch() is synchronous and does the bi5 download,
LZMA decompression, tick-to-bar aggregation and per-instrument price scaling
internally, so get_candles just maps our epic/resolution/side to its constants
and runs it in a thread. Volume is TICK-COUNT volume, not traded size.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone

import dukascopy_python
import dukascopy_python.instruments as dinstr

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.core.models import Candle, Resolution


@dataclass(frozen=True)
class InstrumentInfo:
    epic: str          # our symbol, shown in the picker
    constant: str      # dukascopy_python.instruments constant VALUE
    name: str          # display name
    precision: int     # decimal places for price display
    kind: str          # "fx" | "metal" | "index"
    approx: bool = False  # index CFDs differ from broker pricing/sessions


# Curated catalogue. Use the exact constants confirmed in Task 1 Step 2.
_INSTRUMENT_LIST: list[InstrumentInfo] = [
    InstrumentInfo("EURUSD", dinstr.INSTRUMENT_FX_MAJORS_EUR_USD, "EUR/USD", 5, "fx"),
    InstrumentInfo("GBPUSD", dinstr.INSTRUMENT_FX_MAJORS_GBP_USD, "GBP/USD", 5, "fx"),
    InstrumentInfo("USDJPY", dinstr.INSTRUMENT_FX_MAJORS_USD_JPY, "USD/JPY", 3, "fx"),
    InstrumentInfo("AUDUSD", dinstr.INSTRUMENT_FX_MAJORS_AUD_USD, "AUD/USD", 5, "fx"),
    InstrumentInfo("USDCHF", dinstr.INSTRUMENT_FX_MAJORS_USD_CHF, "USD/CHF", 5, "fx"),
    InstrumentInfo("USDCAD", dinstr.INSTRUMENT_FX_MAJORS_USD_CAD, "USD/CAD", 5, "fx"),
    InstrumentInfo("NZDUSD", dinstr.INSTRUMENT_FX_MAJORS_NZD_USD, "NZD/USD", 5, "fx"),
    InstrumentInfo("XAUUSD", dinstr.INSTRUMENT_METALS_XAU_USD, "Gold", 3, "metal"),
    InstrumentInfo("XAGUSD", dinstr.INSTRUMENT_METALS_XAG_USD, "Silver", 4, "metal"),
    InstrumentInfo("US500", dinstr.INSTRUMENT_US_500_IDX_USD, "S&P 500", 2, "index", approx=True),
    InstrumentInfo("US30", dinstr.INSTRUMENT_US_30_IDX_USD, "Dow 30", 1, "index", approx=True),
    InstrumentInfo("US100", dinstr.INSTRUMENT_US_TECH_100_IDX_USD, "Nasdaq 100", 1, "index", approx=True),
]
_INSTRUMENTS: dict[str, InstrumentInfo] = {i.epic: i for i in _INSTRUMENT_LIST}

_INTERVALS: dict[Resolution, str] = {
    Resolution.MINUTE: dukascopy_python.INTERVAL_MIN_1,
    Resolution.MINUTE_5: dukascopy_python.INTERVAL_MIN_5,
    Resolution.MINUTE_15: dukascopy_python.INTERVAL_MIN_15,
    Resolution.MINUTE_30: dukascopy_python.INTERVAL_MIN_30,
    Resolution.HOUR: dukascopy_python.INTERVAL_HOUR_1,
    Resolution.HOUR_4: dukascopy_python.INTERVAL_HOUR_4,
    Resolution.DAY: dukascopy_python.INTERVAL_DAY_1,
    Resolution.WEEK: dukascopy_python.INTERVAL_WEEK_1,
}

_OFFER_SIDES: dict[str, str] = {
    "bid": dukascopy_python.OFFER_SIDE_BID,
    "ask": dukascopy_python.OFFER_SIDE_ASK,
}


def _instrument_for(epic: str) -> str:
    info = _INSTRUMENTS.get(epic)
    if info is None:
        raise ValueError(f"unknown dukascopy epic: {epic}")
    return info.constant


def _interval_for(resolution: Resolution) -> str:
    interval = _INTERVALS.get(resolution)
    if interval is None:
        raise ValueError(f"unsupported dukascopy resolution: {resolution}")
    return interval


def _offer_side_for(price_side: str) -> str | None:
    """bid/ask map to the library constant; mid returns None (caller averages
    bid and ask). Any other value falls back to mid."""
    return _OFFER_SIDES.get(price_side)
```

Note: if Step 2 showed different constant names (e.g. `INSTRUMENT_US_SPX_500` instead of `INSTRUMENT_US_500_IDX_USD`, or a missing `INTERVAL_HOUR_4`), correct the lines above to match. For any resolution whose constant does not exist in the installed library, delete that `_INTERVALS` entry so `_interval_for` raises rather than referencing a missing attribute at import time.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py -v`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
cd backend && git add pyproject.toml uv.lock auto_trader/brokers/dukascopy.py tests/test_dukascopy_broker.py
git commit -m "feat(dukascopy): add dependency + epic/interval/side maps

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Nt1oG1HY6ZnfLnFfrMwPoU')"
```

---

### Task 2: `get_candles` — fetch, build candles, synthesize mid

Adds the core candle fetch: map inputs, run `fetch()` in a thread, convert the DataFrame to ascending UTC `Candle`s, and synthesize `mid` by averaging bid and ask.

**Files:**
- Modify: `backend/auto_trader/brokers/dukascopy.py`
- Test: `backend/tests/test_dukascopy_broker.py`

**Interfaces:**
- Consumes: `_instrument_for`, `_interval_for`, `_offer_side_for` (Task 1).
- Produces:
  - `DukascopyBroker.get_candles(epic, resolution, start, end, price_side="mid") -> list[Candle]`
  - `_df_to_candles(df) -> list[Candle]` — module helper, ascending, tz-aware UTC.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_dukascopy_broker.py`:

```python
from datetime import datetime, timezone

import pandas as pd

from auto_trader.brokers.dukascopy import DukascopyBroker


def _fake_df(rows):
    """rows: list of (unix_seconds, o, h, l, c, v) -> OHLC DataFrame indexed by
    a tz-aware UTC DatetimeIndex named 'timestamp', mirroring dukascopy_python."""
    idx = pd.DatetimeIndex(
        [datetime.fromtimestamp(r[0], tz=timezone.utc) for r in rows], name="timestamp"
    )
    return pd.DataFrame(
        {
            "open": [r[1] for r in rows],
            "high": [r[2] for r in rows],
            "low": [r[3] for r in rows],
            "close": [r[4] for r in rows],
            "volume": [r[5] for r in rows],
        },
        index=idx,
    )


@pytest.fixture
def broker():
    return DukascopyBroker()


def _patch_fetch(monkeypatch, by_side):
    """by_side: dict OFFER_SIDE_* -> DataFrame. Records calls."""
    calls = []

    def fake_fetch(instrument, interval, offer_side, start, end):
        calls.append((instrument, interval, offer_side, start, end))
        return by_side[offer_side]

    monkeypatch.setattr("dukascopy_python.fetch", fake_fetch)
    return calls


def test_get_candles_bid_single_fetch(broker, monkeypatch):
    df = _fake_df([(1_600_000_000, 1.1, 1.2, 1.05, 1.15, 10.0)])
    calls = _patch_fetch(monkeypatch, {dukascopy_python.OFFER_SIDE_BID: df})
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)

    out = asyncio.run(broker.get_candles("EURUSD", Resolution.MINUTE, start, end, "bid"))

    assert len(calls) == 1  # bid only, no mid averaging
    assert len(out) == 1
    c = out[0]
    assert c.time == datetime.fromtimestamp(1_600_000_000, tz=timezone.utc)
    assert (c.open, c.high, c.low, c.close, c.volume) == (1.1, 1.2, 1.05, 1.15, 10.0)


def test_get_candles_mid_averages_bid_ask(broker, monkeypatch):
    bid = _fake_df([(1_600_000_000, 1.0, 1.0, 1.0, 1.0, 4.0)])
    ask = _fake_df([(1_600_000_000, 2.0, 2.0, 2.0, 2.0, 6.0)])
    calls = _patch_fetch(
        monkeypatch,
        {dukascopy_python.OFFER_SIDE_BID: bid, dukascopy_python.OFFER_SIDE_ASK: ask},
    )
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)

    out = asyncio.run(broker.get_candles("EURUSD", Resolution.MINUTE, start, end, "mid"))

    assert len(calls) == 2  # bid + ask
    assert out[0].close == 1.5  # (1.0 + 2.0) / 2


def test_get_candles_sorted_ascending(broker, monkeypatch):
    df = _fake_df([
        (1_600_000_120, 3, 3, 3, 3, 1.0),
        (1_600_000_000, 1, 1, 1, 1, 1.0),
        (1_600_000_060, 2, 2, 2, 2, 1.0),
    ])
    _patch_fetch(monkeypatch, {dukascopy_python.OFFER_SIDE_BID: df})
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)

    out = asyncio.run(broker.get_candles("EURUSD", Resolution.MINUTE, start, end, "bid"))
    assert [c.close for c in out] == [1, 2, 3]


def test_get_candles_unknown_epic_raises(broker):
    start = datetime(2020, 9, 13, tzinfo=timezone.utc)
    end = datetime(2020, 9, 14, tzinfo=timezone.utc)
    with pytest.raises(ValueError, match="unknown"):
        asyncio.run(broker.get_candles("NOPE", Resolution.MINUTE, start, end, "bid"))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py -k get_candles -v`
Expected: FAIL with `AttributeError`/`TypeError` (no `DukascopyBroker.get_candles` yet).

- [ ] **Step 3: Implement `get_candles` and `_df_to_candles`**

Append to `backend/auto_trader/brokers/dukascopy.py`:

```python
def _df_to_candles(df) -> list[Candle]:
    """OHLCV DataFrame (index = timestamp) -> ascending, tz-aware-UTC Candles.
    An empty frame yields []. The index may be tz-naive (assume UTC) or tz-aware
    (convert to UTC)."""
    if df is None or len(df) == 0:
        return []
    idx = df.index
    if idx.tz is None:
        idx = idx.tz_localize(timezone.utc)
    else:
        idx = idx.tz_convert(timezone.utc)
    out: list[Candle] = []
    for ts, row in zip(idx, df.itertuples(index=False)):
        out.append(
            Candle(
                time=ts.to_pydatetime(),
                open=float(row.open),
                high=float(row.high),
                low=float(row.low),
                close=float(row.close),
                volume=float(getattr(row, "volume", 0.0)),
            )
        )
    out.sort(key=lambda c: c.time)
    return out


class DukascopyBroker(MarketDataBroker):
    """Read-only historical candles from Dukascopy. Data-only: no stream, no quote."""

    supports_streaming = False

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        instrument = _instrument_for(epic)  # raises on unknown epic
        interval = _interval_for(resolution)  # raises on unsupported resolution
        side = _offer_side_for(price_side)
        if side is not None:
            df = await asyncio.to_thread(
                dukascopy_python.fetch, instrument, interval, side, start, end
            )
            return _df_to_candles(df)
        # mid: average bid and ask on their shared index. Two fetches; the cache
        # stores the result under side="mid" so this cost is paid once per series.
        import pandas as pd  # local import: only the mid path needs it

        bid = await asyncio.to_thread(
            dukascopy_python.fetch, instrument, interval,
            dukascopy_python.OFFER_SIDE_BID, start, end,
        )
        ask = await asyncio.to_thread(
            dukascopy_python.fetch, instrument, interval,
            dukascopy_python.OFFER_SIDE_ASK, start, end,
        )
        if bid is None or len(bid) == 0 or ask is None or len(ask) == 0:
            return _df_to_candles(bid if (ask is None or len(ask) == 0) else ask)
        bid_a, ask_a = bid.align(ask, join="inner", axis=0)
        return _df_to_candles((bid_a + ask_a) / 2.0)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py -v`
Expected: PASS (all tests, including Task 1's).

- [ ] **Step 5: Commit**

```bash
cd backend && git add auto_trader/brokers/dukascopy.py tests/test_dukascopy_broker.py
git commit -m "feat(dukascopy): get_candles with mid = avg(bid, ask)

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Nt1oG1HY6ZnfLnFfrMwPoU')"
```

---

### Task 3: `get_recent_candles`, `get_quote`, and the catalogue surface

Fills in the remaining `MarketDataBroker` methods so charts and the symbol-search modal work: recent-candle tailing, a null quote, and the catalogue driven by `_INSTRUMENTS`.

**Files:**
- Modify: `backend/auto_trader/brokers/dukascopy.py`
- Test: `backend/tests/test_dukascopy_broker.py`

**Interfaces:**
- Consumes: `DukascopyBroker.get_candles`, `_INSTRUMENT_LIST`, `_INSTRUMENTS`.
- Produces:
  - `get_recent_candles(epic, resolution, count, price_side="mid") -> list[Candle]`
  - `get_quote(epic) -> tuple[None, None]`
  - `search_markets(query, limit=20) -> list[dict]`, `all_markets() -> list[dict]`, `get_market_meta(epic) -> dict | None`, `get_market_detail(epic) -> dict | None`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_dukascopy_broker.py`:

```python
def test_get_recent_candles_tails_count(broker, monkeypatch):
    rows = [(1_600_000_000 + 60 * i, i, i, i, i, 1.0) for i in range(10)]
    _patch_fetch(monkeypatch, {dukascopy_python.OFFER_SIDE_BID: _fake_df(rows)})
    out = asyncio.run(broker.get_recent_candles("EURUSD", Resolution.MINUTE, 3, "bid"))
    assert len(out) == 3
    assert [c.close for c in out] == [7, 8, 9]  # last 3, ascending


def test_get_quote_is_none(broker):
    assert asyncio.run(broker.get_quote("EURUSD")) == (None, None)


def test_all_markets_lists_catalogue(broker):
    markets = asyncio.run(broker.all_markets())
    epics = {m["epic"] for m in markets}
    assert {"EURUSD", "XAUUSD", "US500"} <= epics
    eur = next(m for m in markets if m["epic"] == "EURUSD")
    assert eur["name"] == "EUR/USD"
    assert eur["type"] == "fx"


def test_search_markets_matches_epic_and_name(broker):
    by_epic = asyncio.run(broker.search_markets("eur"))
    assert any(m["epic"] == "EURUSD" for m in by_epic)
    by_name = asyncio.run(broker.search_markets("gold"))
    assert any(m["epic"] == "XAUUSD" for m in by_name)


def test_market_meta_has_precision(broker):
    meta = asyncio.run(broker.get_market_meta("USDJPY"))
    assert meta is not None
    assert meta["precision"] == 3
    assert asyncio.run(broker.get_market_meta("NOPE")) is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py -k "recent or quote or markets or meta" -v`
Expected: FAIL (`AttributeError` on `get_recent_candles` etc.).

- [ ] **Step 3: Implement the methods**

Append inside the `DukascopyBroker` class in `backend/auto_trader/brokers/dukascopy.py`:

```python
    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Most-recent `count` bars. Dukascopy has no 'recent N' primitive, so pull
        a window sized to `count` bars back from now (with slack for weekend/holiday
        gaps) and tail it."""
        from datetime import timedelta

        now = datetime.now(timezone.utc)
        span_seconds = resolution.seconds * max(count, 1)
        start = now - timedelta(seconds=span_seconds * 3 + 7 * 86_400)
        bars = await self.get_candles(epic, resolution, start, now, price_side)
        return bars[-count:]

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Historical-only source: no live quote. Paper trading cannot price off
        this broker (documented limitation)."""
        return (None, None)

    def _market_row(self, info: InstrumentInfo) -> dict:
        note = "Index pricing/sessions differ from broker CFDs." if info.approx else ""
        return {
            "epic": info.epic,
            "name": info.name,
            "status": "TRADEABLE",  # history is always available; no live session gate
            "type": info.kind,
            "precision": info.precision,
            "note": note,
        }

    async def all_markets(self) -> list[dict]:
        return [self._market_row(i) for i in _INSTRUMENT_LIST]

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        q = query.strip().lower()
        rows = [
            self._market_row(i)
            for i in _INSTRUMENT_LIST
            if q in i.epic.lower() or q in i.name.lower()
        ]
        return rows[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        info = _INSTRUMENTS.get(epic)
        return self._market_row(info) if info else None

    async def get_market_detail(self, epic: str) -> dict | None:
        return await self.get_market_meta(epic)
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
cd backend && git add auto_trader/brokers/dukascopy.py tests/test_dukascopy_broker.py
git commit -m "feat(dukascopy): recent candles, null quote, catalogue surface

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Nt1oG1HY6ZnfLnFfrMwPoU')"
```

---

### Task 4: Register the broker

Wires `dukascopy` into `build_registry()` so it appears in the data-source selector and routes through the existing candle path. No credentials, so it registers unconditionally.

**Files:**
- Modify: `backend/auto_trader/brokers/dukascopy.py`
- Modify: `backend/auto_trader/brokers/registry.py`
- Test: `backend/tests/test_dukascopy_broker.py`

**Interfaces:**
- Consumes: `DukascopyBroker`, `BrokerRegistry.add_data`.
- Produces: `register(registry: BrokerRegistry) -> DukascopyBroker`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_dukascopy_broker.py`:

```python
def test_build_registry_includes_dukascopy():
    from auto_trader.brokers.registry import build_registry

    registry = build_registry()
    assert "dukascopy" in registry.data
    assert "dukascopy" in registry.describe()["data"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py::test_build_registry_includes_dukascopy -v`
Expected: FAIL (`assert "dukascopy" in {...}` is False).

- [ ] **Step 3: Add `register()` to the broker module**

Append to `backend/auto_trader/brokers/dukascopy.py`:

```python
def register(registry) -> DukascopyBroker:
    """Register the read-only dukascopy data broker. No credentials needed, so it
    is always available. Data-only: no executor is registered, so it appears as a
    chart/backtest source but not a tradeable account."""
    broker = DukascopyBroker()
    registry.add_data("dukascopy", broker)
    return broker
```

- [ ] **Step 4: Wire it into `build_registry()`**

In `backend/auto_trader/brokers/registry.py`, in `build_registry()`:

Change the import line (currently `from auto_trader.brokers import capital, ig, mt5`) to:

```python
    from auto_trader.brokers import capital, dukascopy, ig, mt5
```

Then, immediately after `registry = BrokerRegistry()` and before `capital.register(registry)`, add:

```python
    # Dukascopy: read-only deep-history source (FX/metals/indices). No credentials,
    # always available. Data-only, so no executor: a chart/backtest source, not a
    # tradeable account.
    dukascopy.register(registry)
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py -v`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
cd backend && git add auto_trader/brokers/dukascopy.py auto_trader/brokers/registry.py tests/test_dukascopy_broker.py
git commit -m "feat(dukascopy): register as an always-on data broker

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Nt1oG1HY6ZnfLnFfrMwPoU')"
```

---

### Task 5: Bulk prefill CLI

A script that deep-fills one series into the candle cache via the existing coverage-safe machinery, decoupling the slow multi-year pull from the interactive request path.

**Files:**
- Create: `backend/scripts/dukascopy_import.py`
- Test: `backend/tests/test_dukascopy_import.py`

**Interfaces:**
- Consumes: `DukascopyBroker.get_candles`/`get_recent_candles`, `CandleCache.recent`, `CandleCache.backfill_below`, `Resolution`.
- Produces:
  - `async def prefill(cache, broker, epic, resolution, side, target_oldest_ts, *, seed_count=500) -> str` — seeds a forward anchor block then backfills to target; returns the `backfill_below` status string.
  - `main(argv=None)` — argparse entrypoint.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_dukascopy_import.py`:

```python
"""Prefill CLI: drives cache.recent + backfill_below with a fake broker over a
temp cache db, so no network and no real dukascopy import is needed."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.models import Candle, Resolution
from scripts.dukascopy_import import prefill


class FakeBroker:
    """Returns 1-minute bars for any requested [start, end], newest-inclusive."""

    async def get_recent_candles(self, epic, resolution, count, price_side="mid"):
        now = int(datetime.now(timezone.utc).timestamp()) // 60 * 60
        return [
            Candle(
                time=datetime.fromtimestamp(now - 60 * (count - 1 - i), tz=timezone.utc),
                open=1.0, high=1.0, low=1.0, close=1.0, volume=1.0,
            )
            for i in range(count)
        ]

    async def get_candles(self, epic, resolution, start, end, price_side="mid"):
        s = int(start.timestamp()) // 60 * 60
        e = int(end.timestamp()) // 60 * 60
        out = []
        t = s
        while t <= e:
            out.append(Candle(
                time=datetime.fromtimestamp(t, tz=timezone.utc),
                open=1.0, high=1.0, low=1.0, close=1.0, volume=1.0,
            ))
            t += 60
        return out


def test_prefill_fills_down_to_target(tmp_path):
    cache = CandleCache(str(tmp_path / "cache.db"))
    broker = FakeBroker()
    now = int(datetime.now(timezone.utc).timestamp())
    target = (now // 60 * 60) - 60 * 500  # 500 minutes back

    status = asyncio.run(
        prefill(cache, broker, "EURUSD", Resolution.MINUTE, "mid", target, seed_count=50)
    )

    assert status in ("target", "floor")
    key = ("dukascopy", "EURUSD", "MINUTE", "mid")
    cov = cache._coverage(key)
    assert cov is not None
    assert cov[0] <= target + 60  # reached (within one bar of) the target
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_dukascopy_import.py -v`
Expected: FAIL with `ModuleNotFoundError: scripts.dukascopy_import`.

- [ ] **Step 3: Write the CLI**

Create `backend/scripts/dukascopy_import.py`:

```python
"""Bulk-prefill deep Dukascopy history into the candle cache.

Deep 1-minute history is tens of thousands of per-hour files, so pulling it
through the interactive chart path would hold the per-series cache lock for a
long time. This script does the slow pull out-of-band: run it once per series,
then charts/backtests read instantly from the warmed cache.

Run from backend/ (venv active):
    python -m scripts.dukascopy_import EURUSD MINUTE --from 2015-01-01
    python -m scripts.dukascopy_import XAUUSD HOUR --from 2010-01-01 --side bid

It reuses the cache's coverage-safe machinery (recent + backfill_below) rather
than writing rows itself, so a truncated/failed pull can never punch a silent
hole; re-running resumes from where coverage stopped.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import datetime, timezone

from auto_trader.brokers.dukascopy import DukascopyBroker
from auto_trader.core.candle_cache import CANDLE_CACHE, CandleCache
from auto_trader.core.models import Resolution

log = logging.getLogger("dukascopy_import")


async def prefill(
    cache: CandleCache,
    broker,
    epic: str,
    resolution: Resolution,
    side: str,
    target_oldest_ts: int,
    *,
    seed_count: int = 500,
) -> str:
    """Seed a forward anchor block, then backfill down to target_oldest_ts.
    Returns backfill_below's status ("target"/"floor"/"cold"/"error")."""
    key = ("dukascopy", epic, resolution.value, side)
    res_seconds = resolution.seconds

    async def fetch_recent(n: int):
        return await broker.get_recent_candles(epic, resolution, n, side)

    async def fetch_range(start: datetime, end: datetime):
        return await broker.get_candles(epic, resolution, start, end, side)

    # 1) Establish coverage so backfill_below has an anchor to walk below.
    await cache.recent(key, res_seconds, seed_count, fetch_recent)
    # 2) Walk oldest down to the target date (or the broker's data floor).
    status = await cache.backfill_below(
        key, res_seconds, fetch_range, target_oldest_ts=target_oldest_ts
    )
    log.info("prefill %s %s %s -> %s", epic, resolution.value, side, status)
    return status


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    parser = argparse.ArgumentParser(description="Prefill Dukascopy history into the candle cache.")
    parser.add_argument("epic", help="e.g. EURUSD, XAUUSD, US500")
    parser.add_argument("resolution", help="MINUTE, MINUTE_5, HOUR, DAY, ...")
    parser.add_argument("--from", dest="from_date", required=True, help="YYYY-MM-DD (oldest bar to pull)")
    parser.add_argument("--side", default="mid", choices=["mid", "bid", "ask"])
    parser.add_argument("--seed-count", type=int, default=500)
    args = parser.parse_args(argv)

    resolution = Resolution(args.resolution)
    target = int(datetime.strptime(args.from_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    broker = DukascopyBroker()

    status = asyncio.run(
        prefill(CANDLE_CACHE, broker, args.epic, resolution, args.side, target, seed_count=args.seed_count)
    )
    print(f"done: {args.epic} {args.resolution} {args.side} -> {status}")
    return 0 if status in ("target", "floor") else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_dukascopy_import.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && git add scripts/dukascopy_import.py tests/test_dukascopy_import.py
git commit -m "feat(dukascopy): bulk prefill CLI over backfill_below

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Nt1oG1HY6ZnfLnFfrMwPoU')"
```

---

### Task 6: Frontend selector label

Gives the source a friendly name in the broker selector. Everything else (symbol search, charting) already flows through broker-agnostic paths.

**Files:**
- Modify: `frontend/src/lib/trading.ts:91-98`
- Test: `frontend/src/lib/trading.test.ts`

**Interfaces:**
- Consumes: `brokerLabel(brokerId)` (existing).
- Produces: `BROKER_LABELS["dukascopy"] === "Dukascopy (history)"`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/trading.test.ts` (inside the existing describe block for `brokerLabel`, or a new one mirroring the existing label assertions):

```ts
it("labels the dukascopy history source", () => {
  expect(brokerLabel("dukascopy")).toBe("Dukascopy (history)");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/trading.test.ts -t "dukascopy"`
Expected: FAIL (returns `"Dukascopy"` from the capitalize fallback, not `"Dukascopy (history)"`).

- [ ] **Step 3: Add the label**

In `frontend/src/lib/trading.ts`, add to the `BROKER_LABELS` object (after the `ig-live` entry):

```ts
  // Read-only deep-history source (Dukascopy). Charts/backtests only, no dealing.
  dukascopy: "Dukascopy (history)",
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/lib/trading.test.ts -t "dukascopy"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/trading.ts src/lib/trading.test.ts
git commit -m "feat(dukascopy): label the history source in the broker selector

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Nt1oG1HY6ZnfLnFfrMwPoU')"
```

---

### Task 7: End-to-end verification

Prove the source works through the real app, not just unit tests. This is a manual verification task (no new code) using the `verify`/`run` flow.

- [ ] **Step 1: Full backend test run**

Run: `cd backend && uv run pytest tests/test_dukascopy_broker.py tests/test_dukascopy_import.py -v`
Expected: all green.

- [ ] **Step 2: Live library smoke pull** (real network, one small window)

Run (from `backend/`):

```bash
uv run python -c "import asyncio; from datetime import datetime, timezone, timedelta; \
from auto_trader.brokers.dukascopy import DukascopyBroker; \
b=DukascopyBroker(); end=datetime(2020,1,3,tzinfo=timezone.utc); start=end-timedelta(days=1); \
bars=asyncio.run(b.get_candles('EURUSD', __import__('auto_trader.core.models', fromlist=['Resolution']).Resolution.MINUTE, start, end, 'mid')); \
print('bars:', len(bars), 'first:', bars[0] if bars else None, 'last:', bars[-1] if bars else None)"
```

Expected: several hundred 1-minute bars for 2020-01-02, prices near EURUSD ~1.12, ascending UTC timestamps. If this returns 0 bars or wrong-magnitude prices, STOP: the instrument/interval constant mapping in Task 1 is wrong, fix it before proceeding.

- [ ] **Step 3: Chart it in the running app**

Start the app (project `run` skill or the usual dev servers). In the UI: switch the data source to "Dukascopy (history)", open the symbol search, confirm EURUSD/XAUUSD/US500 appear, select EURUSD on the 1m timeframe, and pan back past what your live broker retains. Confirm bars render with no gap/seam and the live dot is off (data-only). Confirm a backtest over an old date range (e.g. 2020) returns trades.

- [ ] **Step 4: No commit** (verification only). Record the smoke-pull bar count and a screenshot in the PR/summary.

---

## Self-Review

**Spec coverage:**
- Read-only `dukascopy` MarketDataBroker, own namespace → Tasks 2-4. ✓
- `dukascopy-python` dep + pandas note → Task 1 Step 1 + Global Constraints. ✓
- Resolution/instrument/side maps, unknown→error → Task 1 + Task 2 tests. ✓
- `mid` = avg(bid, ask) cached once → Task 2 Step 3 + test. ✓
- volume = tick-count note → module docstring (Task 1 Step 5) + Global Constraints. ✓
- Data-only: `supports_streaming=False`, `get_quote → (None,None)`, no paper trading → Task 2 (flag) + Task 3. ✓
- Catalogue (FX/metals/indices, indices approx flag) → Task 3. ✓
- On-demand path free via existing deps wiring → confirmed in spec/Architecture; exercised in Task 7 Step 3 (no code). ✓
- Prefill CLI over backfill_below → Task 5. ✓
- Frontend label only → Task 6. ✓
- Error handling (ValueError→4xx, cache fallback on raise, backfill "error" resumable) → Task 2/Task 5 behaviour + Global Constraints. ✓
- Testing plan (hermetic fake-fetch, no CI network) → Tasks 1-5 tests; live smoke is Task 7 (manual, not CI). ✓

**Placeholder scan:** The only deferred literals are the exact `INSTRUMENT_*`/`INTERVAL_*` constant NAMES, which genuinely cannot be known until the package is installed; Task 1 Step 2 is a concrete enumeration command that resolves them, and Step 5 instructs correcting the table to match. Not a hidden TODO.

**Type consistency:** `prefill(...)` signature identical in Task 5 test and impl. `_instrument_for/_interval_for/_offer_side_for` signatures match Task 1 definition and Task 2 usage. Cache key tuple `("dukascopy", epic, resolution.value, side)` uses `resolution.value` (a str) consistently with `CandleKey = tuple[str, str, str, str]`. `_market_row` keys (`epic/name/status/type/precision/note`) consistent across catalogue methods and tests.
