from __future__ import annotations

from dataclasses import dataclass

from auto_trader.indicators.candle_patterns import PATTERN_FNS as _PATTERN_FNS


@dataclass(frozen=True, slots=True)
class IndicatorSpec:
    arity: int
    arg_kind: str  # "length" | "anchor"


INDICATORS: dict[str, IndicatorSpec] = {
    "EMA": IndicatorSpec(1, "length"),
    "SMA": IndicatorSpec(1, "length"),
    "RSI": IndicatorSpec(1, "length"),
    "ATR": IndicatorSpec(1, "length"),
    "ATR%": IndicatorSpec(1, "length"),
    "VOLMA": IndicatorSpec(1, "length"),
    "VOL": IndicatorSpec(0, "length"),
    "AVWAP": IndicatorSpec(1, "anchor"),
}

WRAPPERS: dict[str, int] = {"slope": 2, "highest": 2, "lowest": 2, "avg": 2}

CROSSES = ("crossAbove", "crossBelow")
COUNT = "count"

# The expr layer knows pattern NAMES only; all detection lives in
# auto_trader.indicators.candle_patterns (same arrangement as INDICATORS above,
# whose math lives in indicators/core.py).
PATTERN_FN_NAMES: tuple[str, ...] = tuple(_PATTERN_FNS)
