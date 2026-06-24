"""Tick recorder: persist live ticks so we can serve sub-minute history.

Capital.com has no sub-minute history endpoint — its smallest resolution is
MINUTE for both REST and the OHLC stream. Sub-minute bars exist only in the live
tick (`quote`) stream. So to give seconds charts any history, we record ticks as
they stream and rebuild N-second bars on demand.

Storage is stdlib sqlite3 (no new dependency), so history survives process
restarts — important because the dev server runs under `uvicorn --reload`, which
restarts on every edit and would wipe an in-memory buffer. Ticks are buffered in
memory and flushed in batches off the event loop (`asyncio.to_thread`); at
1–5 ticks/sec the write cost is trivial. Retention is bounded by RETENTION_MS so
the table can't grow without limit.

Properties this design buys:
- Recording is fed from BOTH stream generators' quote branch, so watching ANY
  timeframe of an epic warms its tick store for later sub-minute views.
- `aggregate_ticks` is the SINGLE bucketing implementation shared by the history
  path here; it matches `capital_stream._TickBar`'s live bucketing exactly (same
  `(ts // step) * step`), so the seam between history and the forming bar can't
  jitter. A test pins the two against each other.

Limits (deliberate): a brand-new epic's first view is still empty until ticks
accrue (no past ticks exist to recover); history only accrues for epics actually
streamed; ticks older than RETENTION_MS are pruned.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from collections.abc import Iterable

from auto_trader.core.models import Candle
from datetime import datetime, timezone

log = logging.getLogger(__name__)

RETENTION_MS = 48 * 3600 * 1000  # keep ~2 days of ticks
FLUSH_INTERVAL = 3.0  # seconds between batch writes


def aggregate_ticks(ticks: Iterable[tuple[int, float]], bucket_seconds: int) -> list[Candle]:
    """Bucket time-ordered (ts_ms, price) ticks into N-second OHLC Candles.

    Volume is 0 (quotes carry no traded volume). A bucket with no ticks emits no
    bar — bars are contiguous by index but may skip empty time slots, identical to
    `_TickBar`'s live behavior. Ticks MUST be sorted ascending by ts."""
    step = bucket_seconds * 1000
    bars: list[Candle] = []
    cur: int | None = None
    o = h = l = c = 0.0
    for ts, price in ticks:
        bucket = (ts // step) * step
        if bucket != cur:
            if cur is not None:
                bars.append(_candle(cur, o, h, l, c))
            cur = bucket
            o = h = l = c = price
        else:
            c = price
            h = max(h, price)
            l = min(l, price)
    if cur is not None:
        bars.append(_candle(cur, o, h, l, c))
    return bars


def _candle(t_ms: int, o: float, h: float, l: float, c: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc),
        open=o, high=h, low=l, close=c, volume=0.0,
    )


class TickStore:
    """Sqlite-backed per-epic tick store feeding sub-minute history.

    Uses a fresh connection per DB operation (cheap for sqlite, sidesteps the
    one-connection-per-thread rule since flush/read run via `to_thread`). Recent
    un-flushed ticks live in an in-memory buffer and are merged into reads so the
    freshest bars appear before the next flush.
    """

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._buffer: list[tuple[str, int, float]] = []  # (epic, ts, price)
        self._last_ts: dict[str, int] = {}  # per-epic monotonic guard
        self._connect().close()  # create the db file + schema up front

    def _connect(self) -> sqlite3.Connection:
        """Open a connection with the schema guaranteed.

        Ensuring the schema on EVERY connection (not just at construction) makes
        reads/writes robust to a db file created by an older build, a different
        working directory, or a races at startup — the symptom was a live
        `no such table: ticks` on read while the table only existed on another
        connection's view. CREATE ... IF NOT EXISTS is a cheap no-op once present.
        """
        conn = sqlite3.connect(self._db_path, timeout=5.0)  # wait on the flusher's lock
        conn.execute("PRAGMA journal_mode=WAL")  # concurrent reads during writes
        conn.execute("CREATE TABLE IF NOT EXISTS ticks (epic TEXT, ts INTEGER, price REAL)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ticks_epic_ts ON ticks(epic, ts)")
        conn.commit()
        return conn

    def record(self, epic: str, ts_ms: int, price: float) -> None:
        """Buffer a tick. Drops out-of-order (older) AND duplicate-timestamp ticks to
        keep buckets clean: a reconnect can replay the last timestamp, and recording
        it again would corrupt that bucket's close price."""
        last = self._last_ts.get(epic)
        if last is not None and ts_ms <= last:
            return
        self._last_ts[epic] = ts_ms
        self._buffer.append((epic, ts_ms, price))

    async def flush(self) -> None:
        if not self._buffer:
            return
        batch, self._buffer = self._buffer, []
        try:
            await asyncio.to_thread(self._flush_sync, batch)
        except Exception:
            # Write failed (e.g. sqlite locked). Re-queue the batch ahead of any
            # ticks recorded during the await so the next flush retries it,
            # instead of silently dropping the batch.
            self._buffer[:0] = batch
            raise

    def _flush_sync(self, batch: list[tuple[str, int, float]]) -> None:
        conn = self._connect()
        try:
            conn.executemany("INSERT INTO ticks (epic, ts, price) VALUES (?, ?, ?)", batch)
            cutoff = int(time.time() * 1000) - RETENTION_MS
            conn.execute("DELETE FROM ticks WHERE ts < ?", (cutoff,))
            conn.commit()
        finally:
            conn.close()

    async def bars(self, epic: str, bucket_seconds: int, count: int) -> list[Candle]:
        """Most-recent `count` N-second bars for `epic`, from stored + buffered ticks."""
        ticks = await asyncio.to_thread(self._recent_ticks_sync, epic, bucket_seconds, count)
        # Merge in un-flushed buffered ticks for this epic. Sort the union:
        # aggregate_ticks needs ascending order, and right after a restart the
        # in-memory monotonic guard is empty, so a stray out-of-order tick can't
        # be assumed away here.
        ticks.extend((ts, price) for (e, ts, price) in self._buffer if e == epic)
        ticks.sort(key=lambda tp: tp[0])
        return aggregate_ticks(ticks, bucket_seconds)[-count:]

    def _recent_ticks_sync(
        self, epic: str, bucket_seconds: int, count: int
    ) -> list[tuple[int, float]]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT MAX(ts) FROM ticks WHERE epic = ?", (epic,)
            ).fetchone()
            latest = row[0] if row else None
            if latest is None:
                return []
            # Enough span to cover `count` buckets (plus a little slack for gaps).
            span_ms = (count + 1) * bucket_seconds * 1000
            cur = conn.execute(
                "SELECT ts, price FROM ticks WHERE epic = ? AND ts >= ? ORDER BY ts",
                (epic, latest - span_ms),
            )
            return cur.fetchall()
        finally:
            conn.close()

    async def run_flusher(self, interval: float = FLUSH_INTERVAL) -> None:
        """Periodic batch flush; cancelled on shutdown after a final flush."""
        try:
            while True:
                await asyncio.sleep(interval)
                try:
                    await self.flush()
                except Exception:
                    # A failed write re-queued its batch. Keep the loop alive so
                    # the next interval retries, instead of ending all persistence
                    # and letting the buffer grow forever.
                    log.warning("tick flush failed; retrying next interval", exc_info=True)
        except asyncio.CancelledError:
            try:
                await self.flush()  # don't lose the last batch on shutdown
            except Exception:
                log.warning("final tick flush on shutdown failed", exc_info=True)
            raise


# Module singleton, configured from settings. Imported by the stream generators
# (record) and the candles endpoint (bars). The flush loop is started in the app
# lifespan.
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

TICK_STORE = TickStore(settings.tick_db_path)
