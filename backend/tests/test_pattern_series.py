"""The pattern-search series cache: the load is 4.5s on the largest series and
the scan is 0.12s, so everything here exists to make the load happen once."""

from __future__ import annotations

import asyncio
import sqlite3

import numpy as np
import pytest

pytestmark = pytest.mark.anyio

from auto_trader.core.pattern_scan import prefix_sums, window_distances
from auto_trader.core.pattern_series import PatternSeriesCache


def _db(path, rows, *, broker="capital", epic="US100", res="MINUTE_5", side="bid"):
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE bars (broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
        " ts INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL,"
        " PRIMARY KEY (broker, epic, resolution, side, ts))"
    )
    con.execute(
        "CREATE TABLE coverage (broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
        " oldest_ts INTEGER, newest_ts INTEGER,"
        " PRIMARY KEY (broker, epic, resolution, side))"
    )
    con.executemany(
        "INSERT INTO bars VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(broker, epic, res, side, ts, o, h, l, c, 0.0) for ts, o, h, l, c in rows],
    )
    con.execute(
        "INSERT INTO coverage VALUES (?,?,?,?,?,?)",
        (broker, epic, res, side, rows[0][0], rows[-1][0]),
    )
    con.commit()
    con.close()


def _rows(n, start_ts=1_700_000_000):
    return [
        (start_ts + i * 300, 100.0 + i, 101.0 + i, 99.0 + i, 100.5 + i) for i in range(n)
    ]


def _append(path, *, start_i: int, count: int, broker="capital", epic="US100",
            res="MINUTE_5", side="bid"):
    """New bars arriving at the right edge, as the live stream delivers them."""
    rows = _rows(start_i + count)[start_i:]
    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO bars VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(broker, epic, res, side, ts, o, h, l, c, 0.0) for ts, o, h, l, c in rows],
    )
    con.execute(
        "UPDATE coverage SET newest_ts=? WHERE broker=? AND epic=? AND resolution=? AND side=?",
        (rows[-1][0], broker, epic, res, side),
    )
    con.commit()
    con.close()


def _prepend(path, *, count: int, broker="capital", epic="US100",
             res="MINUTE_5", side="bid"):
    """Older bars arriving from a backfill, at the LEFT edge."""
    rows = [
        (1_700_000_000 - (count - i) * 300, 50.0 + i, 51.0 + i, 49.0 + i, 50.5 + i)
        for i in range(count)
    ]
    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO bars VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(broker, epic, res, side, ts, o, h, l, c, 0.0) for ts, o, h, l, c in rows],
    )
    con.execute(
        "UPDATE coverage SET oldest_ts=? WHERE broker=? AND epic=? AND resolution=? AND side=?",
        (rows[0][0], broker, epic, res, side),
    )
    con.commit()
    con.close()


async def test_loads_a_series_with_centred_ohlc_and_prefix_sums(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(50))
    cache = PatternSeriesCache(str(path))
    s = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert s is not None
    assert s.bars == 50
    assert s.ohlc.shape == (50, 4)
    assert s.ohlc.mean() == pytest.approx(0.0, abs=1e-9)
    assert s.s1.shape == (51,) and s.s2.shape == (51,)
    # The prefix sums must come from the CENTRED array, not the raw one. Nothing
    # downstream can detect the mismatch: wrong s1/s2 give silently wrong
    # distances with no error, and pattern_scan takes them as separate arguments
    # precisely so it stays testable. This is the only place that binds them.
    assert float(s.s1[-1]) == pytest.approx(float(s.ohlc.sum()), abs=1e-6)
    assert float(s.s2[-1]) == pytest.approx(float(np.square(s.ohlc).sum()), rel=1e-12)
    # The offset puts real prices back: the scan is level-invariant, the response is not.
    assert float(s.ohlc[0][0] + s.offset) == pytest.approx(100.0, abs=1e-9)
    assert s.oldest_ts == 1_700_000_000
    assert s.newest_ts == 1_700_000_000 + 49 * 300


async def test_every_connection_is_closed(tmp_path, monkeypatch):
    """`with sqlite3.connect(...)` commits but does not close, and `_coverage`
    runs on EVERY get including warm hits, so the naive form leaks one file
    descriptor per search. Measured at 500 leaked descriptors over 500 warm gets
    before this was fixed, reclaimed only by an explicit gc pass.

    Asserted by using the connections afterwards rather than by counting: a
    closed sqlite3 connection raises ProgrammingError, and a leaked one does
    not. `sqlite3.Connection` is a C type whose attributes cannot be patched, so
    wrapping `close` is not an option.

    The helpers are called DIRECTLY rather than through `get()`, and that is
    what makes the assertion mean anything. `get()` runs both under
    `asyncio.to_thread`, so the connections are created in worker threads, and
    sqlite3's `check_same_thread` guard raises ProgrammingError("created in a
    thread") when they are touched from here whether or not they were closed.
    That guard fires first and the test passes against leaking code. Adding
    `match="closed"` does not rescue it: the cross-thread message would then
    fail against the FIXED code. On the main thread the only ProgrammingError
    available is the one this test is looking for."""
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    key = ("capital", "US100", "MINUTE_5", "bid")

    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def tracking(*args, **kwargs):
        con = real_connect(*args, **kwargs)
        opened.append(con)
        return con

    monkeypatch.setattr(sqlite3, "connect", tracking)
    cache._coverage(key)
    cache._load(key)
    cache._load_after(key, 0)

    assert len(opened) == 3, "fixture check: one connection per helper"
    for con in opened:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            con.execute("SELECT 1")


async def test_is_cached_answers_before_the_first_load(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    assert cache.is_cached("capital", "US100", "MINUTE_5", "bid") is False
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert cache.is_cached("capital", "US100", "MINUTE_5", "bid") is True


async def test_unknown_series_is_none_not_an_error(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(10))
    cache = PatternSeriesCache(str(path))
    assert await cache.get("capital", "NOPE", "MINUTE_5", "bid") is None


async def test_second_get_is_served_from_cache(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert first is second


async def test_new_bars_reach_the_next_get(tmp_path):
    """A bar arriving at the right edge must be visible to the next search. It
    gets there by extension rather than a reload now (see the extension tests
    below), but from the caller's side the contract is unchanged."""
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO bars VALUES ('capital','US100','MINUTE_5','bid',?,1,1,1,1,0)",
        (1_700_000_000 + 20 * 300,),
    )
    con.execute(
        "UPDATE coverage SET newest_ts=? WHERE epic='US100'",
        (1_700_000_000 + 20 * 300,),
    )
    con.commit()
    con.close()
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert second is not first
    assert second.bars == 21


async def test_concurrent_cold_gets_load_once(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(30))
    cache = PatternSeriesCache(str(path))
    loads = 0
    original = cache._load

    def counting(*a, **kw):
        nonlocal loads
        loads += 1
        return original(*a, **kw)

    cache._load = counting
    results = await asyncio.gather(
        *[cache.get("capital", "US100", "MINUTE_5", "bid") for _ in range(5)]
    )
    assert loads == 1
    assert all(r is results[0] for r in results)


async def test_lru_evicts_when_the_bar_budget_is_exceeded(tmp_path):
    path = tmp_path / "c.db"
    _db(path, _rows(40))
    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO bars VALUES ('capital',?,'MINUTE_5','bid',?,1,2,0.5,1.5,0)",
        [(e, 1_700_000_000 + i * 300) for e in ("GOLD", "US500") for i in range(40)],
    )
    con.executemany(
        "INSERT INTO coverage VALUES ('capital',?,'MINUTE_5','bid',?,?)",
        [(e, 1_700_000_000, 1_700_000_000 + 39 * 300) for e in ("GOLD", "US500")],
    )
    con.commit()
    con.close()

    cache = PatternSeriesCache(str(path), max_bars=100)
    a = await cache.get("capital", "US100", "MINUTE_5", "bid")
    await cache.get("capital", "GOLD", "MINUTE_5", "bid")
    await cache.get("capital", "US500", "MINUTE_5", "bid")  # 120 bars: over budget
    again = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert again is not a, "the oldest entry should have been evicted"


async def test_new_bars_extend_the_cached_array_without_reloading(tmp_path):
    """The whole point. A live 5m chart gains a bar every five minutes, so a
    full reload on every growth means the cache never helps the case it exists
    for."""
    path = tmp_path / "c.db"
    _db(path, _rows(100))
    cache = PatternSeriesCache(str(path))

    loads = 0
    original = cache._load

    def counting(*a, **kw):
        nonlocal loads
        loads += 1
        return original(*a, **kw)

    cache._load = counting
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert loads == 1

    _append(path, start_i=100, count=3)
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")

    assert loads == 1, "growth must extend, not reload"
    assert second is not first
    assert second.bars == 103
    assert second.newest_ts == 1_700_000_000 + 102 * 300


async def test_an_extended_series_is_identical_to_a_freshly_loaded_one(tmp_path):
    """The strongest statement available: extension is not merely fast, it is
    indistinguishable. Compares the arrays the scan actually consumes."""
    grown = tmp_path / "grown.db"
    _db(grown, _rows(100))
    cache = PatternSeriesCache(str(grown))
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    _append(grown, start_i=100, count=7)
    extended = await cache.get("capital", "US100", "MINUTE_5", "bid")

    whole = tmp_path / "whole.db"
    _db(whole, _rows(107))
    fresh = await PatternSeriesCache(str(whole)).get("capital", "US100", "MINUTE_5", "bid")

    np.testing.assert_array_equal(extended.ts, fresh.ts)
    # Not identical arrays: the extension keeps the ORIGINAL offset rather than
    # recomputing the mean over the grown series, so the centred values differ by
    # a constant. That is deliberate (centring only needs to sit near the data),
    # and the distance is level-invariant, so the scan cannot tell.
    assert extended.offset != fresh.offset
    np.testing.assert_allclose(
        extended.ohlc + extended.offset, fresh.ohlc + fresh.offset, atol=1e-9
    )


async def test_the_extended_prefix_sums_still_describe_the_extended_array(tmp_path):
    """The binding from Task 3, re-asserted after extension. Wrong s1/s2 give
    silently wrong distances with no error, and extension is where they are most
    likely to drift."""
    path = tmp_path / "c.db"
    _db(path, _rows(60))
    cache = PatternSeriesCache(str(path))
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    _append(path, start_i=60, count=5)
    s = await cache.get("capital", "US100", "MINUTE_5", "bid")

    expected_s1, expected_s2 = prefix_sums(s.ohlc)
    np.testing.assert_allclose(s.s1, expected_s1, atol=1e-6)
    np.testing.assert_allclose(s.s2, expected_s2, rtol=1e-12)


async def test_an_extended_series_scans_the_same_as_a_fresh_one(tmp_path):
    """End to end: the numbers the user sees must not depend on how the array
    was assembled."""
    grown = tmp_path / "grown.db"
    _db(grown, _rows(200))
    cache = PatternSeriesCache(str(grown))
    await cache.get("capital", "US100", "MINUTE_5", "bid")
    _append(grown, start_i=200, count=20)
    extended = await cache.get("capital", "US100", "MINUTE_5", "bid")

    whole = tmp_path / "whole.db"
    _db(whole, _rows(220))
    fresh = await PatternSeriesCache(str(whole)).get("capital", "US100", "MINUTE_5", "bid")

    query = fresh.ohlc[50:58] + fresh.offset
    d_ext = window_distances(extended.ohlc, extended.s1, extended.s2, query - extended.offset)
    d_fresh = window_distances(fresh.ohlc, fresh.s1, fresh.s2, query - fresh.offset)
    np.testing.assert_allclose(d_ext, d_fresh, atol=1e-6)


async def test_older_history_arriving_forces_a_full_reload(tmp_path):
    """Backfill extends the series BACKWARDS. newest_ts does not move, so a
    newest-only stamp would never notice and the cache would serve a series
    missing everything the backfill just fetched."""
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    first = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert first.bars == 20

    _prepend(path, count=5)
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")
    assert second.bars == 25
    assert second.oldest_ts == 1_700_000_000 - 5 * 300


async def test_a_backfill_alongside_new_bars_still_forces_a_full_reload(tmp_path):
    """The ordinary chart-open case: a backfill lands AND live bars arrive, so
    both coverage edges move at once. The right edge moving is what tempts the
    extension path, and taking it here would silently drop every backfilled bar,
    because _load_after only ever looks to the right of what is cached. Backfill
    alone cannot catch this: newest_ts does not move, so the extension path is
    skipped for a reason that has nothing to do with the left edge."""
    path = tmp_path / "c.db"
    _db(path, _rows(20))
    cache = PatternSeriesCache(str(path))
    assert (await cache.get("capital", "US100", "MINUTE_5", "bid")).bars == 20

    _prepend(path, count=5)
    _append(path, start_i=20, count=3)
    second = await cache.get("capital", "US100", "MINUTE_5", "bid")

    assert second.bars == 28
    assert second.oldest_ts == 1_700_000_000 - 5 * 300
    assert second.newest_ts == 1_700_000_000 + 22 * 300
