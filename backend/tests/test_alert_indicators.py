import asyncio
from datetime import datetime, timezone

import auto_trader.core.alert_indicators as alert_indicators_mod
from auto_trader.core.alert_bars import Sample
from auto_trader.core.alert_indicators import IndicatorHub
from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import IndicatorKey

H = 3_600_000
SMA3 = IndicatorKey("MA", (3,), (("maType", "sma"), ("source", "close")))
SMA5 = IndicatorKey("MA", (5,), (("maType", "sma"), ("source", "close")))
KEY = ("capital", "US100", "HOUR", "mid")


def c(ms, close):
    return Candle(datetime.fromtimestamp(ms / 1000, tz=timezone.utc), close, close, close, close, 1.0)


class FakeLoader:
    def __init__(self, bars):
        self.bars = bars
        self.calls = []
        self.degraded = False

    async def __call__(self, broker, epic, res, side, count):
        self.calls.append(count)
        return [b for b in self.bars][-count:], self.degraded


def make(bars, now):
    loader = FakeLoader(bars)
    t = [0.0]
    hub = IndicatorHub(loader, clock=lambda: t[0], now_ms=lambda: now[0])
    return hub, loader, t


def test_seed_then_values_ready():
    async def main():
        now = [10 * H + 5]
        hub, loader, _ = make([c(i * H, float(i)) for i in range(5, 11)], now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        assert loader.calls[0] == 3 + 50  # warmup + margin
        assert hub.values(KEY, SMA3, intrabar=False) == {"value": (7 + 8 + 9) / 3}
        assert hub.ready(KEY, SMA3)
    asyncio.run(main())


def test_first_seed_does_not_block_on_sample():
    # F17: the first seed for a brand-new series can fetch up to SEED_CAP
    # bars (mt5's own budget allows up to ~90s) - on_sample must return
    # immediately regardless, so price alerts on the same feed never wait on
    # it. A loader that hangs until released proves on_sample didn't await it.
    async def main():
        now = [10 * H + 5]
        gate = asyncio.Event()

        class SlowLoader:
            async def __call__(self, broker, epic, res, side, count):
                await gate.wait()
                return [c(i * H, float(i)) for i in range(5, 11)], False

        hub = IndicatorHub(SlowLoader(), clock=lambda: 0.0, now_ms=lambda: now[0])
        hub.set_needs({KEY: {SMA3}})
        await asyncio.wait_for(
            hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None)), timeout=0.5,
        )
        assert not hub.ready(KEY, SMA3)  # the gated loader hasn't returned yet
        gate.set()
        await asyncio.sleep(0)
        assert hub.ready(KEY, SMA3)
    asyncio.run(main())


def test_not_ready_below_warmup():
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(9 * H, 9.0)], now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run, so
        # this actually exercises "below warmup" rather than "seed hasn't run yet"
        assert hub.values(KEY, SMA3, intrabar=False) is None
        assert not hub.ready(KEY, SMA3)
    asyncio.run(main())


def test_bar_close_refreshes_tail_and_reports_closed():
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        loader.bars = bars + [c(11 * H, 11.0)]
        now[0] = 11 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 11.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 10.0
        assert hub.values(KEY, SMA3, intrabar=False) == {"value": (8 + 9 + 10) / 3}
        assert hub.prev_closed(KEY).close == 9.0
        assert hub.prev_values(KEY, SMA3) == {"value": (7 + 8 + 9) / 3}
    asyncio.run(main())


def test_close_refresh_degraded_holds_previous_close():
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        loader.degraded = True
        now[0] = 11 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 11.0, None, None))
        assert closed == set()
        assert not hub.ready(KEY, SMA3)
        assert hub.last_closed(KEY).close == 9.0  # never a sample-built bar
    asyncio.run(main())


def test_intrabar_values_include_forming_and_throttle():
    async def main():
        now = [10 * H + 5]
        hub, _, t = make([c(i * H, float(i)) for i in range(5, 10)], now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 12.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        assert hub.values(KEY, SMA3, intrabar=True) == {"value": (8 + 9 + 12) / 3}
        await hub.on_sample("capital", "US100", Sample(now[0] + 1, 15.0, None, None))
        assert hub.values(KEY, SMA3, intrabar=True) == {"value": (8 + 9 + 12) / 3}  # throttled
        t[0] = 1.5
        assert hub.values(KEY, SMA3, intrabar=True) == {"value": (8 + 9 + 15) / 3}
    asyncio.run(main())


def test_set_needs_drops_unused_series():
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(i * H, float(i)) for i in range(5, 10)], now)
        hub.set_needs({KEY: {SMA3}})
        assert hub.has_feed("capital", "US100")
        hub.set_needs({})
        assert not hub.has_feed("capital", "US100")
    asyncio.run(main())


def test_set_needs_cancels_an_in_flight_seed_task():
    # F17's background seed must not keep running (or keep a reference
    # alive) once the series it was seeding has been dropped.
    async def main():
        now = [10 * H + 5]
        gate = asyncio.Event()

        class SlowLoader:
            async def __call__(self, broker, epic, res, side, count):
                await gate.wait()
                return [c(i * H, float(i)) for i in range(5, 11)], False

        hub = IndicatorHub(SlowLoader(), clock=lambda: 0.0, now_ms=lambda: now[0])
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        assert KEY in hub._seed_tasks
        task = hub._seed_tasks[KEY]
        hub.set_needs({})
        await asyncio.sleep(0)
        assert task.cancelled()
        assert KEY not in hub._seed_tasks
    asyncio.run(main())


def test_first_seed_retry_is_gated_not_spammed_on_every_sample():
    # A failing/degraded loader must not get a fresh SEED_CAP fetch on every
    # single sample while the clock stands still - that's a retry storm, not
    # a retry schedule.
    async def main():
        now = [10 * H + 5]

        class FailingLoader:
            def __init__(self):
                self.calls = 0

            async def __call__(self, broker, epic, res, side, count):
                self.calls += 1
                return [], True  # always degraded

        loader = FailingLoader()
        t = [0.0]
        hub = IndicatorHub(loader, clock=lambda: t[0], now_ms=lambda: now[0])
        hub.set_needs({KEY: {SMA3}})
        for _ in range(10):
            await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
            await asyncio.sleep(0)  # let each background attempt finish before the next sample
        assert loader.calls == 1  # frozen clock: no retry is due yet
        t[0] = 5.0  # past _RETRY_SECONDS
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)
        assert loader.calls == 2
    asyncio.run(main())


def test_growth_reseed_still_reports_a_close_on_the_current_series():
    # Adding an indicator that needs more warm-up than the series currently
    # has must not swallow a close that lands while the growth reseed is in
    # flight: the CLOSED refresh keeps running against the already-good
    # current series, independent of the backgrounded growth fetch.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the first seed (F17) run...
        await asyncio.sleep(0)  # ...and its done-callback clear the task slot
        assert hub.ready(KEY, SMA3)

        hub.set_needs({KEY: {SMA3, SMA5}})  # warm-up grows from 3 to 5

        loader.bars = bars + [c(11 * H, 11.0)]
        now[0] = 11 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 11.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 10.0

        await asyncio.sleep(0)  # let the backgrounded growth reseed land
        assert hub.ready(KEY, SMA5)
        assert 55 in loader.calls  # the growth fetch (warm-up 5 + margin) actually ran
        assert hub._states[KEY].seeded_for == 5
    asyncio.run(main())


def test_growth_reseed_failure_keeps_series_ok_and_reports_close():
    # A growth reseed's fetch can fail (e.g. a transient broker error)
    # without taking the whole series offline: it already has valid closed
    # bars for its EXISTING needs, so a close in that window must still be
    # reported, and ready() must stay true for the indicator it was already
    # ready for - the failure only concerns the NEW, bigger warm-up target.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]

        class GrowthFailLoader:
            def __init__(self, bars):
                self.bars = bars
                self.fail_seed_fetches = False  # flips on once SMA3 is seeded

            async def __call__(self, broker, epic, res, side, count):
                if self.fail_seed_fetches and count > 5:  # the growth fetch, not the tail refresh
                    raise RuntimeError("growth fetch failed")
                return [b for b in self.bars][-count:], False

        loader = GrowthFailLoader(bars)
        t = [0.0]
        hub = IndicatorHub(loader, clock=lambda: t[0], now_ms=lambda: now[0])
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the first seed (F17) run...
        await asyncio.sleep(0)  # ...and its done-callback clear the task slot
        assert hub.ready(KEY, SMA3)

        hub.set_needs({KEY: {SMA3, SMA5}})  # warm-up grows from 3 to 5
        loader.fail_seed_fetches = True       # ...and that growth fetch will fail

        # A sample with no roll at all (still inside the 10h-11h bar): this
        # only spawns the growth reseed, with nothing else to report. Lets
        # the growth failure happen and land on its own, BEFORE any close.
        closed = await hub.on_sample("capital", "US100", Sample(now[0] + 1, 10.5, None, None))
        await asyncio.sleep(0)  # let the failing background growth reseed run and fail
        assert closed == set()
        assert hub.ready(KEY, SMA3)  # the existing need survives the growth failure

        # NOW land a close, strictly after the growth failure happened.
        loader.bars = bars + [c(11 * H, 11.0)]
        now[0] = 11 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 11.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 10.0
        assert hub.ready(KEY, SMA3)
    asyncio.run(main())


def test_growth_reseed_skips_a_stale_fetch_that_lands_after_a_fresher_refresh():
    # A slow growth seed's fetch can land AFTER a faster inline close
    # refresh already moved the tail forward. Applying the slow fetch
    # wholesale would walk last_closed backwards and undo that refresh, so
    # a fetch whose last bar is older than the current tail must be
    # skipped rather than applied.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        gate = asyncio.Event()

        class SlowGrowthLoader:
            def __init__(self, bars):
                self.bars = bars
                self.slow = False

            async def __call__(self, broker, epic, res, side, count):
                if self.slow and count > 5:  # only the growth fetch is slow
                    await gate.wait()
                    # Stale: snapshotted before the 10h bar closed, so it
                    # only ever returns up through 9h.
                    return [c(i * H, float(i)) for i in range(5, 10)], False
                return [b for b in self.bars][-count:], False

        loader = SlowGrowthLoader(bars)
        t = [0.0]
        hub = IndicatorHub(loader, clock=lambda: t[0], now_ms=lambda: now[0])
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the first seed (F17) run...
        await asyncio.sleep(0)  # ...and its done-callback clear the task slot
        assert hub.ready(KEY, SMA3)

        hub.set_needs({KEY: {SMA3, SMA5}})  # warm-up grows from 3 to 5
        loader.slow = True                    # the growth fetch will now hang on `gate`

        loader.bars = bars + [c(11 * H, 11.0)]
        now[0] = 11 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 11.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 10.0  # the inline refresh moved the tail to 10h

        gate.set()  # release the slow growth fetch now, with its stale (9h) data
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert hub.last_closed(KEY).close == 10.0  # must not have gone backwards to 9h
        assert hub.ready(KEY, SMA3)
        assert hub._states[KEY].seeded_for == 3  # the stale fetch was skipped, not applied
    asyncio.run(main())


def test_gap_reseed_failure_marks_series_not_ready_and_recovers_on_retry():
    # _seed is shared by the backgrounded GROWTH path (which must NOT knock
    # an already-ok series offline on failure, per
    # test_growth_reseed_failure_keeps_series_ok_and_reports_close) and the
    # inline Roll.GAP reseed of an already-warm series. Those are different:
    # a failed GAP reseed leaves the tail missing every bar across the gap,
    # so the series must go not-ready immediately (matching this module's
    # own "a degraded or failed refresh ... marks the series not ready"
    # contract) rather than staying "ok" over a hole, and it must recover
    # once a later sample retries successfully.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, t = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the first seed (F17) run...
        await asyncio.sleep(0)  # ...and its done-callback clear the task slot
        assert hub.ready(KEY, SMA3)

        loader.degraded = True  # the GAP reseed's fetch will fail
        now[0] = 13 * H + 5  # 11h/12h never sampled -> Roll.GAP
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        assert closed == set()
        assert not hub.ready(KEY, SMA3)  # offline immediately, not stale-but-"ok"

        loader.degraded = False
        loader.bars = bars + [c(11 * H, 11.0), c(12 * H, 12.0)]
        t[0] = 10.0  # past _RETRY_SECONDS
        now[0] = 13 * H + 100  # same bar period as the failed GAP: no new roll, just a retry
        await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        assert hub.ready(KEY, SMA3)  # recovered once the retry landed
    asyncio.run(main())


def test_cancelled_old_seed_task_does_not_evict_a_newer_one_for_the_same_key():
    # set_needs cancels a dropped key's in-flight task but cannot wait for
    # the cancellation to land. If the SAME key comes back before it does,
    # a NEW task is spawned under it; the old task's done-callback must not
    # evict the new task's dict entry when it finally fires.
    async def main():
        now = [10 * H + 5]
        gate = asyncio.Event()

        class SlowLoader:
            async def __call__(self, broker, epic, res, side, count):
                await gate.wait()
                return [c(i * H, float(i)) for i in range(5, 11)], False

        hub = IndicatorHub(SlowLoader(), clock=lambda: 0.0, now_ms=lambda: now[0])
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        old_task = hub._seed_tasks[KEY]

        hub.set_needs({})               # drops KEY, cancels old_task (not yet landed)
        hub.set_needs({KEY: {SMA3}})     # KEY comes right back
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))  # spawns a NEW task
        new_task = hub._seed_tasks[KEY]
        assert new_task is not old_task

        try:
            await old_task
        except asyncio.CancelledError:
            pass
        assert old_task.cancelled()
        assert hub._seed_tasks.get(KEY) is new_task  # not evicted by the stale callback

        gate.set()
        await asyncio.sleep(0)
    asyncio.run(main())


def test_gap_reseed_closes_the_bar_that_just_closed():
    # A skipped period (Roll.GAP, e.g. a thin 1m market) still has to report
    # the bar that closed just before the gap as closed, once the reseed's
    # fresh history actually contains it - else close-mode alerts silently
    # never evaluate that bar.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]  # ...9h,10h closed-ish
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        # Skip straight to 13h: 11h and 12h never got a sample (Roll.GAP).
        # The fresh history already has the 12h bar closed by the time the
        # reseed's loader call lands.
        loader.bars = bars + [c(11 * H, 11.0), c(12 * H, 12.0)]
        now[0] = 13 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 12.0
    asyncio.run(main())


def test_gap_reseed_over_market_closure_reports_closed():
    # The commonest gap is a market closure with NO bars inside it at all
    # (e.g. a DAY series over a weekend): the reseed's freshest bar is
    # exactly the one that was forming right before the gap, not anything
    # newer than it. That bar still closed during the gap and must be
    # reported, so the GAP check uses >= (not >) against prev_open_ms.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        # loader.bars unchanged: no new bars appeared over the gap, but
        # enough wall-clock time has passed for the 10h bar to be closed now.
        now[0] = 13 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 10.0
    asyncio.run(main())


def test_gap_reseed_without_the_closing_bar_reports_not_closed():
    # Same gap, but the reseed's fresh history is genuinely stale - stuck
    # BEFORE the bar that was forming right before the gap (prev_open_ms),
    # not merely equal to it: closed must stay empty rather than firing a
    # close-mode alert against the wrong bar.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        loader.bars = bars[:-1]  # stale: the fetch hasn't even reached 10h yet
        now[0] = 13 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        assert closed == set()
    asyncio.run(main())


def test_compute_exception_marks_not_ok_instead_of_crashing(monkeypatch):
    # A broken indicator computation (e.g. a pathological config that makes
    # the batch function raise) must not escape _recompute: that would blow
    # up on_tick and stall the whole feed, taking every OTHER alert on this
    # (broker, epic) down with it.
    def boom(ind, bars):
        raise ValueError("boom")

    monkeypatch.setattr(alert_indicators_mod, "compute", boom)

    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(i * H, float(i)) for i in range(5, 11)], now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        assert not hub.ready(KEY, SMA3)
        assert hub.values(KEY, SMA3, intrabar=False) is None
    asyncio.run(main())


def test_set_needs_adding_an_indicator_to_a_warm_series_is_ready_at_once():
    # I1: a key added to an already-ok series's needs (and covered by its
    # current warm-up) must get closed values right away, not only after the
    # next bar close refreshes the tail.
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(i * H, float(i)) for i in range(0, 11)], now)
        hub.set_needs({KEY: {SMA5}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert hub.ready(KEY, SMA5)

        hub.set_needs({KEY: {SMA3}})  # mid-bar switch, warm-up shrinks
        for i in range(10):
            await hub.on_sample("capital", "US100", Sample(now[0] + i, 10.0, None, None))
        assert hub.ready(KEY, SMA3)
        assert hub.values(KEY, SMA3, intrabar=False) == {"value": (7 + 8 + 9) / 3}
    asyncio.run(main())


def test_close_detection_is_broker_offset_safe():
    # I6: some brokers open their 4H bars at 01:00/05:00/... rather than on our
    # UTC grid (00:00/04:00/...), the same case test_alert_bars.py's
    # test_keep_closed_is_broker_offset_safe covers one level down. A refresh
    # must accept the broker's own newly closed bar instead of demanding the
    # grid's timestamp, or the series goes offline for good after one roll.
    async def main():
        key4 = ("capital", "US100", "HOUR_4", "mid")
        opens = [1 + 4 * i for i in range(6)]  # 01, 05, 09, 13, 17, 21
        bars = [c(o * H, float(o)) for o in opens]
        now = [14 * H + 30 * 60_000]  # 14:30: the 13:00 bar is still forming
        hub, loader, t = make(bars[:4], now)
        hub.set_needs({key4: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert hub.ready(key4, SMA3)
        assert hub.last_closed(key4).close == 9.0

        for closing, nxt in ((13, 17), (17, 21)):
            # Our grid rolls an hour before the broker's bar closes: nothing
            # new has closed at the broker yet, so nothing is reported.
            now[0] = (closing + 3) * H + 5
            assert await hub.on_sample("capital", "US100", Sample(now[0], 1.0, None, None)) == set()
            # The broker's bar closes; the pending refresh retries and lands it.
            loader.bars = [b for b in bars if b.time.timestamp() * 1000 <= nxt * H]
            now[0] = nxt * H + 5
            t[0] += 10
            closed = await hub.on_sample("capital", "US100", Sample(now[0], 1.0, None, None))
            assert closed == {key4}
            assert hub.last_closed(key4).close == float(closing)
            assert hub.ready(key4, SMA3)
            assert hub.values(key4, SMA3, intrabar=False) == {"value": (closing - 8 + closing - 4 + closing) / 3}
    asyncio.run(main())


def test_gap_close_detection_is_broker_offset_safe():
    # I6, GAP side: bars opening an hour BEFORE our grid (03:00/07:00 against
    # 04:00/08:00). The market closes after the 07:00 bar; after the gap the
    # reseed's newest bar is that 07:00 bar, which is earlier than our grid's
    # forming-bar open (08:00) yet is exactly the bar that closed across it.
    async def main():
        key4 = ("capital", "US100", "HOUR_4", "mid")
        bars = [c(o * H, float(o)) for o in (-5, -1, 3, 7)]  # 19:00, 23:00, 03:00, 07:00
        now = [8 * H + 30 * 60_000]  # 08:30: the 07:00 bar is forming
        hub, loader, t = make(bars, now)
        hub.set_needs({key4: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 7.0, None, None))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert hub.last_closed(key4).close == 3.0
        now[0] = 20 * H + 30 * 60_000  # well past the closure: our grid skipped 12:00 and 16:00
        t[0] += 10
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 7.0, None, None))
        assert closed == {key4}
        assert hub.last_closed(key4).close == 7.0
    asyncio.run(main())
