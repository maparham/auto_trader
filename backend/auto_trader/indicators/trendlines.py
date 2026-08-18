"""TRENDLINES: major sloping support/resistance lines from confirmed fractal
pivots. Ported operation-for-operation from
frontend/src/lib/indicators/trendlines.ts (computeTrendlines) and
frontend/src/lib/indicators/trendlinesOutputs.ts (parseTrendlinesConfig /
trendlinesWarmup).

Validity here is a BOOLEAN THAT GATES SET MEMBERSHIP, not a number: a 1-ULP
disagreement with the TS deletes a line and changes the whole output set from
that bar forward. That is why every side test multiplies through by the exact
positive integer (i2 - i1) instead of computing a slope. Division survives only
in project_at, whose output is a price that can drift harmlessly.

Do NOT "improve" the arithmetic (see core.py's parity contract). Values at index
i depend only on inputs [0..i] — no lookahead by construction: a strict fractal
pivot at bar i only exists at its confirm bar i + pivot_len, every line is
seeded at a confirm bar, and break detection at bar i only tests lines whose
anchors precede i.

Chart-timeframe only (v1 has no MTF), so the registry pins timeframe to None.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series  # NOT .atr — sr_levels.py uses this one

TL_ATR_LEN = 14

# DEFAULT for how many earlier same-side pivots a new pivot pairs with (frontend
# MAX_PAIR_PIVOTS); the live value is cfg.pair_pivots. Bounds the run at
# O(P * n) instead of O(P^2), and bounds how far back a line can reach.
#
# COUNTED IN PIVOTS, NOT BARS: anything that removes pivots (a higher pivot_len,
# min_swing_atr, min_swing_reach) makes these slots reach FURTHER BACK in time,
# so NEW lines can appear from a stricter setting.
MAX_PAIR_PIVOTS = 20

# Live state keeps this multiple of max_lines per side, so a line that is
# temporarily outranked is not destroyed and can return when it gains a touch.
MAX_LIVE_MULT = 4

# Name transliterates the TS TRENDLINES_OUTPUTS exactly, like every other symbol
# in this feature — grep for one and you find both.
TRENDLINES_OUTPUTS: tuple[str, ...] = (
    "tl_support",
    "tl_resistance",
    "tl_broken_support",
    "tl_broken_resistance",
)

# [pivot_len, viol_mult, touch_mult, min_touches, min_span_bars, max_proj_bars,
#  break_hold_bars, max_lines, min_swing_atr, min_swing_reach, pair_pivots,
#  max_touches, max_span_bars, max_slope_atr, min_slope_atr, min_back_bars] —
#  TRENDLINES_DEFAULTS in
#  trendlinesOutputs.ts.
_DEFAULTS = (5, 0.25, 0.75, 2, 20, 250, 30, 3, 0.0, 0, MAX_PAIR_PIVOTS, 0, 0, 0.0, 0.0, 10)

Side = Literal["support", "resistance"]

# RESISTANCE FIRST, deliberately, and the OPPOSITE order from
# TRENDLINES_OUTPUTS. This is the TS `SIDES` array: it fixes the order
# candidates are appended to `lines` and the order the per-side live cap runs
# in, both of which feed the stable sort's tie-break. Do not alphabetise.
SIDES: tuple[Side, ...] = ("resistance", "support")


@dataclass(frozen=True, slots=True)
class TrendlinesConfig:
    pivot_len: int  # fractal lookback each side; confirm lag = this many bars
    viol_mult: float  # pierce tolerance as a multiple of ATR(14)
    touch_mult: float  # touch tolerance as a multiple of ATR(14)
    min_touches: int  # touches before a line is major (2 = anchors only)
    min_span_bars: int  # minimum span before a line is major
    max_proj_bars: int  # how far past its last touch an unbroken line stays live
    break_hold_bars: int  # how long a broken line keeps emitting
    max_lines: int  # sizes live state (x MAX_LIVE_MULT), per side
    # How far a pivot must stand out from the AVERAGE of its own window, as a
    # multiple of ATR(14), before it counts as a swing at all. 0 = off.
    min_swing_atr: float
    # Bars a pivot must dominate to its LEFT, on top of the fractal window.
    # 0 = off, and so is anything <= pivot_len. LEFT ONLY: right reach keeps
    # growing after the pivot confirms, so gating on it would repaint.
    min_swing_reach: int
    pair_pivots: int  # earlier same-side pivots a new pivot pairs with
    max_touches: int  # upper bound on touches; 0 = no limit
    max_span_bars: int  # upper bound on span; 0 = no limit
    max_slope_atr: float  # ceiling on steepness, ATR(14) per bar; 0 = no limit
    min_slope_atr: float  # floor on steepness, same units; 0 = no floor
    # Bars before the FIRST anchor that must sit on the line's own side of it,
    # within the Max Pierce tolerance. 0 = off, and the only gate here whose
    # DEFAULT is not off. See _has_back_clearance.
    min_back_bars: int


@dataclass(slots=True)
class TrendLine:
    """Two anchor pivots; the line NEVER rotates once defined. Later touches
    move last_touch_idx (extending coverage) but never i2/p2.

    NO touch_idxs HERE, deliberately, though the TS carries one. It records the
    bars that touched so the chart can ring them, no gate reads it, and it
    cannot move an emitted value — draw-time state, like lineKey and
    selectDrawnLines, which this port has no counterpart for either."""

    side: Side
    i1: int  # first anchor bar index
    p1: float  # first anchor price (high for resistance, low for support)
    i2: int  # second anchor bar index (i2 > i1)
    p2: float
    touches: int
    last_touch_idx: int  # seeded to i2, only ever moves forward
    broken_idx: int | None  # bar that pierced it, once one has


def parse_trendlines_config(calc_params: object, extend_data: object) -> TrendlinesConfig:
    """Mirrors TS parseTrendlinesConfig.

    `extend_data` is UNUSED ON PURPOSE. The only extendData field TRENDLINES
    carries is the render-only `extend` option, and collectExprInstances ships
    it here unconditionally; the settings copy promises Extend is "drawing only"
    and "cannot alter a strategy", which stays true only while nothing in this
    function reads it. v1 also has no MTF, so there is no timeframe to pull.

    Number coercion diverges from the TS on null, "" and [] — Number() makes
    each 0 (which passes viol_mult's >= 0 rule) whereas float() raises and we
    fall back to the default — and on other strings float() rejects but
    Number() does not, such as whitespace-only " " (0) and "0x10" (16). A few
    go the other way, e.g. float("1_0") is 10.0 while Number("1_0") is NaN.
    False is NOT one of them: float(False) == 0.0, so both runtimes agree.
    None of these are reachable from the settings modal.

    A huge int literal AGREES: float(10**400) raises OverflowError and we fall
    back to the default, while Number(10**400) is Infinity and the TS's
    isFinite check falls back too. Reachable only from a hand-written API
    payload, and caught rather than raised so that payload gets the default
    instead of a 500.
    """
    p: list[Any] = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    d = _DEFAULTS

    def num_at(i: int, default: float, allow_zero: bool) -> float:
        try:
            v = float(p[i])
        except (IndexError, OverflowError, TypeError, ValueError):
            # OverflowError is float()'s answer to a huge INT literal
            # (float(10**400)), which no settings modal can produce but a
            # hand-written API payload can. The TS gives Infinity there, which
            # its own isFinite check sends to the default, so catching it is
            # what keeps the two runtimes agreeing instead of 500ing.
            return default
        if not math.isfinite(v):
            return default
        return v if (v >= 0 if allow_zero else v > 0) else default

    def int_at(i: int, default: float) -> int:
        return max(1, math.floor(num_at(i, default, False)))

    return TrendlinesConfig(
        pivot_len=int_at(0, d[0]),
        # viol_mult takes ZERO (exact containment, the strictest setting), so it
        # alone validates on >= 0.
        viol_mult=num_at(1, d[1], True),
        touch_mult=num_at(2, d[2], False),
        # A line is defined by two anchor pivots, so it cannot exist with fewer.
        min_touches=max(2, math.floor(num_at(3, d[3], False))),
        min_span_bars=int_at(4, d[4]),
        max_proj_bars=int_at(5, d[5]),
        break_hold_bars=int_at(6, d[6]),
        max_lines=int_at(7, d[7]),
        # ZERO like viol_mult, and for the same reason spelled out in the TS:
        # on a `> 0` rule a stored 0 would fall back to the default, so the
        # gate could never be switched off.
        min_swing_atr=num_at(8, d[8], True),
        # Floored like the integer params but clamped to 0, not 1: int_at's
        # floor of 1 would make the off state unreachable, and 1 is a no-op.
        min_swing_reach=max(0, math.floor(num_at(9, d[9], True))),
        pair_pivots=int_at(10, d[10]),
        # Clamped to 0, not 1, like min_swing_reach: 0 is the off state and
        # int_at would make it unreachable.
        max_touches=max(0, math.floor(num_at(11, d[11], True))),
        max_span_bars=max(0, math.floor(num_at(12, d[12], True))),
        max_slope_atr=num_at(13, d[13], True),
        min_slope_atr=num_at(14, d[14], True),
        # Clamped to 0, not 1, like min_swing_reach: 0 is the off state and
        # int_at would make it unreachable. Its DEFAULT is not the off state,
        # so a chart saved before this param existed gets the gate at 10, which
        # is intended.
        min_back_bars=max(0, math.floor(num_at(15, d[15], True))),
    )


def project_at(line: TrendLine, j: int) -> float:
    """The line's price at bar j. The ONLY division in this module: its output
    is a price that drifts harmlessly, not a gate. It does feed the
    nearest-to-the-close comparison, so keep the operation order exact."""
    return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1)


def pierces(line: TrendLine, j: int, price: float, viol_tol: float) -> bool:
    """True when bar j's extreme goes beyond the line by more than viol_tol.

    Cross-multiplied: with span = i2 - i1 an exact positive integer,
      (price - p1) * span  vs  (p2 - p1) * (j - i1) +/- viol_tol * span
    is the same inequality as comparing price against the projected value, with
    one rounding source removed."""
    span = line.i2 - line.i1
    lhs = (price - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    tol = viol_tol * span
    if line.side == "resistance":
        return lhs > rhs + tol
    return lhs < rhs - tol


def in_touch_band(
    line: TrendLine, j: int, price: float, viol_tol: float, touch_tol: float
) -> bool:
    """Asymmetric on purpose: for resistance the band is
    [line - touch_tol, line + viol_tol], so the far edge of the touch zone
    cannot reach into the pierce zone."""
    span = line.i2 - line.i1
    lhs = (price - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    out = viol_tol * span
    inn = touch_tol * span
    if line.side == "resistance":
        return lhs >= rhs - inn and lhs <= rhs + out
    return lhs >= rhs - out and lhs <= rhs + inn



def within_slope(line: TrendLine, atr_at: float, mult: float) -> bool:
    """Mirrors TS withinSlope.

    A line's slope is fixed the moment it is defined and never rotates, so this
    is asked once at seed time: a candidate that fails can never come to pass,
    and one that passes can never come to fail. That is why this gate DELETES
    where the touch and span ceilings only silence.

    No quotient: both sides multiply through by span, an exact positive integer,
    rather than comparing abs(p2 - p1) / span against the threshold.
    """
    if mult <= 0:
        return True
    span = line.i2 - line.i1
    rise = line.p2 - line.p1
    return abs(rise) <= mult * atr_at * span


def above_slope(line: TrendLine, atr_at: float, mult: float) -> bool:
    """Mirrors TS aboveSlope: the floor to within_slope's ceiling.

    A line flat enough to be a horizontal shelf is not a trendline; sr_levels
    already draws those, properly, as levels. Same cross-multiplied form.
    """
    if mult <= 0:
        return True
    span = line.i2 - line.i1
    rise = line.p2 - line.p1
    return abs(rise) >= mult * atr_at * span


def rank_key(line: TrendLine) -> tuple[int, int, int, int, float]:
    """Reproduces TS rankLines as a total-order sort key: strongest, then
    longest, then most recent, then oldest origin, then lowest anchor price. p1
    is a STORED price, never a projected one, so ranking cannot depend on which
    bar it runs at."""
    return (
        -line.touches,
        -(line.last_touch_idx - line.i1),
        -line.last_touch_idx,
        line.i1,
        line.p1,
    )


def _is_pivot_at(values: Sequence[float], i: int, lb_l: int, lb_r: int, want: str) -> bool:
    """Mirrors TS isPivotAt with strict=True: the pivot must be strictly beyond
    every neighbour, so a flat top or bottom does not register."""
    if i - lb_l < 0 or i + lb_r >= len(values):
        return False
    v = values[i]
    for j in range(i - lb_l, i + lb_r + 1):
        if j == i:
            continue
        w = values[j]
        if want == "low":
            if w <= v:
                return False
        else:
            if w >= v:
                return False
    return True



def _is_significant_swing(
    highs: Sequence[float],
    lows: Sequence[float],
    opposite_pool: Sequence[int],
    k: int,
    side: str,
    atr_k: float,
    mult: float,
) -> bool:
    """Mirrors TS isSignificantSwing.

    The fractal test only asks about SHAPE; this adds SIZE, measured as the LEG:
    the distance from this pivot to the most recent pivot on the OTHER side.

    NOT against the fractal window's average, which an earlier version used and
    which coupled this setting to pivot_len (a wider window pulls the average
    further from the pivot, so measured size grew with pivot_len and a stricter
    pivot_len could ADD lines). The leg has no such coupling.

    LEFT ONLY, and causal: that opposite pivot is at some h < k, so it confirmed
    strictly before this pivot's confirm bar. No opposite pivot yet is a REJECT
    (unmeasurable is not big), and a negative leg fails the same comparison
    without a special case.
    """
    if mult <= 0:
        return True
    # Strictly before k: one bar can be both a strict high and a strict low
    # pivot (a lone spike), and the resistance pool fills before the support one
    # within a confirm bar.
    h = -1
    for q in range(len(opposite_pool) - 1, -1, -1):
        if opposite_pool[q] < k:
            h = opposite_pool[q]
            break
    if h < 0:
        return False
    leg = highs[k] - lows[h] if side == "resistance" else highs[h] - lows[k]
    return leg >= mult * atr_k


def _has_swing_reach(vals: Sequence[float], k: int, side: str, bars: int) -> bool:
    """Mirrors TS hasSwingReach.

    pivot_len thresholds strength and throws the measurement away: at length 5 a
    bar that beats 40 bars each side and one that just wins its 5 register
    identically. This asks for the reach itself, without lengthening the confirm
    lag the way raising pivot_len would.

    LEFT ONLY, not an approximation: right reach keeps growing after the pivot
    confirms, so gating on it would change a line's strength under a bar already
    emitted. Scans at most `bars` back, since the answer is a yes or no, and
    rejects off the start of the series the way _is_pivot_at does."""
    if bars <= 0:
        return True
    if k - bars < 0:
        return False
    for j in range(k - bars, k):
        if (vals[j] >= vals[k]) if side == "resistance" else (vals[j] <= vals[k]):
            return False
    return True


def _has_back_clearance(
    line: TrendLine,
    vals: Sequence[float],
    atr: Sequence[float | None],
    viol_mult: float,
    bars: int,
) -> bool:
    """Mirrors TS hasBackClearance.

    Seeding validates a candidate over (i1, i] and never looks BEFORE i1, so a
    pair whose angle has nothing to do with the trend passes as long as its
    wrong side is in the past. This is that same pierce test run backwards over
    the `bars` bars before the first anchor, at the same Max Pierce tolerance.

    It does not merely delete: the freed pairing slots refill, so the detector
    picks a better FIRST anchor for the same trend.

    A FLAT BAR COUNT, not a fraction of the span. Rejects off the start of the
    series the way _is_pivot_at and _has_swing_reach do. A bar whose ATR has not
    warmed up cannot be tested, so it counts as surviving, exactly as the
    forward pass treats it. At most `bars` iterations, which is why it is asked
    before the O(span) forward walk."""
    if bars <= 0:
        return True
    if line.i1 - bars < 0:
        return False
    for j in range(line.i1 - 1, line.i1 - bars - 1, -1):
        tol_j = atr[j]
        if tol_j is None:
            continue
        if pierces(line, j, vals[j], viol_mult * tol_j):
            return False
    return True


def is_live(line: TrendLine, i: int, cfg: TrendlinesConfig) -> bool:
    """Not aged out past its projection horizon, and if broken, still inside the
    hold window."""
    if line.broken_idx is not None:
        return i - line.broken_idx <= cfg.break_hold_bars
    return i - line.last_touch_idx <= cfg.max_proj_bars


def over_ceilings(line: TrendLine, cfg: TrendlinesConfig) -> bool:
    """Mirrors TS overCeilings: the line has grown past Max Touches or Max Span
    (0 = no limit on either).

    SILENCES, does not delete: touches and span only ever grow, so a line that
    crossed a ceiling can never come back. is_major stops reading it and the
    chart stops painting it, but it stays in live state for the pierce and touch
    passes. Contrast the slope gates, which delete at seed time.

    Also the live cap's FIRST sort key (step 3). Without that the ceilings
    starve their own side: rank_key's first two components are touches and span,
    exactly what these reject, so the rejects took the front of the
    MAX_LIVE_MULT * max_lines slots and evicted the lines still able to emit.
    """
    if cfg.max_touches > 0 and line.touches > cfg.max_touches:
        return True
    if cfg.max_span_bars > 0 and line.last_touch_idx - line.i1 > cfg.max_span_bars:
        return True
    return False


def is_major(line: TrendLine, i: int, cfg: TrendlinesConfig) -> bool:
    """Enough touches, enough span, and covering this bar. The ONLY gate on the
    operand path (there is deliberately no cap-by-rank; see compute_trendlines).

    TWO INDEPENDENT CLOCKS, and they must NOT intersect. max_proj_bars ages an
    UNBROKEN line forward from last_touch_idx; break_hold_bars holds a BROKEN
    one forward from broken_idx, and is_live owns that second clock ALONE. So
    once a line is broken this function stops applying max_proj_bars entirely —
    intersecting them truncates the retest window to a single bar at stock
    defaults, or to nothing when max_proj_bars < break_hold_bars."""
    if line.touches < cfg.min_touches:
        return False
    if over_ceilings(line, cfg):
        return False
    span = line.last_touch_idx - line.i1
    if span < cfg.min_span_bars:
        return False
    if line.broken_idx is not None:
        return i >= line.i1
    return i >= line.i1 and i <= line.last_touch_idx + cfg.max_proj_bars


def compute_trendlines(
    candles: Sequence[Candle], cfg: TrendlinesConfig
) -> tuple[list[dict[str, float]], list[TrendLine]]:
    """Transliteration of TS computeTrendlines: same loop order, same branch
    order, same arithmetic order. Returns (points, live lines)."""
    n = len(candles)
    points: list[dict[str, float]] = [{} for _ in range(n)]
    if n == 0:
        return points, []

    atr = atr_series(candles, TL_ATR_LEN)
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    pools: dict[str, list[int]] = {"resistance": [], "support": []}
    # EVERY confirmed fractal pivot, including the ones the size and reach gates
    # reject. `pools` holds only survivors (what may seed a line); this holds the
    # turning points, because the leg min_swing_atr measures runs to the previous
    # turn whether or not that turn was big enough to trade. Using `pools` here
    # DEADLOCKS the indicator: the first pivot has no opposite pivot, so it is
    # rejected, so it never enters the pool, so the next has no opposite either.
    turns: dict[str, list[int]] = {"resistance": [], "support": []}
    lines: list[TrendLine] = []

    def extreme_of(side: str, j: int) -> float:
        return highs[j] if side == "resistance" else lows[j]

    for i in range(n):
        a = atr[i]

        # 1. PER-BAR break test. Runs every bar, not only at confirm bars: a
        #    line is almost always broken by an ordinary bar. Still causal —
        #    every anchor of every line tested here precedes i.
        if a is not None:
            for line in lines:
                if line.broken_idx is not None:
                    continue
                # UNREACHABLE BY CONSTRUCTION, kept as a guard rail (mirrors the
                # TS). A line is created at its confirm bar c = i2 + pivot_len
                # and step 1 runs before step 2, so this loop first sees the
                # line at c + 1, already > i2.
                if i <= line.i2:
                    continue
                if pierces(line, i, extreme_of(line.side, i), cfg.viol_mult * a):
                    line.broken_idx = i

        # 2. CONFIRM-BAR work for the pivot at bar k = i - pivot_len.
        k = i - cfg.pivot_len
        if k >= 0 and a is not None:
            for side in SIDES:
                vals = highs if side == "resistance" else lows
                want = "high" if side == "resistance" else "low"
                if not _is_pivot_at(vals, k, cfg.pivot_len, cfg.pivot_len, want):
                    continue
                turns[side].append(k)
                # The size gate sits HERE, above everything else this bar does,
                # so a rejected bar is not a pivot in any sense: no line seeded
                # (2b), no touch counted (2a), and no pool entry, so no LATER
                # pivot can pair with it either. touches is rank_key's primary
                # key, so a smaller pool reorders the live cap and moves the
                # emitted values — the point of the setting, not a leak.
                #
                # atr[k], not `a` = atr[i]: atr[i] can be warm while atr[k] is
                # still None, for any k in the pivot_len bars before warm-up
                # ends. WHOLE BLOCK behind min_swing_atr > 0 so that off means
                # untouched — hoisting the None check out drops those early
                # pivots even at 0, which the parity golden catches.
                if cfg.min_swing_atr > 0:
                    atr_k = atr[k]
                    if atr_k is None:
                        continue
                    opposite = turns["support" if side == "resistance" else "resistance"]
                    if not _is_significant_swing(
                        highs, lows, opposite, k, side, atr_k, cfg.min_swing_atr
                    ):
                        continue
                # Duration, after size. Two independent gates: a swing can be
                # deep and brief (a spike) or long and shallow (a drift), and
                # each setting rejects one of them.
                if not _has_swing_reach(vals, k, side, cfg.min_swing_reach):
                    continue
                pool = pools[side]
                price = vals[k]

                # 2a. Test the new pivot against every existing line on this
                #     side. NOTE the tolerance comes from atr[k], NOT `a`: k can
                #     precede ATR warm-up even when atr[i] is warm.
                for line in lines:
                    if line.side != side:
                        continue
                    if k <= line.i2:
                        continue
                    if line.broken_idx is not None:
                        continue
                    tol_a = atr[k]
                    if tol_a is None:
                        continue
                    if in_touch_band(
                        line, k, price, cfg.viol_mult * tol_a, cfg.touch_mult * tol_a
                    ):
                        line.touches += 1
                        line.last_touch_idx = k

                # 2b. Seed candidates against the previous MAX_PAIR_PIVOTS
                #     pivots. `pool.append(k)` happens AFTER this loop, so every
                #     i1 read here is strictly less than i2 = k: that is what
                #     keeps span positive, and both geometry gates silently
                #     invert if it ever stops being true.
                frm = max(0, len(pool) - cfg.pair_pivots)
                for q in range(frm, len(pool)):
                    i1 = pool[q]
                    # NO DUPLICATE CHECK, and none is needed: every stored i2 is
                    # an earlier confirm bar and this bar's pool entries are
                    # distinct, so (side, i1, i2) cannot be built twice. The
                    # defensive scan that used to sit here fired zero times and
                    # cost a quarter of the run; the TS suite asserts the
                    # invariant instead.
                    cand = TrendLine(
                        side=side,
                        i1=i1,
                        p1=vals[i1],
                        i2=k,
                        p2=price,
                        touches=2,
                        last_touch_idx=k,
                        broken_idx=None,
                    )
                    # Slope first: one comparison, where the validation below
                    # walks every bar back to i1. Seed time is the only time it
                    # needs asking, since the line never rotates.
                    if cfg.max_slope_atr > 0 or cfg.min_slope_atr > 0:
                        atr_k = atr[k]
                        if atr_k is None:
                            continue
                        if not within_slope(cand, atr_k, cfg.max_slope_atr):
                            continue
                        if not above_slope(cand, atr_k, cfg.min_slope_atr):
                            continue
                    # Then the backward clearance, still before the forward
                    # walk: bounded by min_back_bars where the walk below is
                    # O(span). Reads ONLY bars before i1, so it is fixed the
                    # moment the line is defined and cannot repaint.
                    if not _has_back_clearance(
                        cand, vals, atr, cfg.viol_mult, cfg.min_back_bars
                    ):
                        continue
                    # Validate over (i1, c]: bars between the anchors AND the
                    # bars since the second anchor, which are real bars that
                    # could already have pierced it. Anchor bars are excluded.
                    ok = True
                    for j in range(i1 + 1, i + 1):
                        if j == k:
                            continue
                        tol_j = atr[j]
                        if tol_j is None:
                            continue
                        if pierces(cand, j, extreme_of(side, j), cfg.viol_mult * tol_j):
                            ok = False
                            break
                    if not ok:
                        continue
                    # Retro-count touches from pivots already in the pool
                    # between the anchors. Not lookahead: each confirmed before
                    # i. The pool is in strictly increasing bar order and i1 IS
                    # pool[q], so the window (i1, k) starts at q + 1 and ends at
                    # the first entry reaching k; scanning the whole pool meant
                    # a walk that grew with the series, per candidate.
                    for q2 in range(q + 1, len(pool)):
                        pj = pool[q2]
                        if pj >= k:
                            break
                        tol_p = atr[pj]
                        if tol_p is None:
                            continue
                        if in_touch_band(
                            cand, pj, vals[pj], cfg.viol_mult * tol_p, cfg.touch_mult * tol_p
                        ):
                            cand.touches += 1
                    lines.append(cand)
                pool.append(k)

            # 3. Prune the dead, then cap live state by rank. This is
            #    cfg.max_lines' only use inside the detector: it sizes live
            #    state via MAX_LIVE_MULT. (The chart's own cap on the DRAWN set
            #    is selectDrawnLines, draw-time only, with no Python twin.)
            #
            #    Identity sets, not value sets: TrendLine is mutable and two
            #    lines can compare equal, exactly as the TS `new Set` keys on
            #    object identity.
            # Rebuilt only when something actually died: this runs at every
            # confirm bar and the list is usually untouched.
            if any(not is_live(line, i, cfg) for line in lines):
                lines = [line for line in lines if is_live(line, i, cfg)]
            cap = MAX_LIVE_MULT * cfg.max_lines
            for side in SIDES:
                # CEILING-FAILED LINES SORT LAST, ahead of every rank_key
                # component: they can never re-qualify, so holding slots would
                # evict lines that CAN still emit (see over_ceilings).
                mine = [line for line in lines if line.side == side]
                # Under the cap there is nothing to drop, so the sort cannot
                # change which lines survive and is pure cost. On most bars
                # this is the branch taken.
                if len(mine) <= cap:
                    continue
                mine.sort(key=lambda line: (over_ceilings(line, cfg), rank_key(line)))
                keep = {id(line) for line in mine[:cap]}
                lines = [line for line in lines if line.side != side or id(line) in keep]

        # 4. Emit. Membership is gated (live + major); selection is nearest to
        #    the close, the same reading as SR_LEVELS.
        #
        #    NO CAP-BY-RANK HERE, and that is the whole point. Taking the top
        #    cfg.max_lines by rank before nearest-selection is SR_LEVELS' idiom,
        #    safe only for HORIZONTAL levels; a sloping line projected 250 bars
        #    produces a number with no relationship to price, and rank actively
        #    favours exactly those old lines. On DXY monthly the cap threw away
        #    the live post-2022 downtrend at 106.6 and emitted a 2009->2017
        #    artifact at 121.2 instead.
        #
        #    The sort is kept even though nothing is sliced: nearest-selection
        #    resolves an exact tie by first-wins, so iterating in rank order
        #    keeps that tie-break defined by rank rather than by list order.
        close = candles[i].close
        point: dict[str, float] = {}
        for side in SIDES:
            # ONE PASS, NO SORT, and it is the same choice the sort expressed.
            # This used to build a rank-sorted list of the majors and walk it
            # taking the first STRICTLY nearer line, so the winner was the
            # rank-minimum among the distance-minimums; tracking that pair
            # directly says the same thing without a list and a sort on every
            # bar. Ties resolve identically: rank_key is a total order, and a
            # candidate that ranks equal does not displace the one held, which
            # is what a stable sort plus first-wins gave.
            #
            # The side test applies to UNBROKEN lines ONLY, and the two cases
            # must not be merged. An unbroken support sits at or below the close
            # and an unbroken resistance above it. A BROKEN line gets NO side
            # test: once price has pierced a line it can sit on EITHER side of
            # the close during the hold window (a wick break snaps back the next
            # bar), and that window exists precisely to keep the level visible
            # for a retest. Gating broken lines on side silently blanks
            # tl_broken_* for whole windows.
            u_line: TrendLine | None = None
            u_val = 0.0
            u_dist = 0.0
            b_line: TrendLine | None = None
            b_val = 0.0
            b_dist = 0.0
            for line in lines:
                if line.side != side:
                    continue
                if not is_live(line, i, cfg) or not is_major(line, i, cfg):
                    continue
                v = project_at(line, i)
                d = abs(v - close)
                if line.broken_idx is not None:
                    if b_line is None or d < b_dist or (
                        d == b_dist and rank_key(line) < rank_key(b_line)
                    ):
                        b_line, b_val, b_dist = line, v, d
                    continue
                # CROSS-MULTIPLIED, exactly as pierces does, because this is a
                # boolean that gates whether an output fires at all. With
                # s = i2 - i1 an exact positive integer,
                #   project_at(line, i) <= close
                # is the same inequality as
                #   (p2 - p1) * (i - i1) <= (close - p1) * s
                # with the quotient's rounding removed.
                s_span = line.i2 - line.i1
                below = (line.p2 - line.p1) * (i - line.i1) <= (close - line.p1) * s_span
                if below != (side == "support"):
                    continue
                if u_line is None or d < u_dist or (
                    d == u_dist and rank_key(line) < rank_key(u_line)
                ):
                    u_line, u_val, u_dist = line, v, d

            if side == "support":
                if u_line is not None:
                    point["tl_support"] = u_val
                if b_line is not None:
                    point["tl_broken_support"] = b_val
            else:
                if u_line is not None:
                    point["tl_resistance"] = u_val
                if b_line is not None:
                    point["tl_broken_resistance"] = b_val
        points[i] = point

    return points, lines


def trendlines_outputs(cfg: TrendlinesConfig) -> tuple[str, ...]:
    return TRENDLINES_OUTPUTS


def trendlines_warmup(cfg: TrendlinesConfig, output: str) -> int:
    """ATR(14) warm-up, plus the two pivots that must confirm (pivot_len each),
    plus the span they must cover. Lines keep forming after that, so this is the
    floor. Every output shares it; an output this pane does not expose costs 0,
    like fvg_warmup.

    LEFT-WINDOW GATES ARE LEFT OUT, and there are two of them now: min_swing_reach
    and min_back_bars each require that many bars before the first anchor. Right
    for each one alone (this floor is about the shape of the spec, not the
    strictest reachable config), but it is a pattern rather than an exception
    now: the floor is optimistic by their SUM, so a third such gate belongs on
    this list too. Mirrors the TS trendlinesWarmup docstring."""
    if output not in TRENDLINES_OUTPUTS:
        return 0
    return TL_ATR_LEN + 2 * cfg.pivot_len + cfg.min_span_bars


def trendlines_series(
    cfg: TrendlinesConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    """bar_hours is unused (nothing here is time-scaled); it is in the signature
    because IndicatorSeriesSpec.series requires it."""
    if output not in TRENDLINES_OUTPUTS:
        return [None] * len(candles)
    points, _lines = compute_trendlines(candles, cfg)
    return [p.get(output) for p in points]
