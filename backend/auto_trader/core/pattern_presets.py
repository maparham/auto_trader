"""Preset chart-pattern detection: classic formations (head & shoulders,
double tops/bottoms, broadening formations, triangles and wedges) found by a
grammar over zigzag pivots, then ranked by the similarity machinery against
per-family archetypes.

Detection is scale-aware through the pivot pass alone: the zigzag's reversal
threshold is k * ATR, so "a swing" means the same thing on a 3-minute oil
chart and a weekly index chart. Grammars then reason over pivots (hundreds),
never bars (hundreds of thousands)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from auto_trader.core.pattern_shape import (
    _zigzag_pivots,
    envelope_divergence_distance,
    multires_distance,
)


@dataclass(frozen=True)
class Pivot:
    i: int  # bar index into the series
    price: float
    d: int  # +1 swing high, -1 swing low


def atr(ohlc: np.ndarray) -> float:
    """Median true range over the whole array: the per-bar move unit every
    threshold in this module is expressed in. Median, not mean, so one
    flash-crash bar cannot loosen every grammar; floored above zero so a
    dead-flat synthetic series cannot divide by it."""
    h, l, c = ohlc[:, 1], ohlc[:, 2], ohlc[:, 3]
    prev_c = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h, prev_c) - np.minimum(l, prev_c)
    v = float(np.median(tr))
    return v if v > 0 else 1e-9


def series_pivots(ohlc: np.ndarray, k: float) -> list[Pivot]:
    """Interior confirmed swing pivots of the close path, zigzag reversal
    threshold k * ATR. Reuses pattern_shape's engine: its threshold is a
    fraction of the path's total range, so the absolute threshold converts to
    rev_frac = (k * ATR) / range."""
    close = np.ascontiguousarray(ohlc[:, 3], dtype=np.float64)
    rng = float(close.max() - close.min())
    if rng <= 0:
        return []
    piv = _zigzag_pivots(close, (k * atr(ohlc)) / rng)
    n = len(close)
    return [Pivot(i=int(round(p * (n - 1))), price=float(lv), d=d) for p, lv, d in piv]


@dataclass(frozen=True)
class Instance:
    start: int  # bar index of the first pattern pivot
    end: int  # break bar when completed, last series bar when forming
    family: str
    variant: str
    forming: bool
    pivots: tuple[Pivot, ...]
    direction: int  # +1 up / -1 down; actual break when completed, prior else
    break_i: int | None
    tell: str | None  # "partial-rise" | "partial-decline" on forming broadening


def _fit(pts: list[Pivot]) -> tuple[float, float]:
    """Least-squares (slope, intercept) through pivots' (bar index, price)."""
    xs = np.array([p.i for p in pts], dtype=np.float64)
    ys = np.array([p.price for p in pts], dtype=np.float64)
    denom = float(((xs - xs.mean()) ** 2).sum()) or 1e-9
    slope = float(((xs - xs.mean()) * (ys - ys.mean())).sum() / denom)
    return slope, float(ys.mean() - slope * xs.mean())


def _first_break(close, start_i, hi_line, lo_line, tol, end_i=None):
    """First bar in (start_i, end_i] whose close clears a line by tol:
    (bar, +1/-1), or None while price stays inside both. end_i caps the scan:
    a formation that has not resolved within its horizon has dissolved, and a
    break found years later belongs to some other story."""
    hs, hb = hi_line
    ls, lb = lo_line
    stop = len(close) if end_i is None else min(len(close), end_i + 1)
    for i in range(start_i + 1, stop):
        if close[i] > hs * i + hb + tol:
            return i, 1
        if close[i] < ls * i + lb - tol:
            return i, -1
    return None


def _prior_trend_ok(close, f, i0: int, span: int, need: float) -> bool:
    """Reversal context: the net close move over the pattern's own span of
    bars INTO its first pivot, in the direction the pattern reverses (f=+1
    demands a rise, -1 a fall), must reach `need` price units. A head &
    shoulders top without a prior rise is three bumps in a range, not a
    reversal (Bulkowski's identification rules lead with the trend)."""
    look = min(span, i0)
    if look < 2:
        return False
    return f * (float(close[i0]) - float(close[i0 - look])) >= need


def _swings_expand(run, hs: float, ls: float, p: dict) -> bool:
    """A broadening formation is monotone expansion by definition: every
    touch of a sloping line makes a new extreme, and each leg into it grows
    within a band of the leg before (Bulkowski's higher-highs/lower-lows,
    plus TFlab's per-swing 1.2x-2x extension filter, loosened). Legs sharing
    a middle pivot are compared: for lows (l1, h, l2) the ratio is
    (h-l2)/(h-l1); mirrored for highs. The flat side of a right-angled
    variant is exempt — its touches are level, not expanding."""
    lo_ex = p.get("swing_expand", 1.0)
    hi_ex = p.get("swing_expand_max", 3.0)
    flat = p["flat_slope"]
    for j in range(2, len(run)):
        q0, q1, q2 = run[j - 2], run[j - 1], run[j]
        if q0.d != q2.d:
            continue
        if q2.d > 0:
            if hs <= flat:
                continue
            prev, cur = q0.price - q1.price, q2.price - q1.price
        else:
            if ls >= -flat:
                continue
            prev, cur = q1.price - q0.price, q1.price - q2.price
        if prev <= 0 or not lo_ex * prev <= cur <= hi_ex * prev:
            return False
    return True


def _envelope_variant(hs: float, ls: float, p: dict) -> tuple[str, str] | None:
    """(family, variant) from the two line slopes in ATR-per-bar units, or
    None when the lines neither diverge nor converge enough (a channel)."""
    flat = p["flat_slope"]
    if hs - ls >= p["min_slope_gap"]:  # diverging
        if hs > flat and ls < -flat:
            return "broadening", "megaphone"
        if hs > flat and abs(ls) <= flat:
            return "broadening", "ascending"
        if abs(hs) <= flat and ls < -flat:
            return "broadening", "descending"
        return None
    if ls - hs >= p["min_slope_gap"]:  # converging
        if hs < -flat and ls > flat:
            return "triangle", "symmetric"
        if abs(hs) <= flat and ls > flat:
            return "triangle", "ascending"
        if hs < -flat and abs(ls) <= flat:
            return "triangle", "descending"
        if hs > flat and ls > flat:
            return "triangle", "rising-wedge"
        if hs < -flat and ls < -flat:
            return "triangle", "falling-wedge"
    return None


def find_envelope(piv: list[Pivot], close: np.ndarray, a: float, p: dict) -> list[Instance]:
    """Broadening formations, triangles and wedges: for each run of
    min_pivots..max_pivots consecutive pivots, fit a line through the highs
    and one through the lows; the slope pair classifies the variant. Longest
    qualifying run per end pivot wins, and runs contained in an already-kept
    instance are dropped, so one formation reports once."""
    out: list[Instance] = []
    n = len(close)
    for e in range(len(piv) - 1, -1, -1):
        found = None
        for npv in range(min(p["max_pivots"], e + 1), p["min_pivots"] - 1, -1):
            run = piv[e - npv + 1 : e + 1]
            highs = [q for q in run if q.d > 0]
            lows = [q for q in run if q.d < 0]
            if len(highs) < 2 or len(lows) < 2:
                continue
            hi, lo = _fit(highs), _fit(lows)
            # Both lines must actually describe their pivots: a run whose
            # extremes wander off the fit is texture, not a formation.
            if max(abs(q.price - (hi[0] * q.i + hi[1])) for q in highs) > p["fit_tol"] * a:
                continue
            if max(abs(q.price - (lo[0] * q.i + lo[1])) for q in lows) > p["fit_tol"] * a:
                continue
            fam = _envelope_variant(hi[0] / a, lo[0] / a, p)
            if fam is None:
                continue
            if fam[0] == "broadening" and not _swings_expand(run, hi[0] / a, lo[0] / a, p):
                continue
            last = run[-1].i
            if (hi[0] * last + hi[1]) - (lo[0] * last + lo[1]) < p["min_height"] * a:
                continue
            # The break must land within the formation's own timescale: a
            # trendline extrapolated for multiples of the pattern's span stops
            # meaning anything.
            span = last - run[0].i
            horizon = last + max(1, int(round(p["break_horizon"] * span)))
            brk = _first_break(close, last, hi, lo, p["break_tol"] * a, end_i=horizon)
            if brk is not None:
                found = Instance(run[0].i, brk[0], fam[0], fam[1], False,
                                 tuple(run), brk[1], brk[0], None)
                break
            if horizon < n - 1:
                # Horizon expired unbroken: the formation dissolved.
                continue
            if e == len(piv) - 1:
                # No break and the run ends at the series' final confirmed
                # pivot: the formation is open at the live edge.
                tell = None
                if fam[0] == "broadening":
                    width = (hi[0] * last + hi[1]) - (lo[0] * last + lo[1])
                    q = run[-1]
                    if q.d < 0 and q.price - (lo[0] * q.i + lo[1]) >= p["partial_frac"] * width:
                        tell = "partial-decline"
                    elif q.d > 0 and (hi[0] * q.i + hi[1]) - q.price >= p["partial_frac"] * width:
                        tell = "partial-rise"
                found = Instance(run[0].i, n - 1, fam[0], fam[1], True,
                                 tuple(run), 0, None, tell)
                break
            # Unbroken but stale (pivots continued past it without a break):
            # the formation dissolved rather than resolving; not an instance.
        if found is not None and not any(
            o.start <= found.start and found.end <= o.end for o in out
        ):
            out.append(found)
    out.sort(key=lambda i: i.start)
    return out


def find_hns(piv: list[Pivot], close: np.ndarray, a: float, p: dict) -> list[Instance]:
    """Head & shoulders: five alternating pivots LS-v1-H-v2-RS (tops; the
    mirror for inverses) — three swing highs whose middle one dominates.
    Structural rules beyond the skeleton, per Bulkowski's identification
    guidelines (thepatternsite.com):
    - reversal context: a top must cap a prior RISE (an inverse a fall) of
      pre_trend x height over the pattern's own span into LS;
    - shoulders near-level in price (shoulder_tol) AND balanced in time
      (time_sym: the shorter of LS->head / head->RS at least that fraction of
      the longer);
    - busted-pattern rule: a close beyond the head before the neckline breaks
      voids the pattern — it made a new extreme instead of reversing;
    - the neckline break must land within break_horizon x span after RS, or
      the formation dissolved.
    Completed = neckline (v1-v2, extrapolated) broken in time; forming = the
    five pivots are the series' last, unbroken, unbusted, horizon still open."""
    out: list[Instance] = []
    n = len(close)
    for j in range(len(piv) - 4):
        run = piv[j : j + 5]
        sign = run[0].d
        if [q.d for q in run] != [sign, -sign, sign, -sign, sign]:
            continue
        ls, v1, head, v2, rs = run
        # Work in "top" orientation: flip prices for an inverse so one set of
        # comparisons serves both.
        f = 1.0 if sign > 0 else -1.0
        height = f * head.price - f * (v1.price + v2.price) / 2.0
        if height < p["min_height"] * a:
            continue
        if f * head.price - max(f * ls.price, f * rs.price) < p["head_prominence"] * height:
            continue
        if abs(ls.price - rs.price) > p["shoulder_tol"] * height:
            continue
        if abs(v1.price - v2.price) > p["neck_tilt"] * height:
            continue
        left, right = head.i - ls.i, rs.i - head.i
        if min(left, right) < p["time_sym"] * max(left, right):
            continue
        span = rs.i - ls.i
        if not _prior_trend_ok(close, f, ls.i, span, p["pre_trend"] * height):
            continue
        neck = _fit([v1, v2])
        horizon = rs.i + max(1, int(round(p["break_horizon"] * span)))
        brk = None
        busted = False
        for i in range(rs.i + 1, min(n, horizon + 1)):
            if f * close[i] > f * head.price:
                busted = True
                break
            if f * close[i] < f * (neck[0] * i + neck[1]) - p["break_tol"] * a:
                brk = i
                break
        if busted:
            continue
        variant = "top" if sign > 0 else "inverse"
        direction = -1 if sign > 0 else 1
        if brk is not None:
            out.append(Instance(ls.i, brk, "hns", variant, False,
                                tuple(run), direction, brk, None))
        elif j + 5 == len(piv) and horizon >= n - 1:
            out.append(Instance(ls.i, n - 1, "hns", variant, True,
                                tuple(run), direction, None, None))
    return out


def find_double(piv: list[Pivot], close: np.ndarray, a: float, p: dict) -> list[Instance]:
    """Double top/bottom: P1-V-P2 with near-equal extremes around one valley
    (peak, for bottoms). Same structural rules as the H&S family, because a
    double is the same kind of reversal event:
    - reversal context (pre_trend x height into P1);
    - busted if a close exceeds the higher peak before the valley breaks;
    - the valley break must land within break_horizon x span after P2.
    Completed on the in-time valley break — without it twin peaks are just a
    range; forming = P1-V-P2 are the series' last pivots, horizon still open."""
    out: list[Instance] = []
    n = len(close)
    for j in range(len(piv) - 2):
        run = piv[j : j + 3]
        sign = run[0].d
        if [q.d for q in run] != [sign, -sign, sign]:
            continue
        p1, v, p2 = run
        f = 1.0 if sign > 0 else -1.0
        height = max(f * p1.price, f * p2.price) - f * v.price
        if height < p["min_height"] * a:
            continue
        if abs(p1.price - p2.price) > p["peak_tol"] * height:
            continue
        span = p2.i - p1.i
        if not _prior_trend_ok(close, f, p1.i, span, p["pre_trend"] * height):
            continue
        top_level = max(f * p1.price, f * p2.price)
        horizon = p2.i + max(1, int(round(p["break_horizon"] * span)))
        brk = None
        busted = False
        for i in range(p2.i + 1, min(n, horizon + 1)):
            if f * close[i] > top_level:
                busted = True
                break
            if f * close[i] < f * v.price - p["break_tol"] * a:
                brk = i
                break
        if busted:
            continue
        variant = "top" if sign > 0 else "bottom"
        direction = -1 if sign > 0 else 1
        if brk is not None:
            out.append(Instance(p1.i, brk, "double", variant, False,
                                tuple(run), direction, brk, None))
        elif j + 3 == len(piv) and horizon >= n - 1:
            out.append(Instance(p1.i, n - 1, "double", variant, True,
                                tuple(run), direction, None, None))
    return out


# ------------------------------------------------------------------- params

_SHARED_PARAMS = [
    {"name": "k", "type": "float", "min": 0.5, "max": 6.0, "default": 2.0,
     "help": "pivot sensitivity: a swing must reverse by k x ATR to count"},
    {"name": "min_bars", "type": "int", "min": 10, "max": 5000, "default": 20,
     "help": "shortest instance reported, in bars"},
    {"name": "max_bars", "type": "int", "min": 20, "max": 5000, "default": 600,
     "help": "longest instance reported, in bars"},
    {"name": "strictness", "type": "float", "min": 0.2, "max": 3.0, "default": 1.6,
     "help": "max shape distance from the family archetype before a hit is dropped"},
]

PARAM_SCHEMAS: dict[str, list[dict]] = {
    "hns": _SHARED_PARAMS + [
        {"name": "shoulder_tol", "type": "float", "min": 0.05, "max": 0.8, "default": 0.35,
         "help": "max shoulder height difference, as a fraction of pattern height"},
        {"name": "head_prominence", "type": "float", "min": 0.05, "max": 1.0, "default": 0.25,
         "help": "head must top the higher shoulder by this fraction of height"},
        {"name": "neck_tilt", "type": "float", "min": 0.05, "max": 1.0, "default": 0.4,
         "help": "max neckline tilt across the pattern, as a fraction of height"},
        {"name": "break_tol", "type": "float", "min": 0.1, "max": 2.0, "default": 0.5,
         "help": "close must clear the neckline by this many ATRs to confirm"},
        {"name": "min_height", "type": "float", "min": 1.0, "max": 20.0, "default": 3.0,
         "help": "min pattern height in ATRs"},
        {"name": "pre_trend", "type": "float", "min": 0.0, "max": 2.0, "default": 0.5,
         "help": "reversal context: prior move into the left shoulder, as a fraction of pattern height"},
        {"name": "break_horizon", "type": "float", "min": 0.2, "max": 3.0, "default": 1.0,
         "help": "how long after the right shoulder the neckline may break, as a multiple of the pattern span"},
        {"name": "time_sym", "type": "float", "min": 0.0, "max": 1.0, "default": 0.33,
         "help": "shoulder balance in TIME: shorter half at least this fraction of the longer"},
    ],
    "double": _SHARED_PARAMS + [
        {"name": "peak_tol", "type": "float", "min": 0.02, "max": 0.5, "default": 0.15,
         "help": "max difference between the two peaks, as a fraction of height"},
        {"name": "break_tol", "type": "float", "min": 0.1, "max": 2.0, "default": 0.5,
         "help": "close must clear the valley by this many ATRs to confirm"},
        {"name": "min_height", "type": "float", "min": 1.0, "max": 20.0, "default": 3.0,
         "help": "min pattern height in ATRs"},
        {"name": "pre_trend", "type": "float", "min": 0.0, "max": 2.0, "default": 0.5,
         "help": "reversal context: prior move into the first peak, as a fraction of pattern height"},
        {"name": "break_horizon", "type": "float", "min": 0.2, "max": 3.0, "default": 1.0,
         "help": "how long after the second peak the valley may break, as a multiple of the pattern span"},
    ],
    "broadening": _SHARED_PARAMS + [
        {"name": "min_pivots", "type": "int", "min": 4, "max": 10, "default": 5,
         "help": "min trendline touches across both lines (Bulkowski: 3 + 2)"},
        {"name": "max_pivots", "type": "int", "min": 6, "max": 20, "default": 12,
         "help": "max pivots one instance may span"},
        {"name": "fit_tol", "type": "float", "min": 0.3, "max": 3.0, "default": 1.2,
         "help": "max pivot distance from its trendline, in ATRs"},
        {"name": "flat_slope", "type": "float", "min": 0.01, "max": 0.2, "default": 0.04,
         "help": "a line flatter than this (ATR/bar) counts as horizontal"},
        {"name": "min_slope_gap", "type": "float", "min": 0.02, "max": 0.5, "default": 0.06,
         "help": "min divergence between the lines, in ATR/bar"},
        {"name": "min_height", "type": "float", "min": 1.0, "max": 20.0, "default": 3.0,
         "help": "min height at the wide end, in ATRs"},
        {"name": "break_tol", "type": "float", "min": 0.1, "max": 2.0, "default": 0.5,
         "help": "close must clear a trendline by this many ATRs to confirm"},
        {"name": "partial_frac", "type": "float", "min": 0.1, "max": 0.5, "default": 0.25,
         "help": "how far short of the far line a swing may stop to count as a partial rise/decline"},
        {"name": "break_horizon", "type": "float", "min": 0.2, "max": 3.0, "default": 1.0,
         "help": "how long after the last touch a trendline may break, as a multiple of the pattern span"},
        {"name": "swing_expand", "type": "float", "min": 1.0, "max": 2.0, "default": 1.0,
         "help": "each leg into a sloping line must be at least this multiple of the leg before (1.0 = just higher highs / lower lows)"},
        {"name": "swing_expand_max", "type": "float", "min": 1.2, "max": 5.0, "default": 3.0,
         "help": "a leg beyond this multiple of the one before is a blow-off move, not orderly broadening"},
    ],
}
# Triangles share the envelope engine and its knobs; min_slope_gap reads as
# min convergence there. The swing-expansion band is broadening-only
# (converging legs contract), so triangles get the schema without it.
PARAM_SCHEMAS["triangle"] = [
    d for d in PARAM_SCHEMAS["broadening"]
    if d["name"] not in ("swing_expand", "swing_expand_max")
]

FAMILIES = ["hns", "double", "broadening", "triangle"]


def resolve_params(family: str, overrides: dict) -> dict:
    if family not in PARAM_SCHEMAS:
        raise ValueError(f"unknown pattern family '{family}'")
    schema = {d["name"]: d for d in PARAM_SCHEMAS[family]}
    out = {name: d["default"] for name, d in schema.items()}
    for name, val in overrides.items():
        d = schema.get(name)
        if d is None:
            raise ValueError(f"unknown param '{name}' for family '{family}'")
        val = int(val) if d["type"] == "int" else float(val)
        if not d["min"] <= val <= d["max"]:
            raise ValueError(
                f"param '{name}' out of range [{d['min']}, {d['max']}]: {val}"
            )
        out[name] = val
    return out


# ---------------------------------------------------------- ranking + stats

# Idealized close paths per variant, (t, value) knots in the unit square —
# the same idiom as scripts/pattern_bench/planting.py (duplicated: core must
# not import from scripts). The ranked window is the pattern BODY (first
# pivot to break/last pivot), so paths end where the pattern does.
ARCHETYPES: dict[tuple[str, str], tuple[tuple[float, float], ...]] = {
    ("hns", "top"): ((0.0, 0.1), (0.15, 0.6), (0.3, 0.2), (0.5, 1.0),
                     (0.7, 0.22), (0.85, 0.58), (1.0, 0.05)),
    ("hns", "inverse"): ((0.0, 0.9), (0.15, 0.4), (0.3, 0.8), (0.5, 0.0),
                         (0.7, 0.78), (0.85, 0.42), (1.0, 0.95)),
    ("double", "top"): ((0.0, 0.0), (0.25, 1.0), (0.5, 0.5), (0.75, 0.97), (1.0, 0.1)),
    ("double", "bottom"): ((0.0, 1.0), (0.25, 0.0), (0.5, 0.5), (0.75, 0.03), (1.0, 0.9)),
    ("broadening", "megaphone"): ((0.0, 0.5), (0.12, 0.65), (0.25, 0.35), (0.4, 0.78),
                                  (0.55, 0.22), (0.72, 0.9), (0.88, 0.1), (1.0, 0.6)),
    ("broadening", "ascending"): ((0.0, 0.2), (0.12, 0.5), (0.25, 0.2), (0.4, 0.65),
                                  (0.55, 0.2), (0.72, 0.8), (0.88, 0.2), (1.0, 0.55)),
    ("broadening", "descending"): ((0.0, 0.8), (0.12, 0.5), (0.25, 0.8), (0.4, 0.35),
                                   (0.55, 0.8), (0.72, 0.2), (0.88, 0.8), (1.0, 0.45)),
    # These three converging (triangle) archetypes are trimmed to the pivot
    # BODY, unlike the other archetypes above: a converging run's first knot
    # sits inside the flat lead-in the zigzag needs to confirm the first
    # interior pivot, so it is never actually part of the ranked window
    # (start pivot -> break) scan_series compares against — only the
    # untrimmed knots ever get there. Ranking the untrimmed archetype against
    # a trimmed window measured ~1.87 distance for an ideal symmetric
    # triangle (default strictness 1.6), silently dropping the variant.
    # Recalibrated by dropping each original first knot and renormalizing the
    # rest to [0, 1] (see backend/tests/test_pattern_presets_scan.py's
    # TestArchetypeCalibration for the ideal-instance regression this fixes).
    # Measured before/after (default strictness 1.6): symmetric 1.8844 ->
    # 0.0200; ascending/descending 1.8430 -> 0.0713 (all three previously
    # scored above strictness, so scan_series reported the variant NEVER).
    ("triangle", "symmetric"): ((0.0, 0.9), (0.1818, 0.2), (0.375, 0.75),
                                (0.5682, 0.32), (0.7727, 0.62), (1.0, 0.45)),
    ("triangle", "ascending"): ((0.0, 0.8), (0.1765, 0.3), (0.4118, 0.8),
                                (0.5882, 0.5), (0.7882, 0.8), (1.0, 0.68)),
    ("triangle", "descending"): ((0.0, 0.2), (0.1765, 0.7), (0.4118, 0.2),
                                 (0.5882, 0.5), (0.7882, 0.2), (1.0, 0.32)),
    ("triangle", "rising-wedge"): ((0.0, 0.0), (0.15, 0.5), (0.3, 0.2), (0.5, 0.7),
                                   (0.65, 0.5), (0.82, 0.85), (1.0, 0.72)),
    ("triangle", "falling-wedge"): ((0.0, 1.0), (0.15, 0.5), (0.3, 0.8), (0.5, 0.3),
                                    (0.65, 0.5), (0.82, 0.15), (1.0, 0.28)),
}

# Breakout-direction priors. Sources: thepatternsite.com (Bulkowski) pages —
# rabfa.html, bt.html, abw.html and the pattern index. None where the
# direction is part of the definition (H&S, doubles: the break IS the
# pattern) — the panel shows the measure target instead of a coin-flip stat.
STATS: dict[tuple[str, str], dict] = {
    ("hns", "top"): {"breakout_up_pct": None, "source": "Bulkowski: breaks down by definition"},
    ("hns", "inverse"): {"breakout_up_pct": None, "source": "Bulkowski: breaks up by definition"},
    ("double", "top"): {"breakout_up_pct": None, "source": "Bulkowski: confirmed on the down break"},
    ("double", "bottom"): {"breakout_up_pct": None, "source": "Bulkowski: confirmed on the up break"},
    ("broadening", "megaphone"): {"breakout_up_pct": 53, "source": "Bulkowski, broadening tops"},
    ("broadening", "ascending"): {"breakout_up_pct": 55, "source": "Bulkowski, RABFA (thepatternsite.com/rabfa.html)"},
    ("broadening", "descending"): {"breakout_up_pct": 48, "source": "Bulkowski, right-angled descending"},
    ("triangle", "symmetric"): {"breakout_up_pct": 54, "source": "Bulkowski, symmetrical triangles"},
    ("triangle", "ascending"): {"breakout_up_pct": 63, "source": "Bulkowski, ascending triangles"},
    ("triangle", "descending"): {"breakout_up_pct": 45, "source": "Bulkowski, descending triangles"},
    ("triangle", "rising-wedge"): {"breakout_up_pct": 32, "source": "Bulkowski, rising wedges"},
    ("triangle", "falling-wedge"): {"breakout_up_pct": 68, "source": "Bulkowski, falling wedges"},
}


@dataclass(frozen=True)
class Hit:
    instance: Instance
    distance: float
    breakout_up_pct: int | None
    target: float | None
    source: str


def _archetype_path(key: tuple[str, str], m: int) -> np.ndarray:
    knots = ARCHETYPES[key]
    t = np.array([k[0] for k in knots])
    v = np.array([k[1] for k in knots])
    return np.interp(np.linspace(0.0, 1.0, m), t, v)


def _measure_target(inst: Instance, close: np.ndarray, a: float) -> float | None:
    """The measure rule: pattern height projected from the break level in the
    breakout direction. Forming instances have no break level yet."""
    if inst.break_i is None or inst.direction == 0:
        return None
    prices = [q.price for q in inst.pivots]
    height = max(prices) - min(prices)
    return float(close[inst.break_i] + inst.direction * height)


_GRAMMARS = {
    "hns": find_hns,
    "double": find_double,
    "broadening": find_envelope,
    "triangle": find_envelope,
}


def _dedup_family_overlap(hits: list[Hit]) -> list[Hit]:
    """Suppress near-duplicate same-family hits: the grammars often emit
    several pivot-window variants of literally the same swing (e.g. a
    symmetric-triangle instance differing from another only by which bar the
    break lands on), all ranked and passing strictness independently. Sort by
    distance (best fit first) and keep a hit only when its own [start, end]
    span is NOT majority-covered (>= 70%) by an already-kept hit of the SAME
    family — variants of one family may still legitimately differ (a
    triangle vs. its wedge reading), so this only collapses literal
    near-duplicates, not cross-variant disagreement within a family."""
    by_distance = sorted(hits, key=lambda h: h.distance)
    kept: list[Hit] = []
    for h in by_distance:
        s, e = h.instance.start, h.instance.end
        length = max(e - s, 1)
        if any(
            k.instance.family == h.instance.family
            and (min(e, k.instance.end) - max(s, k.instance.start)) / length >= 0.7
            for k in kept
        ):
            continue
        kept.append(h)
    return kept


def scan_series(ohlc: np.ndarray, families: list[tuple[str, dict]]) -> list[Hit]:
    """One series through the whole preset pipeline. Grammars detect,
    archetype similarity ranks, strictness cuts; an hns instance suppresses a
    double it contains (three of the same five pivots — the more specific
    reading wins)."""
    close = np.ascontiguousarray(ohlc[:, 3], dtype=np.float64)
    a = atr(ohlc)
    raw: list[tuple[Instance, dict]] = []
    piv_cache: dict[float, list[Pivot]] = {}
    for family, p in families:
        piv = piv_cache.setdefault(p["k"], series_pivots(ohlc, p["k"]))
        for inst in _GRAMMARS[family](piv, close, a, p):
            if inst.family != family:
                continue  # the shared envelope engine emits both; keep asked-for
            body_end = inst.break_i if inst.break_i is not None else inst.pivots[-1].i
            if not p["min_bars"] <= body_end - inst.start + 1 <= p["max_bars"]:
                continue
            raw.append((inst, p))
    hits: list[Hit] = []
    hns_spans = [(i.start, i.end) for i, _ in raw if i.family == "hns"]
    for inst, p in raw:
        if inst.family == "double":
            length = inst.end - inst.start or 1
            if any(min(inst.end, e) - max(inst.start, s) >= 0.8 * length
                   for s, e in hns_spans):
                continue
        body_end = inst.break_i if inst.break_i is not None else inst.pivots[-1].i
        win = close[inst.start : body_end + 1]
        arch = _archetype_path((inst.family, inst.variant), len(win))
        dist = multires_distance(arch, win) + 0.2 * envelope_divergence_distance(arch, win)
        if dist > p["strictness"]:
            continue
        st = STATS[(inst.family, inst.variant)]
        hits.append(Hit(inst, float(dist), st["breakout_up_pct"],
                        _measure_target(inst, close, a), st["source"]))
    hits = _dedup_family_overlap(hits)
    hits.sort(key=lambda h: (not h.instance.forming, h.instance.start))
    return hits
