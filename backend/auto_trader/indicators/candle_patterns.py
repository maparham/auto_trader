"""Candlestick pattern detection. The Python side of
frontend/src/lib/indicators/candlePatterns.ts — bar-for-bar identical, enforced
by tests/test_candle_patterns_parity.py against a golden fixture generated from
the TypeScript detector.

This module owns ALL pattern math. strategy/expr/ imports only CANDLE_PATTERN_DEFS,
PATTERN_FNS, and pattern_series from here (same arrangement as indicators/core.py
for EMA/RSI/ATR).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle


@dataclass(frozen=True, slots=True)
class CandlePatternDef:
    id: str
    fn: str            # camelCase predicate name used in rule expressions
    polarity: str      # "bull" | "bear" | "neutral"


# Order mirrors CANDLE_PATTERN_DEFS in candlePatterns.ts. The TS side keys
# operands by array index; here the id is the key, so order is documentation
# only — but keep it aligned to make diffs against the TS file readable.
CANDLE_PATTERN_DEFS: tuple[CandlePatternDef, ...] = (
    CandlePatternDef("bull_engulfing", "bullEngulfing", "bull"),
    CandlePatternDef("bear_engulfing", "bearEngulfing", "bear"),
    CandlePatternDef("pin_top", "pinTop", "bear"),
    CandlePatternDef("pin_bottom", "pinBottom", "bull"),
    CandlePatternDef("doji", "doji", "neutral"),
    CandlePatternDef("inside", "insideBar", "neutral"),
    CandlePatternDef("outside", "outsideBar", "neutral"),
    CandlePatternDef("bull_harami", "bullHarami", "bull"),
    CandlePatternDef("bear_harami", "bearHarami", "bear"),
    CandlePatternDef("piercing_line", "piercingLine", "bull"),
    CandlePatternDef("dark_cloud_cover", "darkCloudCover", "bear"),
    CandlePatternDef("morning_star", "morningStar", "bull"),
    CandlePatternDef("evening_star", "eveningStar", "bear"),
    CandlePatternDef("bull_belt_hold", "bullBeltHold", "bull"),
    CandlePatternDef("bear_belt_hold", "bearBeltHold", "bear"),
    CandlePatternDef("three_white_soldiers", "threeWhiteSoldiers", "bull"),
    CandlePatternDef("three_black_crows", "threeBlackCrows", "bear"),
    CandlePatternDef("three_stars_south", "threeStarsSouth", "bull"),
    CandlePatternDef("stick_sandwich", "stickSandwich", "bull"),
    CandlePatternDef("bull_meeting_line", "bullMeetingLine", "bull"),
    CandlePatternDef("bear_meeting_line", "bearMeetingLine", "bear"),
    CandlePatternDef("bull_kicking", "bullKicking", "bull"),
    CandlePatternDef("bear_kicking", "bearKicking", "bear"),
    CandlePatternDef("ladder_bottom", "ladderBottom", "bull"),
)

# Sentinels for the two aggregate predicates (not real pattern ids).
ANY_BULL = "@bull"
ANY_BEAR = "@bear"

PATTERN_FNS: dict[str, str] = {
    **{d.fn: d.id for d in CANDLE_PATTERN_DEFS},
    "bullPattern": ANY_BULL,
    "bearPattern": ANY_BEAR,
}

_BULL_IDS = frozenset(d.id for d in CANDLE_PATTERN_DEFS if d.polarity == "bull")
_BEAR_IDS = frozenset(d.id for d in CANDLE_PATTERN_DEFS if d.polarity == "bear")


def eps_series(bars: Sequence[Candle]) -> list[float]:
    """eps[i] = 0.05 * SMA14 of true range up to and including bar i. Before 14
    true ranges exist, falls back to 1e-4 * close (index data has no fixed tick).
    """
    eps: list[float] = []
    trs: list[float] = []
    total = 0.0
    for i, b in enumerate(bars):
        pc = bars[i - 1].close if i > 0 else b.close
        tr = max(b.high - b.low, abs(b.high - pc), abs(b.low - pc))
        trs.append(tr)
        total += tr
        if len(trs) > 14:
            total -= trs[-15]
        eps.append(0.05 * (total / 14) if len(trs) >= 14 else 1e-4 * b.close)
    return eps


def _eq(a: float, b: float, e: float) -> bool:
    return abs(a - b) <= e


def detect_all_patterns(bars: Sequence[Candle]) -> list[frozenset[str]]:
    """hits[i] = every pattern id matching at bar i, with no enable filtering.
    Unlike engine.context_features.classify_candle (first-match, single label),
    every matching pattern is reported — rule operands are independent.
    """
    n = len(bars)
    eps = eps_series(bars)
    out: list[frozenset[str]] = []

    for i in range(n):
        s: set[str] = set()
        e = eps[i]

        # Pine-style back-indexers: k=0 is bar i, k=1 is i-1. Each block below
        # is guarded by the lookback it needs.
        def o(k: int, _i: int = i) -> float:
            return bars[_i - k].open

        def h(k: int, _i: int = i) -> float:
            return bars[_i - k].high

        def lo(k: int, _i: int = i) -> float:
            return bars[_i - k].low

        def cl(k: int, _i: int = i) -> float:
            return bars[_i - k].close

        bar = bars[i]
        body = abs(bar.close - bar.open)
        rng = bar.high - bar.low

        if i >= 1:
            prev = bars[i - 1]
            p_hi = max(prev.open, prev.close)
            p_lo = min(prev.open, prev.close)
            b_hi = max(bar.open, bar.close)
            b_lo = min(bar.open, bar.close)
            prev_down = prev.close < prev.open
            prev_up = prev.close > prev.open

            if bar.close > bar.open and prev_down and b_lo <= p_lo and b_hi >= p_hi:
                s.add("bull_engulfing")
            if bar.close < bar.open and prev_up and b_lo <= p_lo and b_hi >= p_hi:
                s.add("bear_engulfing")

            # pin_top / pin_bottom keep the TS guard nesting (inside `i >= 1`).
            if rng > 0:
                upper = bar.high - max(bar.open, bar.close)
                lower = min(bar.open, bar.close) - bar.low
                if upper >= 2 * body and min(bar.open, bar.close) <= bar.low + rng / 3:
                    s.add("pin_top")
                if lower >= 2 * body and max(bar.open, bar.close) >= bar.high - rng / 3:
                    s.add("pin_bottom")

            if bar.high < prev.high and bar.low > prev.low:
                s.add("inside")
            if bar.high > prev.high and bar.low < prev.low:
                s.add("outside")

        # doji sits outside the prev block, matching the TS source.
        if rng > 0 and body <= 0.1 * rng:
            s.add("doji")

        if i >= 2:
            if (o(1) > cl(1) and cl(1) < cl(2) and o(0) > cl(1) and o(0) < o(1)
                    and cl(0) > cl(1) and cl(0) < o(1) and h(0) < h(1) and lo(0) > lo(1)
                    and cl(0) >= o(0)):
                s.add("bull_harami")
            if (o(1) < cl(1) and cl(1) > cl(2) and o(0) < cl(1) and o(0) > o(1)
                    and cl(0) < cl(1) and cl(0) > o(1) and h(0) < h(1) and lo(0) > lo(1)
                    and cl(0) <= o(0)):
                s.add("bear_harami")
            if cl(2) > cl(1) and o(0) < lo(1) and cl(0) > (o(1) + cl(1)) / 2 and cl(0) < o(1):
                s.add("piercing_line")
            if cl(2) < cl(1) and o(0) > h(1) and cl(0) < (o(1) + cl(1)) / 2 and cl(0) > o(1):
                s.add("dark_cloud_cover")
            if (o(2) > cl(2) and o(1) > cl(2) and o(1) < cl(1) and o(0) > cl(1)
                    and o(0) > cl(0) and _eq(cl(0), cl(2), e)):
                s.add("stick_sandwich")
            if (o(2) > cl(2) and o(1) > cl(1) and _eq(cl(1), cl(0), e)
                    and o(0) < cl(0) and o(1) >= h(0)):
                s.add("bull_meeting_line")
            if (o(2) < cl(2) and o(1) < cl(1) and _eq(cl(1), cl(0), e)
                    and o(0) > cl(0) and o(1) <= lo(0)):
                s.add("bear_meeting_line")

        if i >= 1:
            if (cl(1) < o(1) and lo(1) > o(0) and cl(1) > o(0)
                    and _eq(o(0), lo(0), e) and cl(0) > o(0)):
                s.add("bull_belt_hold")
            if (cl(1) > o(1) and h(1) < o(0) and cl(1) < o(0)
                    and _eq(o(0), h(0), e) and cl(0) < o(0)):
                s.add("bear_belt_hold")
            if (o(1) > cl(1) and _eq(o(1), h(1), e) and _eq(cl(1), lo(1), e)
                    and o(0) > o(1) and _eq(o(0), lo(0), e) and _eq(cl(0), h(0), e)
                    and cl(0) - o(0) > o(1) - cl(1)):
                s.add("bull_kicking")
            if (o(1) < cl(1) and _eq(o(1), lo(1), e) and _eq(cl(1), h(1), e)
                    and o(0) < o(1) and _eq(o(0), h(0), e) and _eq(cl(0), lo(0), e)
                    and o(0) - cl(0) > cl(1) - o(1)):
                s.add("bear_kicking")

        if i >= 3:
            if (cl(3) > cl(2) and cl(2) < o(2) and o(1) < cl(2) and cl(1) < cl(2)
                    and o(0) > o(1) and o(0) > cl(1) and cl(0) > cl(2)
                    and o(2) - cl(2) > cl(0) - o(0)):
                s.add("morning_star")
            if (cl(3) < cl(2) and cl(2) > o(2) and o(1) > cl(2) and cl(1) > cl(2)
                    and o(0) < o(1) and o(0) < cl(1) and cl(0) < cl(2)
                    and cl(2) - o(2) > o(0) - cl(0)):
                s.add("evening_star")
            if (cl(3) < o(3) and o(2) < cl(3) and cl(2) > o(2) and o(1) > o(2)
                    and o(1) < cl(2) and cl(1) > o(1) and o(0) > o(1) and o(0) < cl(1)
                    and cl(0) > o(0) and h(1) > h(2) and h(0) > h(1)):
                s.add("three_white_soldiers")
            if (cl(3) > o(3) and o(2) > cl(3) and cl(2) < o(2) and o(1) < o(2)
                    and o(1) > cl(2) and cl(1) < o(1) and o(0) < o(1) and o(0) > cl(1)
                    and cl(0) < o(0) and lo(1) < lo(2) and lo(0) < lo(1)):
                s.add("three_black_crows")
            if (o(3) > cl(3) and o(2) > cl(2) and _eq(o(2), h(2), e) and o(1) > cl(1)
                    and o(1) < o(2) and o(1) > cl(2) and lo(1) > lo(2)
                    and _eq(o(1), h(1), e) and o(0) > cl(0) and o(0) < o(1)
                    and o(0) > cl(1) and _eq(o(0), h(0), e) and _eq(cl(0), lo(0), e)
                    and cl(0) >= lo(1)):
                s.add("three_stars_south")

        if i >= 4:
            if (o(4) > cl(4) and o(3) > cl(3) and o(3) < o(4) and o(2) > cl(2)
                    and o(2) < o(3) and o(1) > cl(1) and o(1) < o(2) and o(0) < cl(0)
                    and o(0) > o(1) and lo(4) > lo(3) and lo(3) > lo(2) and lo(2) > lo(1)):
                s.add("ladder_bottom")

        out.append(frozenset(s))

    return out


def pattern_series(bars: Sequence[Candle], fn: str) -> list[float]:
    """1.0 where `fn` matches, else 0.0. Float rather than bool so the result
    feeds indicators.mtf.align_htf_to_base unchanged for @tf-pinned rules.

    Raises KeyError for an unknown predicate name (validation should have caught
    it long before evaluation).

    Deliberately NOT memoized, unlike the TS side's detectCache WeakMap: a
    strategy with several pattern rows re-runs the 24-condition sweep once per
    row. evaluate.py caches per condition node where it matters (the per-bar
    path). Revisit if profiling shows the sweep is hot.
    """
    target = PATTERN_FNS[fn]
    hits = detect_all_patterns(bars)
    if target == ANY_BULL:
        return [1.0 if s & _BULL_IDS else 0.0 for s in hits]
    if target == ANY_BEAR:
        return [1.0 if s & _BEAR_IDS else 0.0 for s in hits]
    return [1.0 if target in s else 0.0 for s in hits]
