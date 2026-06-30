# Candle History Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent backend cache for minute-and-above chart history so timeframe switches are fast, IG's weekly allowance and Capital round-trips are spared, and history survives restarts/outages.

**Architecture:** A new `CandleCache` (sqlite, sibling to the existing `TickStore`) sits between the `/api/candles` route and the broker. The route injects broker fetch callables; the cache decides what to fetch. Coverage per series is two watermarks `[oldest_ts, newest_ts]`; below-oldest requests trigger a **contiguous backfill** down to the requested start, keeping coverage gap-free (which also makes the future chart-replay feature work without a redesign).

**Tech Stack:** Python 3.14, FastAPI, stdlib `sqlite3`, `pytest` (sync tests via `asyncio.run`, `tmp_path` fixture).

## Global Constraints

- **Closed bars only in storage.** A bar at open-time `ts` spanning `[ts, ts+res_seconds)` is closed once `now` has left its interval. The cutoff is the **forming bucket's open time**: `cutoff_ts = (int(now) // res_seconds) * res_seconds`. Never store a bar with `ts >= cutoff_ts` (strict `<`), so the bar whose interval contains `now` (the forming bar) is excluded while the one that just closed is kept. Both `window()` and `recent()` derive the cutoff from the shared helper `_bucket_start(now_s, res_seconds)` so the two paths agree on "closed" while writing the same table. (NB: an earlier draft used `now - res_seconds`, which wrongly dropped the just-closed bar — see Task 3.)
- **`ts` is bar-open unix seconds (int, UTC).** Convert `Candle.time` ↔ `ts` with `int(c.time.timestamp())` / `datetime.fromtimestamp(ts, tz=timezone.utc)`.
- **Cache is never load-bearing for correctness.** On any broker-fetch exception, serve whatever the cache holds; re-raise the original exception only when the cache yields nothing.
- **Per-side rows.** Series key is `(broker, epic, resolution, side)` — bid/mid/ask cached independently.
- **No new dependencies.** stdlib `sqlite3` only, mirroring `tick_store.py`.
- **Recent-N response still includes the forming bar** (so the chart shows current price immediately, exactly as today) — the cache stores only closed bars but appends the freshly-fetched forming bar to the response.
- **Out of scope for v1:** stream write-through, pruning/retention. Seconds intervals stay on `TICK_STORE`, untouched.

---

## File Structure

- **Create** `backend/auto_trader/core/candle_cache.py` — the `CandleCache` class + module singleton `CANDLE_CACHE`. One responsibility: cache/serve closed candle history.
- **Create** `backend/tests/test_candle_cache.py` — unit tests with a fake fetcher.
- **Modify** `backend/auto_trader/config.py` — add `candle_db_path` setting.
- **Modify** `backend/auto_trader/api/app.py` — wire the cache into the `/api/candles` route.

---

## Task 1: Storage primitives (schema, store, read, coverage)

**Files:**
- Create: `backend/auto_trader/core/candle_cache.py`
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Consumes: `auto_trader.core.models.Candle`.
- Produces:
  - `CandleKey = tuple[str, str, str, str]` — `(broker, epic, resolution, side)`.
  - `class CandleCache.__init__(self, db_path: str)`.
  - `CandleCache._store_closed(self, key: CandleKey, bars: list[Candle], cutoff_ts: int) -> None` — inserts (OR REPLACE) only bars with `ts < cutoff_ts`; unions coverage with the stored bars' min/max ts. No-op if nothing qualifies.
  - `CandleCache._read_window(self, key: CandleKey, from_ts: int, to_ts: int) -> list[Candle]` — bars in `[from_ts, to_ts]`, ascending.
  - `CandleCache._read_back(self, key: CandleKey, n: int, before_ts: int) -> list[Candle]` — most-recent `n` bars with `ts < before_ts`, returned ascending.
  - `CandleCache._coverage(self, key: CandleKey) -> tuple[int, int] | None` — `(oldest_ts, newest_ts)` or None.
  - `CandleCache._extend_coverage(self, key: CandleKey, lo: int, hi: int) -> None` — union the coverage range with `[lo, hi]`.
  - `CandleCache._cached_count(self, key: CandleKey) -> int` — number of stored bars for the series.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_candle_cache.py
from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.models import Candle


def _c(ts: int, close: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=close, high=close, low=close, close=close, volume=0.0,
    )


KEY = ("capital", "EURUSD", "MINUTE", "mid")


def test_store_closed_filters_forming_and_sets_coverage(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    bars = [_c(100, 1.0), _c(160, 2.0), _c(220, 3.0)]  # ts 100,160,220
    cache._store_closed(KEY, bars, cutoff_ts=220)  # 220 is forming -> excluded
    assert cache._coverage(KEY) == (100, 160)
    assert cache._cached_count(KEY) == 2
    got = cache._read_window(KEY, 0, 1000)
    assert [int(c.time.timestamp()) for c in got] == [100, 160]
    assert got[1].close == 2.0


def test_read_back_returns_most_recent_n_ascending(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220, 280)], cutoff_ts=10_000)
    back = cache._read_back(KEY, n=2, before_ts=10_000)
    assert [int(c.time.timestamp()) for c in back] == [220, 280]


def test_extend_coverage_unions_range(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(200, 1.0)], cutoff_ts=10_000)  # coverage (200,200)
    cache._extend_coverage(KEY, 50, 200)  # backfilled an empty gap down to 50
    assert cache._coverage(KEY) == (50, 200)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_candle_cache.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.core.candle_cache'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/auto_trader/core/candle_cache.py
"""Persistent cache for minute-and-above candle history.

Sits between the /api/candles route and the broker: the route injects broker
fetch callables, the cache decides what to fetch and serves the rest from sqlite.
Broker-agnostic (no broker imports) so it unit-tests with a fake fetcher.

Storage is stdlib sqlite3 (no new dependency), a sibling file to tick_store's, so
history survives `uvicorn --reload`. Only CLOSED bars are stored — the forming bar
never enters the cache (it changes every tick). Coverage per series is two
watermarks [oldest_ts, newest_ts]; below-oldest requests backfill the whole gap so
coverage stays contiguous (no holes) — which is also what the future replay feature
needs (play forward continuously from an arbitrary past point).
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timezone

from auto_trader.core.models import Candle

log = logging.getLogger(__name__)

CandleKey = tuple[str, str, str, str]  # (broker, epic, resolution, side)


def _to_candle(ts: int, o: float, h: float, l: float, c: float, v: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=o, high=h, low=l, close=c, volume=v,
    )


class CandleCache:
    """Sqlite-backed closed-bar cache. Fresh connection per op (cheap for sqlite,
    sidesteps the one-connection-per-thread rule; public async methods run the sync
    helpers via asyncio.to_thread)."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._connect().close()  # create db file + schema up front

    def _connect(self) -> sqlite3.Connection:
        # Ensure schema on EVERY connection (robust to an older db file / cwd change),
        # mirroring tick_store.
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS bars ("
            "broker TEXT, epic TEXT, resolution TEXT, side TEXT, ts INTEGER,"
            "open REAL, high REAL, low REAL, close REAL, volume REAL,"
            "PRIMARY KEY (broker, epic, resolution, side, ts))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS coverage ("
            "broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
            "oldest_ts INTEGER, newest_ts INTEGER,"
            "PRIMARY KEY (broker, epic, resolution, side))"
        )
        conn.commit()
        return conn

    def _store_closed(self, key: CandleKey, bars: list[Candle], cutoff_ts: int) -> None:
        rows = [
            (*key, int(b.time.timestamp()), b.open, b.high, b.low, b.close, b.volume)
            for b in bars
            if int(b.time.timestamp()) < cutoff_ts
        ]
        if not rows:
            return
        conn = self._connect()
        try:
            conn.executemany(
                "INSERT OR REPLACE INTO bars "
                "(broker, epic, resolution, side, ts, open, high, low, close, volume) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            conn.commit()
        finally:
            conn.close()
        ts_vals = [r[4] for r in rows]
        self._extend_coverage(key, min(ts_vals), max(ts_vals))

    def _read_window(self, key: CandleKey, from_ts: int, to_ts: int) -> list[Candle]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT ts, open, high, low, close, volume FROM bars "
                "WHERE broker=? AND epic=? AND resolution=? AND side=? "
                "AND ts BETWEEN ? AND ? ORDER BY ts ASC",
                (*key, from_ts, to_ts),
            ).fetchall()
        finally:
            conn.close()
        return [_to_candle(*r) for r in rows]

    def _read_back(self, key: CandleKey, n: int, before_ts: int) -> list[Candle]:
        if n <= 0:
            return []
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT ts, open, high, low, close, volume FROM bars "
                "WHERE broker=? AND epic=? AND resolution=? AND side=? AND ts < ? "
                "ORDER BY ts DESC LIMIT ?",
                (*key, before_ts, n),
            ).fetchall()
        finally:
            conn.close()
        return [_to_candle(*r) for r in reversed(rows)]

    def _coverage(self, key: CandleKey) -> tuple[int, int] | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT oldest_ts, newest_ts FROM coverage "
                "WHERE broker=? AND epic=? AND resolution=? AND side=?",
                key,
            ).fetchone()
        finally:
            conn.close()
        return (row[0], row[1]) if row else None

    def _extend_coverage(self, key: CandleKey, lo: int, hi: int) -> None:
        cur = self._coverage(key)
        if cur is not None:
            lo, hi = min(lo, cur[0]), max(hi, cur[1])
        conn = self._connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO coverage "
                "(broker, epic, resolution, side, oldest_ts, newest_ts) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (*key, lo, hi),
            )
            conn.commit()
        finally:
            conn.close()

    def _cached_count(self, key: CandleKey) -> int:
        conn = self._connect()
        try:
            (n,) = conn.execute(
                "SELECT COUNT(*) FROM bars "
                "WHERE broker=? AND epic=? AND resolution=? AND side=?",
                key,
            ).fetchone()
        finally:
            conn.close()
        return n
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_candle_cache.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): candle cache storage primitives (bars + coverage)"
```

---

## Task 2: `window()` — contiguous-backfill scroll-back path

**Files:**
- Modify: `backend/auto_trader/core/candle_cache.py`
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Consumes: Task 1 primitives.
- Produces:
  - `async CandleCache.window(self, key: CandleKey, res_seconds: int, start: datetime, end: datetime, fetch_range: Callable[[datetime, datetime], Awaitable[list[Candle]]], *, now: float | None = None) -> list[Candle]`
  - Behavior: cache hit when `[from_ts, to_ts] ⊆ coverage` → zero fetch calls. Miss → fetch the gap **below `oldest_ts` down to `from_ts`** (or the whole window when cold), store closed bars, extend coverage to cover `[from_ts, to_ts]` (even on an empty fetch, so closed-market gaps aren't re-fetched), serve from cache. On fetch exception, serve cache and re-raise only if empty.
  - `fetch_range` is called as `await fetch_range(start_dt, end_dt)`.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_candle_cache.py
import asyncio


class FakeFetcher:
    """Records calls; returns canned candles. Stand-in for the broker."""

    def __init__(self, bars: list[Candle] | None = None, error: Exception | None = None):
        self._bars = bars or []
        self._error = error
        self.range_calls: list[tuple[int, int]] = []
        self.recent_calls: list[int] = []

    async def range(self, start: datetime, end: datetime) -> list[Candle]:
        self.range_calls.append((int(start.timestamp()), int(end.timestamp())))
        if self._error:
            raise self._error
        s, e = int(start.timestamp()), int(end.timestamp())
        return [b for b in self._bars if s <= int(b.time.timestamp()) <= e]

    async def recent(self, count: int) -> list[Candle]:
        self.recent_calls.append(count)
        if self._error:
            raise self._error
        return self._bars[-count:]


def _dt(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def test_window_cold_fetches_and_stores(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(KEY, 60, _dt(100), _dt(280), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220, 280]
    assert len(f.range_calls) == 1  # cold miss -> one fetch


def test_window_warm_hit_makes_zero_calls(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(280), f.range, now=10_000))
    f.range_calls.clear()
    again = asyncio.run(cache.window(KEY, 60, _dt(160), _dt(220), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in again] == [160, 220]
    assert f.range_calls == []  # fully covered -> no fetch


def test_window_replay_backfill_fills_gap_below_oldest(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # Warm coverage to [220, 280].
    f0 = FakeFetcher([_c(t, float(t)) for t in (220, 280)])
    asyncio.run(cache.window(KEY, 60, _dt(220), _dt(280), f0.range, now=10_000))
    # Replay jump to ts=40: must backfill the whole gap [40, 220].
    src = [_c(t, float(t)) for t in (40, 100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(KEY, 60, _dt(40), _dt(120), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [40, 100]
    # Backfill fetched down to oldest (220), not just the tiny [40,120] window.
    assert f.range_calls == [(40, 220)]
    assert cache._coverage(KEY) == (40, 280)


def test_window_empty_gap_advances_oldest_no_refetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    f = FakeFetcher([])  # broker has nothing in this range (closed market)
    asyncio.run(cache.window(KEY, 60, _dt(40), _dt(100), f.range, now=10_000))
    assert cache._coverage(KEY) == (40, 100)  # recorded as covered (empty)
    asyncio.run(cache.window(KEY, 60, _dt(40), _dt(100), f.range, now=10_000))
    assert len(f.range_calls) == 1  # second call served from cache, no refetch


def test_window_serves_cache_when_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    good = FakeFetcher([_c(t, float(t)) for t in (100, 160, 220)])
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), good.range, now=10_000))
    boom = FakeFetcher(error=RuntimeError("breaker open"))
    out = asyncio.run(cache.window(KEY, 60, _dt(100), _dt(160), boom.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [100, 160]  # cache served despite error


def test_window_reraises_when_cache_empty_and_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    boom = FakeFetcher(error=RuntimeError("breaker open"))
    try:
        asyncio.run(cache.window(KEY, 60, _dt(100), _dt(160), boom.range, now=10_000))
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert str(e) == "breaker open"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_candle_cache.py -k window -v`
Expected: FAIL — `AttributeError: 'CandleCache' object has no attribute 'window'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add imports at top of candle_cache.py
import asyncio
import time
from collections.abc import Awaitable, Callable
```

```python
# add method to CandleCache
    async def window(
        self,
        key: CandleKey,
        res_seconds: int,
        start: datetime,
        end: datetime,
        fetch_range: Callable[[datetime, datetime], Awaitable[list[Candle]]],
        *,
        now: float | None = None,
    ) -> list[Candle]:
        """Candles in [start, end]. Cache hit when the window is fully covered.
        Otherwise contiguous-backfill: fetch the gap below oldest down to `start`
        (or the whole window when cold), store closed bars, mark covered, serve."""
        from_ts, to_ts = int(start.timestamp()), int(end.timestamp())
        cov = await asyncio.to_thread(self._coverage, key)
        if cov is not None and cov[0] <= from_ts and cov[1] >= to_ts:
            return await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
        # Backfill from `start` up to the current oldest (gap-free), or the whole
        # window when cold. End the fetch at oldest so we don't re-pull covered bars.
        fetch_end = datetime.fromtimestamp(cov[0], tz=timezone.utc) if cov else end
        try:
            fetched = await fetch_range(start, fetch_end)
        except Exception:
            cached = await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
            if cached:
                return cached
            raise
        cutoff = int(now if now is not None else time.time()) - res_seconds
        await asyncio.to_thread(self._store_closed, key, fetched, cutoff)
        # Record the requested span as covered even if the fetch was empty (closed
        # market): mirrors the frontend's "keep walking back past the gap" so we
        # don't re-fetch the hole forever.
        await asyncio.to_thread(self._extend_coverage, key, from_ts, to_ts)
        return await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_candle_cache.py -v`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): window() with contiguous backfill + outage fallback"
```

---

## Task 3: `recent()` — tail-anchored recent-N path

**Files:**
- Modify: `backend/auto_trader/core/candle_cache.py`
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Consumes: Task 1 + Task 2.
- Produces:
  - `async CandleCache.recent(self, key: CandleKey, res_seconds: int, count: int, fetch_recent: Callable[[int], Awaitable[list[Candle]]], *, tail: int = 3, now: float | None = None) -> list[Candle]`
  - Behavior: **cold or short** cache (no coverage, or fewer than `count` stored bars) → `fetch_recent(count)`, store closed bars, return the fetched bars (incl forming bar) unchanged. **Warm** cache → `fetch_recent(tail)` to anchor "now" + capture the forming bar; store its closed bars; serve the most-recent `count - len(forming)` closed bars from cache and append the forming bar(s) `>= cutoff`. On fetch exception, serve cache and re-raise only if empty.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_candle_cache.py
def test_recent_cold_fetches_full_and_returns_with_forming(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # ts 280 is the forming bar (>= cutoff 280); 100/160/220 are closed.
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.recent(KEY, 60, 4, f.recent, tail=3, now=280))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220, 280]  # forming kept
    assert f.recent_calls == [4]  # cold -> one full fetch
    assert cache._cached_count(KEY) == 3  # only the 3 closed bars stored


def test_recent_warm_makes_one_tail_call_and_appends_forming(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=280))
    # Warm: forming bar now at 340 (>= cutoff 340); 280 is closed and newly fetched.
    tail_src = [_c(t, float(t)) for t in (220, 280, 340)]
    f = FakeFetcher(tail_src)
    out = asyncio.run(cache.recent(KEY, 60, 4, f.recent, tail=3, now=340))
    assert f.recent_calls == [3]  # only the small tail, not a full 4
    assert [int(c.time.timestamp()) for c in out] == [160, 220, 280, 340]  # closed+forming
    assert cache._cached_count(KEY) == 4  # 280 now stored as closed


def test_recent_serves_cache_when_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=280))
    boom = FakeFetcher(error=RuntimeError("offline"))
    out = asyncio.run(cache.recent(KEY, 60, 3, boom.recent, tail=3, now=340))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220]  # cache served


def test_recent_reraises_when_cache_empty_and_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    boom = FakeFetcher(error=RuntimeError("offline"))
    try:
        asyncio.run(cache.recent(KEY, 60, 4, boom.recent, tail=3, now=280))
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert str(e) == "offline"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_candle_cache.py -k recent -v`
Expected: FAIL — `AttributeError: 'CandleCache' object has no attribute 'recent'`.

- [ ] **Step 3: Write minimal implementation**

```python
# add method to CandleCache
    async def recent(
        self,
        key: CandleKey,
        res_seconds: int,
        count: int,
        fetch_recent: Callable[[int], Awaitable[list[Candle]]],
        *,
        tail: int = 3,
        now: float | None = None,
    ) -> list[Candle]:
        """Most-recent `count` bars. Cold/short cache -> one full fetch. Warm cache
        -> a small `tail` fetch to anchor 'now' + carry the forming bar, with the
        rest served from cache. The forming bar (ts >= cutoff) is always passed
        through so the chart shows current price immediately, as before."""
        cutoff = int(now if now is not None else time.time()) - res_seconds
        cov = await asyncio.to_thread(self._coverage, key)
        cached_n = await asyncio.to_thread(self._cached_count, key)
        if cov is None or cached_n < count:
            try:
                fetched = await fetch_recent(count)
            except Exception:
                cached = await asyncio.to_thread(self._read_back, key, count, cutoff + res_seconds)
                if cached:
                    return cached
                raise
            await asyncio.to_thread(self._store_closed, key, fetched, cutoff)
            return fetched[-count:]
        try:
            tail_bars = await fetch_recent(tail)
        except Exception:
            cached = await asyncio.to_thread(self._read_back, key, count, cutoff + res_seconds)
            if cached:
                return cached
            raise
        await asyncio.to_thread(self._store_closed, key, tail_bars, cutoff)
        forming = [b for b in tail_bars if int(b.time.timestamp()) >= cutoff]
        closed = await asyncio.to_thread(self._read_back, key, count - len(forming), cutoff)
        return closed + forming
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_candle_cache.py -v`
Expected: PASS (all Task 1–3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): recent() tail-anchored path with forming-bar passthrough"
```

---

## Task 4: Config setting, singleton, and route wiring

**Files:**
- Modify: `backend/auto_trader/config.py:54` (next to `tick_db_path`)
- Modify: `backend/auto_trader/core/candle_cache.py` (append module singleton)
- Modify: `backend/auto_trader/api/app.py` (import + `/api/candles` route, lines ~777-830)
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Consumes: Task 1–3, `auto_trader.config.settings`, `auto_trader.api.app.guarded`.
- Produces: `CANDLE_CACHE = CandleCache(settings.candle_db_path)` module singleton; `/api/candles` non-seconds paths routed through it.

- [ ] **Step 1: Add the config setting**

In `backend/auto_trader/config.py`, directly after the `tick_db_path` line (`tick_db_path: str = "tick_history.db"`), add:

```python
    candle_db_path: str = "candle_history.db"
```

- [ ] **Step 2: Add the module singleton**

At the end of `backend/auto_trader/core/candle_cache.py`, add:

```python
from auto_trader.config import settings  # noqa: E402  (singleton at module load, mirrors tick_store)

CANDLE_CACHE = CandleCache(settings.candle_db_path)
```

- [ ] **Step 3: Write the failing integration test**

```python
# append to backend/tests/test_candle_cache.py
def test_route_window_short_circuits_repeat(tmp_path, monkeypatch):
    """The /api/candles window path serves a repeated window from cache (no 2nd
    broker call). Uses the cache directly with a counting fetcher to prove the
    short-circuit the route relies on."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220)]
    f = FakeFetcher(src)
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), f.range, now=10_000))
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), f.range, now=10_000))
    assert len(f.range_calls) == 1  # second window served from cache
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_candle_cache.py::test_route_window_short_circuits_repeat -v`
Expected: PASS.

- [ ] **Step 5: Wire the cache into the `/api/candles` route**

In `backend/auto_trader/api/app.py`, add to the core imports (near `from auto_trader.core.tick_store import TICK_STORE`):

```python
from auto_trader.core.candle_cache import CANDLE_CACHE
```

Replace the body of the `candles` route from `resolution = _parse_resolution(resolution)` through the `else:`/`get_recent_candles` block (the current lines ~799-825) with:

```python
    resolution = _parse_resolution(resolution)
    broker = get_data(broker_id)  # 404 on unknown broker (not a breaker failure)
    key = (broker_id, epic, resolution.value, price_side)
    res_seconds = resolution.seconds

    async def fetch_range(start_dt, end_dt):
        # Keep the circuit breaker around the actual broker call so one down broker
        # can't starve the others (see guarded()).
        return await guarded(
            broker_id,
            lambda: broker.get_candles(epic, resolution, start_dt, end_dt, price_side),
            "data fetch",
        )

    async def fetch_recent(n):
        return await guarded(
            broker_id,
            lambda: broker.get_recent_candles(epic, resolution, n, price_side),
            "data fetch",
        )

    if from_ts is not None and to_ts is not None:
        if from_ts > to_ts:
            raise HTTPException(422, "from_ts must be <= to_ts")
        try:
            start = datetime.fromtimestamp(from_ts, tz=timezone.utc)
            end = datetime.fromtimestamp(to_ts, tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as e:
            raise HTTPException(422, f"from_ts/to_ts out of range: {e}") from e
        loaded = await CANDLE_CACHE.window(key, res_seconds, start, end, fetch_range)
    else:
        loaded = await CANDLE_CACHE.recent(key, res_seconds, bars, fetch_recent)
```

(The `if not loaded and from_ts is None: raise HTTPException(404, ...)` line and `return [_candle_dto(c) for c in loaded]` directly below stay unchanged.)

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS — all existing tests (incl `test_parse_prices`, broker tests) plus the new `test_candle_cache.py`. No regressions.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/config.py backend/auto_trader/core/candle_cache.py backend/auto_trader/api/app.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): wire candle cache into /api/candles route"
```

---

## Manual verification (after Task 4)

1. Start the backend (`cd backend && .venv/bin/uvicorn auto_trader.api.app:app --reload`).
2. `curl 'http://localhost:8000/api/candles?epic=EURUSD&resolution=MINUTE_5&bars=200&broker=capital'` — first call hits the broker.
3. In the chart UI, switch a symbol between timeframes and scroll back; confirm scroll-back pages and re-views are visibly faster on repeat.
4. Confirm `backend/candle_history.db` was created and grows as windows are fetched.
5. Confirm seconds intervals (e.g. `5s`) still load (served by `TICK_STORE`, unaffected).

---

## Self-Review

- **Spec coverage:** storage + watermarks (Task 1); contiguous backfill / replay (Task 2); recent-N tail + closed-cutoff + forming passthrough (Task 3); per-side key, outage fallback, route wiring, seconds untouched (Tasks 1–4). No-pruning / no-stream-write-through are explicit non-goals — no task, by design.
- **Placeholders:** none — every code/test step is complete.
- **Type consistency:** `CandleKey` tuple, `window()`/`recent()` signatures, and `_store_closed(..., cutoff_ts)` are used identically across tasks and the route.
