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


def test_asks_for_enough_bars():
    async def run():
        calls = []
        jobs = ScreenJobs(loader=_loader({"A": _bars([1.0] * 300)}, calls=calls), clock=lambda: NOW)
        jid = jobs.start("u1", broker="yfinance", resolution="DAY", side="mid", symbols=["A"],
                         cs=compile_screen("candle.close > EMA(200)", []))
        await _finish(jobs, "u1", jid)
        assert calls[0][2] >= 202  # warm-up + the forming bar it may drop
    asyncio.run(run())
