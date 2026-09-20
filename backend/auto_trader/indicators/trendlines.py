"""TRENDLINES (sideless): major sloping lines through confirmed fractal pivots
of EITHER kind. Ported operation-for-operation from
frontend/src/lib/indicators/trendlines.ts (computeTrendlines) and
frontend/src/lib/indicators/trendlinesOutputs.ts.

A line is two significant swings, high or low in any mix, that later swings
land on. A touch has TWO tolerances: how far a pivot may poke THROUGH the line
(Max Pierce, a full touch) and how far it may stop SHORT of it (Max Touch Gap,
half a touch), so `touches` is a half-step sum. Price may cross a line freely;
crossings are COUNTED (a gate and a rank key), never a fault. No broken state.

Validity here is a BOOLEAN THAT GATES SET MEMBERSHIP: every side test
multiplies through by the exact positive integer (i2 - i1) instead of
computing a slope. Division survives only in project_at. Do NOT "improve" the
arithmetic (see core.py's parity contract). Values at index i depend only on
inputs [0..i].
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

TL_ATR_LEN = 14
# ONE POOL holds highs and lows, so this reaches about half as far back in time
# as the old per-side 20; hence 40. Counted in pivots, not bars.
MAX_PAIR_PIVOTS = 40
# Live state keeps this multiple of max_lines lines IN TOTAL. 16, not 4: a line
# is built once, at its second anchor, so the cap is a one-shot test it can
# never retake (see survival_key). Mirrors MAX_LIVE_MULT in
# frontend/src/lib/indicators/trendlinesOutputs.ts.
MAX_LIVE_MULT = 16
# Hard ceiling on max_lines, applied at parse time. The sideless rewrite re-cut
# the calcParams layout, so a pane saved under the OLD one reads its Max
# Projection (250 by default) into this slot. Each unit costs a rule operand AND
# MAX_LIVE_MULT live lines, so 250 would mint 251 operands over 4000 live lines
# on a pane nobody asked to change. Mirrors MAX_MAX_LINES in
# frontend/src/lib/indicators/trendlinesOutputs.ts.
MAX_MAX_LINES = 50
TL_NEAREST = "tl_nearest"

PivotKind = Literal["high", "low"]
KINDS: tuple[PivotKind, ...] = ("high", "low")

# [pivot_len, touch_mult, min_touches, min_span_bars, max_proj_bars, max_lines,
#  min_swing_atr, min_swing_reach, pair_pivots, max_touches, max_span_bars,
#  max_slope_atr, min_slope_atr, max_touch_spacing, min_touch_spacing,
#  min_crossings, max_crossings, pierce_mult, min_back_bars, max_dist_atr,
#  max_dist_pct, merge_atr, max_per_pivot, merge_pct]: TRENDLINES_DEFAULTS
#  in trendlinesOutputs.ts.
_DEFAULTS = (5, 0.0, 2, 20, 250, 3, 0.0, 0, MAX_PAIR_PIVOTS, 0, 0, 0.0, 0.0, 0, 0, 0, 0, 0.25, 0, 0.0, 0.0, 0.25, 0, 0.0)
# The distance "Only lines near price" drew at, in ATR(14): what a pane saved
# with that retired rule migrates onto as max_dist_atr. TL_NEAR_PRICE_ATR in
# trendlinesOutputs.ts.
TL_NEAR_PRICE_ATR = 5.0


def tl_output_name(rank: int) -> str:
    return f"tl_{rank}"


@dataclass(frozen=True, slots=True)
class TrendlinesConfig:
    pivot_len: int
    touch_mult: float  # how far SHORT of the line still counts, in ATR(14); scores 0.5
    min_touches: int
    min_span_bars: int
    max_proj_bars: int
    max_lines: int  # live-state size (x MAX_LIVE_MULT) and the ranked output count
    min_swing_atr: float  # 0 = off
    min_swing_reach: int  # 0 = off
    pair_pivots: int  # earlier pivots of either kind a new pivot pairs with
    max_touches: int  # 0 = no limit
    max_span_bars: int  # 0 = no limit
    max_slope_atr: float  # SIGNED (rising +, falling -); 0 = no limit
    min_slope_atr: float  # signed; 0 = no floor
    max_touch_spacing: int  # 0 = no limit
    min_touch_spacing: int  # 0 = off
    min_crossings: int  # floor; a line can grow into it
    max_crossings: int  # ceiling; 0 = no limit; silences like max_touches
    # How far THROUGH the line still counts, same units; scores 1. 0 means only
    # an extreme exactly ON the line pierces. Which way is "through" comes from
    # the pivot's kind (see touch_weight).
    pierce_mult: float
    # Bars before i1 over which the close must stay on one side of the line.
    # 0 = off; runs off the start of the series by rejecting.
    min_back_bars: int = 0
    # How far a line may project from the close, in ATR(14) at that bar and as
    # a percent of that close; each 0 = off, each applied on its own. A
    # per-bar gate in the emit step: a far line stays live but emits nothing
    # until price is back within the cut (mirrors the TS).
    max_dist_atr: float = 0.0
    max_dist_pct: float = 0.0
    # The merge pass, in the emit step: two majors that stay within the band
    # of each other over the whole stretch they both exist are one line and
    # the better-ranked survives. The band is the tighter of merge_atr x
    # ATR(14) and merge_pct % of the close, each 0 = off. max_per_pivot caps
    # how many kept lines may run through one bar (anchor or touch) in the
    # same pass, 0 = off, 1 was "One line per pivot". A merged-away line
    # emits nothing.
    merge_atr: float = 0.25
    max_per_pivot: int = 0
    merge_pct: float = 0.0
    timeframe: str | None = None


@dataclass(slots=True)
class TrendLine:
    """Two anchor pivots; the line NEVER rotates. k1/k2 say which extreme each
    anchor is; no gate reads them (kept so the two TrendLine shapes match).
    touch_idxs is what the per-pivot cap reads: every bar counted as a touch, the
    anchors included, in the order they were recorded (mirrors the TS)."""

    i1: int
    p1: float
    k1: str
    i2: int
    p2: float
    k2: str
    touches: float  # half-step sum: a pierce adds 1, a gap 0.5
    last_touch_idx: int
    crossings: int  # times the close changed side since i1
    last_sign: int  # last NON-ZERO side: 1 above, -1 below, 0 none yet
    max_touch_gap: int
    min_touch_gap: float  # float only because the no-gap guard is math.inf
    max_touch_idx: int
    touch_idxs: list[int] = field(default_factory=list)


def trendlines_outputs(cfg: TrendlinesConfig) -> tuple[str, ...]:
    return tuple(tl_output_name(r) for r in range(1, cfg.max_lines + 1)) + (TL_NEAREST,)


def parse_trendlines_config(calc_params: object, extend_data: object) -> TrendlinesConfig:
    """Mirrors TS parseTrendlinesConfig. extendData is read for `mtf.timeframe`
    and for the migrations of panes saved before slots 19 to 22 existed,
    each only while its slot is ABSENT: "Only lines near price" (`declutter:
    "near"`, or the checkbox-era `nearPrice: True` with no `declutter`) is
    max_dist_atr TL_NEAR_PRICE_ATR; the render-only merge tolerance
    (`dedupeAtr`, or `dedupe: False` meaning 0) is merge_atr; `declutter:
    "pivot"` is max_per_pivot 1. Number
    coercion diverges from the TS on None, "" and [] (float() raises,
    Number() gives 0); deliberate and tested on both sides."""
    p: list[Any] = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    d = _DEFAULTS
    ext = extend_data if isinstance(extend_data, dict) else {}
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    max_dist_atr_default = TL_NEAR_PRICE_ATR if len(p) <= 19 and _legacy_near_price(ext) else d[19]
    legacy_merge = _legacy_merge_atr(ext) if len(p) <= 21 else None
    merge_atr_default = d[21] if legacy_merge is None else legacy_merge
    max_per_pivot_default = 1 if len(p) <= 22 and ext.get("declutter") == "pivot" else d[22]

    def num_at(i: int, default: float, allow_zero: bool) -> float:
        try:
            v = float(p[i])
        except (IndexError, OverflowError, TypeError, ValueError):
            return default
        if not math.isfinite(v):
            return default
        return v if (v >= 0 if allow_zero else v > 0) else default

    def signed_at(i: int, default: float) -> float:
        # A signed slot: any finite number, negative included; 0 stays off.
        try:
            v = float(p[i])
        except (IndexError, OverflowError, TypeError, ValueError):
            return default
        return v if math.isfinite(v) else default

    def int_at(i: int, default: float) -> int:
        return max(1, math.floor(num_at(i, default, False)))

    def zero_int(i: int, default: float) -> int:
        return max(0, math.floor(num_at(i, default, True)))

    return TrendlinesConfig(
        pivot_len=int_at(0, d[0]),
        touch_mult=num_at(1, d[1], True),
        min_touches=max(2, math.floor(num_at(2, d[2], False))),
        min_span_bars=int_at(3, d[3]),
        max_proj_bars=int_at(4, d[4]),
        max_lines=min(MAX_MAX_LINES, int_at(5, d[5])),
        min_swing_atr=num_at(6, d[6], True),
        min_swing_reach=zero_int(7, d[7]),
        pair_pivots=int_at(8, d[8]),
        max_touches=zero_int(9, d[9]),
        max_span_bars=zero_int(10, d[10]),
        max_slope_atr=signed_at(11, d[11]),
        min_slope_atr=signed_at(12, d[12]),
        max_touch_spacing=zero_int(13, d[13]),
        min_touch_spacing=zero_int(14, d[14]),
        min_crossings=zero_int(15, d[15]),
        max_crossings=zero_int(16, d[16]),
        pierce_mult=num_at(17, d[17], True),
        min_back_bars=zero_int(18, d[18]),
        max_dist_atr=num_at(19, max_dist_atr_default, True),
        max_dist_pct=num_at(20, d[20], True),
        merge_atr=num_at(21, merge_atr_default, True),
        max_per_pivot=zero_int(22, max_per_pivot_default),
        merge_pct=num_at(23, d[23], True),
        timeframe=tf if isinstance(tf, str) and tf and tf != "chart" else None,
    )


def _legacy_near_price(ext: dict[str, Any]) -> bool:
    """Mirrors TS legacyNearPrice."""
    if "declutter" in ext:
        return ext["declutter"] == "near"
    return ext.get("nearPrice") is True


def _legacy_merge_atr(ext: dict[str, Any]) -> float | None:
    """Mirrors TS legacyMergeAtr."""
    if ext.get("dedupe") is False:
        return 0.0
    v = ext.get("dedupeAtr")
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) and v >= 0 else None


def merge_tolerance(cfg: TrendlinesConfig, atr_i: float | None, close: float) -> float:
    """Mirrors TS mergeTolerance: the tighter of merge_atr x ATR and
    merge_pct % of the close, each skipped at 0 (the ATR half while
    unwarmed); 0 (off) when neither is on. The per-pivot cap is a separate
    merge_lines argument."""
    tol = math.inf
    if cfg.merge_atr > 0 and atr_i is not None and math.isfinite(atr_i):
        tol = cfg.merge_atr * atr_i
    if cfg.merge_pct > 0:
        pct = abs(close) * (cfg.merge_pct / 100)
        if pct < tol:
            tol = pct
    return 0.0 if tol == math.inf else tol


def same_trend(a: TrendLine, b: TrendLine, at_idx: int, tol: float) -> bool:
    """Mirrors TS sameTrend: within tol at at_idx AND where the younger line
    starts, which for two straight lines is within tol throughout."""
    start = max(a.i1, b.i1)
    return (
        abs(project_at(a, at_idx) - project_at(b, at_idx)) <= tol
        and abs(project_at(a, start) - project_at(b, start)) <= tol
    )


def cap_per_pivot(ranked: list[TrendLine], max_per_pivot: int) -> list[TrendLine]:
    """Mirrors TS capPerPivot (no pin exemption: pins are draw-time UI).
    Walks rank order and drops a line once max_per_pivot kept lines already
    run through one of its bars (anchor or touch: touch_idxs); 0 = off."""
    if max_per_pivot < 1:
        return ranked
    out: list[TrendLine] = []
    per_bar: dict[int, int] = {}
    for line in ranked:
        if any(per_bar.get(b, 0) >= max_per_pivot for b in line.touch_idxs):
            continue
        out.append(line)
        for b in line.touch_idxs:
            per_bar[b] = per_bar.get(b, 0) + 1
    return out


def eligible_lines(
    pool: list[TrendLine], i: int, close: float, atr_i: float | None, cfg: TrendlinesConfig
) -> list[TrendLine]:
    """Mirrors TS eligibleLines: the live majors in rank order, cut by the
    per-pivot cap, THEN gated by Max Distance. is_major is about the line
    itself, so a line it refuses must not hold its pivots' slots; Max
    Distance is a per-bar visibility cut and runs after the cap so that
    tightening it, like the merge, can only remove the lines it targets."""
    majors = sorted(
        (line for line in pool if is_live(line, i, cfg) and is_major(line, i, cfg)), key=rank_key
    )
    capped = cap_per_pivot(majors, cfg.max_per_pivot)
    dist_tol = max_distance_tol(cfg, atr_i, close)
    if dist_tol == math.inf:
        return capped
    return [line for line in capped if within_distance(line, i, close, dist_tol)]


def merge_lines(
    ranked: list[TrendLine],
    at_idx: int,
    tol: float,
    limit: float = math.inf,
    max_per_pivot: int = 0,
) -> list[TrendLine]:
    """Mirrors TS mergeLines (no pin exemption here: pins are draw-time UI).
    Two passes, cap first: under max_per_pivot (0 = off) a line that runs
    through a bar (anchor or touch: touch_idxs) already holding that many
    higher-ranked lines goes, whatever the tolerance; then the survivors are
    walked in rank order, dropping any that shows the same trend as a kept one
    (same_trend at tol), stopping at `limit`. Cap first so a wider tolerance
    can only remove a line that is within it of a kept one and never, by
    freeing a twin's pivot tallies, let lower-ranked lines in to crowd out an
    unrelated one."""
    capped = max_per_pivot >= 1
    if not tol > 0 and not capped:
        return ranked
    cap_set = cap_per_pivot(ranked, max_per_pivot) if capped else ranked
    if not tol > 0:
        return cap_set[: int(limit)] if len(cap_set) > limit else cap_set
    out: list[TrendLine] = []
    proj: list[float] = []
    for line in cap_set:
        if len(out) >= limit:
            break
        p = project_at(line, at_idx)
        twin = any(
            abs(proj[idx] - p) <= tol and same_trend(k, line, at_idx, tol)
            for idx, k in enumerate(out)
        )
        if not twin:
            out.append(line)
            proj.append(p)
    return out


def max_distance_tol(cfg: TrendlinesConfig, atr_i: float | None, close: float) -> float:
    """Mirrors TS maxDistanceTol: the price distance past which a line is too
    far from this bar's close to take part, math.inf when both cuts are off.
    The two cuts apply on their own, so the tighter one is the band; the ATR
    half waits for a warmed ATR."""
    tol = math.inf
    if cfg.max_dist_atr > 0 and atr_i is not None and math.isfinite(atr_i):
        tol = cfg.max_dist_atr * atr_i
    if cfg.max_dist_pct > 0:
        pct = abs(close) * (cfg.max_dist_pct / 100)
        if pct < tol:
            tol = pct
    return tol


def within_distance(line: TrendLine, j: int, close: float, tol: float) -> bool:
    return abs(project_at(line, j) - close) <= tol


def project_at(line: TrendLine, j: int) -> float:
    """The ONLY division in this module."""
    return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1)


def touch_weight(
    line: TrendLine, j: int, price: float, kind: str, gap_tol: float, pierce_tol: float
) -> float:
    """1 for a pierce, 0.5 for a gap, 0 for neither. Mirrors TS touchWeight.

    Which way is "through" comes from the PIVOT'S kind: a swing high tests the
    line from below, so a high at or above it has pierced; a swing low mirrors
    that. Tolerances arrive pre-multiplied by ATR(14) at the pivot's bar, and
    the comparison keeps the `lhs <= rhs + t` shape rather than forming a
    difference, so the band edges land on the same bits in both ports.
    """
    span = line.i2 - line.i1
    lhs = (price - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    through = lhs >= rhs if kind == "high" else lhs <= rhs
    if through:
        t = pierce_tol * span
        ok = lhs <= rhs + t if kind == "high" else lhs >= rhs - t
        return 1.0 if ok else 0.0
    t = gap_tol * span
    ok = lhs >= rhs - t if kind == "high" else lhs <= rhs + t
    return 0.5 if ok else 0.0


def side_sign(line: TrendLine, j: int, close: float) -> int:
    span = line.i2 - line.i1
    lhs = (close - line.p1) * span
    rhs = (line.p2 - line.p1) * (j - line.i1)
    return 1 if lhs > rhs else (-1 if lhs < rhs else 0)


def step_crossing(line: TrendLine, j: int, close: float) -> None:
    """First non-zero sign is the baseline; a zero keeps the previous sign."""
    s = side_sign(line, j, close)
    if s == 0:
        return
    if line.last_sign != 0 and s != line.last_sign:
        line.crossings += 1
    line.last_sign = s


def has_back_clearance(line: TrendLine, closes: Sequence[float], bars: int) -> bool:
    """Mirrors TS hasBackClearance with startIdx 0: the close must not change
    side of the line over the `bars` bars before i1; a bar on the line is
    neutral; a window reaching before bar 0 rejects."""
    if bars <= 0:
        return True
    if line.i1 - bars < 0:
        return False
    last = 0
    for j in range(line.i1 - 1, line.i1 - bars - 1, -1):
        s = side_sign(line, j, closes[j])
        if s == 0:
            continue
        if last != 0 and s != last:
            return False
        last = s
    return True


def within_slope(line: TrendLine, atr_at: float, mult: float) -> bool:
    """Signed slope (rising +, falling -) at most mult ATR/bar; 0 = off."""
    if mult == 0:
        return True
    return (line.p2 - line.p1) <= mult * atr_at * (line.i2 - line.i1)


def above_slope(line: TrendLine, atr_at: float, mult: float) -> bool:
    """Signed slope at least mult ATR/bar; 0 = off."""
    if mult == 0:
        return True
    return (line.p2 - line.p1) >= mult * atr_at * (line.i2 - line.i1)


def rank_key(line: TrendLine) -> tuple[float, int, int, int, int, float]:
    """TS rankLines as a total-order key: most touches, longest span, FEWEST
    crossings, most recent, oldest origin, lowest anchor price."""
    return (
        -line.touches,
        -(line.last_touch_idx - line.i1),
        line.crossings,
        -line.last_touch_idx,
        line.i1,
        line.p1,
    )


def survival_key(line: TrendLine) -> tuple[int, int, float, int, int, float]:
    """TS compareSurvival as a total-order key: FEWEST crossings, longest span,
    most touches, most recent, oldest origin, lowest anchor price.

    NOT rank_key, deliberately. rank_key answers which lines the user reads
    this bar and leads with touches; this answers which lines are worth
    carrying. A line is built once, at its second anchor, so losing the live
    cap is permanent, and at that moment it holds only its seed-time touches
    while the crowd around it has had years to collect theirs. Leading with
    touches therefore evicts every long line at birth. Crossings lead instead:
    the count already covers the whole span between the anchors, so it means
    something at birth and does not reward age.
    """
    return (
        line.crossings,
        -(line.last_touch_idx - line.i1),
        -line.touches,
        -line.last_touch_idx,
        line.i1,
        line.p1,
    )


def _is_pivot_at(values: Sequence[float], i: int, lb_l: int, lb_r: int, want: str) -> bool:
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
        elif w >= v:
            return False
    return True


def _is_significant_swing(
    highs: Sequence[float], lows: Sequence[float], opposite_turns: Sequence[int],
    k: int, kind: str, atr_k: float, mult: float,
) -> bool:
    """SIZE of the swing as the LEG to the most recent turn of the other kind,
    strictly before k. No opposite turn yet is a REJECT."""
    if mult <= 0:
        return True
    h = -1
    for q in range(len(opposite_turns) - 1, -1, -1):
        if opposite_turns[q] < k:
            h = opposite_turns[q]
            break
    if h < 0:
        return False
    leg = highs[k] - lows[h] if kind == "high" else highs[h] - lows[k]
    return leg >= mult * atr_k


def _has_swing_reach(vals: Sequence[float], k: int, kind: str, bars: int) -> bool:
    if bars <= 0:
        return True
    if k - bars < 0:
        return False
    for j in range(k - bars, k):
        if (vals[j] >= vals[k]) if kind == "high" else (vals[j] <= vals[k]):
            return False
    return True


def is_live(line: TrendLine, i: int, cfg: TrendlinesConfig) -> bool:
    return i - line.last_touch_idx <= cfg.max_proj_bars


def touch_gaps(touch_idxs: Sequence[int]) -> tuple[int, float]:
    if len(touch_idxs) < 2:
        return 0, math.inf
    ordered = sorted(touch_idxs)
    gaps = [b - a for a, b in zip(ordered, ordered[1:])]
    return max(gaps), min(gaps)


def over_ceilings(line: TrendLine, cfg: TrendlinesConfig) -> bool:
    """Mirrors TS overCeilings: SILENCES, does not delete."""
    if cfg.max_touches > 0 and line.touches > cfg.max_touches:
        return True
    if cfg.max_span_bars > 0 and line.last_touch_idx - line.i1 > cfg.max_span_bars:
        return True
    if cfg.max_touch_spacing > 0 and line.max_touch_gap > cfg.max_touch_spacing:
        return True
    if cfg.min_touch_spacing > 0 and line.min_touch_gap < cfg.min_touch_spacing:
        return True
    if cfg.max_crossings > 0 and line.crossings > cfg.max_crossings:
        return True
    return False


def is_major(line: TrendLine, i: int, cfg: TrendlinesConfig) -> bool:
    if line.touches < cfg.min_touches:
        return False
    if over_ceilings(line, cfg):
        return False
    if line.last_touch_idx - line.i1 < cfg.min_span_bars:
        return False
    if line.crossings < cfg.min_crossings:
        return False
    return i >= line.i1 and i <= line.last_touch_idx + cfg.max_proj_bars


def compute_trendlines(
    candles: Sequence[Candle], cfg: TrendlinesConfig
) -> tuple[list[dict[str, float]], list[TrendLine]]:
    """Transliteration of TS stepTrendlinesBar over every bar: same loop order,
    same branch order, same arithmetic order. Returns (points, live lines)."""
    n = len(candles)
    points: list[dict[str, float]] = [{} for _ in range(n)]
    if n == 0:
        return points, []

    atr = atr_series(candles, TL_ATR_LEN)
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    closes = [c.close for c in candles]
    pool_idxs: list[int] = []
    pool_kinds: list[str] = []
    turns: dict[str, list[int]] = {"high": [], "low": []}
    lines: list[TrendLine] = []

    for i in range(n):
        a = atr[i]

        # 1. Per-bar crossing step for every existing line.
        for line in lines:
            step_crossing(line, i, closes[i])

        # 2. Confirm-bar work for the pivot at k = i - pivot_len.
        k = i - cfg.pivot_len
        if k >= 0 and a is not None:
            for kind in KINDS:
                vals = highs if kind == "high" else lows
                if not _is_pivot_at(vals, k, cfg.pivot_len, cfg.pivot_len, kind):
                    continue
                turns[kind].append(k)
                if cfg.min_swing_atr > 0:
                    atr_k = atr[k]
                    if atr_k is None:
                        continue
                    opposite = turns["low" if kind == "high" else "high"]
                    if not _is_significant_swing(highs, lows, opposite, k, kind, atr_k, cfg.min_swing_atr):
                        continue
                if not _has_swing_reach(vals, k, kind, cfg.min_swing_reach):
                    continue
                price = vals[k]

                # 2a. Touch test against every existing line, any kind.
                tol_a = atr[k]
                if tol_a is not None:
                    for line in lines:
                        if k <= line.i2:
                            continue
                        w = touch_weight(
                            line, k, price, kind, cfg.touch_mult * tol_a, cfg.pierce_mult * tol_a
                        )
                        if w > 0:
                            line.touches += w
                            line.touch_idxs.append(k)
                            gap = k - line.max_touch_idx
                            if gap > line.max_touch_gap:
                                line.max_touch_gap = gap
                            if gap < line.min_touch_gap:
                                line.min_touch_gap = gap
                            line.max_touch_idx = k
                            line.last_touch_idx = k

                # 2b. Seed against the previous pair_pivots pool entries.
                frm = max(0, len(pool_idxs) - cfg.pair_pivots)
                for q in range(frm, len(pool_idxs)):
                    i1 = pool_idxs[q]
                    if i1 >= k:
                        continue
                    k1 = pool_kinds[q]
                    p1 = highs[i1] if k1 == "high" else lows[i1]
                    cand = TrendLine(
                        i1=i1, p1=p1, k1=k1, i2=k, p2=price, k2=kind, touches=2.0,
                        last_touch_idx=k, crossings=0, last_sign=0,
                        max_touch_gap=k - i1, min_touch_gap=k - i1, max_touch_idx=k,
                        touch_idxs=[i1, k],
                    )
                    if cfg.max_slope_atr != 0 or cfg.min_slope_atr != 0:
                        atr_k = atr[k]
                        if atr_k is None:
                            continue
                        if not within_slope(cand, atr_k, cfg.max_slope_atr):
                            continue
                        if not above_slope(cand, atr_k, cfg.min_slope_atr):
                            continue
                    if not has_back_clearance(cand, closes, cfg.min_back_bars):
                        continue
                    for j in range(i1 + 1, i + 1):
                        step_crossing(cand, j, closes[j])
                    for q2 in range(q + 1, len(pool_idxs)):
                        pj = pool_idxs[q2]
                        if pj >= k:
                            break
                        if pj == i1:
                            continue
                        tol_p = atr[pj]
                        if tol_p is None:
                            continue
                        kj = pool_kinds[q2]
                        pv = highs[pj] if kj == "high" else lows[pj]
                        w = touch_weight(
                            cand, pj, pv, kj, cfg.touch_mult * tol_p, cfg.pierce_mult * tol_p
                        )
                        if w > 0:
                            cand.touches += w
                            cand.touch_idxs.append(pj)
                    cand.max_touch_gap, cand.min_touch_gap = touch_gaps(cand.touch_idxs)
                    cand.max_touch_idx = cand.i2
                    lines.append(cand)
                pool_idxs.append(k)
                pool_kinds.append(kind)

            # 3. Prune the dead, then cap live state by the SURVIVAL order IN
            #    TOTAL (survival_key, not rank_key: see its docstring).
            if any(not is_live(line, i, cfg) for line in lines):
                lines = [line for line in lines if is_live(line, i, cfg)]
            cap = MAX_LIVE_MULT * cfg.max_lines
            if len(lines) > cap:
                lines.sort(key=lambda line: (over_ceilings(line, cfg), survival_key(line)))
                lines = lines[:cap]

        # 4. Emit eligible_lines (rank, per-pivot cap, THEN Max Distance and
        #    the major gates), MERGED at this bar's tolerance (the pass the
        #    draw path runs), cut to max_lines; tl_nearest is the nearest
        #    AMONG THOSE. A line not on the chart reports nothing.
        close = closes[i]
        point: dict[str, float] = {}
        majors = eligible_lines(lines, i, close, a, cfg)
        drawn = merge_lines(majors, i, merge_tolerance(cfg, a, close), cfg.max_lines, 0)
        nearest_v = 0.0
        nearest_d = math.inf
        shown = min(len(drawn), cfg.max_lines)
        for r in range(shown):
            v = project_at(drawn[r], i)
            point[tl_output_name(r + 1)] = v
            d = abs(v - close)
            if d < nearest_d:
                nearest_d = d
                nearest_v = v
        if shown:
            point[TL_NEAREST] = nearest_v
        points[i] = point

    return points, lines


def trendlines_warmup(cfg: TrendlinesConfig, output: str) -> int:
    """ATR(14) warm-up + two pivot confirms + the minimum span. An output this
    config does not expose costs 0. Mirrors TS trendlinesWarmup."""
    if output not in trendlines_outputs(cfg):
        return 0
    return TL_ATR_LEN + 2 * cfg.pivot_len + cfg.min_span_bars


def trendlines_series(
    cfg: TrendlinesConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    """bar_hours is unused; the IndicatorSeriesSpec signature requires it."""
    if output not in trendlines_outputs(cfg):
        return [None] * len(candles)
    points, _lines = compute_trendlines(candles, cfg)
    return [p.get(output) for p in points]
