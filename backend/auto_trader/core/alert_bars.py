"""Bars for alerts: the one bar clock and a per-series forming bar.

`period_start` is the only definition of "which bar is this sample in", used
by the once-per-bar rule for every alert and by `BarSeries` to detect a bar
close. Derived timeframes bucket exactly like the candles API
(`candle_aggregate.bucket_open`). `BarSeries` never invents closed bars: the
forming bar is built from live samples for intrabar use only, and closed bars
arrive through `seed`/`replace_tail` from the candle cache.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from auto_trader.core import timeframe as _tf
from auto_trader.core.candle_aggregate import bucket_open, rule_for
from auto_trader.core.models import Candle, Resolution

_DAY = 86_400
_WEEK = 7 * _DAY
_MONDAY_OFFSET = 4 * _DAY  # the epoch was a Thursday


def alert_resolution(timeframe: str | None) -> str:
    """Canonical bar timeframe for an alert; 1 minute when missing, invalid or
    finer than a minute."""
    if not timeframe:
        return "MINUTE"
    try:
        res = _tf.canonicalize(timeframe)
        if _tf.parse(res).unit == "SECOND":
            return "MINUTE"
        return res
    except _tf.TimeframeError:
        return "MINUTE"


def _native_open(ts: int, res: str) -> int:
    if res == "WEEK":
        return ((ts - _MONDAY_OFFSET) // _WEEK) * _WEEK + _MONDAY_OFFSET
    secs = Resolution(res).seconds
    return ts - ts % secs


def period_start(t_ms: int, resolution: str) -> int:
    res = alert_resolution(resolution)
    ts = t_ms // 1000
    rule = rule_for(res)
    if rule is None:
        return _native_open(ts, res) * 1000
    return bucket_open(_native_open(ts, rule.base.value), rule) * 1000


def candle_ms(c: Candle) -> int:
    return int(c.time.timestamp() * 1000)


@dataclass(frozen=True)
class Sample:
    t_ms: int
    mid: float
    bid: float | None
    ask: float | None
    bar: Candle | None = None  # the stream's 1-minute mid bar, when streaming


class Roll(Enum):
    NONE = "none"
    CLOSED = "closed"
    GAP = "gap"


class BarSeries:
    def __init__(self, resolution: str, side: str, cap: int = 2000) -> None:
        self.resolution = alert_resolution(resolution)
        self.side = side
        self.cap = cap
        self.closed: list[Candle] = []
        self.forming: Candle | None = None
        self.forming_open_ms: int | None = None
        self._minute_vol: dict[int, float] = {}
        # Volume a seeded forming bar already carries, and the minute it was
        # seeded in (stream minutes up to and including it are inside it).
        self._base_vol = 0.0
        self._base_minute: int | None = None

    def keep_closed(self, bars: list[Candle], now_ms: int) -> list[Candle]:
        # A full resolution must have elapsed since the bar's OWN open, not
        # merely "before our epoch grid's current boundary": some brokers
        # offset their 4H/daily bars from UTC midnight (candle_aggregate.py's
        # HOUR rule_for comment), so a broker bar need not sit on our grid at
        # all. Comparing elapsed time instead of grid position is safe either
        # way (see test_keep_closed_is_broker_offset_safe). Public: callers
        # (e.g. alert_indicators.IndicatorHub._refresh) need to classify a
        # freshly-fetched tail as closed/not-closed without going through
        # seed/replace_tail.
        span_ms = _tf.seconds(self.resolution) * 1000
        return [b for b in bars if candle_ms(b) + span_ms <= now_ms]

    def seed(self, bars: list[Candle], now_ms: int) -> None:
        closed = self.keep_closed(bars, now_ms)
        self.closed = closed[-self.cap:]
        # The loader passes the still-forming bar through as its last element.
        # It is the real partial bar, already on this series' price side (the
        # loader fetches per side), so no mid-to-side shift applies. Adopt it
        # only when it is THIS period's bar on our grid, the one on_sample
        # extends; a broker bar off our grid is left alone.
        if not bars or (closed and bars[-1] is closed[-1]):
            return
        bar = bars[-1]
        open_ms = period_start(now_ms, self.resolution)
        if candle_ms(bar) != open_ms:
            return
        f = self.forming if self.forming_open_ms == open_ms else None
        if f is None:
            self.forming = bar
        else:
            # Live samples already built part of it: keep the true open from
            # the loader, the widest range, and the fresher live close.
            self.forming = Candle(
                bar.time, bar.open, max(bar.high, f.high), min(bar.low, f.low), f.close,
                max(bar.volume or 0.0, f.volume or 0.0),
            )
        self.forming_open_ms = open_ms
        self._minute_vol = {}
        self._base_vol = self.forming.volume or 0.0
        self._base_minute = now_ms - now_ms % 60_000

    def replace_tail(self, bars: list[Candle], now_ms: int) -> None:
        fresh = self.keep_closed(bars, now_ms)
        if not fresh:
            return
        first = candle_ms(fresh[0])
        kept = [b for b in self.closed if candle_ms(b) < first]
        self.closed = (kept + fresh)[-self.cap:]

    def _shift(self, s: Sample) -> float:
        if self.side == "bid" and s.bid is not None:
            return s.bid - s.mid
        if self.side == "ask" and s.ask is not None:
            return s.ask - s.mid
        return 0.0

    def on_sample(self, s: Sample) -> Roll:
        open_ms = period_start(s.t_ms, self.resolution)
        roll = Roll.NONE
        if self.forming_open_ms is not None and open_ms > self.forming_open_ms:
            nxt = period_start(
                self.forming_open_ms + _tf.seconds(self.resolution) * 1000, self.resolution
            )
            roll = Roll.GAP if open_ms > nxt else Roll.CLOSED
            self.forming = None
            self._minute_vol = {}
            self._base_vol, self._base_minute = 0.0, None
        self.forming_open_ms = open_ms

        shift = self._shift(s)
        if s.bar is not None:
            b = s.bar
            o, h, l, c = b.open + shift, b.high + shift, b.low + shift, b.close + shift
            self._minute_vol[candle_ms(b)] = b.volume or 0.0
        else:
            o = h = l = c = s.mid + shift
        base = self._base_minute
        vol = self._base_vol + sum(
            v for m, v in self._minute_vol.items() if base is None or m > base
        )
        f = self.forming
        t = datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc)
        if f is None:
            self.forming = Candle(t, o, h, l, c, vol)
        else:
            self.forming = Candle(t, f.open, max(f.high, h), min(f.low, l), c, vol)
        return roll

    def with_forming(self) -> list[Candle]:
        return self.closed + ([self.forming] if self.forming is not None else [])
