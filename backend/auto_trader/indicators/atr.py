"""ATR pane instances (`ATR#id.<length>`). Mirrors the frontend pane:
Length in calcParams[0], Smoothing on extendData (frontend lib/atr.ts
atrLength / atrOutputs / atrWarmup / atrSeries). Chart-timeframe only — the
pane has no MTF input (spec 2026-08-07), so `timeframe` is always None."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series, atr_smoothed_series

SMOOTHINGS = ("rma", "sma", "ema", "wma")


@dataclass(frozen=True, slots=True)
class AtrConfig:
    length: int
    smoothing: str


def parse_atr_config(calc_params: object, extend_data: object) -> AtrConfig:
    """Defensive like parse_slope_config: malformed input falls back to the
    defaults (14, rma) — resolve_instances must not 500 on chart state.
    Non-finite values (NaN, ±inf) → 14; zero → 14; negative stays negative."""
    length = 14
    if isinstance(calc_params, (list, tuple)) and calc_params:
        try:
            n = float(calc_params[0])
            # Reject non-finite values (NaN or inf) before int()
            if n == n and n not in (float("inf"), float("-inf")):
                length = int(n) or 14
        except (TypeError, ValueError):
            length = 14
    ext = extend_data if isinstance(extend_data, dict) else {}
    smoothing = ext.get("smoothing")
    return AtrConfig(
        length=length,
        smoothing=smoothing if smoothing in SMOOTHINGS else "rma",
    )


def atr_outputs(cfg: AtrConfig) -> tuple[str, ...]:
    """The single output, named by LENGTH (`ATR#id.14`) — the SLOPE convention:
    retune the length and rules naming the old one fail loudly with
    unknown_indicator_output instead of silently re-pointing."""
    return (str(cfg.length),)


def atr_pane_series(
    cfg: AtrConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    if cfg.smoothing == "rma":
        return atr_series(candles, cfg.length)
    return atr_smoothed_series(candles, cfg.length, cfg.smoothing)


def atr_warmup(cfg: AtrConfig, output: str) -> int:
    """= length, matching expr-level ATR(n) (warmup.py arg_kind "length");
    0 for an output this config does not expose — the unknown ref is the
    validation layer's error to report."""
    return cfg.length if output == str(cfg.length) else 0
