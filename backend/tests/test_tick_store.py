"""Tick recorder: bucket aggregation, store round-trip, retention.

The load-bearing invariant is that `aggregate_ticks` (history path) produces the
SAME bars as `_TickBar` (live path) for the same ticks — otherwise the seam
between recorded history and the forming candle would jitter. `test_history_*`
pins the store; `test_aggregate_matches_live_tickbar` pins the two paths together.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time

import pytest

from auto_trader.brokers.capital_stream import _TickBar
from auto_trader.core.tick_store import RETENTION_MS, TickStore, aggregate_ticks


# --- aggregate_ticks ---------------------------------------------------------


def test_aggregate_buckets_ohlc():
    ticks = [(60_000, 100.0), (61_000, 105.0), (62_000, 98.0), (66_000, 50.0)]
    bars = aggregate_ticks(ticks, 5)  # 5s buckets: 60000, 65000
    assert [b.time.timestamp() for b in bars] == [60.0, 65.0]
    o, h, l, c = bars[0].open, bars[0].high, bars[0].low, bars[0].close
    assert (o, h, l, c) == (100, 105, 98, 98)
    assert bars[1].open == 50 and bars[0].volume == 0.0


def test_aggregate_skips_empty_buckets():
    bars = aggregate_ticks([(60_000, 1.0), (73_000, 2.0)], 5)  # 65000 bucket empty
    assert [b.time.timestamp() for b in bars] == [60.0, 70.0]


def test_aggregate_matches_live_tickbar():
    # Same ticks through both paths must yield identical final bars.
    ticks = [
        (60_000, 100.0), (61_500, 104.0), (64_900, 101.0),
        (65_100, 99.0), (69_000, 103.0), (78_000, 107.0),
    ]
    agg = aggregate_ticks(ticks, 5)

    live = _TickBar(5)
    by_time: dict[float, tuple] = {}
    for ts, price in ticks:
        c = live.apply_tick(ts, price)
        by_time[c.time.timestamp()] = (c.open, c.high, c.low, c.close)

    assert {b.time.timestamp(): (b.open, b.high, b.low, b.close) for b in agg} == by_time


# --- TickStore round-trip ----------------------------------------------------


def test_history_from_buffer_before_flush(tmp_path):
    store = TickStore(str(tmp_path / "t.db"))
    store.record("E", 60_000, 100.0)
    store.record("E", 61_000, 105.0)
    store.record("E", 66_000, 98.0)
    bars = asyncio.run(store.bars("E", 5, 10))  # un-flushed: served from buffer
    assert [b.time.timestamp() for b in bars] == [60.0, 65.0]
    assert (bars[0].open, bars[0].high, bars[0].close) == (100, 105, 105)


def test_history_survives_flush(tmp_path):
    store = TickStore(str(tmp_path / "t.db"))
    # Recent, 5s-aligned timestamps so retention (now - 48h) doesn't prune them.
    base = (int(time.time() * 1000) // 5000) * 5000
    for off, p in [(0, 100.0), (1_000, 105.0), (6_000, 98.0)]:
        store.record("E", base + off, p)
    asyncio.run(store.flush())
    # A fresh store on the same db sees the flushed ticks (durable across restart).
    reopened = TickStore(str(tmp_path / "t.db"))
    bars = asyncio.run(reopened.bars("E", 5, 10))
    assert [b.time.timestamp() for b in bars] == [base / 1000, base / 1000 + 5]
    assert (bars[0].open, bars[0].high, bars[0].close) == (100, 105, 105)


def test_unknown_epic_is_empty(tmp_path):
    store = TickStore(str(tmp_path / "t.db"))
    assert asyncio.run(store.bars("NOPE", 5, 10)) == []


def test_latest_returns_freshest_buffered_tick(tmp_path):
    store = TickStore(str(tmp_path / "t.db"))
    store.record("E", 60_000, 100.0)
    store.record("E", 61_000, 105.0)
    assert store.latest("E") == (61_000, 105.0)
    assert store.latest("NOPE") is None


def test_latest_falls_back_to_flushed_tick(tmp_path):
    store = TickStore(str(tmp_path / "t.db"))
    base = (int(time.time() * 1000) // 5000) * 5000
    store.record("E", base, 100.0)
    store.record("E", base + 1_000, 105.0)
    asyncio.run(store.flush())  # buffer now empty
    reopened = TickStore(str(tmp_path / "t.db"))
    assert reopened.latest("E") == (base + 1_000, 105.0)


def test_latest_survives_flush_from_memory(tmp_path):
    # flush() empties the write buffer, but the freshest tick stays cached in
    # memory so latest() answers a streamed epic without a disk read (it runs on
    # the event loop's hot path). Same store as recorded — not a reopen.
    store = TickStore(str(tmp_path / "t.db"))
    store.record("E", 60_000, 100.0)
    store.record("E", 61_000, 105.0)
    asyncio.run(store.flush())
    assert store._buffer == []  # buffer drained by the flush
    assert store.latest("E") == (61_000, 105.0)  # still served from the cache


def test_out_of_order_ticks_dropped(tmp_path):
    store = TickStore(str(tmp_path / "t.db"))
    store.record("E", 61_000, 100.0)
    store.record("E", 60_000, 999.0)  # older than last seen -> dropped
    bars = asyncio.run(store.bars("E", 5, 10))
    assert len(bars) == 1 and bars[0].close == 100


def test_count_limits_returned_bars(tmp_path):
    store = TickStore(str(tmp_path / "t.db"))
    for i in range(10):
        store.record("E", 60_000 + i * 5_000, float(i))  # 10 distinct 5s buckets
    bars = asyncio.run(store.bars("E", 5, 3))
    assert len(bars) == 3
    assert [b.close for b in bars] == [7.0, 8.0, 9.0]  # the most recent 3


def test_bars_survives_missing_table(tmp_path):
    # Regression: a db file from an older build (no `ticks` table) raised
    # `no such table: ticks` on read. Every connection now ensures the schema, so
    # the read path must recover (return empty) rather than 500.
    db = str(tmp_path / "t.db")
    store = TickStore(db)
    conn = sqlite3.connect(db)
    try:
        conn.execute("DROP TABLE ticks")
        conn.commit()
    finally:
        conn.close()
    assert asyncio.run(store.bars("E", 5, 10)) == []  # no exception


def test_failed_flush_requeues_batch_not_lost(tmp_path):
    # A write that fails (e.g. sqlite locked) must re-queue its batch so a later
    # flush retries it, instead of swapping the buffer empty and dropping ticks.
    store = TickStore(str(tmp_path / "t.db"))
    ts = (int(time.time() * 1000) // 5000) * 5000  # recent, so retention won't prune
    store.record("E", ts, 100.0)

    real = store._flush_sync
    calls = {"n": 0}

    def flaky(batch):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return real(batch)

    store._flush_sync = flaky
    with pytest.raises(sqlite3.OperationalError):
        asyncio.run(store.flush())
    assert len(store._buffer) == 1  # re-queued, not dropped

    asyncio.run(store.flush())  # retry succeeds
    assert store._buffer == []
    bars = asyncio.run(store.bars("E", 5, 10))
    assert bars and bars[0].close == 100


def test_retention_prunes_old_ticks(tmp_path):
    db = str(tmp_path / "t.db")
    store = TickStore(db)
    now = int(time.time() * 1000)
    store.record("E", now - RETENTION_MS - 10_000, 1.0)  # older than retention
    store.record("E", now, 2.0)
    asyncio.run(store.flush())  # prune runs on flush
    conn = sqlite3.connect(db)
    try:
        (rows,) = conn.execute("SELECT COUNT(*) FROM ticks").fetchone()
    finally:
        conn.close()
    assert rows == 1  # the stale tick was pruned
