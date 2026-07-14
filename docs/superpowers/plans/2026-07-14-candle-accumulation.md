# Automatic Candle Accumulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically accumulate a chart's candle history in the backend cache while it is being viewed, so low-timeframe bars are captured before the broker drops them.

**Architecture:** Drive accumulation off the existing `/ws/candles` relay lifecycle (the precise "this series is being viewed" signal). On the first viewer of a series, a background task runs a coverage-safe deep backward-backfill toward the broker's retention floor and then a periodic `recent()` refresh loop that persists newly-closed bars; the loop is cancelled when the last viewer disconnects. All coverage mutation stays inside `CandleCache` (under its per-key lock) so no coverage math is hand-rolled elsewhere.

**Tech Stack:** Python 3.14, FastAPI, stdlib `sqlite3`, `asyncio`, `pytest` (tests use `asyncio.run`, no pytest-asyncio).

## Global Constraints

- No frontend changes. No UI toggle. Opening/viewing a chart is the only enrollment signal.
- Accumulation scope is the exact viewed series `(broker, epic, resolution, price_side)`; derived timeframes accumulate their base series (the ws handler already computes `base_key`). Seconds resolutions are out of scope (served from `TICK_STORE`).
- Never over-claim coverage: coverage `[oldest, newest]` must contain NO unfetched closed bars. Deep backfill lowers `oldest` ONLY to a bar actually returned by the broker.
- Deep backfill and the refresh loop are best-effort: a broker/breaker error stops that run and leaves coverage marked only to what was actually fetched; the broker-floor marker is NOT set on error (so it resumes next session).
- The candle cache DB is created via `CREATE TABLE IF NOT EXISTS` on every connection; new tables are additive (no migration).
- No em dashes in code comments or copy; use a colon, comma, or period.
- Broker fetch calls go through `deps.guarded(broker_id, factory, label)` (circuit breaker).

---

## File Structure

- **Modify** `backend/auto_trader/core/candle_cache.py`: add the `backfill_state` table + floor helpers (Task 1) and the `backfill_below` method (Task 2).
- **Create** `backend/auto_trader/core/candle_accumulator.py`: the `CandleAccumulator` singleton + policy helpers (Task 3).
- **Modify** `backend/auto_trader/api/routers/stream.py`: call `on_view_start`/`on_view_stop` from the ws lifecycle (Task 4).
- **Modify** `backend/tests/test_candle_cache.py`: tests for Tasks 1 and 2.
- **Create** `backend/tests/test_candle_accumulator.py`: tests for Task 3.
- **Modify** `backend/tests/test_stream_accumulation.py` (new): wiring test for Task 4.

Reference existing test helpers in `backend/tests/test_candle_cache.py`: `_c(ts, close)`, `_dt(ts)`, `KEY = ("capital", "EURUSD", "MINUTE", "mid")`, and `FakeFetcher` (records `range_calls`/`recent_calls`, `.range(start,end)` returns bars in `[start,end]`, `.recent(count)` returns the last `count`).

---

### Task 1: `backfill_state` table + floor helpers in CandleCache

**Files:**
- Modify: `backend/auto_trader/core/candle_cache.py` (`_connect` ~line 77, add helpers after `_set_coverage`)
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Consumes: existing `CandleKey`, `_connect`.
- Produces:
  - `CandleCache._backfill_reached_floor(key: CandleKey) -> bool`
  - `CandleCache._set_backfill_floor(key: CandleKey) -> None`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_candle_cache.py`:

```python
def test_backfill_floor_defaults_false(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    assert cache._backfill_reached_floor(KEY) is False


def test_set_backfill_floor_persists_true(tmp_path):
    path = str(tmp_path / "c.db")
    cache = CandleCache(path)
    cache._set_backfill_floor(KEY)
    assert cache._backfill_reached_floor(KEY) is True
    # Survives a fresh connection (new cache instance, same file).
    assert CandleCache(path)._backfill_reached_floor(KEY) is True


def test_backfill_floor_is_per_key(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._set_backfill_floor(KEY)
    other = ("capital", "GBPUSD", "MINUTE", "mid")
    assert cache._backfill_reached_floor(other) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -k backfill_floor -v`
Expected: FAIL with `AttributeError: 'CandleCache' object has no attribute '_backfill_reached_floor'`

- [ ] **Step 3: Add the table to `_connect`**

In `candle_cache.py` `_connect`, after the `coverage` table `CREATE TABLE` block (before `conn.commit()`):

```python
        conn.execute(
            "CREATE TABLE IF NOT EXISTS backfill_state ("
            "broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
            "reached_floor INTEGER NOT NULL DEFAULT 0,"
            "PRIMARY KEY (broker, epic, resolution, side))"
        )
```

- [ ] **Step 4: Add the helper methods**

In `candle_cache.py`, add after `_set_coverage` (~line 203):

```python
    def _backfill_reached_floor(self, key: CandleKey) -> bool:
        """True once deep backfill has confirmed the broker has no bars below our
        oldest cached bar for this series, so reopens don't re-page empty pre-history."""
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT reached_floor FROM backfill_state "
                "WHERE broker=? AND epic=? AND resolution=? AND side=?",
                key,
            ).fetchone()
        finally:
            conn.close()
        return bool(row and row[0])

    def _set_backfill_floor(self, key: CandleKey) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO backfill_state "
                "(broker, epic, resolution, side, reached_floor) VALUES (?, ?, ?, ?, 1)",
                key,
            )
            conn.commit()
        finally:
            conn.close()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -k backfill_floor -v`
Expected: PASS (3 passed)

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): backfill_state table + floor markers"
```

---

### Task 2: `CandleCache.backfill_below` (coverage-safe backward paging)

**Files:**
- Modify: `backend/auto_trader/core/candle_cache.py` (add method after `recent`)
- Test: `backend/tests/test_candle_cache.py`

**Interfaces:**
- Consumes: `_coverage`, `_store_closed`, `_extend_coverage`, `_bucket_start`, `_key_lock`, `_backfill_reached_floor`, `_set_backfill_floor` (Task 1).
- Produces:
  ```python
  async def backfill_below(
      self,
      key: CandleKey,
      res_seconds: int,
      fetch_range: Callable[[datetime, datetime], Awaitable[list[Candle]]],
      *,
      target_oldest_ts: int,
      max_bars_per_step: int = 1000,
      max_empty_gap_seconds: int = 5 * 86_400,
      now: float | None = None,
  ) -> str  # one of: "floor", "target", "cold", "error"
  ```

Semantics: under the per-key lock, read coverage once and walk `oldest` backward locally. Each non-empty step stores returned closed bars and lowers `coverage.oldest` ONLY to the min ts actually returned (so a truncated wide request cannot over-claim). Each empty step advances the local cursor and accrues `empty_span` but does NOT extend coverage (so `coverage.oldest` stays at the deepest real bar). Stop and return: `"cold"` if there is no coverage yet (forward load must run first); `"target"` if `target_oldest_ts` is reached; `"floor"` (and set the floor marker) once a continuous empty run >= `max_empty_gap_seconds` is crossed (broker floor; weekends/holidays don't trip it); `"error"` if `fetch_range` raises (floor NOT set).

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_candle_cache.py`:

```python
class _RangeSource:
    """Fetcher returning only bars that actually exist in `_have` within [start,end].
    Models a broker whose history has a hard floor and interior (weekend) gaps."""

    def __init__(self, have_ts: list[int], close: float = 1.0, error: Exception | None = None):
        self._have = sorted(have_ts)
        self._close = close
        self._error = error
        self.range_calls: list[tuple[int, int]] = []

    async def range(self, start, end):
        s, e = int(start.timestamp()), int(end.timestamp())
        self.range_calls.append((s, e))
        if self._error:
            raise self._error
        return [_c(t, self._close) for t in self._have if s <= t <= e]


class _OneThenError:
    """Returns a fixed block on the first range call, raises on the second. Used to
    freeze the walk after exactly one productive step so coverage can be inspected."""

    def __init__(self, bars):
        self._bars = bars
        self.calls = 0

    async def range(self, start, end):
        self.calls += 1
        if self.calls == 1:
            return list(self._bars)
        raise RuntimeError("stop after one step")


def test_backfill_cold_returns_cold_no_fetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = _RangeSource(have_ts=[100, 160])
    status = asyncio.run(
        cache.backfill_below(KEY, 60, src.range, target_oldest_ts=0, now=10_000)
    )
    assert status == "cold"
    assert src.range_calls == []  # no coverage to anchor below


def test_backfill_reaches_floor_and_sets_marker(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # Seed a forward block so coverage.oldest = 400.
    cache._store_closed(KEY, [_c(400, 1.0), _c(460, 1.0)], cutoff_ts=10_000)
    # Broker has bars 100..400 (step 60), nothing below 100.
    src = _RangeSource(have_ts=list(range(100, 460, 60)))
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=0, max_bars_per_step=2, max_empty_gap_seconds=100, now=10_000,
        )
    )
    assert status == "floor"
    assert cache._coverage(KEY)[0] == 100          # oldest stays at the deepest real bar
    assert cache._backfill_reached_floor(KEY) is True


def test_backfill_extends_only_to_returned_min_not_step_start(tmp_path):
    # Regression for the MT5 page-cap silent-hole: a step whose returned bars have a
    # min ABOVE the requested step_start must lower coverage only to that min, never
    # to step_start. Freeze after one step to inspect.
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(1000, 1.0)], cutoff_ts=100_000)  # oldest = 1000
    src = _OneThenError([_c(880, 1.0), _c(940, 1.0)])  # min 880, step_start will be 400
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=0, max_bars_per_step=10, now=100_000,
        )
    )
    assert status == "error"                 # second step raised, ending the walk
    assert cache._coverage(KEY)[0] == 880    # only the deepest returned bar, NOT 400


def test_backfill_skips_interior_gap_without_false_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(1200, 1.0)], cutoff_ts=100_000)  # oldest = 1200
    # Top block 1000..1120, interior 120s empty gap, bottom block 700..820; floor 700.
    have = [700, 760, 820, 1000, 1060, 1120]
    src = _RangeSource(have_ts=have)
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=0, max_bars_per_step=2,
            max_empty_gap_seconds=600,  # > the 120s interior gap, < the empty run below 700
            now=100_000,
        )
    )
    assert status == "floor"
    assert cache._coverage(KEY)[0] == 700  # crossed the interior gap, reached the real floor


def test_backfill_stops_at_target_without_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(1000, 1.0)], cutoff_ts=100_000)  # oldest = 1000
    src = _RangeSource(have_ts=list(range(100, 1000, 60)))  # bars all the way down
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=700, max_bars_per_step=2, now=100_000,
        )
    )
    assert status == "target"
    assert cache._coverage(KEY)[0] == 700
    assert cache._backfill_reached_floor(KEY) is False  # target, not floor


def test_backfill_noop_after_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(400, 1.0)], cutoff_ts=10_000)
    cache._set_backfill_floor(KEY)
    src = _RangeSource(have_ts=[100, 160, 220])
    status = asyncio.run(
        cache.backfill_below(KEY, 60, src.range, target_oldest_ts=0, now=10_000)
    )
    assert status == "floor"
    assert src.range_calls == []  # already at floor -> zero broker calls


def test_backfill_error_does_not_set_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(400, 1.0)], cutoff_ts=10_000)
    src = _RangeSource(have_ts=[], error=RuntimeError("breaker open"))
    status = asyncio.run(
        cache.backfill_below(KEY, 60, src.range, target_oldest_ts=0, now=10_000)
    )
    assert status == "error"
    assert cache._backfill_reached_floor(KEY) is False  # resumes next session
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -k backfill_ -v`
Expected: FAIL with `AttributeError: ... 'backfill_below'` (the floor tests from Task 1 also match `-k backfill_` and still pass; the new ones fail).

- [ ] **Step 3: Implement `backfill_below`**

In `candle_cache.py`, add after `_recent` (~line 393), before the module-level singleton block:

```python
    async def backfill_below(
        self,
        key: CandleKey,
        res_seconds: int,
        fetch_range: Callable[[datetime, datetime], Awaitable[list[Candle]]],
        *,
        target_oldest_ts: int,
        max_bars_per_step: int = 1000,
        max_empty_gap_seconds: int = 5 * 86_400,
        now: float | None = None,
    ) -> str:
        """Walk coverage's `oldest` watermark down toward `target_oldest_ts` (or the
        broker's retention floor), storing every closed bar found.

        Coverage-safe by construction: `oldest` is lowered ONLY to a bar the broker
        actually returned, never to a requested start, so a broker that truncates a
        wide request (MT5 pages cap ~40k bars) can't create a silent hole. Empty steps
        (proven-empty windows) advance an in-loop cursor but do NOT extend coverage, so
        `coverage.oldest` always equals the deepest real bar (clean cache-stats). A
        continuous empty run >= `max_empty_gap_seconds` is the broker floor (short
        weekend/holiday gaps don't trip it) and sets a persistent marker so reopens skip.

        Holds the per-key lock across the whole walk (serialized with window()/recent()).
        A first-ever deep backfill can hold it for the run; live bars keep flowing over
        the stream meanwhile, and recent() bridges any gap once the lock frees. Returns
        "cold" (no coverage yet), "target", "floor", or "error" (a fetch raised)."""
        if await asyncio.to_thread(self._backfill_reached_floor, key):
            return "floor"
        now_s = now if now is not None else time.time()
        cutoff = _bucket_start(now_s, res_seconds)
        async with self._key_lock(key):
            cov = await asyncio.to_thread(self._coverage, key)
            if cov is None:
                return "cold"  # a forward load must establish a block to anchor below
            oldest = cov[0]
            empty_span = 0
            while oldest > target_oldest_ts:
                step_start = max(target_oldest_ts, oldest - max_bars_per_step * res_seconds)
                start_dt = datetime.fromtimestamp(step_start, tz=timezone.utc)
                end_dt = datetime.fromtimestamp(oldest - 1, tz=timezone.utc)
                try:
                    fetched = await fetch_range(start_dt, end_dt)
                except Exception:
                    log.warning("backfill fetch failed for %s; stopping (floor unset)", key)
                    return "error"
                closed = [b for b in fetched if int(b.time.timestamp()) < cutoff]
                new_oldest = min((int(b.time.timestamp()) for b in closed), default=None)
                if new_oldest is None:
                    # Proven-empty window: advance the local cursor and accrue the gap.
                    # Do NOT extend coverage, so coverage.oldest stays at the deepest
                    # real bar. A long-enough continuous empty run is the broker floor.
                    empty_span += oldest - step_start
                    oldest = step_start
                    if empty_span >= max_empty_gap_seconds:
                        await asyncio.to_thread(self._set_backfill_floor, key)
                        return "floor"
                    continue
                empty_span = 0
                await asyncio.to_thread(self._store_closed, key, closed, cutoff, False)
                # Lower oldest only to the deepest real bar. MIN keeps oldest; passing
                # new_oldest as the hi arg leaves newest intact (new_oldest < newest).
                await asyncio.to_thread(self._extend_coverage, key, new_oldest, new_oldest)
                oldest = new_oldest
            return "target"
```

Termination: every non-empty step strictly lowers the local `oldest` to `new_oldest` (< the fetched `oldest`); every empty step lowers `oldest` to `step_start` (< `oldest`, since `max_bars_per_step * res_seconds > 0`) or clamps to `target_oldest_ts` and exits the `while`. `empty_span` accumulates only across *consecutive* empty steps (reset to 0 on any non-empty step), so interior weekend/holiday gaps shorter than `max_empty_gap_seconds` don't falsely trip the floor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -k backfill_ -v`
Expected: PASS (all Task 1 + Task 2 backfill tests)

- [ ] **Step 5: Run the full cache suite (no regressions)**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -v`
Expected: PASS (all prior tests still pass)

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): coverage-safe backward deep-backfill (backfill_below)"
```

---

### Task 3: `CandleAccumulator` singleton + policy

**Files:**
- Create: `backend/auto_trader/core/candle_accumulator.py`
- Test: `backend/tests/test_candle_accumulator.py`

**Interfaces:**
- Consumes: `CANDLE_CACHE` (`recent`, `backfill_below`, `_coverage`), `CandleKey`.
- Produces:
  - `_target_oldest_ts(res_seconds: int, is_ig: bool, now: float) -> int`
  - `_refresh_interval(res_seconds: int) -> float`
  - class `CandleAccumulator` with:
    - `on_view_start(key, res_seconds, fetch_range, fetch_recent, *, is_ig=False) -> None`
    - `on_view_stop(key) -> None`
  - module singleton `CANDLE_ACCUMULATOR`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_candle_accumulator.py`:

```python
from __future__ import annotations

import asyncio

from auto_trader.core.candle_accumulator import (
    CandleAccumulator,
    _refresh_interval,
    _target_oldest_ts,
)

KEY = ("capital", "EURUSD", "MINUTE", "mid")


def test_target_lookback_shrinks_for_ig():
    now = 1_000_000_000.0
    cap = _target_oldest_ts(60, is_ig=True, now=now)
    wide = _target_oldest_ts(60, is_ig=False, now=now)
    assert cap > wide          # IG reaches back less far (larger target ts = shallower)
    assert wide < now          # target is in the past


def test_refresh_interval_bounds():
    assert _refresh_interval(60) >= 30       # 1m: floored
    assert _refresh_interval(86_400) <= 300  # DAY: capped


class FakeCache:
    """Records backfill/recent calls; coverage starts present so backfill is not cold."""

    def __init__(self):
        self.backfill_calls = 0
        self.recent_calls = 0
        self._recent_event = asyncio.Event()

    def _coverage(self, key):
        return (100, 200)

    async def backfill_below(self, key, res_seconds, fetch_range, **kw):
        self.backfill_calls += 1
        return "floor"

    async def recent(self, key, res_seconds, count, fetch_recent, **kw):
        self.recent_calls += 1
        self._recent_event.set()
        return []


async def _noop_range(s, e):
    return []


async def _noop_recent(n):
    return []


def test_two_starts_one_backfill_and_one_loop():
    async def run():
        cache = FakeCache()
        acc = CandleAccumulator(cache, refresh_interval_fn=lambda _s: 0.01)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)  # second viewer, same key
        await asyncio.wait_for(cache._recent_event.wait(), timeout=1.0)
        acc.on_view_stop(KEY)
        acc.on_view_stop(KEY)
        return cache
    cache = asyncio.run(run())
    assert cache.backfill_calls == 1  # deduped across two viewers


def test_last_stop_cancels_loop():
    async def run():
        cache = FakeCache()
        acc = CandleAccumulator(cache, refresh_interval_fn=lambda _s: 0.01)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)
        await asyncio.wait_for(cache._recent_event.wait(), timeout=1.0)
        acc.on_view_stop(KEY)
        await asyncio.sleep(0.05)
        n = cache.recent_calls
        await asyncio.sleep(0.05)
        return cache.recent_calls, n
    after, before = asyncio.run(run())
    assert after == before  # no refreshes after the last viewer left


def test_stop_without_start_is_safe():
    acc = CandleAccumulator(FakeCache())
    acc.on_view_stop(KEY)  # must not raise / underflow
    assert acc._refcount.get(KEY, 0) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_candle_accumulator.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.core.candle_accumulator'`

- [ ] **Step 3: Implement the accumulator**

Create `backend/auto_trader/core/candle_accumulator.py`:

```python
"""Drives automatic candle accumulation for series that are being viewed.

The /ws/candles relay calls on_view_start when a chart begins viewing a series and
on_view_stop when it disconnects. The first viewer of a series triggers one
background task that (1) deep-backfills history downward toward the broker's floor
and (2) periodically calls CANDLE_CACHE.recent() to persist newly-closed bars.
Reference-counted per series, so N charts on the same series share ONE task; the
task is cancelled when the last viewer leaves. Broker-agnostic: the relay injects
the guarded fetch callables (no broker imports here).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import datetime

from auto_trader.core.candle_cache import CANDLE_CACHE, CandleKey, CandleCache
from auto_trader.core.models import Candle

log = logging.getLogger(__name__)

FetchRange = Callable[[datetime, datetime], Awaitable[list[Candle]]]
FetchRecent = Callable[[int], Awaitable[list[Candle]]]

# Per-resolution deep-backfill depth (seconds of history to aim for). Bounded so a
# series never pages arbitrarily deep; the broker floor usually stops it sooner.
_DAY = 86_400
_LOOKBACK_SECONDS = [
    (60, 30 * _DAY),      # <= 1m  -> 30 days
    (300, 90 * _DAY),     # <= 5m  -> 90 days
    (900, 180 * _DAY),    # <= 15m -> 180 days
    (3600, 730 * _DAY),   # <= 1h  -> 2 years
]
_LOOKBACK_DEFAULT = 3650 * _DAY  # >= 1h up to DAY/WEEK -> ~10 years
# IG bills /prices against a weekly allowance, so cap its backfill much shallower.
_IG_MAX_LOOKBACK = 7 * _DAY

_SEED_COUNT = 500     # bars to establish a forward block if the series is cold
_REFRESH_COUNT = 10   # tiny tail per refresh; recent() bridges from cached newest


def _lookback_seconds(res_seconds: int) -> int:
    for ceiling, seconds in _LOOKBACK_SECONDS:
        if res_seconds <= ceiling:
            return seconds
    return _LOOKBACK_DEFAULT


def _target_oldest_ts(res_seconds: int, is_ig: bool, now: float) -> int:
    lookback = _lookback_seconds(res_seconds)
    if is_ig:
        lookback = min(lookback, _IG_MAX_LOOKBACK)
    return int(now) - lookback


def _refresh_interval(res_seconds: int) -> float:
    """Refresh about once per bar period, floored at 30s and capped at 5min so DAY/WEEK
    series don't idle-poll and 1m series don't hammer the broker."""
    return float(min(max(res_seconds, 30), 300))


class CandleAccumulator:
    def __init__(
        self,
        cache: CandleCache,
        *,
        refresh_interval_fn: Callable[[int], float] = _refresh_interval,
        target_oldest_fn: Callable[[int, bool, float], int] = _target_oldest_ts,
        seed_count: int = _SEED_COUNT,
        refresh_count: int = _REFRESH_COUNT,
    ) -> None:
        self._cache = cache
        self._refresh_interval_fn = refresh_interval_fn
        self._target_oldest_fn = target_oldest_fn
        self._seed_count = seed_count
        self._refresh_count = refresh_count
        self._refcount: dict[CandleKey, int] = {}
        self._tasks: dict[CandleKey, asyncio.Task] = {}

    def on_view_start(
        self,
        key: CandleKey,
        res_seconds: int,
        fetch_range: FetchRange,
        fetch_recent: FetchRecent,
        *,
        is_ig: bool = False,
    ) -> None:
        n = self._refcount.get(key, 0) + 1
        self._refcount[key] = n
        if n == 1:
            self._tasks[key] = asyncio.create_task(
                self._run(key, res_seconds, fetch_range, fetch_recent, is_ig)
            )

    def on_view_stop(self, key: CandleKey) -> None:
        n = self._refcount.get(key, 0) - 1
        if n > 0:
            self._refcount[key] = n
            return
        self._refcount.pop(key, None)
        task = self._tasks.pop(key, None)
        if task is not None:
            task.cancel()

    async def _run(
        self,
        key: CandleKey,
        res_seconds: int,
        fetch_range: FetchRange,
        fetch_recent: FetchRecent,
        is_ig: bool,
    ) -> None:
        try:
            # 1. Ensure a forward block exists so deep backfill has an anchor.
            cov = await asyncio.to_thread(self._cache._coverage, key)
            if cov is None:
                try:
                    await self._cache.recent(key, res_seconds, self._seed_count, fetch_recent)
                except Exception:
                    log.warning("accumulator seed fetch failed for %s", key)
            # 2. Deep backfill toward the broker floor (resumes if not yet reached).
            target = self._target_oldest_fn(res_seconds, is_ig, time.time())
            try:
                await self._cache.backfill_below(
                    key, res_seconds, fetch_range, target_oldest_ts=target
                )
            except Exception:
                log.exception("accumulator backfill failed for %s", key)
            # 3. Persist newly-closed bars while the series stays viewed.
            interval = self._refresh_interval_fn(res_seconds)
            while True:
                await asyncio.sleep(interval)
                try:
                    await self._cache.recent(
                        key, res_seconds, self._refresh_count, fetch_recent
                    )
                except Exception:
                    log.warning("accumulator refresh failed for %s", key)
        except asyncio.CancelledError:
            raise


CANDLE_ACCUMULATOR = CandleAccumulator(CANDLE_CACHE)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_candle_accumulator.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_accumulator.py backend/tests/test_candle_accumulator.py
git commit -m "feat(cache): CandleAccumulator refcounted view-driven accumulation"
```

---

### Task 4: Wire accumulator into the `/ws/candles` relay

**Files:**
- Modify: `backend/auto_trader/api/routers/stream.py`
- Test: `backend/tests/test_stream_accumulation.py` (new)

**Interfaces:**
- Consumes: `CANDLE_ACCUMULATOR.on_view_start/on_view_stop` (Task 3), `deps.guarded`.
- Produces: no new public API; the ws handler now enrolls the viewed series.

The relay must: build guarded fetch callables for the viewed series, call `on_view_start` right before creating the forward/watch tasks, and call `on_view_stop` in the existing `finally`. Seconds resolutions are skipped. Derived timeframes enroll their BASE series key (matching how `_seed` already targets `base_key`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_stream_accumulation.py`. This unit-tests the enrollment helper in isolation (a full websocket integration test is out of scope; the helper is where the wiring logic lives):

```python
from __future__ import annotations

from auto_trader.api.routers.stream import _accum_params
from auto_trader.core.models import Resolution


def test_accum_params_native_minute():
    params = _accum_params("capital", "EURUSD", Resolution.MINUTE_5.value, "mid", is_ig=False)
    assert params is not None
    key, res_seconds = params
    assert key == ("capital", "EURUSD", "MINUTE_5", "mid")
    assert res_seconds == Resolution.MINUTE_5.seconds


def test_accum_params_seconds_returns_none():
    assert _accum_params("capital", "EURUSD", "SECOND_10", "mid", is_ig=False) is None


def test_accum_params_derived_uses_base_key():
    # 3m derives from 1m; MONTH derives from DAY. Enrollment targets the base series.
    params = _accum_params("capital", "EURUSD", "MINUTE_3", "mid", is_ig=False)
    assert params is not None
    key, res_seconds = params
    assert key == ("capital", "EURUSD", "MINUTE", "mid")
    assert res_seconds == Resolution.MINUTE.seconds
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && python -m pytest tests/test_stream_accumulation.py -v`
Expected: FAIL with `ImportError: cannot import name '_accum_params'`

- [ ] **Step 3: Add the `_accum_params` helper and wire the lifecycle**

`stream.py` already imports `SECONDS_INTERVALS`, `DERIVED`, `is_derived`, `Resolution`, and `deps`. Add ONLY the accumulator import near the existing imports:

```python
from auto_trader.core.candle_accumulator import CANDLE_ACCUMULATOR
```

Then add this helper near the top (after imports) that resolves the series to accumulate:

```python
def _accum_params(
    broker_id: str, epic: str, res_raw: str, price_side: str, *, is_ig: bool
) -> tuple[tuple[str, str, str, str], int] | None:
    """The (key, res_seconds) to accumulate for a viewed series, or None to skip.
    Seconds resolutions are skipped (served from TICK_STORE). Derived timeframes
    return their BASE series (the cache only stores base bars)."""
    if res_raw in SECONDS_INTERVALS:
        return None
    if is_derived(res_raw):
        rule = DERIVED.get(res_raw)
        if rule is None:
            return None
        base = rule.base
        return (broker_id, epic, base.value, price_side), base.seconds
    try:
        resolution = Resolution(res_raw)
    except ValueError:
        return None
    return (broker_id, epic, resolution.value, price_side), resolution.seconds
```

Then, in `ws_candles`, just before `forward_task = asyncio.create_task(forward())` (~line 192), enroll the series:

```python
    accum = _accum_params(broker_id, epic, res_raw, price_side, is_ig=is_ig)
    if accum is not None:
        accum_key, accum_res_seconds = accum
        accum_res = Resolution(accum_key[2])  # base resolution for derived, else native

        async def _accum_range(start, end):
            return await deps.guarded(
                broker_id,
                lambda: broker.get_candles(epic, accum_res, start, end, price_side),
                "accumulate backfill",
            )

        async def _accum_recent(n):
            return await deps.guarded(
                broker_id,
                lambda: broker.get_recent_candles(epic, accum_res, n, price_side),
                "accumulate refresh",
            )

        CANDLE_ACCUMULATOR.on_view_start(
            accum_key, accum_res_seconds, _accum_range, _accum_recent, is_ig=is_ig
        )
```

`deps` is already imported in `stream.py` (`from .. import deps`). Then in the existing `finally` block (~line 199), after the task cleanup, add:

```python
        if accum is not None:
            CANDLE_ACCUMULATOR.on_view_stop(accum_key)
```

Note: `accum` is defined before the `try`, so it is in scope in `finally`. If the handler returned early via `_fatal` (bad resolution / not streamable), `on_view_start` was never reached and `on_view_stop` is not called (those early returns are before this block).

- [ ] **Step 4: Run the wiring test to verify it passes**

Run: `cd backend && python -m pytest tests/test_stream_accumulation.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Sanity-check imports and app startup**

Run: `cd backend && python -c "import auto_trader.api.routers.stream; import auto_trader.core.candle_accumulator; print('ok')"`
Expected: prints `ok` (no circular-import error)

- [ ] **Step 6: Run the backend test suite**

Run: `cd backend && python -m pytest tests/test_candle_cache.py tests/test_candle_accumulator.py tests/test_stream_accumulation.py tests/test_api_candles.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/routers/stream.py backend/tests/test_stream_accumulation.py
git commit -m "feat(stream): enroll viewed series into candle accumulation"
```

---

## Manual verification (after all tasks)

1. Start the backend and open a chart on a low timeframe (e.g. Capital EURUSD 1m).
2. Watch the backend logs: within a few seconds a deep backfill should run (one series), then periodic `recent()` refreshes at ~1 bar-period.
3. Hit `GET /api/candle-cache/stats?epic=EURUSD&resolution=MINUTE_1&broker=capital` and confirm `oldest_ts` moves earlier than the first on-screen bar and `cached_bar_count` grows.
4. Close the chart tab; confirm the refresh loop stops (no more refresh log lines for that series).
5. Reopen after a few minutes; confirm the forward bridge fills the gap and (if the broker floor was not yet reached) backfill resumes deeper.

## Self-Review Notes

- Spec coverage: deep backfill (Task 2), floor marker (Task 1), while-open periodic recent (Task 3), ws lifecycle wiring incl. derived base key + seconds skip (Task 4), IG allowance cap + MT5 no-overclaim (Tasks 2-3), refcount dedup (Task 3). All covered.
- The MT5 truncation invariant is explicitly regression-tested (`test_backfill_extends_only_to_returned_min_not_step_start`).
- No frontend work, matching the spec.
