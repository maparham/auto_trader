from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class IndicatorSpec:
    arity: int
    arg_kind: str  # "length" | "anchor"


INDICATORS: dict[str, IndicatorSpec] = {
    "EMA": IndicatorSpec(1, "length"),
    "SMA": IndicatorSpec(1, "length"),
    "RSI": IndicatorSpec(1, "length"),
    "ATR": IndicatorSpec(1, "length"),
    "VOLMA": IndicatorSpec(1, "length"),
    "VOL": IndicatorSpec(0, "length"),
    "AVWAP": IndicatorSpec(1, "anchor"),
}

WRAPPERS: dict[str, int] = {"slope": 2, "highest": 2, "lowest": 2, "avg": 2}

CROSSES = ("crossAbove", "crossBelow")
PREDICATES = ("bullish", "bearish")
COUNT = "count"
