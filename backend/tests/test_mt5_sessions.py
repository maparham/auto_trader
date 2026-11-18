import asyncio
from datetime import datetime, timezone

from auto_trader.brokers._market_hours import _market_hours_state
from auto_trader.brokers._mt5_sessions import MT5Sessions, OUTPUT_PATH, to_opening_hours

H = 3600


def _week(*per_day):
    return [list(d) for d in per_day]


# #SLV-like: Mon..Fri 13:30-20:00 server time (Sunday first).
SLV = _week([], [[13 * H + 1800, 20 * H]], [[13 * H + 1800, 20 * H]], [[13 * H + 1800, 20 * H]],
            [[13 * H + 1800, 20 * H]], [[13 * H + 1800, 20 * H]], [])


def test_converts_server_time_to_utc_windows():
    oh = to_opening_hours(SLV, server_offset_s=2 * H)
    assert oh["zone"] == "UTC"
    assert oh["wed"] == ["11:30 - 18:00"]
    assert oh["sun"] == [] and oh["sat"] == []


def test_window_crossing_utc_midnight_is_split():
    # Server UTC+2: Monday 00:00-01:00 server is Sunday 22:00-23:00 UTC; a
    # Monday 01:00-24:00 window becomes Sun 23:00-24:00 + Mon 00:00-22:00.
    days = _week([], [[0, H], [H, 24 * H]], [], [], [], [], [])
    oh = to_opening_hours(days, server_offset_s=2 * H)
    assert oh["sun"] == ["22:00 - 23:00", "23:00 - 00:00"]
    assert oh["mon"] == ["00:00 - 22:00"]


def test_no_sessions_is_unknown_not_closed():
    assert to_opening_hours(_week([], [], [], [], [], [], []), 0) is None
    assert to_opening_hours("junk", 0) is None


def test_closed_before_the_us_open_with_next_open():
    oh = to_opening_hours(SLV, server_offset_s=0)
    now = datetime(2026, 11, 18, 10, 19, tzinfo=timezone.utc)  # a Wednesday
    closed, nxt = _market_hours_state(oh, now)
    assert closed is True and nxt == "2026-11-18T13:30:00+00:00"
    assert _market_hours_state(oh, now.replace(hour=15))[0] is False


class FakeTerminal:
    def __init__(self, charts):
        self.charts = charts
        self.calls = []
        self.file = None

    async def call(self, tool, args=None, **_):
        self.calls.append(tool)
        if tool == "list_open_charts":
            return {"charts": self.charts}
        if tool == "chart_open":
            return {"chart_id": "77"}
        if tool == "chart_add_script":
            self.file = {"generated": 1_000_000, "serverOffset": 0, "symbols": {"#SLV": SLV}}
            return {"ok": True}
        if tool == "read_file":
            assert args["path"] == OUTPUT_PATH
            if self.file is None:
                raise RuntimeError("no file")
            return self.file
        if tool == "chart_close":
            return {"ok": True}
        raise AssertionError(tool)


async def _load(term):
    s = MT5Sessions(term.call, wall=lambda: 1_000_000.0, sleep=lambda _s: asyncio.sleep(0))
    assert s.opening_hours("#SLV") is None  # first ask starts the load
    await s._task
    return s


def test_runs_the_script_on_an_open_chart_and_reads_hours():
    term = FakeTerminal([{"chart_id": "5"}])
    s = asyncio.run(_load(term))
    assert s.opening_hours("#SLV")["mon"] == ["13:30 - 20:00"]
    assert "chart_open" not in term.calls


def test_opens_and_closes_a_chart_when_none_is_open():
    term = FakeTerminal([])
    asyncio.run(_load(term))
    assert term.calls.count("chart_open") == 1 and term.calls[-1] == "chart_close"


def test_stale_file_times_out_and_stays_unknown():
    term = FakeTerminal([{"chart_id": "5"}])
    term.file = {"generated": 1, "serverOffset": 0, "symbols": {"#SLV": SLV}}

    async def go():
        t = [0.0]

        def clock():
            t[0] += 5.0
            return t[0]

        s = MT5Sessions(term.call, clock=clock, wall=lambda: 1_000_000.0,
                        sleep=lambda _s: asyncio.sleep(0))
        orig = term.call

        async def call(tool, args=None, **kw):
            if tool == "chart_add_script":
                return {"ok": True}  # the script never writes
            return await orig(tool, args, **kw)

        s._call = call
        s.opening_hours("#SLV")
        await s._task
        return s

    s = asyncio.run(go())
    assert s.opening_hours("#SLV") is None
