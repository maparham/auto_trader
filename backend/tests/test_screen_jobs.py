import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.api.screen_jobs import JobBusy, ScreenJobs
from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import compile_screen

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
NOW = (T0 + timedelta(days=400)).timestamp()  # every fake bar is closed


def _bars(closes):
    return [Candle(time=T0 + timedelta(days=k), open=c, high=c, low=c, close=c, volume=1.0)
            for k, c in enumerate(closes)]


def _loader(table, calls=None, gate=None):
    async def load(broker, epic, resolution, side, count):
        if calls is not None:
            calls.append((broker, epic, count))
        if gate is not None:
            await gate.wait()
        v = table[epic]
        if isinstance(v, Exception):
            raise v
        return v, False
    return load


async def _finish(jobs, user, jid):
    for _ in range(200):
        st = jobs.status(user, jid)
        if st["status"] != "running":
            return st
        await asyncio.sleep(0.01)
    raise AssertionError("job did not finish")


def _start(jobs, symbols, expr="candle.close > 10", user="u1"):
    return jobs.start(user, broker="yfinance", resolution="DAY", side="mid",
                      symbols=symbols, cs=compile_screen(expr, []))


def test_matches_and_stats():
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": _bars([5, 11]), "B": _bars([5, 5])}), clock=lambda: NOW)
        st = await _finish(jobs, "u1", _start(jobs, ["A", "B"]))
        assert st["status"] == "done" and st["done"] == st["total"] == 2
        assert [m["epic"] for m in st["result"]["matches"]] == ["A"]
        assert st["result"]["stats"]["matched"] == 1
    asyncio.run(run())


def test_one_symbol_error_does_not_fail_run():
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": RuntimeError("broker down"), "B": _bars([5, 11])}), clock=lambda: NOW)
        st = await _finish(jobs, "u1", _start(jobs, ["A", "B"]))
        assert [m["epic"] for m in st["result"]["matches"]] == ["B"]
        assert st["result"]["skipped"] == [{"epic": "A", "reason": "broker down"}]
    asyncio.run(run())


def test_degraded_and_empty_are_skipped():
    async def run():
        async def load(broker, epic, res, side, count):
            return (_bars([11]), True) if epic == "D" else ([], False)
        jobs = ScreenJobs(loader=load, clock=lambda: NOW)
        st = await _finish(jobs, "u1", _start(jobs, ["D", "E"]))
        reasons = {s["epic"]: s["reason"] for s in st["result"]["skipped"]}
        assert reasons == {"D": "broker unavailable, cached bars only", "E": "no candles"}
    asyncio.run(run())


def test_one_run_per_user():
    async def run():
        gate = asyncio.Event()
        jobs = ScreenJobs(loader=_loader({"A": _bars([11])}, gate=gate), clock=lambda: NOW)
        jid = _start(jobs, ["A"])
        with pytest.raises(JobBusy):
            _start(jobs, ["A"])
        other = _start(jobs, ["A"], user="u2")  # another user is not blocked
        gate.set()
        await _finish(jobs, "u1", jid)
        await _finish(jobs, "u2", other)
        _start(jobs, ["A"])  # free again after finishing
    asyncio.run(run())


def test_per_broker_cap():
    async def run():
        active = 0
        peak = 0

        async def load(broker, epic, res, side, count):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return _bars([11]), False
        jobs = ScreenJobs(loader=load, per_broker=2, clock=lambda: NOW)
        await _finish(jobs, "u1", _start(jobs, [f"S{i}" for i in range(8)]))
        assert peak == 2
    asyncio.run(run())


def test_cancel_and_foreign_user():
    async def run():
        gate = asyncio.Event()
        jobs = ScreenJobs(loader=_loader({"A": _bars([11])}, gate=gate), clock=lambda: NOW)
        jid = _start(jobs, ["A"])
        assert jobs.status("u2", jid) is None and jobs.cancel("u2", jid) is False
        assert jobs.cancel("u1", jid) is True
        st = await _finish(jobs, "u1", jid)
        assert st["status"] == "cancelled"
    asyncio.run(run())


def test_run_error_does_not_lock_out_the_user():
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": _bars([11])}), clock=lambda: NOW)
        jid = jobs.start("u1", broker="yfinance", resolution="BOGUS", side="mid",
                         symbols=["A"], cs=compile_screen("candle.close > 10", []))
        st = await _finish(jobs, "u1", jid)
        assert st["status"] == "error"
        assert st["error"]
        # the failed run must not leave the user permanently "busy"
        _start(jobs, ["A"])
    asyncio.run(run())


def test_asks_for_enough_bars():
    async def run():
        calls = []
        jobs = ScreenJobs(loader=_loader({"A": _bars([1.0] * 300)}, calls=calls), clock=lambda: NOW)
        jid = jobs.start("u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A"],
                         cs=compile_screen("candle.close > EMA(200)", []))
        await _finish(jobs, "u1", jid)
        assert calls[0][2] >= 202  # warm-up + the forming bar it may drop
    asyncio.run(run())


def test_http_exception_reason_drops_status_prefix():
    from fastapi import HTTPException

    async def run():
        jobs = ScreenJobs(loader=_loader({"A": HTTPException(502, "alert bars failed: x")}),
                          clock=lambda: NOW)
        st = await _finish(jobs, "u1", _start(jobs, ["A"]))
        assert st["result"]["skipped"] == [{"epic": "A", "reason": "alert bars failed: x"}]
    asyncio.run(run())


def test_compute_cap_bounds_concurrent_judges(monkeypatch):
    import threading
    import auto_trader.api.screen_jobs as sj
    live, peak, lock = [0], [0], threading.Lock()
    real = sj.judge

    def slow_judge(cs, bars, res, htf=None, also_prev=False, **kwargs):
        with lock:
            live[0] += 1
            peak[0] = max(peak[0], live[0])
        try:
            import time as _t
            _t.sleep(0.02)
            return real(cs, bars, res, htf, also_prev, **kwargs)
        finally:
            with lock:
                live[0] -= 1

    monkeypatch.setattr(sj, "judge", slow_judge)

    async def run():
        table = {f"S{i}": _bars([11.0] * 5) for i in range(8)}
        jobs = ScreenJobs(loader=_loader(table), clock=lambda: NOW, per_compute=2)
        jid = _start(jobs, list(table))
        st = await _finish(jobs, "u1", jid)
        assert st["status"] == "done"
    asyncio.run(run())
    assert peak[0] <= 2


def test_cancel_stops_starting_judges(monkeypatch):
    # Event-gated rather than sleep-timed: the two judges that can start
    # (per_compute=2) block on `release` until this test says go, so there
    # is no wall-clock race between "how many judges started" and "when we
    # cancel" - exactly 2 can ever be in flight before the cancel lands,
    # and nothing else can slip in while cancellation propagates.
    import threading
    import auto_trader.api.screen_jobs as sj
    started: list[int] = []
    release = threading.Event()
    real = sj.judge

    def slow_judge(cs, bars, res, htf=None, also_prev=False, **kwargs):
        started.append(1)
        release.wait(2)
        return real(cs, bars, res, htf, also_prev, **kwargs)

    monkeypatch.setattr(sj, "judge", slow_judge)

    async def run():
        table = {f"S{i}": _bars([11.0] * 5) for i in range(20)}
        jobs = ScreenJobs(loader=_loader(table), clock=lambda: NOW, per_compute=2)
        jid = _start(jobs, list(table))
        for _ in range(200):
            if len(started) >= 2:
                break
            await asyncio.sleep(0.005)
        assert len(started) == 2  # per_compute caps concurrent judges
        assert jobs.cancel("u1", jid)
        release.set()
        await _finish(jobs, "u1", jid)
    asyncio.run(run())
    assert len(started) == 2


# --- pinned timeframes ---------------------------------------------------------

from auto_trader.api.htf_source import HtfNeed  # noqa: E402,F401  (the loader's third argument)

MONDAY = datetime(2026, 1, 5, tzinfo=timezone.utc)


def _days(n, start=MONDAY):
    return [Candle(time=start + timedelta(days=k), open=1, high=1, low=1, close=1, volume=1.0)
            for k in range(n)]


def _weeks(vals, start=MONDAY):
    return [Candle(time=start + timedelta(weeks=k), open=v, high=v, low=v, close=v, volume=1.0)
            for k, v in enumerate(vals)]


def _htf_loader(table, calls=None, degraded=False):
    async def load(broker, epic, need, side, from_ts, to_ts):
        if calls is not None:
            calls.append((epic, need.res, from_ts, to_ts))
        v = table[epic]
        if isinstance(v, Exception):
            raise v
        return v, degraded
    return load


def _pinned(symbols, expr="candle.close@W > 150"):
    return dict(broker="yfinance", resolution="DAY", side="mid", symbols=symbols,
                cs=compile_screen(expr, [], resolution="DAY"))


def test_pinned_series_reaches_the_judge():
    async def run():
        calls = []
        # Day 15 is the third Monday, so week 2 (close 200) has closed before it.
        base = {"A": _days(15), "B": _days(15)}
        wk = {"A": _weeks([100, 200]), "B": _weeks([100, 100])}
        jobs = ScreenJobs(loader=_loader(base), htf_loader=_htf_loader(wk, calls), clock=lambda: NOW)
        st = await _finish(jobs, "u1", jobs.start("u1", **_pinned(["A", "B"])))
        assert [m["epic"] for m in st["result"]["matches"]] == ["A"]
        a = next(c for c in calls if c[0] == "A")
        assert a[1] == "WEEK" and a[2] == int(MONDAY.timestamp()) and a[3] == int(NOW)
    asyncio.run(run())


def test_pinned_shortfall_skips():
    async def run():
        # Weekly bars that open on the judged day and later: none closed before it.
        late = _weeks([100, 200], start=MONDAY + timedelta(days=14))
        jobs = ScreenJobs(loader=_loader({"A": _days(15)}), htf_loader=_htf_loader({"A": late}), clock=lambda: NOW)
        st = await _finish(jobs, "u1", jobs.start("u1", **_pinned(["A"])))
        assert st["result"]["skipped"] == [{"epic": "A", "reason": "not enough @W history"}]
    asyncio.run(run())


def test_pinned_degraded_and_error_skip():
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": _days(15), "B": _days(15)}),
                          htf_loader=_htf_loader({"A": _weeks([100, 200]), "B": RuntimeError("boom")}, degraded=True),
                          clock=lambda: NOW)
        st = await _finish(jobs, "u1", jobs.start("u1", **_pinned(["A", "B"])))
        reasons = {s["epic"]: s["reason"] for s in st["result"]["skipped"]}
        assert reasons == {"A": "broker unavailable, cached bars only", "B": "boom"}
    asyncio.run(run())


def test_pinned_fetch_takes_the_broker_cap():
    async def run():
        gate = asyncio.Event()
        held = []

        async def base(broker, epic, resolution, side, count):
            return _days(15), False

        async def htf(broker, epic, need, side, from_ts, to_ts):
            held.append(epic)
            await gate.wait()
            return _weeks([100, 200]), False

        jobs = ScreenJobs(loader=base, htf_loader=htf, per_broker=1, clock=lambda: NOW)
        jid = jobs.start("u1", **_pinned(["A", "B"]))
        await asyncio.sleep(0.05)
        assert held == ["A"]  # B's pinned fetch waits for the one slot
        gate.set()
        st = await _finish(jobs, "u1", jid)
        assert st["result"]["stats"]["matched"] == 2
    asyncio.run(run())


def test_a_match_ships_its_divergence_pivots():
    from tests.test_screen_eval import _RSI_PANE, _div_closes
    bars = _bars(_div_closes())

    async def run():
        jobs = ScreenJobs(loader=_loader({"A": bars}), clock=lambda: NOW)
        jid = jobs.start("u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A"],
                         cs=compile_screen("count(RSI.bullDiv > 0, 5) >= 1", [], _RSI_PANE))
        st = await _finish(jobs, "u1", jid)
        [m] = st["result"]["matches"]
        assert m["divergences"] == [{"ref": "RSI.bullDiv", "pivot": int(bars[112].time.timestamp() * 1000),
                                     "barsAgo": 7}]
    asyncio.run(run())


def test_include_open_bar_judges_the_forming_bar():
    # The last daily bar opened an hour ago, so it is still forming.
    bars = _bars([5, 5, 11])
    now = bars[-1].time.timestamp() + 3600

    async def run(include_open):
        jobs = ScreenJobs(loader=_loader({"A": bars}), clock=lambda: now)
        jid = jobs.start("u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A"],
                         cs=compile_screen("candle.close > 10", []), include_open=include_open)
        return (await _finish(jobs, "u1", jid))["result"]["matches"]

    assert asyncio.run(run(False)) == []
    [m] = asyncio.run(run(True))
    assert m["bar_time"] == int(bars[-1].time.timestamp() * 1000)


def test_include_open_bar_still_matches_on_the_last_closed_bar():
    # Including the open bar adds a bar to judge; it never drops the last
    # closed one. Here only the closed bar holds.
    bars = _bars([5, 11, 5])
    now = bars[-1].time.timestamp() + 3600

    async def run():
        jobs = ScreenJobs(loader=_loader({"A": bars}), clock=lambda: now)
        jid = jobs.start("u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A"],
                         cs=compile_screen("candle.close > 10", [{"name": "c", "expression": "candle.close"}]),
                         include_open=True)
        return (await _finish(jobs, "u1", jid))["result"]["matches"]

    [m] = asyncio.run(run())
    assert m["bar_time"] == int(bars[1].time.timestamp() * 1000) and m["columns"] == {"c": 11.0}


def test_include_open_bar_skips_the_closed_bar_short_of_pinned_history():
    # The open daily bar is a Monday, the 4th weekly close: it has the 4 weekly
    # bars EMA(3)@W needs, the closed Sunday before it only 3, so that bar is
    # not judged (it would read an under-warmed EMA). Only it holds the close.
    days = [Candle(time=MONDAY + timedelta(days=k), open=c, high=c, low=c, close=c, volume=1.0)
            for k, c in enumerate([1] * 27 + [11, 5])]
    now = days[-1].time.timestamp() + 3600

    async def run():
        jobs = ScreenJobs(loader=_loader({"A": days}), htf_loader=_htf_loader({"A": _weeks([100] * 4)}),
                          clock=lambda: now)
        jid = jobs.start("u1", **_pinned(["A"], "EMA(3)@W > 0 and candle.close > 10"), include_open=True)
        return (await _finish(jobs, "u1", jid))["result"]

    r = asyncio.run(run())
    assert r["matches"] == [] and r["skipped"] == []


# --- picked lines: per-symbol rebase/skip glue ---------------------------------

_EARLY = datetime(2020, 1, 2, tzinfo=timezone.utc)
_LINE_A = {"L1": {"epic": "A", "broker": "yfinance", "timeframe": "DAY",
                  "t1": int((_EARLY - timedelta(days=1)).timestamp() * 1000), "p1": 1.0,
                  "t2": int(_EARLY.timestamp() * 1000), "p2": 2.0, "slope": 0.0,
                  "tRef": int(_EARLY.timestamp() * 1000), "pRef": 10.0}}


def test_line_skip_when_loader_cannot_reach_its_anchor():
    # L1's anchors sit in 2020; both A's and B's loaded bars start at T0
    # (2026) and the loader never has anything older than what it already
    # shipped, so the rebase pre-pass cannot place L1 on A's bars. A is
    # skipped with that reason; B, which does not own L1, is judged on its
    # own merits (the "or" branch independent of the line).
    async def run():
        jobs = ScreenJobs(loader=_loader({"A": _bars([5, 5, 11]), "B": _bars([5, 5, 11])}), clock=lambda: NOW)
        cs = compile_screen("candle.close > L1 or candle.close > 10", [], resolution="DAY", lines=_LINE_A)
        st = await _finish(jobs, "u1", jobs.start(
            "u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A", "B"], cs=cs))
        assert st["result"]["skipped"] == [{"epic": "A", "reason": "L1 could not be placed on the loaded bars. Lines older than 5000 bars of their timeframe need picking again."}]
        assert [m["epic"] for m in st["result"]["matches"]] == ["B"]
    asyncio.run(run())


def test_line_rebase_onto_reachable_history_only_touches_its_own_copy():
    # A deep loader CAN place L1: it reaches back to its tRef anchor, so the
    # rebase succeeds and A is judged with the rebased (reachable) geometry -
    # the pre-rebase geometry (anchor unreachable on the 3 loaded bars) would
    # never have matched at all. The shared CompiledScreen's own `lines` are
    # frozen PickedLines and must come out of the run unchanged: only a
    # per-symbol DTO copy is ever mutated.
    base_bars = _bars([5, 5, 11])
    deep_history = [Candle(time=_EARLY + timedelta(days=k), open=1, high=1, low=1, close=1, volume=1.0)
                    for k in range((T0 - _EARLY).days + 1)]
    calls: list = []

    async def load(broker, epic, resolution, side, count):
        calls.append((resolution, count))
        return (base_bars, False) if len(calls) == 1 else (deep_history, False)

    async def run():
        jobs = ScreenJobs(loader=load, clock=lambda: NOW)
        cs = compile_screen("candle.close > L1", [], resolution="DAY", lines=_LINE_A)
        st = await _finish(jobs, "u1", jobs.start(
            "u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A"], cs=cs))
        assert [m["epic"] for m in st["result"]["matches"]] == ["A"]
        assert st["result"]["skipped"] == []
        # The CompiledScreen handed to start() is never mutated in place.
        assert cs.lines["L1"].tRef == int(_EARLY.timestamp() * 1000)
        assert cs.lines["L1"].pRef == 10.0
    asyncio.run(run())
