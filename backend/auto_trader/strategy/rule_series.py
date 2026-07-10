"""Eager server-side assembly of the series dict RuleStrategy consumes.

The frontend's buildSeries (frontend/src/lib/backtestSeries.ts) is the source of
truth for shape and ordering; this mirrors it operation-for-operation over the
same parity-tested leaf math so a rule backtest computed here equals the one the
chart drew. Skips chart-operand/drawing operands (kind="series"): those depend on
live chart state and stay browser-supplied."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    atr_series, avwap_series, ema_series, rsi_series, sma_series,
)
from auto_trader.indicators.mtf import align_htf_to_base, slope_of
from auto_trader.strategy.rule import Operand, series_name


def _tf_hours(resolution: str) -> float:
    return (resolution_seconds(resolution) or 3600) / 3600


def _compute_raw(op: Operand, candles: Sequence[Candle]) -> list[float | None]:
    """Mirror frontend computeRaw for native operands (kind != series)."""
    if op.kind == "price":
        return [getattr(c, op.field) for c in candles]
    if op.kind != "indicator":
        return [None] * len(candles)
    closes = [c.close for c in candles]
    if op.indicator == "EMA":
        return ema_series(closes, op.length or 0)
    if op.indicator == "SMA":
        return sma_series(closes, op.length or 0)
    if op.indicator == "VOLMA":
        return sma_series([c.volume for c in candles], op.length or 0)
    if op.indicator == "VOL":
        return [c.volume for c in candles]
    if op.indicator == "AVWAP":
        return avwap_series(candles, op.anchor or 0)
    if op.indicator == "RSI":
        return rsi_series(closes, op.length or 14)
    return [None] * len(candles)


def _derive(op: Operand, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    raw = _compute_raw(op, candles)
    if op.slope_len is None:
        return raw
    return slope_of(raw, op.slope_len, bar_hours)


def htf_timeframes(operands: Iterable[Operand], base_resolution: str) -> set[str]:
    out: set[str] = set()
    for op in operands:
        if op.kind in ("indicator", "series") and op.timeframe and op.timeframe != base_resolution:
            out.add(op.timeframe)
    return out


def build_rule_series(
    operands: Iterable[Operand],
    candles: list[Candle],
    base_resolution: str,
    htf_candles: dict[str, list[Candle]],
    atr_lengths: Iterable[int] = (),
) -> dict[str, list[float | None]]:
    out: dict[str, list[float | None]] = {}
    base_ms = [int(c.time.timestamp() * 1000) for c in candles]
    for op in operands:
        if op.kind == "series":
            continue                       # chart operand: browser-supplied
        name = series_name(op)
        if name is None or name in out:
            continue
        tf = op.timeframe if op.kind == "indicator" else None
        if not tf or tf == base_resolution:
            out[name] = _derive(op, candles, _tf_hours(base_resolution))
            continue
        htf = htf_candles.get(tf, [])
        htf_ms = (resolution_seconds(tf) or 0) * 1000
        values = _derive(op, htf, _tf_hours(tf))
        out[name] = align_htf_to_base(base_ms, htf, values, htf_ms)
    for length in atr_lengths:
        out.setdefault(f"ATR_{length}", atr_series(candles, length))
    return out
