"""Slope of a moving average, ported operation-for-operation from
frontend/src/lib/indicators/slope.ts so a rule operand equals the plotted line.

Pipeline, in this exact order (slope.ts:151-173):
    MA (price source only, NO MA-side smoothing)
      -> slope (units)
      -> slope smoothing
      -> accel (absolute difference)
      -> accel smoothing
      -> optional absolute value

`bar_hours` is the NOMINAL bar width from the resolution, never inferred from
candle gaps — the same number the frontend now puts on extendData. See the
design doc's barHours section.

Do NOT "improve" the arithmetic; see indicators/core.py's header."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    ema_series, evwma_series, price_of, sma_series, vwma_series,
)

MA_KINDS: tuple[str, ...] = ("ema", "sma", "vwma", "evwma")
SLOPE_UNITS: tuple[str, ...] = ("pctHr", "pctBar", "priceBar")
SMOOTHING_KINDS: tuple[str, ...] = ("none", "sma", "ema")
MAX_LENGTHS = 5

# ("sma" | "ema" | "none", length); None means off.
Smoothing = tuple[str, int] | None


@dataclass(frozen=True, slots=True)
class SlopeConfig:
    lengths: tuple[int, ...]
    ma_type: str
    source: str
    slope_period: int
    units: str
    smoothing: Smoothing
    show_accel: bool
    accel_period: int
    accel_smoothing: Smoothing
    accel_absolute: bool
    timeframe: str | None


def _smoothing_of(raw: object) -> Smoothing:
    """extendData stores {type, length}; anything else is off."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind not in SMOOTHING_KINDS or kind == "none":
        return None
    try:
        length = int(raw.get("length") or 0)
    except (TypeError, ValueError):
        return None
    return None if length <= 1 else (kind, length)


def _lengths_of(calc_params: object) -> tuple[int, ...]:
    """slope.ts `slopeLengths`: finite non-zero numbers, first 5; else [9]."""
    xs: list[int] = []
    for v in calc_params if isinstance(calc_params, (list, tuple)) else ():
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        if n == n and n not in (float("inf"), float("-inf")) and n != 0:
            xs.append(int(n))
    return tuple(xs[:MAX_LENGTHS]) if xs else (9,)


def parse_slope_config(calc_params: object, extend_data: object) -> SlopeConfig:
    ext = extend_data if isinstance(extend_data, dict) else {}
    ma_type = ext.get("maType")
    units = ext.get("units")
    source = ext.get("source")
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    try:
        slope_period = int(ext.get("slopePeriod") or 0) or 3
    except (TypeError, ValueError):
        slope_period = 3
    try:
        accel_period = int(ext.get("accelPeriod") or 0) or 3
    except (TypeError, ValueError):
        accel_period = 3
    return SlopeConfig(
        lengths=_lengths_of(calc_params),
        ma_type=ma_type if ma_type in MA_KINDS else "ema",
        source=source if isinstance(source, str) else "close",
        slope_period=slope_period,
        units=units if units in SLOPE_UNITS else "pctHr",
        smoothing=_smoothing_of(ext.get("smoothing")),
        show_accel=bool(ext.get("showAccel")),
        accel_period=accel_period,
        accel_smoothing=_smoothing_of(ext.get("accelSmoothing")),
        accel_absolute=bool(ext.get("accelAbsolute")),
        timeframe=(mtf.get("timeframe") or None),
    )


def slope_outputs(cfg: SlopeConfig) -> tuple[str, ...]:
    """The pane's DATA outputs. Excludes thHi/thLo: those are figure keys the
    pane emits only to drive its y-axis auto-scale, not values a rule may read."""
    lines = tuple(f"slope{i}" for i in range(len(cfg.lengths)))
    if not cfg.show_accel:
        return lines
    return lines + tuple(f"accel{i}" for i in range(len(cfg.lengths)))


def ma_base(
    candles: Sequence[Candle], ma_type: str, length: int, source: str
) -> list[float | None]:
    """mtf.ts `maSeries` called with { source } ONLY — slopeLineSeries
    (slope.ts:188) deliberately does not pass ext.smoothing here. That smoothing
    applies to the slope, after differentiation."""
    prices = [price_of(c, source) for c in candles]
    if ma_type == "sma":
        return sma_series(prices, length)
    if ma_type == "vwma":
        return vwma_series(candles, prices, length)
    if ma_type == "evwma":
        return evwma_series(candles, prices, length)
    return ema_series(prices, length)


def slope_with_units(
    raw: Sequence[float | None], n: int, bar_hours: float, units: str
) -> list[float | None]:
    """slope.ts `slopeWithUnits`:
        pctBar   = (v - prev) / |prev| / n * 100
        pctHr    = (v - prev) / |prev| / (n * bar_hours) * 100
        priceBar = (v - prev) / n
    None for the first n bars, where raw is None, or on a zero denominator
    (priceBar has no denominator, so a zero prev is fine there)."""
    out: list[float | None] = [None] * len(raw)
    for i, v in enumerate(raw):
        if i < n or v is None:
            continue
        prev = raw[i - n]
        if prev is None:
            continue
        if units == "priceBar":
            out[i] = (v - prev) / n
            continue
        if prev == 0:
            continue
        denom = n * bar_hours if units == "pctHr" else n
        out[i] = (v - prev) / abs(prev) / denom * 100
    return out


def smooth_series(
    values: Sequence[float | None], s: Smoothing
) -> list[float | None]:
    """slope.ts `smoothSeries`. SMA needs a full window of DEFINED values; EMA is
    the gappy variant (mtf.ts emaGappy) — None passes through and does NOT reset
    the accumulator."""
    if s is None or s[0] == "none" or s[1] <= 1:
        return list(values)
    kind, length = s
    if kind == "ema":
        k = 2 / (length + 1)
        out: list[float | None] = []
        prev: float | None = None
        for v in values:
            if v is None:
                out.append(None)
                continue
            prev = v if prev is None else v * k + prev * (1 - k)
            out.append(prev)
        return out
    out = [None] * len(values)
    for i in range(len(values)):
        if i < length - 1:
            continue
        total = 0.0
        ok = True
        for j in range(i - length + 1, i + 1):
            v = values[j]
            if v is None:
                ok = False
                break
            total += v
        if ok:
            out[i] = total / length
    return out


def accel_series(
    slope: Sequence[float | None], n2: int, bar_hours: float, per_hour: bool
) -> list[float | None]:
    """slope.ts `accelSeries`: ABSOLUTE difference, not the percentage
    renormalization slope_with_units applies — the slope crosses zero, so
    dividing by |prev| would blow up at the crossing.

    A non-positive n2 would make slope[i - n2] read a FUTURE index, a silent
    lookahead. Refuse with an all-None series."""
    if not n2 >= 1:
        return [None] * len(slope)
    out: list[float | None] = [None] * len(slope)
    for i, v in enumerate(slope):
        if i < n2 or v is None:
            continue
        prev = slope[i - n2]
        if prev is None:
            continue
        denom = n2 * (bar_hours if per_hour else 1)
        if denom == 0:
            continue
        out[i] = (v - prev) / denom
    return out


def slope_line_series(
    candles: Sequence[Candle], cfg: SlopeConfig, length: int, bar_hours: float
) -> list[float | None]:
    """slope.ts `slopeLineSeries`: MA -> slope (units) -> slope smoothing."""
    base = ma_base(candles, cfg.ma_type, length, cfg.source)
    raw = slope_with_units(base, cfg.slope_period, bar_hours, cfg.units)
    return smooth_series(raw, cfg.smoothing)


def accel_line_series(
    candles: Sequence[Candle], cfg: SlopeConfig, length: int, bar_hours: float
) -> list[float | None]:
    """slope.ts `accelLineSeries`. The accel TIME BASE follows the slope's units:
    a pctHr slope accelerates per hour; pctBar and priceBar accelerate per bar.
    That is why there is no separate accel-units control."""
    slope = slope_line_series(candles, cfg, length, bar_hours)
    accel = accel_series(slope, cfg.accel_period, bar_hours, cfg.units == "pctHr")
    out = smooth_series(accel, cfg.accel_smoothing)
    if cfg.accel_absolute:
        return [None if v is None else abs(v) for v in out]
    return out


def slope_series(
    cfg: SlopeConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    if output not in slope_outputs(cfg):
        raise KeyError(output)
    idx = int(output.removeprefix("accel").removeprefix("slope"))
    length = cfg.lengths[idx]
    if output.startswith("accel"):
        return accel_line_series(candles, cfg, length, bar_hours)
    return slope_line_series(candles, cfg, length, bar_hours)


def _smoothing_warmup(s: Smoothing) -> int:
    return 0 if s is None else max(0, s[1] - 1)


def slope_warmup(cfg: SlopeConfig, output: str) -> int:
    if output not in slope_outputs(cfg):
        raise KeyError(output)
    idx = int(output.removeprefix("accel").removeprefix("slope"))
    n = cfg.lengths[idx] + cfg.slope_period + _smoothing_warmup(cfg.smoothing)
    if output.startswith("accel"):
        n += cfg.accel_period + _smoothing_warmup(cfg.accel_smoothing)
    return n
