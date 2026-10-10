"""Indicator values for alerts, per (broker, epic, timeframe, price side).

Closed bars only ever come from the injected loader (the app wires it to
CANDLE_CACHE.recent, the path the charts read), so the server sees the bars
the chart sees. A degraded or failed refresh leaves the previous close in
place and marks the series not ready; no alert evaluates a closed bar built
from live samples. Values are the existing batch functions (via
indicators.alertable.compute); intrabar recomputes with the forming bar
appended, at most once a second per (series, indicator).
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from auto_trader.core.alert_bars import BarSeries, Roll, Sample, candle_ms
from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import SEED_CAP, IndicatorKey, compute, warmup

log = logging.getLogger(__name__)

SeriesKey = tuple[str, str, str, str]
Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]

_TAIL = 5
_RETRY_SECONDS = 5.0
_INTRABAR_SECONDS = 1.0


def _at(values: dict[str, list[float | None]], back: int) -> dict[str, float | None]:
    return {line: (series[-1 - back] if len(series) > back else None) for line, series in values.items()}


def _last(values: dict[str, list[float | None]]) -> dict[str, float | None]:
    return _at(values, 0)


@dataclass
class _State:
    series: BarSeries
    needs: set[IndicatorKey] = field(default_factory=set)
    seeded_for: int = 0          # warm-up the current seed covers
    seed_attempted_for: int = -1  # warm-up target the last seed attempt (success or fail) targeted
    ok: bool = False             # last load/refresh succeeded
    pending_close: bool = False  # a close whose refresh failed, retry pending
    last_try: float = -1e9
    logged_failure: bool = False  # a load failure was already logged; quiet until it next succeeds
    closed_vals: dict[IndicatorKey, dict[str, float | None]] = field(default_factory=dict)
    prev_vals: dict[IndicatorKey, dict[str, float | None]] = field(default_factory=dict)
    intrabar: dict[IndicatorKey, tuple[float, dict[str, float | None]]] = field(default_factory=dict)


class IndicatorHub:
    def __init__(
        self,
        loader: Loader,
        clock: Callable[[], float] = time.monotonic,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        self._loader = loader
        self._clock = clock
        self._now_ms = now_ms
        self._states: dict[SeriesKey, _State] = {}
        self._seed_tasks: dict[SeriesKey, asyncio.Task] = {}  # keys with a background seed in flight

    # ---- registry ----

    def set_needs(self, needs: dict[SeriesKey, set[IndicatorKey]]) -> None:
        for key in list(self._states):
            if key not in needs:
                task = self._seed_tasks.pop(key, None)
                if task is not None:
                    task.cancel()
                del self._states[key]
        for key, inds in needs.items():
            st = self._states.get(key)
            if st is None:
                st = self._states[key] = _State(BarSeries(key[2], key[3], cap=SEED_CAP))
            st.needs = set(inds)
            st.closed_vals = {k: v for k, v in st.closed_vals.items() if k in inds}
            st.intrabar = {k: v for k, v in st.intrabar.items() if k in inds}
            if st.ok and any(k not in st.closed_vals for k in st.needs):
                # A newly needed indicator on an already-warm series: its
                # closed values come from the bars we already hold (cheap),
                # so it is ready now rather than at the next bar close. If
                # the current history is too short for it, ready() still
                # says no and the growth reseed in on_sample covers it.
                self._recompute(key, st)

    def has_feed(self, broker: str, epic: str) -> bool:
        return any(k[0] == broker and k[1] == epic for k in self._states)

    def _warmup(self, st: _State) -> int:
        return max((warmup(k) for k in st.needs), default=0)

    # ---- loading ----

    async def _load(self, key: SeriesKey, st: _State, count: int) -> list[Candle] | None:
        try:
            bars, degraded = await self._loader(key[0], key[1], key[2], key[3], count)
        except Exception:
            if not st.logged_failure:
                log.warning("alert bars: load failed for %s", key, exc_info=True)
                st.logged_failure = True
            return None
        if degraded or not bars:
            if not st.logged_failure:
                log.warning("alert bars: load degraded or empty for %s", key)
                st.logged_failure = True
            return None
        st.logged_failure = False
        return bars

    async def _seed(self, key: SeriesKey, st: _State, *, growth: bool = False) -> None:
        need = self._warmup(st)
        st.seed_attempted_for = need
        bars = await self._load(key, st, min(need + 50, SEED_CAP))
        st.last_try = self._clock()
        if bars is None:
            if not growth:
                # `growth=True` is ONLY the backgrounded reseed of an
                # already-ok series picking up a bigger warm-up target
                # (set_needs grew `st.needs`) - that failure only concerns
                # the NEW target, so it must not knock an already-working
                # series offline and drop closes/ready() for needs it was
                # already serving fine. Every other caller - the brand-new
                # first seed (already offline, so this is a no-op) AND the
                # inline GAP/retry reseed of an already-warm series - must
                # still go offline on failure: a failed GAP reseed in
                # particular leaves the tail missing every bar across the
                # gap, so `ready()` must say no until a later retry lands,
                # per this module's own degraded-refresh contract.
                st.ok = False
            return
        fresh = st.series.keep_closed(bars, self._now_ms())
        if (
            fresh and st.series.closed
            and candle_ms(st.series.closed[-1]) > candle_ms(fresh[-1])
        ):
            # A slower fetch (a growth reseed, or a retried one) landing
            # after a faster inline `_refresh` already moved the tail
            # forward: applying it wholesale via `BarSeries.seed` (which
            # REPLACES `closed` outright) would walk `last_closed` backwards
            # and silently undo that refresh. Skip it and leave
            # `seeded_for`/`seed_attempted_for` alone - `_should_spawn_seed`
            # retries the same target on a later sample, hopefully with
            # fresher data next time.
            return
        st.series.seed(bars, self._now_ms())
        st.seeded_for = need
        st.pending_close = False
        self._recompute(key, st)

    def _should_spawn_seed(self, key: SeriesKey, st: _State, target: int) -> bool:
        if key in self._seed_tasks:
            return False
        if st.seed_attempted_for != target:
            # A fresh target (a brand-new series, or a warm-up that just
            # grew past what the last attempt covered): always worth trying
            # right away, regardless of how recently the OLD target was
            # last attempted.
            return True
        # Same target as the last attempt: only a failing/degraded loader
        # lands here repeatedly, so gate on the retry interval - otherwise a
        # stuck loader gets a SEED_CAP fetch on every single sample.
        return self._clock() - st.last_try >= _RETRY_SECONDS

    def _spawn_first_seed(self, key: SeriesKey, st: _State, *, growth: bool) -> None:
        """A brand-new (or just-grown) series's first seed can fetch up to
        SEED_CAP bars (mt5's own fetch budget allows up to ~90s) - run it in
        the background so `on_sample`/`on_tick` never blocks on it. Price
        alerts share the same `on_tick` call for this (broker, epic), so a
        synchronous cold fetch here would stall them too. Idempotent per key
        (callers gate on `_should_spawn_seed`, which checks both "already in
        flight" and the retry interval, so a failing loader doesn't refetch
        SEED_CAP bars on every single sample). Subsequent reseeds (a GAP, or
        a retry after a failed refresh) are on an already-warm series and
        stay inline - see `on_sample` below. The task is tracked so
        `set_needs` can cancel it if the key is dropped mid-flight, and any
        exception it raises is logged instead of vanishing silently.
        `growth` must be True only when `st.ok` is already True (a warm-up
        GROWTH on an already-working series) - see `_seed`'s `growth` note."""
        task = asyncio.ensure_future(self._seed(key, st, growth=growth))
        self._seed_tasks[key] = task

        def _done(t: asyncio.Task, key: SeriesKey = key) -> None:
            # Identity-checked: set_needs cancels a dropped key's task but
            # can't wait for the cancellation to land, so if the SAME key
            # comes back before it does, a NEW task is already registered
            # under this key by the time the OLD task's callback fires.
            # Popping unconditionally would evict that newer task's entry.
            if self._seed_tasks.get(key) is t:
                del self._seed_tasks[key]
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None:
                log.warning("alert indicator background seed failed for %s", key, exc_info=exc)

        task.add_done_callback(_done)

    async def _refresh(self, key: SeriesKey, st: _State) -> bool:
        bars = await self._load(key, st, _TAIL)
        st.last_try = self._clock()
        if bars is None:
            st.ok, st.pending_close = False, True
            return False
        fresh = st.series.keep_closed(bars, self._now_ms())
        have = st.series.closed
        if not fresh or (have and candle_ms(fresh[-1]) <= candle_ms(have[-1])):
            # No closed bar newer than the one we already hold: either the
            # cache served a stale tail (candle_cache.py can absorb/budget a
            # stale read without flagging `degraded`), or the broker's bar
            # has not closed yet because its bars sit off our UTC grid (a 4H
            # bar opening 01:00 closes an hour after our grid rolls). Compared
            # against our OWN last closed bar, never a grid timestamp, so an
            # offset broker still lands its close (keep_closed's same rule).
            # Hold the previous close rather than let close-mode re-evaluate
            # the same bar twice; retry on the next sample past the retry
            # interval.
            st.ok, st.pending_close = False, True
            return False
        st.series.replace_tail(bars, self._now_ms())
        st.ok, st.pending_close = True, False
        self._recompute(key, st)
        return st.ok  # _recompute may have flipped this back to False

    def _recompute(self, key: SeriesKey, st: _State) -> None:
        bars = st.series.closed
        closed_vals: dict[IndicatorKey, dict[str, float | None]] = {}
        prev_vals: dict[IndicatorKey, dict[str, float | None]] = {}
        try:
            for ind in st.needs:
                out = compute(ind, bars)
                closed_vals[ind], prev_vals[ind] = _at(out, 0), _at(out, 1)
        except Exception:
            # A broken compute must not escape to on_sample/on_tick: that
            # would back off the whole feed and stall every OTHER alert on
            # this (broker, epic), not just this one.
            log.warning("alert indicator compute failed for series %s", key, exc_info=True)
            st.ok = False
            return
        st.closed_vals, st.prev_vals = closed_vals, prev_vals
        st.ok = True
        st.intrabar = {}

    # ---- samples ----

    async def on_sample(self, broker: str, epic: str, s: Sample) -> set[SeriesKey]:
        closed: set[SeriesKey] = set()
        for key, st in list(self._states.items()):
            if key[0] != broker or key[1] != epic:
                continue
            roll = st.series.on_sample(s)
            retry_due = self._clock() - st.last_try >= _RETRY_SECONDS

            target = self._warmup(st)
            needs_seed = st.seeded_for < target
            if needs_seed and not st.ok:
                # Never warmed up at all: the ONE path that can be a
                # genuinely cold, unbounded-latency fetch (F17).
                # Backgrounded - never awaited from on_sample - and there is
                # nothing usable to refresh/close against yet, so skip the
                # rest of this series's handling until the seed lands.
                if self._should_spawn_seed(key, st, target):
                    self._spawn_first_seed(key, st, growth=False)
                continue
            if needs_seed and st.ok:
                # Growing an already-working series's warm-up (a newly added
                # indicator needing more history): kick the same backgrounded
                # reseed, but keep tracking GAP/CLOSE on the CURRENT series in
                # the meantime - otherwise a close that lands while the
                # growth reseed is in flight would be silently dropped (the
                # series looks "busy seeding" even though it has perfectly
                # good closed bars to refresh right now). `growth=True`: a
                # failed fetch here must not knock this already-ok series
                # offline (see `_seed`).
                if self._should_spawn_seed(key, st, target):
                    self._spawn_first_seed(key, st, growth=True)

            if roll is Roll.GAP or (not st.ok and not st.pending_close and retry_due):
                # A reseed of an ALREADY-warm series (GAP, or a retry after a
                # failed refresh): bounded the same way a refresh is in
                # practice, and GAP needs this awaited inline so the
                # closed-bar check below can run in the SAME call.
                had = candle_ms(st.series.closed[-1]) if st.series.closed else None
                await self._seed(key, st)
                if (
                    roll is Roll.GAP and st.ok and st.series.closed
                    and (had is None or candle_ms(st.series.closed[-1]) > had)
                ):
                    # The reseed brought a closed bar newer than the one we
                    # held before the gap, so a bar closed across it. For the
                    # commonest gap, a market closure with no bars inside it,
                    # that newest bar is the one that was forming right
                    # before the gap, and it still needs to be reported.
                    # Compared against our own previous tail, never the grid
                    # timestamp of the forming bar, so brokers whose bars sit
                    # off our UTC grid (FX dailies opening 22:00) still
                    # report; `_refresh` uses the same rule.
                    closed.add(key)
            elif roll is Roll.CLOSED or (st.pending_close and retry_due):
                if await self._refresh(key, st):
                    closed.add(key)
        return closed

    # ---- reads ----

    def ready(self, key: SeriesKey, ind: IndicatorKey) -> bool:
        st = self._states.get(key)
        if st is None or not st.ok or len(st.series.closed) < warmup(ind):
            return False
        vals = st.closed_vals.get(ind)
        return vals is not None and all(v is not None for v in vals.values())

    def values(self, key: SeriesKey, ind: IndicatorKey, intrabar: bool) -> dict[str, float | None] | None:
        if not self.ready(key, ind):
            return None
        st = self._states[key]
        if not intrabar:
            return st.closed_vals[ind]
        now = self._clock()
        hit = st.intrabar.get(ind)
        if hit is not None and now - hit[0] < _INTRABAR_SECONDS:
            return hit[1]
        try:
            vals = _last(compute(ind, st.series.with_forming()))
        except Exception:
            # Same guard as _recompute: never let a forming-bar compute
            # exception escape into on_tick. Fall back to the last closed
            # value rather than crash; the close-mode state (st.ok) is
            # unaffected, since the closed bars themselves are still fine.
            log.warning("alert indicator intrabar compute failed for series %s", key, exc_info=True)
            return st.closed_vals.get(ind)
        st.intrabar[ind] = (now, vals)
        return vals

    def prev_values(self, key: SeriesKey, ind: IndicatorKey) -> dict[str, float | None] | None:
        if not self.ready(key, ind):
            return None
        return self._states[key].prev_vals.get(ind)

    def last_closed(self, key: SeriesKey) -> Candle | None:
        st = self._states.get(key)
        return st.series.closed[-1] if st and st.series.closed else None

    def prev_closed(self, key: SeriesKey) -> Candle | None:
        st = self._states.get(key)
        return st.series.closed[-2] if st and len(st.series.closed) >= 2 else None

    def forming_open_ms(self, key: SeriesKey) -> int | None:
        st = self._states.get(key)
        return st.series.forming_open_ms if st else None
