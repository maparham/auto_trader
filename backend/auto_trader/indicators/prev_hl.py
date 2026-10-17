"""PREV_HL pane (registry type `PREV_HL`), ported from frontend
lib/indicators/prevHl.ts computePrevHl: previous rolling / day / week /
anchored high and low.

- Display toggles (lineHidden) never gate a value: a hidden line is still a
  valid operand (PIVOT_BANDS precedent).
- Day and week bucket in extendData.tz, which the frontend stamps with the
  chart zone (lib/indicatorTimezone.ts); absent, "chart" or invalid means UTC.
- Bar spacing is the TS estimateBarMs median of positive timestamp deltas,
  read from the candles, never the nominal bar_hours, so the rolling
  "trading" bar count and the finer-than-one-bar check match the chart."""
from __future__ import annotations

import math
import threading
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from auto_trader.core.models import Candle

PREV_HL_OUTPUTS: tuple[str, ...] = (
    "rollingHigh", "rollingLow", "dayHigh", "dayLow", "weekHigh", "weekLow", "anchorHigh", "anchorLow",
)
_KIND = {o: o[: -len("High")] if o.endswith("High") else o[: -len("Low")] for o in PREV_HL_OUTPUTS}
_AGGS = ("extreme", "avg", "median")
_UNITS = ("bars", "minute", "hour", "day", "week")
ROLLING_UNIT_MS = {"minute": 60_000, "hour": 3_600_000, "day": 86_400_000, "week": 604_800_000}
_DAY_MS = 86_400_000
_WEEK_MS = 604_800_000


@dataclass(frozen=True, slots=True)
class PrevHlConfig:
    tz: str
    rolling_len: int
    day_len: int
    week_len: int
    rolling_agg: str
    day_agg: str
    week_agg: str
    rolling_unit: str
    gap_mode: str
    anchor_ms: int


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def _zone(tz: object) -> str:
    if not isinstance(tz, str) or not tz or tz == "chart":
        return "UTC"
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"
    return tz


def parse_prev_hl_config(calc_params: object, extend_data: object) -> PrevHlConfig:
    """PREV_HL has no calcParams. Fallbacks mirror computePrevHl: length floor
    1, agg "extreme", unit "hour", gap mode "trading", anchor `Number || 0`.

    A non-numeric stored length is `Math.floor(NaN)` on the chart (n in
    computePrevHl), which then makes every window computation it feeds into
    degenerate to no window at all (prev_hl_series below returns blank for
    length 0). A real length always floors to >= 1, so 0 is never ambiguous
    with one."""
    ext = extend_data if isinstance(extend_data, dict) else {}
    lengths = ext.get("lengths") if isinstance(ext.get("lengths"), dict) else {}
    aggs = ext.get("aggs") if isinstance(ext.get("aggs"), dict) else {}

    def length(kind: str) -> int:
        n = _num(lengths.get(kind, 1))
        return 0 if n is None else max(1, math.floor(n))

    def agg(kind: str) -> str:
        return aggs.get(kind) if aggs.get(kind) in _AGGS else "extreme"

    a = _num(ext.get("anchorTs"))
    return PrevHlConfig(
        tz=_zone(ext.get("tz")),
        rolling_len=length("rolling"), day_len=length("day"), week_len=length("week"),
        rolling_agg=agg("rolling"), day_agg=agg("day"), week_agg=agg("week"),
        rolling_unit=ext.get("rollingUnit") if ext.get("rollingUnit") in _UNITS else "hour",
        gap_mode="wallclock" if ext.get("gapMode") == "wallclock" else "trading",
        anchor_ms=int(a) if a else 0,
    )


def prev_hl_outputs(cfg: PrevHlConfig) -> tuple[str, ...]:
    return PREV_HL_OUTPUTS


def estimate_bar_ms(ts: Sequence[int]) -> int:
    """estimateBarMs: the median positive gap over the whole history."""
    if len(ts) < 2:
        return 0
    deltas = sorted(d for d in (ts[i] - ts[i - 1] for i in range(1, len(ts))) if d > 0)
    return deltas[len(deltas) >> 1] if deltas else 0


# series() runs once per PREV_HL output (8 per instance), rebuilding the same
# `ts` and re-sorting it just to find the same median gap each time. A plain
# list can't be weakly referenced (no WeakMap-by-identity, unlike prevHl.ts's
# barMsCache), so this keys on a cheap fingerprint instead: (length, first ts,
# last ts) is enough to recognize "the same candle history" call to call
# within one request; a bounded size keeps it from growing across unrelated
# requests.
_BAR_MS_CACHE: "OrderedDict[tuple[int, int, int], int]" = OrderedDict()
_BAR_MS_CACHE_MAX = 32
# The alert hub computes series on worker threads; the get/move/pop sequence
# below is not atomic without it.
_BAR_MS_LOCK = threading.Lock()


def _cached_bar_ms(ts: Sequence[int]) -> int:
    if len(ts) < 2:
        return 0
    key = (len(ts), ts[0], ts[-1])
    with _BAR_MS_LOCK:
        hit = _BAR_MS_CACHE.get(key)
        if hit is not None:
            _BAR_MS_CACHE.move_to_end(key)
            return hit
    bar_ms = estimate_bar_ms(ts)
    with _BAR_MS_LOCK:
        _BAR_MS_CACHE[key] = bar_ms
        if len(_BAR_MS_CACHE) > _BAR_MS_CACHE_MAX:
            _BAR_MS_CACHE.popitem(last=False)
    return bar_ms


def _aggregate(values: list[float], fn: str, want_max: bool) -> float:
    if fn == "avg":
        s = 0.0
        for v in values:
            s += v
        return s / len(values)
    if fn == "median":
        s_ = sorted(values)
        mid = len(s_) >> 1
        return s_[mid] if len(s_) % 2 else (s_[mid - 1] + s_[mid]) / 2
    return max(values) if want_max else min(values)


def _period_key(ms: int, kind: str, zone: ZoneInfo) -> object:
    d = datetime.fromtimestamp(ms / 1000, zone).date()
    return d if kind == "day" else d.toordinal() - d.weekday()  # week: back to Monday


def _bucketed(candles, ts, kind, n, fn, zone, want_hi) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    window: list[tuple[float, float]] = []
    cur_key = None
    cur_hi, cur_lo = -math.inf, math.inf
    level: float | None = None
    for i, c in enumerate(candles):
        key = _period_key(ts[i], kind, zone)
        if cur_key is None:
            cur_key = key
        elif key != cur_key:
            window.append((cur_hi, cur_lo))
            if len(window) > n:
                window.pop(0)
            level = _aggregate([w[0] if want_hi else w[1] for w in window], fn, want_hi)
            cur_key = key
            cur_hi, cur_lo = -math.inf, math.inf
        cur_hi = max(cur_hi, c.high)
        cur_lo = min(cur_lo, c.low)
        if level is not None:
            out[i] = level
    return out


def _rolling(candles, ts, n, unit, gap_mode, fn, bar_ms, want_hi) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    is_bars = unit == "bars"
    span = 0 if is_bars else n * ROLLING_UNIT_MS[unit]
    wallclock = not is_bars and gap_mode == "wallclock"
    if is_bars:
        bar_count = max(1, n)
    else:
        bar_count = max(1, math.floor(span / bar_ms + 0.5)) if bar_ms > 0 else 1  # JS Math.round
    left = 0
    for i in range(len(candles)):
        if wallclock:
            cutoff = ts[i] - span
            while left < i and ts[left] < cutoff:
                left += 1
            start = left
            if start >= i:
                continue
        else:
            start = i - bar_count
            if start < 0:
                continue
        vals = [candles[j].high if want_hi else candles[j].low for j in range(start, i)]
        out[i] = _aggregate(vals, fn, want_hi)
    return out


def _anchor(candles, ts, anchor_ms, want_hi) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    if anchor_ms <= 0 or not candles or ts[0] > anchor_ms:
        # Anchored before the first bar held: the extreme since the anchor is
        # unknowable from this window (the alert hub's seed is bounded), so blank.
        return out
    hi, lo = -math.inf, math.inf
    for i, c in enumerate(candles):
        if ts[i] < anchor_ms:
            continue
        hi = max(hi, c.high)
        lo = min(lo, c.low)
        out[i] = hi if want_hi else lo
    return out


def prev_hl_series(cfg: PrevHlConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output not in _KIND:
        raise ValueError(f"unknown PREV_HL output {output!r}")
    kind = _KIND[output]
    want_hi = output.endswith("High")
    ts = [int(c.time.timestamp() * 1000) for c in candles]
    if kind == "anchor":
        return _anchor(candles, ts, cfg.anchor_ms, want_hi)
    bar_ms = _cached_bar_ms(ts)
    blank: list[float | None] = [None] * len(candles)
    if kind == "rolling":
        if cfg.rolling_len == 0:  # a non-finite stored length: no valid window
            return blank
        if cfg.rolling_unit != "bars" and bar_ms > 0 and cfg.rolling_len * ROLLING_UNIT_MS[cfg.rolling_unit] < bar_ms:
            return blank
        return _rolling(candles, ts, cfg.rolling_len, cfg.rolling_unit, cfg.gap_mode, cfg.rolling_agg, bar_ms, want_hi)
    n = cfg.day_len if kind == "day" else cfg.week_len
    if n == 0:  # a non-finite stored length: no valid window
        return blank
    if bar_ms > 0 and n * (_DAY_MS if kind == "day" else _WEEK_MS) < bar_ms:
        return blank
    fn = cfg.day_agg if kind == "day" else cfg.week_agg
    return _bucketed(candles, ts, kind, n, fn, ZoneInfo(cfg.tz), want_hi)


def prev_hl_warmup(cfg: PrevHlConfig, output: str) -> int:
    """A floor: exact for a bars-unit rolling window, 0 where the bar count
    depends on spacing or calendar gaps (prevHlOutputs.ts prevHlWarmup)."""
    if output not in _KIND:
        return 0
    # A bars-unit window excludes bar i, so its first value is at index n.
    n = cfg.rolling_len
    return n + 1 if _KIND[output] == "rolling" and cfg.rolling_unit == "bars" and n > 0 else 0
