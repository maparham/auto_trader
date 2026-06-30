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
        # Scroll-back/replay windows never extend above newest, so we only backfill below oldest.
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
        cutoff = _bucket_start(now if now is not None else time.time(), res_seconds)
        await asyncio.to_thread(self._store_closed, key, fetched, cutoff)
        # Record the requested span as covered even if the fetch was empty (closed
        # market): mirrors the frontend's "keep walking back past the gap" so we
        # don't re-fetch the hole forever.
        await asyncio.to_thread(self._extend_coverage, key, from_ts, to_ts)
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
        """Most-recent `count` bars. Cold/short cache -> one full fetch. Warm cache
        -> a small `tail` fetch to anchor 'now' + carry the forming bar, with the
        rest served from cache. The forming bar (ts >= cutoff) is always passed
        through so the chart shows current price immediately, as before."""
        cutoff = _bucket_start(now if now is not None else time.time(), res_seconds)
        cov = await asyncio.to_thread(self._coverage, key)
        cached_n = await asyncio.to_thread(self._cached_count, key)
        # Warm path needs `count - 1` closed bars cached: the forming bar fills the
        # final slot. Fewer than that (or cold) -> one full fetch.
        if cov is None or cached_n < count - 1:
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


from auto_trader.config import settings  # noqa: E402  (singleton at module load, mirrors tick_store)

# Must come after CandleCache is defined; mirrors the TICK_STORE singleton in tick_store.py.
CANDLE_CACHE = CandleCache(settings.candle_db_path)
