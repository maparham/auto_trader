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

import asyncio
import logging
import sqlite3
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from auto_trader.core.models import Candle

log = logging.getLogger(__name__)

CandleKey = tuple[str, str, str, str]  # (broker, epic, resolution, side)


def _to_candle(ts: int, o: float, h: float, l: float, c: float, v: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=o, high=h, low=l, close=c, volume=v,
    )


def _bucket_start(now_s: float, res_seconds: int) -> int:
    """Open time (unix s) of the bucket containing now_s — the forming bar's open.
    Bars with ts < this are closed; the bar at/after it is still forming."""
    return (int(now_s) // res_seconds) * res_seconds


class CandleCache:
    """Sqlite-backed closed-bar cache. Fresh connection per op (cheap for sqlite,
    sidesteps the one-connection-per-thread rule; public async methods run the sync
    helpers via asyncio.to_thread)."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._locks: dict[CandleKey, asyncio.Lock] = {}
        self._connect().close()  # create db file + schema up front

    def _key_lock(self, key: CandleKey) -> asyncio.Lock:
        """Per-series lock. window() and recent() each snapshot coverage BEFORE their
        broker await, then write it after — so two concurrent calls on the SAME key can
        interleave such that a disjoint recent() reset is clobbered by a window() union
        re-injecting a stale watermark, silently claiming an unfetched gap as covered.
        All requests share this in-process singleton, so the lock serializes that
        critical section across every user/chart on the same series; different keys stay
        fully concurrent. Created lazily on the running loop — the get/set pair has no
        await between it, so it's race-free on the single-threaded event loop.

        NB: this guards a single backend process. Running multiple worker processes
        against one cache db would need DB-level coordination instead."""
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

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

    def _store_closed(
        self, key: CandleKey, bars: list[Candle], cutoff_ts: int, extend_coverage: bool = True
    ) -> tuple[int, int] | None:
        """Persist the closed bars (ts < cutoff_ts). Returns the stored [min, max] ts
        span (or None if nothing qualified). When `extend_coverage` is True (the
        window() default) the span is unioned into coverage; recent() passes False so
        it can decide between union and reset depending on contiguity."""
        rows = [
            (*key, int(b.time.timestamp()), b.open, b.high, b.low, b.close, b.volume)
            for b in bars
            if int(b.time.timestamp()) < cutoff_ts
        ]
        if not rows:
            return None
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
        span = (min(ts_vals), max(ts_vals))
        if extend_coverage:
            self._extend_coverage(key, *span)
        return span

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
            # Floor at coverage.oldest_ts so rows orphaned by a disjoint reset (which
            # leaves stale bars below the new oldest, INSERT OR REPLACE never deletes)
            # can't be spliced into the result as if contiguous with the fresh block.
            rows = conn.execute(
                "SELECT ts, open, high, low, close, volume FROM bars "
                "WHERE broker=? AND epic=? AND resolution=? AND side=? AND ts < ? "
                "AND ts >= COALESCE((SELECT oldest_ts FROM coverage "
                "WHERE broker=? AND epic=? AND resolution=? AND side=?), 0) "
                "ORDER BY ts DESC LIMIT ?",
                (*key, before_ts, *key, n),
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
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO coverage "
                "(broker, epic, resolution, side, oldest_ts, newest_ts) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (broker, epic, resolution, side) DO UPDATE SET "
                "oldest_ts = MIN(oldest_ts, excluded.oldest_ts), "
                "newest_ts = MAX(newest_ts, excluded.newest_ts)",
                (*key, lo, hi),
            )
            conn.commit()
        finally:
            conn.close()

    def _set_coverage(self, key: CandleKey, lo: int, hi: int) -> None:
        """Overwrite coverage (NOT union). Used when a fresh recent-N block lands
        disjoint from stale coverage — unioning would falsely claim the gap between
        them as covered, so we drop the stale range and keep only the fresh block."""
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
        # Count only bars within the live coverage window: rows orphaned by a disjoint
        # reset must not inflate the count and misclassify a near-empty series as warm.
        conn = self._connect()
        try:
            (n,) = conn.execute(
                "SELECT COUNT(*) FROM bars "
                "WHERE broker=? AND epic=? AND resolution=? AND side=? "
                "AND ts >= COALESCE((SELECT oldest_ts FROM coverage "
                "WHERE broker=? AND epic=? AND resolution=? AND side=?), 0)",
                (*key, *key),
            ).fetchone()
        finally:
            conn.close()
        return n

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
        """Candles in [start, end]. Serializes per-key with recent() (see _key_lock)."""
        async with self._key_lock(key):
            return await self._window(key, res_seconds, start, end, fetch_range, now=now)

    async def _window(
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
        # A cache hit needs the window fully inside coverage. We only backfill BELOW
        # oldest; fetching a gap ABOVE newest (the live edge) is out of scope for v1 —
        # recent()/the stream own the live edge — so we never push the newest
        # watermark past the closed cutoff here (see the coverage cap below).
        if cov is not None and cov[0] <= from_ts and cov[1] >= to_ts:
            return await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
        # Backfill from `start` up to the current oldest (gap-free), or the whole
        # window when cold. End the fetch at oldest so we don't re-pull covered bars.
        fetch_end = datetime.fromtimestamp(cov[0], tz=timezone.utc) if cov else end
        try:
            # Skip a degenerate/inverted call when the miss is purely above newest
            # (start >= oldest): there is nothing below oldest to backfill.
            fetched = await fetch_range(start, fetch_end) if start < fetch_end else []
        except Exception:
            cached = await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
            if cached:
                return cached
            raise
        cutoff = _bucket_start(now if now is not None else time.time(), res_seconds)
        await asyncio.to_thread(self._store_closed, key, fetched, cutoff)
        # Mark the requested span covered even on an empty fetch (closed market) so we
        # don't re-fetch the hole forever. Cap the NEWEST watermark: a cold fetch pulled
        # the whole window so we have every closed bar up to `cutoff`, but the forming
        # bar (>= cutoff) was filtered out by _store_closed and must stay re-fetchable;
        # a warm fetch only backfilled below oldest, so newest stays cov[1]. Skip the
        # write entirely if there's no valid closed span (an entirely-future window),
        # which would otherwise record an inverted oldest>newest row.
        hi = cov[1] if cov is not None else min(to_ts, cutoff)
        if hi >= from_ts:
            await asyncio.to_thread(self._extend_coverage, key, from_ts, hi)
        return await asyncio.to_thread(self._read_window, key, from_ts, to_ts)

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
        """Most-recent `count` bars. Serializes per-key with window() (see _key_lock)."""
        async with self._key_lock(key):
            return await self._recent(key, res_seconds, count, fetch_recent, tail=tail, now=now)

    async def _recent(
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
        cutoff = _bucket_start(now if now is not None else time.time(), res_seconds)
        cov = await asyncio.to_thread(self._coverage, key)
        cached_n = await asyncio.to_thread(self._cached_count, key)
        newest = cov[1] if cov is not None else None
        # Cold/short cache (no coverage, or fewer than `count - 1` closed bars — the
        # forming bar fills the final slot) -> one full `count` page. Warm cache -> a
        # small tail, but sized to BRIDGE from the cached newest bar up to now: a fixed
        # tail would leave a hole whenever `now` has advanced more than `tail` bars past
        # newest (e.g. after a restart with a stale cache). Bounded by `count`.
        cold = cov is None or cached_n < count - 1
        if cold:
            fetch_n = count
        else:
            bridge = (cutoff - newest) // res_seconds + 1  # bars between newest and now
            fetch_n = min(count, max(tail, bridge))
        try:
            fetched = await fetch_recent(fetch_n)
        except Exception:
            cached = await asyncio.to_thread(self._read_back, key, count, cutoff + res_seconds)
            if cached:
                return cached
            raise
        # Store without auto-extending coverage, then set it ourselves: a block that
        # connects to the existing coverage (its oldest is within one bar of newest)
        # unions; a block that lands disjoint (the gap was bigger than we could bridge)
        # RESETS coverage to just the fresh block, so the unfetched gap is never claimed.
        span = await asyncio.to_thread(self._store_closed, key, fetched, cutoff, False)
        if span is not None:
            lo, hi = span
            if newest is not None and lo <= newest + res_seconds:
                await asyncio.to_thread(self._extend_coverage, key, lo, hi)
            else:
                await asyncio.to_thread(self._set_coverage, key, lo, hi)
        if cold:
            return fetched[-count:]
        forming = [b for b in fetched if int(b.time.timestamp()) >= cutoff]
        closed = await asyncio.to_thread(self._read_back, key, count - len(forming), cutoff)
        return closed + forming


from auto_trader.config import settings  # noqa: E402  (singleton at module load, mirrors tick_store)

# Must come after CandleCache is defined; mirrors the TICK_STORE singleton in tick_store.py.
CANDLE_CACHE = CandleCache(settings.candle_db_path)
