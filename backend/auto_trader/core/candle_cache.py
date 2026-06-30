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
