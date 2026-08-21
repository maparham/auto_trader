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
import os
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


def _key_label(key: CandleKey) -> str:
    """Compact one-token series name for log lines: broker/epic/resolution/side."""
    return "/".join(key)


def _stamp(ts: int) -> str:
    """Log-friendly UTC timestamp (minute precision — bars are minute-and-above)."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


# Active multi-chunk backfills, keyed by CandleKey — the UI's "downloading data"
# progress source, the in-flight counterpart to the backfill log lines below.
# Written only inside _window()'s walk (same gating as those logs: multi-chunk
# walks only) and always removed in the finally, so a crashed walk can't strand
# an entry past the reader's 60s staleness cut. The finally (not a plain pop
# after the loop) is what covers CancelledError — a client disconnecting mid-
# backfill unwinds straight through `await fetch_range(...)`, and the walk's
# `except Exception` does not catch it.
_ACTIVE_BACKFILLS: dict[CandleKey, dict] = {}
_BACKFILL_STALE_S = 60.0


def active_backfills(now: float | None = None) -> list[dict]:
    """Snapshot of in-flight multi-chunk backfills for the progress endpoint."""
    cutoff = (now if now is not None else time.time()) - _BACKFILL_STALE_S
    # Copy the values first: the reader runs on a different thread than the walk
    # that pops entries, and iterating the live dict could hit a resize mid-loop.
    return [dict(e) for e in list(_ACTIVE_BACKFILLS.values()) if e["updated_at"] >= cutoff]


def _bucket_start(now_s: float, res_seconds: int) -> int:
    """Open time (unix s) of the bucket containing now_s — the forming bar's open.
    Bars with ts < this are closed; the bar at/after it is still forming."""
    return (int(now_s) // res_seconds) * res_seconds


# Bars per backfill broker call. A below-oldest miss can span months (e.g. a chart
# panned back years past the recent cache), and some data sources (Dukascopy) are
# erratically slow — one giant fetch would blow the broker breaker's per-call
# timeout and cache NOTHING, permanently walling scroll-back. So window() walks the
# gap in bounded top-down chunks, persisting each as it lands; a slow/failed chunk
# stops the walk with coverage still contiguous, and the next request resumes.
_BACKFILL_CHUNK_BARS = 3000


class CandleCache:
    """Sqlite-backed closed-bar cache. Fresh connection per op (cheap for sqlite,
    sidesteps the one-connection-per-thread rule; public async methods run the sync
    helpers via asyncio.to_thread)."""

    def __init__(self, db_path: str, tail_fetch_budget: float = 3.0) -> None:
        self._db_path = db_path
        # How long recent() waits on the live tail fetch before serving cached
        # bars instead (the fetch finishes in the background and is absorbed).
        # Must stay well under the frontend's 10s history timeout.
        self._tail_budget = tail_fetch_budget
        # Late-absorb tasks (see _absorb_late); referenced so they aren't GC'd mid-run.
        self._bg_tasks: set[asyncio.Task] = set()
        # Keys with a late absorb still in flight: recent() serves straight from
        # cache for these instead of launching yet another slow fetch per call.
        self._absorbing: set[CandleKey] = set()
        self._locks: dict[CandleKey, asyncio.Lock] = {}
        # In-memory only (reset on restart) — debug/introspection counters for the
        # candle-cache-stats UI, not durable telemetry.
        self._hits: dict[CandleKey, int] = {}
        self._misses: dict[CandleKey, int] = {}
        self._last_fetch: dict[CandleKey, float] = {}
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
        conn.execute(
            "CREATE TABLE IF NOT EXISTS backfill_state ("
            "broker TEXT, epic TEXT, resolution TEXT, side TEXT,"
            "reached_floor INTEGER NOT NULL DEFAULT 0,"
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

    def _has_stored(self, key: CandleKey, from_ts: int, to_ts: int) -> bool:
        """Whether the bars table holds ANY bar in [from_ts, to_ts] — including
        bars coverage does not claim (a coverage reset, an import, bars recorded
        before the row was rebuilt). The archive-absorb path in _window keys off
        this: such spans are usually beyond the broker's retention, so their
        presence is the signal to serve from the store instead of the wire."""
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT 1 FROM bars WHERE broker=? AND epic=? AND resolution=? "
                "AND side=? AND ts BETWEEN ? AND ? LIMIT 1",
                (*key, from_ts, to_ts),
            ).fetchone()
        finally:
            conn.close()
        return row is not None

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

    def _record_hit(self, key: CandleKey) -> None:
        self._hits[key] = self._hits.get(key, 0) + 1

    def _record_miss(self, key: CandleKey) -> None:
        self._misses[key] = self._misses.get(key, 0) + 1

    def _record_last_fetch(self, key: CandleKey, when: float) -> None:
        self._last_fetch[key] = when

    def stats(self, key: CandleKey) -> dict:
        """Read-only per-series introspection for the cache-stats UI. Never
        touches the broker; safe to call from a route handler."""
        cov = self._coverage(key)
        return {
            "oldest_ts": cov[0] if cov else None,
            "newest_ts": cov[1] if cov else None,
            "cached_bar_count": self._cached_count(key),
            "hits": self._hits.get(key, 0),
            "misses": self._misses.get(key, 0),
            "last_fetch_ts": self._last_fetch.get(key),
        }

    def global_stats(self) -> dict:
        """Cache-wide introspection (all series) for the cache-stats popover.
        Deliberately touches no table: a `SELECT COUNT(*) FROM bars` here scanned
        millions of rows (~14s once the db reached ~750MB, worse under concurrent
        writes), blowing the frontend's 6s budget and zeroing the whole popover.
        Everything below is O(1) — in-memory counters plus a stat() on the file."""
        return {
            "total_hits": sum(self._hits.values()),
            "total_misses": sum(self._misses.values()),
            "db_size_bytes": os.path.getsize(self._db_path) if os.path.exists(self._db_path) else 0,
        }

    async def window(
        self,
        key: CandleKey,
        res_seconds: int,
        start: datetime,
        end: datetime,
        fetch_range: Callable[[datetime, datetime], Awaitable[list[Candle]]],
        *,
        now: float | None = None,
        chunk_bars: int = _BACKFILL_CHUNK_BARS,
        degraded: dict | None = None,
        budget_s: float | None = None,
        partial: dict | None = None,
    ) -> list[Candle]:
        """Candles in [start, end]. Serializes per-key with recent() (see _key_lock).

        `degraded` (optional out-param): when a broker fetch failed but cached bars
        were served anyway, degraded["reason"] is set to the error text — the
        caller's signal that the result may be missing the unreachable portion.

        `budget_s` (optional): how long this call may spend FILLING before it
        serves what it has. None (the default) means unbounded, which is what
        every non-interactive reader wants: a backtest that silently ran on the
        first twenty seconds of a year's history would report numbers for data it
        never had. An interactive chart read passes one, because the alternative
        is not a slower answer but no answer at all — coverage must stay
        contiguous, so asking for a year of 1m candles behind a two-week cache
        means ~175 sequential broker calls, minutes of them, with this key's lock
        held against every other read of the same series.

        The budget starts HERE, before the lock: a caller queued behind someone
        else's backfill is exactly the caller that must not wait forever.

        `partial` (optional out-param): set when the budget, not an error, ended
        the fill. Deliberately NOT `degraded` — nothing is broken and nothing is
        unreachable, the download is simply still going, and the two want
        different words in front of a user."""
        deadline = None if budget_s is None else time.monotonic() + budget_s
        async with self._key_lock(key):
            return await self._window(
                key, res_seconds, start, end, fetch_range,
                now=now, chunk_bars=chunk_bars, degraded=degraded,
                deadline=deadline, partial=partial,
            )

    async def _window(
        self,
        key: CandleKey,
        res_seconds: int,
        start: datetime,
        end: datetime,
        fetch_range: Callable[[datetime, datetime], Awaitable[list[Candle]]],
        *,
        now: float | None = None,
        chunk_bars: int = _BACKFILL_CHUNK_BARS,
        degraded: dict | None = None,
        deadline: float | None = None,
        partial: dict | None = None,
    ) -> list[Candle]:
        """Candles in [start, end]. Cache hit when the window is fully covered.
        Otherwise contiguous-backfill: fetch the gap below oldest down to `start`
        (or the whole window when cold), store closed bars, mark covered, serve."""
        from_ts, to_ts = int(start.timestamp()), int(end.timestamp())
        cov = await asyncio.to_thread(self._coverage, key)
        # A cache hit needs the window fully inside coverage. Misses fill BELOW
        # oldest (scroll-back) and ABOVE newest (forward walks) — but the newest
        # watermark never passes the closed cutoff: the forming bar belongs to
        # recent()/the stream and must stay re-fetchable.
        if cov is not None and cov[0] <= from_ts and cov[1] >= to_ts:
            self._record_hit(key)
            return await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
        cutoff = _bucket_start(now if now is not None else time.time(), res_seconds)
        chunk_secs = res_seconds * max(1, chunk_bars)
        fetched_any = False
        # Forward-fill and downward-backfill failures are tracked separately: an
        # unreachable live edge (broker outage) must not abort the downward walk,
        # which can still be served — often straight from cache or a healthier
        # historical source. Each walk stops on ITS first error only.
        fwd_err: Exception | None = None
        err: Exception | None = None
        # Set when the BUDGET stopped a walk, so the caller can say "still
        # downloading" rather than "broker unreachable". Checked before each
        # chunk, never mid-flight: a chunk already in the air is cheaper to land
        # (it is stored and marked covered, so the next call resumes deeper) than
        # to abandon.
        out_of_time = False

        def spent() -> bool:
            return deadline is not None and time.monotonic() >= deadline
        # Fill any gap ABOVE newest first (an API client walking history
        # forward, or a window straddling the live edge — historically this
        # returned an empty 200 with no fetch at all). Chunks walk BOTTOM-UP
        # from the newest watermark so a mid-gap failure leaves coverage
        # contiguous and the retry resumes from the last landed chunk. The walk
        # never passes the closed-bar cutoff, so the forming bar stays
        # re-fetchable (same rule as a cold fill's coverage cap).
        if cov is not None and min(to_ts, cutoff) > cov[1]:
            top = min(to_ts, cutoff)
            cur = cov[1]
            while cur < top:
                if spent():
                    out_of_time = True
                    break
                chunk_to = min(top, cur + chunk_secs)
                try:
                    chunk = await fetch_range(
                        datetime.fromtimestamp(cur, tz=timezone.utc),
                        datetime.fromtimestamp(chunk_to, tz=timezone.utc))
                except Exception as e:  # noqa: BLE001 — same contract as the walk below
                    fwd_err = e
                    break
                fetched_any = True
                await asyncio.to_thread(self._store_closed, key, chunk, cutoff)
                await asyncio.to_thread(self._extend_coverage, key, cov[1], chunk_to)
                cur = chunk_to
            cov = (cov[0], max(cov[1], cur))
        # Backfill from `start` up to the current oldest (gap-free), or the whole
        # window when cold. End the fetch at oldest so we don't re-pull covered bars.
        fetch_end = datetime.fromtimestamp(cov[0], tz=timezone.utc) if cov else end
        # Cap the NEWEST watermark. A cold fill pulled every closed bar up to `cutoff`,
        # but the forming bar (>= cutoff) was filtered out by _store_closed and must
        # stay re-fetchable; a warm fill only backfilled below oldest, so newest stays
        # cov[1]. Reused for every chunk's coverage write below so the segment stays
        # anchored to the same top edge (contiguous, no hole).
        hi = cov[1] if cov is not None else min(to_ts, cutoff)
        # Walk [start, fetch_end] in bounded top-down chunks so no single broker call
        # spans the whole gap (see _BACKFILL_CHUNK_BARS). Each chunk is stored + marked
        # covered as it lands — even an empty one (closed market), so we don't re-fetch
        # the hole. A chunk that raises (slow/failed source) stops the walk: coverage
        # stays contiguous down to the last success and the next request resumes there.
        cursor = fetch_end
        # Archive absorb, for the downward walk only: bars can sit in the table
        # BELOW what coverage claims (a coverage reset, an import, bars recorded
        # before the row was rebuilt) — 17 months of real 1m bars behind a
        # coverage row that starts much later, in the case that surfaced this.
        # Walking the broker over such spans is slow and fruitless: they are
        # usually beyond its retention, and a deep jump turns into hundreds of
        # doomed fetches inside one request. So a chunk entirely below the
        # pre-walk oldest watermark is served from the store when the store has
        # bars in it (or when deep backfill already proved the broker floor),
        # and coverage self-heals downward over it. Strictly below the original
        # oldest, never above: orphaned rows near the live edge must not
        # short-circuit a forward fill the broker could serve fresher.
        absorb_below = cov[0] if cov is not None else None
        floor_reached = absorb_below is not None and await asyncio.to_thread(
            self._backfill_reached_floor, key
        )
        # Progress logging. A multi-chunk backfill (a backtest's warm-up ask, a deep
        # scroll-back) can run for minutes inside ONE http request, and uvicorn only
        # logs that request when it finishes — so without these lines the download is
        # invisible while it's happening. Kept to multi-chunk walks: a warm 1-chunk
        # fetch (ordinary scroll-back page) would otherwise spam a line per page.
        span_secs = max(1, int(fetch_end.timestamp()) - from_ts)
        total_chunks = max(1, -(-span_secs // chunk_secs))  # ceil
        started = time.monotonic()
        done_chunks = 0
        bars_in = 0
        if total_chunks > 1:
            log.info(
                "backfill start %s %s..%s (%d chunks x %d bars)",
                _key_label(key), _stamp(from_ts), _stamp(int(fetch_end.timestamp())),
                total_chunks, chunk_bars,
            )
            # Same gating as the logs, and the same fields — this is the live view
            # of them. `updated_at` is wall-clock time.time(), never the injected
            # `now`: `now` is bar-time fiction (tests pass now=10_000) while this
            # value is what the HTTP reader compares against for staleness.
            _ACTIVE_BACKFILLS[key] = {
                "label": _key_label(key), "done_chunks": 0,
                "total_chunks": total_chunks, "bars": 0, "elapsed_s": 0.0,
                "eta_s": None, "at": "", "updated_at": time.time(),
            }
        try:
            while err is None and start < cursor:
                if spent():
                    out_of_time = True
                    break
                chunk_from_ts = max(from_ts, int(cursor.timestamp()) - chunk_secs)
                chunk_from = datetime.fromtimestamp(chunk_from_ts, tz=timezone.utc)
                if (
                    absorb_below is not None
                    and int(cursor.timestamp()) <= absorb_below
                    and (
                        floor_reached
                        or await asyncio.to_thread(
                            self._has_stored, key, chunk_from_ts, int(cursor.timestamp()) - 1
                        )
                    )
                ):
                    # Stored (or provably broker-less) span: mark covered and move
                    # on — the settle-time _read_window picks the bars up. A chunk
                    # only partially stored is absorbed whole; its holes sit below
                    # broker retention, so a fetch could not have filled them.
                    if hi >= chunk_from_ts:
                        await asyncio.to_thread(self._extend_coverage, key, chunk_from_ts, hi)
                    cursor = chunk_from
                    done_chunks += 1
                    continue
                try:
                    chunk = await fetch_range(chunk_from, cursor)
                except Exception as e:  # noqa: BLE001 — a slow/failed broker call stops the walk
                    err = e
                    break
                fetched_any = True
                await asyncio.to_thread(self._store_closed, key, chunk, cutoff)
                # Skip the write when there's no valid closed span (an entirely-future
                # window), which would otherwise record an inverted oldest>newest row.
                if hi >= chunk_from_ts:
                    await asyncio.to_thread(self._extend_coverage, key, chunk_from_ts, hi)
                cursor = chunk_from
                done_chunks += 1
                bars_in += len(chunk)
                if total_chunks > 1:
                    elapsed = time.monotonic() - started
                    # ETA from the mean chunk time so far: chunk cost is roughly flat
                    # (same bar count per broker call), so a mean is a fair estimate.
                    eta = elapsed / done_chunks * max(0, total_chunks - done_chunks)
                    log.info(
                        "backfill %s %d/%d (%d%% done, %d%% left) at %s, %d bars, %.1fs elapsed, ~%.0fs left",
                        _key_label(key), done_chunks, total_chunks,
                        done_chunks * 100 // total_chunks,
                        100 - done_chunks * 100 // total_chunks, _stamp(chunk_from_ts),
                        bars_in, elapsed, eta,
                    )
                    entry = _ACTIVE_BACKFILLS.get(key)
                    if entry is not None:
                        entry.update(
                            done_chunks=done_chunks, bars=bars_in,
                            elapsed_s=elapsed, eta_s=eta,
                            at=_stamp(chunk_from_ts), updated_at=time.time(),
                        )
            if total_chunks > 1 and fetched_any:
                log.info(
                    "backfill %s %s after %d/%d chunks, %d bars, %.1fs",
                    _key_label(key),
                    "stopped (fetch failed)" if err is not None
                    else "paused (out of time)" if out_of_time else "done",
                    done_chunks, total_chunks, bars_in, time.monotonic() - started,
                )
        finally:
            _ACTIVE_BACKFILLS.pop(key, None)
        if fetched_any:
            self._record_miss(key)
            self._record_last_fetch(key, now if now is not None else time.time())
        # A fill errored partway (either walk). If the bars that DID land (plus prior
        # cache) give the window anything, serve that partial data and mark the call
        # degraded — real bars beat a 5xx during an outage, and the caller can tell
        # the result may be short. Otherwise the window is still unreached: surface
        # the error rather than an empty 200. This matters because scroll-back
        # requests a window at the BOTTOM of the gap while chunks fill top-down — a
        # mid-gap failure leaves read_window empty even though top chunks succeeded.
        # Returning [] here would be indistinguishable from genuine end-of-history
        # and would trip the frontend's empty-streak latch (the very thing this
        # guards against); a 5xx is treated as "retry the same window on next
        # scroll". Progress persists: the landed chunks are already stored +
        # covered, so the retry resumes deeper.
        cached = await asyncio.to_thread(self._read_window, key, from_ts, to_ts)
        # The budget ran out with the walk unfinished. Report it whatever the
        # payload looks like: a deep window is usually still EMPTY at this point
        # (chunks fill top-down, the ask sits at the bottom), and an empty 200
        # with no marker is indistinguishable from genuine end-of-history.
        if out_of_time and partial is not None:
            partial.update(
                done_chunks=done_chunks, total_chunks=total_chunks, bars=bars_in,
                reason=(
                    f"still loading history ({done_chunks}/{total_chunks} chunks)"
                ),
            )
        first_err = err if err is not None else fwd_err
        if first_err is not None:
            if cached:
                if degraded is not None and not await self._window_closed_complete(
                    key, from_ts, to_ts, cutoff, res_seconds
                ):
                    degraded["reason"] = str(first_err)
                return cached
            raise first_err
        return cached

    async def _window_closed_complete(
        self, key: CandleKey, from_ts: int, to_ts: int, cutoff: int, res_seconds: int
    ) -> bool:
        """Whether coverage spans every CLOSED bar of [from_ts, to_ts]. A window
        never contains the forming bar (only closed bars are stored), so a
        request reaching past the closed edge is still complete once coverage
        reaches the last closed bar's open (cutoff - res_seconds) — a failed
        fetch whose only unserved content was the forming bar must not mark the
        payload degraded, or every to_ts=now request during an outage would
        carry a false 'missing data' signal (pill + retry churn) over a payload
        missing nothing."""
        need_hi = min(to_ts, cutoff - res_seconds)
        if need_hi < from_ts:
            return True  # entirely in the forming/future region: nothing closed to miss
        cov = await asyncio.to_thread(self._coverage, key)
        return cov is not None and cov[0] <= from_ts and cov[1] >= need_hi

    async def recent(
        self,
        key: CandleKey,
        res_seconds: int,
        count: int,
        fetch_recent: Callable[[int], Awaitable[list[Candle]]],
        *,
        tail: int = 3,
        now: float | None = None,
        degraded: dict | None = None,
    ) -> list[Candle]:
        """Most-recent `count` bars. Serializes per-key with window() (see _key_lock).

        `degraded` (optional out-param): same contract as window() — set when a
        broker fetch failed and cached bars were served in its place."""
        async with self._key_lock(key):
            return await self._recent(
                key, res_seconds, count, fetch_recent, tail=tail, now=now, degraded=degraded
            )

    async def _recent(
        self,
        key: CandleKey,
        res_seconds: int,
        count: int,
        fetch_recent: Callable[[int], Awaitable[list[Candle]]],
        *,
        tail: int = 3,
        now: float | None = None,
        degraded: dict | None = None,
    ) -> list[Candle]:
        """Most-recent `count` bars. Cold/short cache -> one full fetch. Warm cache
        -> a small `tail` fetch to anchor 'now' + carry the forming bar, with the
        rest served from cache. The forming bar (ts >= cutoff) is passed through
        so the chart shows current price immediately, EXCEPT on the stale-serve
        paths (slow or failing fetch), which can only return closed cached bars."""
        cutoff = _bucket_start(now if now is not None else time.time(), res_seconds)
        # A late absorb for this key is still in flight: don't pile another slow
        # fetch on top (thundering herd); serve the cache until the absorb lands.
        if key in self._absorbing:
            cached = await asyncio.to_thread(self._read_back, key, count, cutoff + res_seconds)
            if cached:
                self._record_hit(key)
                return cached
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
        fetch_task = asyncio.ensure_future(fetch_recent(fetch_n))
        try:
            try:
                fetched = await asyncio.wait_for(
                    asyncio.shield(fetch_task), timeout=self._tail_budget
                )
            except TimeoutError:
                # Same builtin type as a TimeoutError raised BY the fetch (broker
                # read timeout): a done task means it was the fetch's own error
                # (or a photo-finish success), not our budget expiring.
                if fetch_task.done():
                    fetched = fetch_task.result()  # re-raises into the error path
                else:
                    # Tail fetch blew the budget (e.g. a broker that emulates
                    # recent-N with a bulk history download). Serve the cached
                    # bars now (stale beats a client-side timeout) and absorb the
                    # late result when it lands so the next call's bridge is short.
                    cached = await asyncio.to_thread(
                        self._read_back, key, count, cutoff + res_seconds
                    )
                    if cached:
                        self._record_hit(key)
                        self._absorb_late(key, res_seconds, fetch_task)
                        return cached
                    # Nothing cached to serve: wait it out (shielded, see below).
                    fetched = await asyncio.shield(fetch_task)
        except asyncio.CancelledError:
            # Client gave up (request task cancelled) but the broker fetch keeps
            # running under the shield; absorb its result so a series that always
            # fetches slower than the client timeout still converges instead of
            # restarting from scratch on every retry.
            self._absorb_late(key, res_seconds, fetch_task)
            raise
        except Exception as e:
            cached = await asyncio.to_thread(self._read_back, key, count, cutoff + res_seconds)
            if cached:
                if degraded is not None:
                    degraded["reason"] = str(e)
                return cached
            raise
        self._record_last_fetch(key, now if now is not None else time.time())
        if cold:
            self._record_miss(key)
        else:
            self._record_hit(key)
        await self._store_recent(key, res_seconds, fetched, cutoff, newest)
        if cold:
            return fetched[-count:]
        forming = [b for b in fetched if int(b.time.timestamp()) >= cutoff]
        closed = await asyncio.to_thread(self._read_back, key, count - len(forming), cutoff)
        return closed + forming

    async def _store_recent(
        self,
        key: CandleKey,
        res_seconds: int,
        fetched: list[Candle],
        cutoff: int,
        newest: int | None,
    ) -> None:
        """Store a recent-fetch block without auto-extending coverage, then set it
        ourselves: a block that connects to the existing coverage (its oldest is
        within one bar of `newest`) unions; a block that lands disjoint (the gap was
        bigger than we could bridge) RESETS coverage to just the fresh block, so the
        unfetched gap is never claimed."""
        span = await asyncio.to_thread(self._store_closed, key, fetched, cutoff, False)
        if span is not None:
            lo, hi = span
            if newest is not None and lo <= newest + res_seconds:
                await asyncio.to_thread(self._extend_coverage, key, lo, hi)
            else:
                await asyncio.to_thread(self._set_coverage, key, lo, hi)

    def _absorb_late(self, key: CandleKey, res_seconds: int, task: asyncio.Task) -> None:
        """Finish a budget-blown tail fetch in the background: when it lands, take
        the key lock (the caller's is long released by then), re-read the newest
        watermark (it may have moved), and store/cover exactly like the foreground
        path. The closed-bar cutoff is re-derived at absorb time: bars that closed
        while the fetch was still running must be stored, or coverage would stall
        one bucket behind forever and the series would never converge. Failures
        are logged and dropped; the response was already served. While the absorb
        is in flight the key is marked so recent() serves cache instead of piling
        on more fetches."""
        self._absorbing.add(key)

        async def absorb() -> None:
            try:
                fetched = await task
            except Exception:
                log.warning("late tail fetch failed for %s", key, exc_info=True)
                return
            async with self._key_lock(key):
                cutoff = _bucket_start(time.time(), res_seconds)
                cov = await asyncio.to_thread(self._coverage, key)
                newest = cov[1] if cov is not None else None
                await self._store_recent(key, res_seconds, fetched, cutoff, newest)

        t = asyncio.create_task(absorb())
        self._bg_tasks.add(t)

        def _done(task_: asyncio.Task) -> None:
            self._bg_tasks.discard(task_)
            self._absorbing.discard(key)

        t.add_done_callback(_done)

    async def absorb_closed(self, key: CandleKey, res_seconds: int, bar: Candle) -> None:
        """Persist one bar that just CLOSED on the live stream.

        This is what keeps the store's right edge tracking the stream while a
        chart sits open: historically closed bars were only persisted on the
        next view's forward bridge, so candle_history.db lagged the live feed
        by however long the tab had been open (measured 2h on 1m), and
        anything reading the store — pattern search's own-selection row, most
        visibly — was told the recent past did not exist.

        The bar is stored unconditionally. Coverage, however, extends ONLY
        when the bar directly abuts covered territory (its open sits within
        one bar of the newest watermark): after a stream drop or a weekend
        the gap between newest and this bar may hide bars a broker fetch can
        still supply, and claiming it covered would freeze the hole in place.
        A non-contiguous bar stays an orphan row until the next REST bridge
        marks the gap — the same state a coverage reset leaves, and one the
        window() walk already knows how to absorb.

        Takes the per-key lock, so it serializes with window()/recent() and
        their read-modify-write of the coverage row."""
        ts = int(bar.time.timestamp())
        async with self._key_lock(key):
            await asyncio.to_thread(
                self._store_closed, key, [bar], ts + 1, False
            )
            cov = await asyncio.to_thread(self._coverage, key)
            if cov is not None and cov[1] < ts and ts - res_seconds <= cov[1]:
                await asyncio.to_thread(self._extend_coverage, key, cov[0], ts)

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


from auto_trader.config import settings  # noqa: E402  (singleton at module load, mirrors tick_store)

# Must come after CandleCache is defined; mirrors the TICK_STORE singleton in tick_store.py.
CANDLE_CACHE = CandleCache(settings.candle_db_path)
