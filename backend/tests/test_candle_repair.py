# backend/tests/test_candle_repair.py
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from auto_trader.api.candle_repair import make_repair_hook
from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.candle_clean import Split
from auto_trader.core.models import Candle

DAY = 86_400
T_APR2 = 1775088000
T_APR6 = 1775433600
T_APR7 = 1775520000
KEY = ("capital", "BKNG", "DAY", "mid")
BKNG_SPLIT = Split(ts=1775482200, ratio=25.0)
NOW = T_APR7 + 10 * DAY


def _bar(ts: int, o: float, h: float, l: float, c: float, v: float = 1.0) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=o, high=h, low=l, close=c, volume=v,
    )


def _days() -> list[Candle]:
    return [
        _bar(T_APR2, 165.6, 168.12, 162.405, 167.5),
        _bar(T_APR6, 4187.5, 4187.5, 166.295, 176.12, 22839.0),
        _bar(T_APR7, 177.6, 180.25, 169.835, 177.375),
    ]


def _hours() -> list[Candle]:
    # The split day's hourly bars, already repaired (they come back through the
    # cache, whose hook fixes the 00:00 stale print on HOUR too).
    return [
        _bar(T_APR6, 167.5, 167.5, 167.495, 167.495),
        _bar(T_APR6 + 13 * 3600, 167.525, 172.64, 166.295, 170.715),
        _bar(T_APR6 + 18 * 3600, 175.435, 176.825, 175.04, 176.22),
        _bar(T_APR6 + 23 * 3600, 176.52, 176.58, 176.12, 176.12),
    ]


class FakeSplits:
    def __init__(self, splits: list[Split]):
        self._splits = splits
        self.calls: list[str] = []

    async def get(self, epic: str) -> list[Split]:
        self.calls.append(epic)
        return self._splits


class FakeFiner:
    def __init__(self, bars: list[Candle] | None = None, error: Exception | None = None):
        self._bars = bars or []
        self._error = error
        self.calls: list[tuple[tuple, str, int, int]] = []

    async def __call__(self, key, resolution, start_ts, end_ts):
        self.calls.append((key, resolution, start_ts, end_ts))
        if self._error:
            raise self._error
        return [b for b in self._bars if start_ts <= int(b.time.timestamp()) <= end_ts]


def _hook(tmp_path, splits=(BKNG_SPLIT,), finer=None, now=NOW):
    cache = CandleCache(str(tmp_path / "c.db"))
    fs = FakeSplits(list(splits))
    ff = finer if finer is not None else FakeFiner(_hours())
    return cache, fs, ff, make_repair_hook(cache, fs, ff, now=lambda: now)


def test_day_bar_rebuilt_from_hourly(tmp_path):
    _, fs, ff, hook = _hook(tmp_path)
    out = asyncio.run(hook(KEY, DAY, _days()))
    b = out[1]
    assert (b.open, b.high, b.low, b.close, b.volume) == (167.5, 176.825, 166.295, 176.12, 22839.0)
    assert fs.calls == ["BKNG"]
    assert ff.calls == [(("capital", "BKNG", "HOUR", "mid"), "HOUR", T_APR6, T_APR6 + DAY - 1)]


def test_rebuild_is_memoized(tmp_path):
    _, _, ff, hook = _hook(tmp_path)
    asyncio.run(hook(KEY, DAY, _days()))
    asyncio.run(hook(KEY, DAY, _days()))
    assert len(ff.calls) == 1


def test_rebuild_failure_keeps_the_clamp(tmp_path):
    _, _, _, hook = _hook(tmp_path, finer=FakeFiner(error=RuntimeError("down")))
    b = asyncio.run(hook(KEY, DAY, _days()))[1]
    assert (b.open, b.high, b.low) == (167.5, 176.12, 166.295)


def test_rebuild_that_disagrees_with_the_bar_keeps_the_clamp(tmp_path):
    wrong = [_bar(T_APR6 + 3600, 90, 95, 85, 91)]
    _, _, _, hook = _hook(tmp_path, finer=FakeFiner(wrong))
    b = asyncio.run(hook(KEY, DAY, _days()))[1]
    assert (b.open, b.high) == (167.5, 176.12)


def test_forming_bar_is_clamped_not_rebuilt(tmp_path):
    _, _, ff, hook = _hook(tmp_path, now=T_APR6 + 3600)
    b = asyncio.run(hook(KEY, DAY, _days()[:2]))[1]
    assert (b.open, b.high) == (167.5, 176.12)
    assert ff.calls == []


def test_hour_bars_are_repaired_but_never_rebuilt(tmp_path):
    _, _, ff, hook = _hook(tmp_path)
    hkey = ("capital", "BKNG", "HOUR", "mid")
    bars = [
        _bar(T_APR2 + 19 * 3600, 167.6, 167.7, 167.4, 167.5),
        _bar(T_APR6, 4187.5, 4187.5, 167.495, 167.495),
    ]
    out = asyncio.run(hook(hkey, 3600, bars))
    assert (out[1].open, out[1].high) == (167.5, 167.5)
    assert ff.calls == []


def test_window_starting_on_the_stale_bar_reads_the_previous_bar(tmp_path):
    cache, _, _, hook = _hook(tmp_path, splits=())
    cache._store_closed(KEY, _days()[:1], cutoff_ts=NOW)
    out = asyncio.run(hook(KEY, DAY, _days()[1:]))
    assert out[0].open == 167.5  # threshold rule, prev close from the store


def test_clean_series_never_asks_for_splits(tmp_path):
    _, fs, _, hook = _hook(tmp_path)
    clean = [_days()[0], _days()[2]]
    assert asyncio.run(hook(KEY, DAY, clean)) == clean
    assert fs.calls == []


def test_crypto_brokers_skip_the_threshold_rule(tmp_path):
    _, _, _, hook = _hook(tmp_path, splits=())
    key = ("nobitex", "BTCIRT", "DAY", "mid")
    out = asyncio.run(hook(key, DAY, _days()))
    assert out[1].open == 4187.5


def test_rebuild_repairs_a_raw_stale_hour_it_is_handed(tmp_path):
    raw = [_bar(T_APR6, 4187.5, 4187.5, 167.495, 167.495)] + _hours()[1:]
    _, _, _, hook = _hook(tmp_path, splits=(), finer=FakeFiner(raw))
    b = asyncio.run(hook(KEY, DAY, _days()))[1]
    assert (b.open, b.high, b.low) == (167.5, 176.825, 166.295)
