"""Named indicator series for agents: 'RSI(14) on these candles' without
composing expression syntax. One seam over the two existing layers: the
simple core series (EMA/SMA/RSI/ATR) and the SERIES_INDICATORS registry.

Registry specs parse their config the same way resolve_instances does (see
registry.resolve_instances): parse_config(calc_params, extend_data), where
calc_params is a list like [14] for a length parameter, not a dict. `params`
here uses the simple {"length": 14}-style shape instead (this seam's own
public contract), so it is translated into that positional calc_params list
before being handed to the registry spec."""
from __future__ import annotations

from collections.abc import Sequence

from ..core.candle_aggregate import resolution_seconds
from ..core.models import Candle
from .core import atr_series, ema_series, rsi_series, sma_series
from .registry import SERIES_INDICATORS

SIMPLE = {"EMA", "SMA", "MA", "RSI", "ATR"}


def valid_indicator_names() -> list[str]:
    return sorted(SIMPLE | set(SERIES_INDICATORS))


def compute_indicator_series(
    candles: Sequence[Candle], indicator: str, params: dict, resolution: str,
) -> dict:
    """params today: {"length": int} for EMA/SMA/MA/RSI/ATR; registry
    indicators (SR_LEVELS, SLOPE, ...) take their own defaults via
    parse_config(None, None) until this seam grows a per-family mapping."""
    ind = indicator.upper()
    timestamps = [int(c.time.timestamp()) for c in candles]
    if ind in SIMPLE:
        length = int(params.get("length", 14))
        closes = [c.close for c in candles]
        if ind == "RSI":
            outputs = {"rsi": rsi_series(closes, length)}
        elif ind == "EMA":
            outputs = {"ema": ema_series(closes, length)}
        elif ind in ("SMA", "MA"):
            outputs = {"sma": sma_series(closes, length)}
        else:  # ATR
            outputs = {"atr": atr_series(candles, length)}
        return {"indicator": ind, "timestamps": timestamps, "outputs": outputs}
    spec = SERIES_INDICATORS.get(ind)
    if spec is None:
        raise ValueError(
            f"unknown indicator: {indicator} (one of {', '.join(valid_indicator_names())})"
        )
    # Registry families each define their own calcParams shape (a length for
    # ATR, a lookback + touch count for SR_LEVELS, ...); this seam has no
    # per-family mapping yet, so registry indicators always take their
    # defaults via parse_config(None, None) rather than guessing a shape from
    # the simple {"length": ...} params SIMPLE indicators use.
    cfg = spec.parse_config(None, None)
    bar_hours = resolution_seconds(resolution) / 3600.0
    outputs = {
        out: spec.series(cfg, out, candles, bar_hours) for out in spec.outputs(cfg)
    }
    return {"indicator": ind, "timestamps": timestamps, "outputs": outputs}
