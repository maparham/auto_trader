"""Whole-series arrays for pattern search, cached in the API process.

Measured on the largest series in the database (dukascopy US100 1m bid,
1,921,754 bars): 3.5s to read from SQLite, 1.0s to convert to numpy, 0.12s to
scan. The load is the entire cost, so it happens once per series per process and
every search after it is interactive.

The cache is per-process and dies with a restart, so user-facing copy says
"first search on a symbol is slower", never "once per series"."""

from __future__ import annotations

import asyncio
import contextlib
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np

from auto_trader.config import settings
from auto_trader.core.candle_aggregate import _WEEK, DERIVED, BucketRule, bucket_open
from auto_trader.core.pattern_scan import prefix_sums

# Roughly 250 MB of float64 once the prefix sums are counted.
_MAX_BARS = 5_000_000

CandleKey = tuple[str, str, str, str]


def fold_arrays(
    ts: np.ndarray, ohlc: np.ndarray, rule: BucketRule
) -> tuple[np.ndarray, np.ndarray]:
    """candle_aggregate.fold on arrays: reduce ascending base bars into one
    OHLC row per bucket, vectorized so a million-bar 1m series folds in
    milliseconds rather than through a million Candle objects. Bucket edges
    follow bucket_open exactly (tested for parity), so the folded timestamps
    match the bars the candles API serves the chart — which is what lets the
    selection's own window come back flagged. Volume is not carried: the
    pattern scan has no use for it."""
    if len(ts) == 0:
        return ts, ohlc
    if rule.kind == "minute":
        span = rule.group * 60
        buckets = ts - ts % span
    elif rule.kind == "week":
        buckets = ts - ((ts // _WEEK) % rule.group) * _WEEK
    else:
        # Calendar buckets. Months-since-1970 make the group arithmetic flat:
        # bucket_open aligns month groups within the calendar year, and the
        # group sizes divide 12, so flooring the flat index is identical.
        months = ts.astype("datetime64[s]").astype("datetime64[M]")
        if rule.kind == "year":
            starts = months.astype("datetime64[Y]").astype("datetime64[M]")
        else:
            idx = months.astype(np.int64)
            starts = ((idx // rule.group) * rule.group).astype("datetime64[M]")
        buckets = starts.astype("datetime64[s]").astype(np.int64)

    firsts = np.concatenate([[0], np.flatnonzero(np.diff(buckets)) + 1])
    lasts = np.concatenate([firsts[1:] - 1, [len(ts) - 1]])
    folded = np.stack(
        [
            ohlc[firsts, 0],
            np.maximum.reduceat(ohlc[:, 1], firsts),
            np.minimum.reduceat(ohlc[:, 2], firsts),
            ohlc[lasts, 3],
        ],
        axis=1,
    )
    return buckets[firsts], folded


@dataclass(frozen=True)
class Series:
    """One (broker, epic, resolution, side) series, ready to scan."""

    ts: np.ndarray
    ohlc: np.ndarray  # centred: see _load
    s1: np.ndarray
    s2: np.ndarray
    offset: float  # the mean _load removed, to put real prices back
    oldest_ts: int
    newest_ts: int

    @property
    def bars(self) -> int:
        return len(self.ts)


class PatternSeriesCache:
    """LRU over whole series, stamped with both coverage edges.

    Bars arriving at the right edge extend the cached arrays in place of a
    reload; a moved left edge (a backfill) rebuilds.

    A per-key lock stops two concurrent cold searches on the same series from
    both paying the multi-second load, mirroring CandleCache._key_lock."""

    def __init__(self, db_path: str, max_bars: int = _MAX_BARS) -> None:
        self._db_path = db_path
        self._max_bars = max_bars
        self._entries: OrderedDict[CandleKey, tuple[tuple[int, int], Series]] = OrderedDict()
        self._locks: dict[CandleKey, asyncio.Lock] = {}

    def clear(self) -> None:
        self._entries.clear()

    def is_cached(self, broker: str, epic: str, resolution: str, side: str) -> bool:
        """Whether a get() would be served without a multi-second load. Asked
        BEFORE get(), since get() is what fills the cache. Present counts as
        cached: bars arriving at the right edge are appended rather than
        reloaded, which is a copy rather than a several-second read. A BACKFILL
        still forces a full reload, and this still answers True, so the "first
        search is slower" warning is missed in that one case. Making it right
        would need the coverage row, and this is sync and runs before get()."""
        return (broker, epic, resolution, side) in self._entries

    def _key_lock(self, key: CandleKey) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    def _connect(self) -> sqlite3.Connection:
        """Always use under `contextlib.closing`. `with sqlite3.connect(...)`
        commits the transaction but does NOT close the connection, and
        `_coverage` runs on every get including warm hits, so the naive form
        leaks one file descriptor per search in a long-lived API process."""
        return sqlite3.connect(self._db_path)

    def _coverage(self, key: CandleKey) -> tuple[int, int] | None:
        """(oldest_ts, newest_ts), or None when the key has no coverage row.

        Both edges, not just the newest: backfill extends a series BACKWARDS,
        which leaves newest_ts untouched. A newest-only stamp would serve a
        cached array that is missing everything the backfill just fetched."""
        with contextlib.closing(self._connect()) as con:
            row = con.execute(
                "SELECT oldest_ts, newest_ts FROM coverage"
                " WHERE broker=? AND epic=? AND resolution=? AND side=?",
                key,
            ).fetchone()
        if not row or row[0] is None or row[1] is None:
            return None
        return int(row[0]), int(row[1])

    def _load_after(self, key: CandleKey, after_ts: int) -> tuple[np.ndarray, np.ndarray] | None:
        """Raw (ts, ohlc) for bars strictly newer than `after_ts`.

        Strictly newer is safe because candle_cache._store_closed persists only
        CLOSED bars (ts < the forming bar's open), so the newest cached bar's
        OHLC never changes under us. If forming bars were ever written, this
        would have to re-read the last bar and drop the cached copy of it."""
        with contextlib.closing(self._connect()) as con:
            rows = con.execute(
                "SELECT ts, open, high, low, close FROM bars"
                " WHERE broker=? AND epic=? AND resolution=? AND side=? AND ts>?"
                " ORDER BY ts",
                (*key, after_ts),
            ).fetchall()
        if not rows:
            return None
        arr = np.asarray(rows, dtype=np.float64)
        return arr[:, 0].astype(np.int64), arr[:, 1:5]

    @staticmethod
    def _extend(series: Series, ts_new: np.ndarray, ohlc_new: np.ndarray) -> Series:
        """Append new bars at the cost of an array copy rather than a reload.

        Not proportional to the new bars: every concatenate copies the whole
        existing array, which is ~100 MB and tens of ms on the largest series,
        and holds both copies briefly. That is still ~100x cheaper than the
        4.5s SQLite read plus numpy conversion it replaces, which is the point.

        Two things keep it to that one copy and both are deliberate:

        The original `offset` is reused rather than recomputed. Centring exists
        for numerical conditioning, so it only has to sit near the data; it does
        not have to be the exact mean. Recomputing it would mean re-centring and
        re-summing the entire array, which is the cost this method exists to
        avoid. The distance is level-invariant, so the scan cannot tell.

        The prefix sums are extended rather than rebuilt. They are cumulative, so
        the new tail is the old total plus the new bars' running sums.
        """
        centred_new = ohlc_new - series.offset
        return Series(
            ts=np.concatenate([series.ts, ts_new]),
            ohlc=np.concatenate([series.ohlc, centred_new]),
            s1=np.concatenate([series.s1, series.s1[-1] + np.cumsum(centred_new.sum(axis=1))]),
            s2=np.concatenate(
                [series.s2, series.s2[-1] + np.cumsum(np.square(centred_new).sum(axis=1))]
            ),
            offset=series.offset,
            oldest_ts=series.oldest_ts,
            newest_ts=int(ts_new[-1]),
        )

    @staticmethod
    def _drop_last(series: Series) -> Series:
        """The series without its newest bar. Only called with bars > 1, from
        the derived-tail refold: that bar is about to be rebuilt from base
        bars, possibly with more of them inside it."""
        return Series(
            ts=series.ts[:-1],
            ohlc=series.ohlc[:-1],
            s1=series.s1[:-1],
            s2=series.s2[:-1],
            offset=series.offset,
            oldest_ts=series.oldest_ts,
            newest_ts=int(series.ts[-2]),
        )

    def _load(self, key: CandleKey, rule: BucketRule | None = None) -> Series | None:
        """`key` names the series to READ (the base series when `rule` is set);
        folding into the derived buckets happens here, before centring."""
        with contextlib.closing(self._connect()) as con:
            rows = con.execute(
                "SELECT ts, open, high, low, close FROM bars"
                " WHERE broker=? AND epic=? AND resolution=? AND side=? ORDER BY ts",
                key,
            ).fetchall()
        if not rows:
            return None
        arr = np.asarray(rows, dtype=np.float64)
        ts = arr[:, 0].astype(np.int64)
        if rule is not None:
            ts, arr = fold_arrays(ts, arr[:, 1:5], rule)
            arr = np.concatenate([ts[:, None].astype(np.float64), arr], axis=1)
        # Centre once. Without this, cumsum cancellation over millions of values
        # at index price levels puts an exact self-match at 0.056 instead of 0,
        # which reorders the close ranks. Correctness, not tuning.
        offset = float(arr[:, 1:5].mean())
        ohlc = arr[:, 1:5] - offset
        s1, s2 = prefix_sums(ohlc)
        return Series(
            ts=ts, ohlc=ohlc, s1=s1, s2=s2, offset=offset,
            oldest_ts=int(ts[0]), newest_ts=int(ts[-1]),
        )

    def _evict(self) -> None:
        total = sum(s.bars for _, s in self._entries.values())
        while total > self._max_bars and len(self._entries) > 1:
            _, (_, dropped) = self._entries.popitem(last=False)
            total -= dropped.bars

    async def get(
        self, broker: str, epic: str, resolution: str, side: str
    ) -> Series | None:
        key: CandleKey = (broker, epic, resolution, side)
        # A derived resolution (MONTH, 3m, 2W…) is never stored as its own
        # series: it is folded here from its base series, exactly as the
        # candles API folds it for the chart. The cache entry lives under the
        # DERIVED key; the database is only ever asked about the base one,
        # whose coverage row also stamps freshness.
        rule = DERIVED.get(resolution)
        data_key: CandleKey = (
            (broker, epic, rule.base.value, side) if rule is not None else key
        )
        async with self._key_lock(key):
            coverage = await asyncio.to_thread(self._coverage, data_key)
            cached = self._entries.get(key)

            if cached is not None and coverage is not None:
                stamp, series = cached
                if stamp == coverage:
                    self._entries.move_to_end(key)
                    return series
                # Only the right edge moved: append rather than rebuild. A
                # moved LEFT edge means a backfill landed, and those bars sit
                # before everything cached, so that falls through to a reload.
                if stamp[0] == coverage[0] and coverage[1] > stamp[1]:
                    if rule is None:
                        grown = await asyncio.to_thread(
                            self._load_after, data_key, series.newest_ts
                        )
                    elif series.bars > 1:
                        # New base bars can EXTEND the newest bucket, not just
                        # add buckets after it, so the tail is refolded: fetch
                        # the base bars from that bucket's open and let the
                        # refold replace the cached last bar.
                        grown = await asyncio.to_thread(
                            self._load_after,
                            data_key,
                            bucket_open(int(series.ts[-1]), rule) - 1,
                        )
                        if grown is not None:
                            series = self._drop_last(series)
                            ts_new, ohlc_new = fold_arrays(*grown, rule)
                            grown = (ts_new, ohlc_new)
                    else:
                        grown = None  # 1-bar series: a reload is the refold
                    if grown is not None:
                        series = self._extend(series, *grown)
                        self._entries[key] = (coverage, series)
                        self._entries.move_to_end(key)
                        self._evict()
                        return series

            series = await asyncio.to_thread(self._load, data_key, rule)
            if series is None:
                return None
            stamp = coverage if coverage is not None else (series.oldest_ts, series.newest_ts)
            self._entries[key] = (stamp, series)
            self._entries.move_to_end(key)
            self._evict()
            return series


PATTERN_SERIES = PatternSeriesCache(settings.candle_db_path)
