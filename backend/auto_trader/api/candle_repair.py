"""The candle cache's read-time repair: stale pre-split prints (see
core/candle_clean.py), installed on CANDLE_CACHE at startup so every reader
of window()/recent() gets it: the chart routes, derived timeframes (they fold
cache reads), the live stream seeds, backtests and the agent tools. Pattern
search reads the sqlite store directly and repairs its own arrays with the
same rules (pattern_series.py); install() hands it the split list.

On top of the pure repair, two things need I/O:

- The previous bar, when a window starts exactly on the bad bar (a scroll-back
  page or a recent(n) can), read from the store.
- An intraday rebuild of a repaired DAY or WEEK bar from its HOUR bars. The
  clamp alone loses the real high of a split day (BKNG: 176.12 clamped vs
  176.825 traded); the hourly bars still hold it. Closed bars only, memoized
  per process, and dropped for the clamp when the hours do not end where the
  bar does.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import datetime, timezone
from typing import Protocol

from auto_trader.core.candle_cache import CandleCache, CandleKey
from auto_trader.core.candle_clean import (
    NO_THRESHOLD_BROKERS,
    Split,
    needs_prev,
    repair_stale_prints,
    suspect_indices,
)
from auto_trader.core.models import Candle, Resolution

log = logging.getLogger(__name__)

_REBUILD_FROM = {Resolution.DAY.value: Resolution.HOUR, Resolution.WEEK.value: Resolution.HOUR}
_REBUILD_CLOSE_TOL = 0.02

FetchFiner = Callable[[CandleKey, str, int, int], Awaitable[list[Candle]]]


class SplitSource(Protocol):
    async def get(self, epic: str) -> list[Split]: ...


def _ts(bar: Candle) -> int:
    return int(bar.time.timestamp())


def make_repair_hook(
    cache: CandleCache,
    splits: SplitSource,
    fetch_finer: FetchFiner,
    *,
    now: Callable[[], float] = time.time,
):
    rebuilt: dict[tuple[CandleKey, int], Candle] = {}
    logged: set[tuple[CandleKey, int]] = set()

    async def rebuild(
        key: CandleKey, res_seconds: int, bar: Candle, before: Candle | None,
        listed: list[Split], allow_threshold: bool,
    ) -> Candle:
        finer = _REBUILD_FROM.get(key[2])
        t = _ts(bar)
        if finer is None or t + res_seconds > now():
            return bar
        memo = rebuilt.get((key, t))
        if memo is not None:
            return memo
        fkey = (key[0], key[1], finer.value, key[3])
        try:
            parts = await fetch_finer(fkey, finer.value, t, t + res_seconds - 1)
        except Exception as e:  # noqa: BLE001 - the clamp is a fine fallback
            log.info("split-day rebuild of %s @%d failed: %s", "/".join(key), t, e)
            return bar
        if not parts or abs(parts[-1].close / bar.close - 1) > _REBUILD_CLOSE_TOL:
            return bar
        # The hours normally arrive repaired (they come back through this hook),
        # but a pass-through window has no stored hour before its first bar to
        # judge it against; the coarse bar's predecessor closes at the same price.
        parts, _ = repair_stale_prints(
            parts, listed, res_seconds=finer.seconds, prev=before,
            allow_threshold=allow_threshold,
        )
        out = replace(
            bar,
            open=parts[0].open,
            high=max(p.high for p in parts),
            low=min(p.low for p in parts),
        )
        rebuilt[(key, t)] = out
        return out

    async def hook(key: CandleKey, res_seconds: int, bars: list[Candle]) -> list[Candle]:
        prev = await cache.bar_before(key, _ts(bars[0])) if needs_prev(bars) else None
        if not suspect_indices(bars, prev):
            return bars
        listed = await splits.get(key[1])
        allow_threshold = key[0] not in NO_THRESHOLD_BROKERS
        out, repairs = repair_stale_prints(
            bars, listed, res_seconds=res_seconds, prev=prev, allow_threshold=allow_threshold,
        )
        for r in repairs:
            before = bars[r.index - 1] if r.index > 0 else prev
            out[r.index] = await rebuild(
                key, res_seconds, r.new, before, listed, allow_threshold
            )
            t = _ts(r.old)
            if (key, t) not in logged:
                logged.add((key, t))
                how = f"split {r.ratio:g}:1" if r.ratio else "threshold"
                log.warning(
                    "repaired stale print %s @%s (%s): open %g -> %g, high %g -> %g, low %g -> %g",
                    "/".join(key),
                    datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d %H:%M"),
                    how, r.old.open, out[r.index].open, r.old.high, out[r.index].high,
                    r.old.low, out[r.index].low,
                )
        return out

    return hook


def install(cache: CandleCache) -> None:
    """Wire the hook to the live brokers and Yahoo's split list, and give
    pattern search (which reads the store directly) the same split list. It
    only peeks: a pattern load must not wait on Yahoo, and the chart that
    shows a split has already fetched it (markers, or this hook)."""
    from auto_trader.brokers.yahoo_splits import SPLITS
    from auto_trader.core.pattern_series import PATTERN_SERIES

    PATTERN_SERIES.set_splits_lookup(lambda epic: SPLITS.peek(epic) or [])

    from . import deps

    async def fetch_finer(fkey: CandleKey, resolution: str, start_ts: int, end_ts: int):
        broker_id, epic, _, side = fkey
        broker = deps.get_data(broker_id)
        res = Resolution(resolution)

        async def fetch_range(s, e):
            return await deps.guarded(
                broker_id, lambda: broker.get_candles(epic, res, s, e, side), "data fetch"
            )

        # max_fill_chunks=1: a split years back must not backfill years of hourly
        # bars just to rebuild one day; this serves the window pass-through.
        return await cache.window(
            fkey, res.seconds,
            datetime.fromtimestamp(start_ts, tz=timezone.utc),
            datetime.fromtimestamp(end_ts, tz=timezone.utc),
            fetch_range, budget_s=5.0, max_fill_chunks=1,
        )

    cache.set_repair(make_repair_hook(cache, SPLITS, fetch_finer))
