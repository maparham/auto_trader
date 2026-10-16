"""Indicators an alert may watch: validation, warm-up, computation, labels.

The single backend definition. The frontend mirror is
frontend/src/lib/alertableIndicators.ts; tests/test_indicator_parity.py
asserts both export the same `ALERTABLE` shape. Values come from the batch
functions in indicators/core.py (the same ones backtests use), so there is
no second implementation of any indicator.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from auto_trader.core.alert_bars import candle_ms
from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_smoothed_series, price_of, rsi_series
from auto_trader.indicators.slope import ma_base
from auto_trader.indicators.trendlines import (
    TL_NEAREST, TL_SLOT_FIELDS, TrendLine, compute_trendlines, parse_trendlines_config,
    project_at, trendlines_config_params, trendlines_warmup,
)

SEED_CAP = 2000
MAX_WARMUP = SEED_CAP - 50

_SOURCES = ("close", "open", "high", "low", "hl2", "hlc3", "ohlc4")

# indicator -> lines, price-target allowed, calcParams int ranges, config
# options (first option is the default).
ALERTABLE: dict[str, dict[str, Any]] = {
    "MA": {
        "lines": ["value"], "priceTarget": True, "params": [[1, 1000]],
        "config": {"maType": ["ema", "sma", "vwma", "evwma"], "source": list(_SOURCES)},
    },
    "RSI": {
        "lines": ["value"], "priceTarget": False, "params": [[2, 1000]],
        "config": {"source": list(_SOURCES)},
    },
    "ATR": {
        "lines": ["value"], "priceTarget": False, "params": [[1, 1000]],
        "config": {"smoothing": ["rma", "sma", "ema", "wma"]},
    },
    # calcParams is the CANONICAL full array (trendlines_config_params), checked
    # by the parser rather than by ranges, so "params" is empty.
    "TRENDLINES": {"lines": ["value"], "priceTarget": True, "params": [], "config": {}},
}

# Timeframes a nearest-line alert refuses: one full Trendlines compute runs per
# closed bar, inline. Set from the 2026-10-16 timing (plan Task 0): median
# 399 ms per 2000-bar compute, too slow to run every minute.
TRENDLINES_REFUSED_TF: frozenset[str] = frozenset({"MINUTE"})


@dataclass(frozen=True)
class IndicatorKey:
    indicator: str
    calc: tuple[float, ...]
    config: tuple[tuple[str, str], ...]

    @classmethod
    def of(cls, params: dict) -> IndicatorKey:
        return cls(
            params["indicator"],
            tuple(params["calcParams"]),
            tuple(sorted(params["config"].items())),
        )

    def cfg(self, name: str) -> str:
        return dict(self.config)[name]


def line_key(t_ref: int, p_ref: float, slope: float) -> IndicatorKey:
    """The hub need for a `line` alert: a straight line in bars from tRef."""
    return IndicatorKey("LINE", (float(t_ref), float(p_ref), float(slope)), ())


def _bars_to_decay(alpha: float) -> int:
    """Bars until a recursive average's starting value weighs < 0.1%."""
    if alpha >= 1:
        return 1
    return math.ceil(math.log(1e-3) / math.log(1 - alpha))


def warmup(key: IndicatorKey) -> int:
    if key.indicator in ("LINE", "TRENDLINES"):
        # Seed target only: load all the history the cap allows. Readiness
        # is min_bars, not this.
        return MAX_WARMUP
    n = int(key.calc[0])
    if key.indicator == "MA":
        kind = key.cfg("maType")
        if kind in ("sma", "vwma"):
            return n
        if kind == "ema":
            return _bars_to_decay(2 / (n + 1))
        return n + _bars_to_decay(1 / n)  # evwma: ~1/n weight per bar
    if key.indicator == "RSI":
        return n + 1 + _bars_to_decay(1 / n)
    smoothing = key.cfg("smoothing")
    if smoothing == "rma":
        return n + 1 + _bars_to_decay(1 / n)
    if smoothing == "ema":
        return n + 1 + _bars_to_decay(2 / (n + 1))
    return n + 1


def min_bars(key: IndicatorKey) -> int:
    """Closed bars a series needs before `ready` (warmup is the SEED target)."""
    if key.indicator == "LINE":
        return 1
    if key.indicator == "TRENDLINES":
        return trendlines_warmup(parse_trendlines_config(list(key.calc), {}), TL_NEAREST)
    return warmup(key)


def sparse(key: IndicatorKey) -> bool:
    """Outputs may be None on a ready series (no trendline drawn)."""
    return key.indicator == "TRENDLINES"


def validate_indicator(
    indicator: Any, calc_params: Any, config: Any, line: Any, target: Any
) -> dict[str, str]:
    spec = ALERTABLE.get(indicator) if isinstance(indicator, str) else None
    if spec is None:
        raise ValueError(f"params.indicator {indicator!r} is not alertable")
    if indicator == "TRENDLINES":
        n = len(TL_SLOT_FIELDS)
        if (
            not isinstance(calc_params, list) or len(calc_params) != n
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                   for v in calc_params)
        ):
            raise ValueError(f"params.calcParams must be the {n} Trendlines settings")
        if [float(v) for v in calc_params] != trendlines_config_params(
            parse_trendlines_config(calc_params, {})
        ):
            raise ValueError("params.calcParams must be canonical Trendlines settings")
        if not isinstance(config, dict) or config:
            raise ValueError("params.config must be {} for TRENDLINES")
        if line != "value":
            raise ValueError("params.line must be one of ['value']")
        if target != "price":
            raise ValueError("params.target must be 'price' for TRENDLINES")
        # Same warm-up cap as the other indicators: a huge pivot length or
        # min span must 422 rather than wait forever for bars.
        if min_bars(IndicatorKey("TRENDLINES", tuple(calc_params), ())) > MAX_WARMUP:
            raise ValueError("params.calcParams: length too long for alerts")
        return {}
    ranges = spec["params"]
    if (
        not isinstance(calc_params, list) or len(calc_params) != len(ranges)
        or any(isinstance(v, bool) or not isinstance(v, int) for v in calc_params)
        or any(not (lo <= v <= hi) for v, (lo, hi) in zip(calc_params, ranges))
    ):
        raise ValueError(f"params.calcParams must be {len(ranges)} integer(s) in {ranges}")
    if not isinstance(config, dict):
        raise ValueError("params.config must be an object")
    unknown = set(config) - set(spec["config"])
    if unknown:
        bad = sorted(unknown)[0]
        raise ValueError(f"params.config.{bad} is not a known option for {indicator}")
    out: dict[str, str] = {}
    for name, options in spec["config"].items():
        value = config.get(name, options[0])
        if value not in options:
            raise ValueError(f"params.config.{name} must be one of {options}")
        out[name] = value
    if line not in spec["lines"]:
        raise ValueError(f"params.line must be one of {spec['lines']}")
    if target not in ("price", "value"):
        raise ValueError("params.target must be 'price' or 'value'")
    if target == "price" and not spec["priceTarget"]:
        raise ValueError(f"params.target 'price' is not allowed for {indicator}")
    key = IndicatorKey(indicator, tuple(calc_params), tuple(sorted(out.items())))
    if warmup(key) > MAX_WARMUP:
        raise ValueError("params.calcParams: length too long for alerts")
    return out


def volume_weighted(key: IndicatorKey) -> bool:
    return key.indicator == "MA" and key.cfg("maType") in ("vwma", "evwma")


def _trendlines_values(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    """value: the nearest line at bar i (tl_nearest). held: the line nearest
    at bar i-1, projected to bar i (the one a close-mode cross is judged
    against). slope / a1 / a2: the nearest line's slope per bar and anchor
    open times, so intrabar can project it and the engine can tell a switch."""
    n = len(candles)
    nearest: list[TrendLine | None] = [None] * n
    points, _ = compute_trendlines(candles, parse_trendlines_config(list(key.calc), {}), nearest_out=nearest)
    held: list[float | None] = [None] * n
    for i in range(1, n):
        prev = nearest[i - 1]
        if prev is not None:
            held[i] = project_at(prev, i)
    return {
        "value": [p.get(TL_NEAREST) for p in points],
        "held": held,
        "slope": [None if ln is None else (ln.p2 - ln.p1) / (ln.i2 - ln.i1) for ln in nearest],
        "a1": [None if ln is None else float(candle_ms(candles[ln.i1])) for ln in nearest],
        "a2": [None if ln is None else float(candle_ms(candles[ln.i2])) for ln in nearest],
    }


def compute(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    """Reuses the existing ports: `slope.ma_base` is mtf.ts `maSeries` with a
    source (exactly what an MA with no offset/smoothing/MTF draws),
    `rsi_series` over the source, and `atr_smoothed_series` (which already
    routes rma to Wilder's `atr_series`)."""
    if key.indicator == "LINE":
        t_ref, p_ref, slope = key.calc
        times = [candle_ms(c) for c in candles]
        try:
            j = times.index(int(t_ref))
        except ValueError:
            return {"value": [None] * len(candles)}
        return {"value": [None if k < j else p_ref + slope * (k - j) for k in range(len(candles))]}
    if key.indicator == "TRENDLINES":
        return _trendlines_values(key, candles)
    n = int(key.calc[0])
    if key.indicator == "MA":
        return {"value": ma_base(candles, key.cfg("maType"), n, key.cfg("source"))}
    if key.indicator == "RSI":
        return {"value": rsi_series([price_of(c, key.cfg("source")) for c in candles], n)}
    return {"value": atr_smoothed_series(candles, n, key.cfg("smoothing"))}


def indicator_label(key: IndicatorKey) -> str:
    if key.indicator == "TRENDLINES":
        return "Trendlines nearest"
    if key.indicator == "LINE":
        return "Trendline"
    n = int(key.calc[0])
    if key.indicator == "MA":
        src = key.cfg("source")
        base = f"{key.cfg('maType').upper()} {n}"
        return base if src == "close" else f"{base} {src}"
    if key.indicator == "RSI":
        src = key.cfg("source")
        return f"RSI {n}" if src == "close" else f"RSI {n} {src}"
    sm = key.cfg("smoothing")
    return f"ATR {n}" if sm == "rma" else f"ATR {n} {sm}"
