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

# How many earlier same-side pivots a new pivot pairs with (frontend
# MAX_PAIR_PIVOTS): bounds the run at O(P * 20) instead of O(P^2).
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
#  break_hold_bars, max_lines] — TRENDLINES_DEFAULTS in trendlinesOutputs.ts.
_DEFAULTS = (5, 0.25, 0.75, 2, 20, 250, 30, 3)

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


@dataclass(slots=True)
class TrendLine:
    """Two anchor pivots; the line NEVER rotates once defined. Later touches
    move last_touch_idx (extending coverage) but never i2/p2."""

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


def is_live(line: TrendLine, i: int, cfg: TrendlinesConfig) -> bool:
    """Not aged out past its projection horizon, and if broken, still inside the
    hold window."""
    if line.broken_idx is not None:
        return i - line.broken_idx <= cfg.break_hold_bars
    return i - line.last_touch_idx <= cfg.max_proj_bars


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
    if line.last_touch_idx - line.i1 < cfg.min_span_bars:
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
                frm = max(0, len(pool) - MAX_PAIR_PIVOTS)
                for q in range(frm, len(pool)):
                    i1 = pool[q]
                    # UNREACHABLE BY CONSTRUCTION, kept as a guard rail: no
                    # stored i2 can equal this k, and pool entries are distinct.
                    if any(
                        line.side == side and line.i1 == i1 and line.i2 == k
                        for line in lines
                    ):
                        continue
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
                    # between the anchors (the WHOLE pool, not the sliced
                    # window). Not lookahead: each confirmed before i.
                    for pj in pool:
                        if pj <= i1 or pj >= k:
                            continue
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
            lines = [line for line in lines if is_live(line, i, cfg)]
            for side in SIDES:
                mine = sorted([line for line in lines if line.side == side], key=rank_key)
                keep = {id(line) for line in mine[: MAX_LIVE_MULT * cfg.max_lines]}
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
            majors = sorted(
                [
                    line
                    for line in lines
                    if line.side == side and is_live(line, i, cfg) and is_major(line, i, cfg)
                ],
                key=rank_key,
            )

            # The side test applies to UNBROKEN lines ONLY, and the two cases
            # must not be merged. An unbroken support sits at or below the close
            # and an unbroken resistance above it — that is what "nearest
            # support" means. A BROKEN line gets NO side test: once price has
            # pierced a line it can sit on EITHER side of the close during the
            # hold window (a wick break snaps back the next bar, leaving the
            # broken support below the close again), and the hold window exists
            # precisely to keep that level visible for a retest. Gating broken
            # lines on side silently blanks tl_broken_* for whole windows.
            def pick(want: str, majors: list[TrendLine] = majors, side: Side = side) -> float | None:
                best: float | None = None
                for line in majors:
                    if (line.broken_idx is not None) if want == "unbroken" else (
                        line.broken_idx is None
                    ):
                        continue
                    v = project_at(line, i)
                    if want == "unbroken":
                        # CROSS-MULTIPLIED, exactly as pierces does, because
                        # this is a boolean that gates whether an output fires
                        # at all. With s = i2 - i1 an exact positive integer,
                        #   project_at(line, i) <= close
                        # is the same inequality as
                        #   (p2 - p1) * (i - i1) <= (close - p1) * s
                        # with the quotient's rounding removed.
                        s = line.i2 - line.i1
                        below = (line.p2 - line.p1) * (i - line.i1) <= (close - line.p1) * s
                        if below != (side == "support"):
                            continue
                    if best is None or abs(v - close) < abs(best - close):
                        best = v
                return best

            unbroken = pick("unbroken")
            broken = pick("broken")
            if side == "support":
                if unbroken is not None:
                    point["tl_support"] = unbroken
                if broken is not None:
                    point["tl_broken_support"] = broken
            else:
                if unbroken is not None:
                    point["tl_resistance"] = unbroken
                if broken is not None:
                    point["tl_broken_resistance"] = broken
        points[i] = point

    return points, lines


def trendlines_outputs(cfg: TrendlinesConfig) -> tuple[str, ...]:
    return TRENDLINES_OUTPUTS


def trendlines_warmup(cfg: TrendlinesConfig, output: str) -> int:
    """ATR(14) warm-up, plus the two pivots that must confirm (pivot_len each),
    plus the span they must cover. Lines keep forming after that, so this is the
    floor. Every output shares it; an output this pane does not expose costs 0,
    like fvg_warmup."""
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
