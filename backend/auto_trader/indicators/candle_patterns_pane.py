"""CANDLE_PATTERNS pane (registry type `CANDLE_PATTERNS`): one 0/1 output per
pattern id plus bullPattern / bearPattern, gated by the pane's toggles the way
frontend lib/indicators/candlePatterns.ts computeCandlePatterns gates drawing
(extendData.disabled, keyed by TOGGLE id). Detection is
candle_patterns.detect_all_patterns, already pinned bar for bar by
test_candle_patterns_parity.py. The toggle and label tables are copies of the
TS defs, pinned by test_candle_patterns_pane.py."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.candle_patterns import CANDLE_PATTERN_DEFS, detect_all_patterns
from auto_trader.indicators.vwap import _js_truthy

PATTERN_TOGGLES: dict[str, str] = {
    "bull_engulfing": "engulfing", "bear_engulfing": "engulfing", "pin_top": "pin_top",
    "pin_bottom": "pin_bottom", "doji": "doji", "inside": "inside", "outside": "outside",
    "bull_harami": "harami", "bear_harami": "harami", "piercing_line": "piercing",
    "dark_cloud_cover": "piercing", "morning_star": "star", "evening_star": "star",
    "bull_belt_hold": "belt_hold", "bear_belt_hold": "belt_hold", "three_white_soldiers": "soldiers",
    "three_black_crows": "soldiers", "three_stars_south": "stars_south", "stick_sandwich": "sandwich",
    "bull_meeting_line": "meeting_line", "bear_meeting_line": "meeting_line",
    "bull_kicking": "kicking", "bear_kicking": "kicking", "ladder_bottom": "ladder",
}
PATTERN_LABELS: dict[str, str] = {
    "bull_engulfing": "Bullish Engulfing", "bear_engulfing": "Bearish Engulfing", "pin_top": "Pin Top",
    "pin_bottom": "Pin Bottom", "doji": "Doji", "inside": "Inside Bar", "outside": "Outside Bar",
    "bull_harami": "Bullish Harami", "bear_harami": "Bearish Harami", "piercing_line": "Piercing Line",
    "dark_cloud_cover": "Dark Cloud Cover", "morning_star": "Morning Star", "evening_star": "Evening Star",
    "bull_belt_hold": "Bullish Belt Hold", "bear_belt_hold": "Bearish Belt Hold",
    "three_white_soldiers": "Three White Soldiers", "three_black_crows": "Three Black Crows",
    "three_stars_south": "Three Stars in the South", "stick_sandwich": "Stick Sandwich",
    "bull_meeting_line": "Bullish Meeting Line", "bear_meeting_line": "Bearish Meeting Line",
    "bull_kicking": "Bullish Kicking", "bear_kicking": "Bearish Kicking", "ladder_bottom": "Ladder Bottom",
}
AGGREGATES: tuple[str, ...] = ("bullPattern", "bearPattern")
# Same floor as the rule predicates (strategy/expr/warmup.py PATTERN_WARMUP);
# copied, not imported, because indicators/ must not import strategy/.
CANDLE_PATTERNS_WARMUP = 18
_POLARITY = {d.id: d.polarity for d in CANDLE_PATTERN_DEFS}
_TOGGLE_IDS = frozenset(PATTERN_TOGGLES.values())


@dataclass(frozen=True, slots=True)
class CandlePatternsConfig:
    disabled: tuple[str, ...]  # sorted toggle ids switched off


def parse_candle_patterns_config(calc_params: object, extend_data: object) -> CandlePatternsConfig:
    """Only the toggles change values; colors and showLabels are display."""
    ext = extend_data if isinstance(extend_data, dict) else {}
    raw = ext.get("disabled") if isinstance(ext.get("disabled"), dict) else {}
    return CandlePatternsConfig(disabled=tuple(sorted(t for t, v in raw.items() if t in _TOGGLE_IDS and _js_truthy(v))))


def _enabled(cfg: CandlePatternsConfig) -> list[str]:
    return [d.id for d in CANDLE_PATTERN_DEFS if PATTERN_TOGGLES[d.id] not in cfg.disabled]


def candle_patterns_outputs(cfg: CandlePatternsConfig) -> tuple[str, ...]:
    return (*_enabled(cfg), *AGGREGATES)


def candle_patterns_series(
    cfg: CandlePatternsConfig, output: str, candles: Sequence[Candle], bar_hours: float,
) -> list[float | None]:
    enabled = _enabled(cfg)
    if output == "bullPattern":
        wanted = frozenset(i for i in enabled if _POLARITY[i] == "bull")
    elif output == "bearPattern":
        wanted = frozenset(i for i in enabled if _POLARITY[i] == "bear")
    elif output in enabled:
        wanted = frozenset((output,))
    else:
        raise ValueError(f"unknown CANDLE_PATTERNS output {output!r}")
    return [1.0 if hits & wanted else 0.0 for hits in detect_all_patterns(candles)]


def candle_patterns_warmup(cfg: CandlePatternsConfig, output: str) -> int:
    return CANDLE_PATTERNS_WARMUP if output in candle_patterns_outputs(cfg) else 0
