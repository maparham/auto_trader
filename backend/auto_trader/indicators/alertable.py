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

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_smoothed_series, price_of, rsi_series
from auto_trader.indicators.slope import ma_base

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
}


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


def _bars_to_decay(alpha: float) -> int:
    """Bars until a recursive average's starting value weighs < 0.1%."""
    if alpha >= 1:
        return 1
    return math.ceil(math.log(1e-3) / math.log(1 - alpha))


def warmup(key: IndicatorKey) -> int:
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


def validate_indicator(
    indicator: Any, calc_params: Any, config: Any, line: Any, target: Any
) -> dict[str, str]:
    spec = ALERTABLE.get(indicator) if isinstance(indicator, str) else None
    if spec is None:
        raise ValueError(f"params.indicator {indicator!r} is not alertable")
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


def compute(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    """Reuses the existing ports: `slope.ma_base` is mtf.ts `maSeries` with a
    source (exactly what an MA with no offset/smoothing/MTF draws),
    `rsi_series` over the source, and `atr_smoothed_series` (which already
    routes rma to Wilder's `atr_series`)."""
    n = int(key.calc[0])
    if key.indicator == "MA":
        return {"value": ma_base(candles, key.cfg("maType"), n, key.cfg("source"))}
    if key.indicator == "RSI":
        return {"value": rsi_series([price_of(c, key.cfg("source")) for c in candles], n)}
    return {"value": atr_smoothed_series(candles, n, key.cfg("smoothing"))}


def indicator_label(key: IndicatorKey) -> str:
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
