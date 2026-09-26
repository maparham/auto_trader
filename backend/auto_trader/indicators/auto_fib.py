"""AUTO_FIB instances (`AUTO_FIB#id.high` / `.low` / `.dir` / `.f0_618` ...):
a fib retracement between the latest confirmed pivot high and pivot low.
Ported operation-for-operation from frontend lib/indicators/autoFib.ts
(computeAutoFibPairs / autoFibSeries) and autoFibOutputs.ts (parse, names,
warm-up, level price); keep the arithmetic order identical, per the parity
contract in indicators/core.py.

Causal: a strict fractal pivot at bar k confirms at k + pivot_len and the pair
only changes at confirm bars, so values at bar i depend only on bars [0..i].
With min_swing_atr at 0 no ATR is computed and pivots count from the first
bar (unlike trendlines, which waits for ATR)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

AUTO_FIB_ATR_LEN = 14
# autoFibOutputs.ts AUTO_FIB_PAIR_REACH: bars reached back for the latest high
# and low, which can be of any age. Bounded because warm-up sizes fetches.
AUTO_FIB_PAIR_REACH = 200
BASE_OUTPUTS = ("high", "low", "dir")
# frontend fibConfig.ts DEFAULT_LEVELS as (value, enabled); colours are
# draw-only and not needed here.
_DEFAULT_LEVELS: tuple[tuple[float, bool], ...] = (
    (0.0, True), (0.236, True), (0.382, True), (0.5, True), (0.618, True),
    (0.786, True), (1.0, True), (1.618, False), (2.618, False), (-0.236, False),
)


@dataclass(frozen=True, slots=True)
class AutoFibConfig:
    pivot_len: int = 5
    min_swing_atr: float = 0.0
    # Enabled levels as (output name, ratio), in level order, names unique.
    levels: tuple[tuple[str, float], ...] = ()
    reverse: bool = False
    # Settings-pinned timeframe (extendData.mtf.timeframe, like SR_LEVELS).
    timeframe: str | None = None


@dataclass(slots=True)
class Pair:
    hi_idx: int
    hi_price: float
    lo_idx: int
    lo_price: float
    direction: int  # +1: the high is the later anchor


def fib_output_name(value: float) -> str | None:
    """fibOutputName: `f`, `m` when negative, |value| rounded to 4 decimals
    (JS toFixed picks the larger n on a tie, so ROUND_HALF_UP on the exact
    binary value), trailing zeros dropped, `.` -> `_`."""
    if not math.isfinite(value) or abs(value) >= 1e6:
        return None
    digits = format(Decimal(abs(value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP), "f")
    if "." in digits:
        digits = digits.rstrip("0").rstrip(".")
    return f"f{'m' if value < 0 else ''}{digits.replace('.', '_')}"


def _raw_levels(ext: dict) -> tuple[list[tuple[float, bool]], bool]:
    """asFibConfig's level filter: keep entries with a finite number value, a
    bool enabled and a str color; nothing kept (or no fib object) falls back to
    the default levels. Returns (levels, reverse)."""
    fib = ext.get("fib")
    if not isinstance(fib, dict):
        return list(_DEFAULT_LEVELS), False
    kept: list[tuple[float, bool]] = []
    raw = fib.get("levels")
    if isinstance(raw, list):
        for lv in raw:
            if not isinstance(lv, dict):
                continue
            v = lv.get("value")
            enabled = lv.get("enabled")
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                continue
            if not isinstance(enabled, bool) or not isinstance(lv.get("color"), str):
                continue
            kept.append((float(v), enabled))
    return (kept or list(_DEFAULT_LEVELS)), fib.get("reverse") is True


def parse_auto_fib_config(calc_params: object, extend_data: object) -> AutoFibConfig:
    """Mirrors frontend parseAutoFibConfig + autoFibLevelOutputs. calcParams
    order: [pivotLen, minSwingAtr]. Never raises on chart state."""
    p = calc_params if isinstance(calc_params, (list, tuple)) else []

    def num_at(i: int) -> float:
        try:
            return float(p[i])
        except (IndexError, TypeError, ValueError):
            return math.nan

    length = num_at(0)
    swing = num_at(1)
    ext = extend_data if isinstance(extend_data, dict) else {}
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    raw, reverse = _raw_levels(ext)
    levels: list[tuple[str, float]] = []
    seen: set[str] = set()
    for value, enabled in raw:
        if not enabled:
            continue
        name = fib_output_name(value)
        if name is None or name in seen:
            continue
        seen.add(name)
        levels.append((name, value))
    return AutoFibConfig(
        pivot_len=max(1, math.floor(length)) if math.isfinite(length) and length > 0 else 5,
        min_swing_atr=swing if math.isfinite(swing) and swing >= 0 else 0.0,
        levels=tuple(levels),
        reverse=reverse,
        timeframe=tf if isinstance(tf, str) and tf and tf != "chart" else None,
    )


def fib_level_price(hi: float, lo: float, direction: int, reverse: bool, r: float) -> float:
    """fibLevelPrice: level 0 on the later anchor, level 1 on the earlier."""
    later = hi if direction > 0 else lo
    earlier = lo if direction > 0 else hi
    p0 = earlier if reverse else later
    p1 = later if reverse else earlier
    return p0 + (p1 - p0) * r


def _is_pivot_at(values: Sequence[float], i: int, n: int, want_high: bool) -> bool:
    """pivots.ts isPivotAt with strict=True, lbL = lbR = n."""
    if i - n < 0 or i + n >= len(values):
        return False
    v = values[i]
    for j in range(i - n, i + n + 1):
        if j == i:
            continue
        w = values[j]
        if want_high:
            if w >= v:
                return False
        elif w <= v:
            return False
    return True


def _is_significant_swing(
    highs: Sequence[float], lows: Sequence[float], opposite_turns: Sequence[int],
    k: int, kind: str, atr_k: float, mult: float,
) -> bool:
    """trendlines.ts isSignificantSwing: the leg to the most recent opposite
    turn strictly before k; no opposite turn yet rejects."""
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


def compute_pairs(cfg: AutoFibConfig, candles: Sequence[Candle]) -> tuple[list[int | None], list[Pair]]:
    """computeAutoFibPairs: pair_of[i] is the pair current at bar i."""
    n = cfg.pivot_len
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    atr = atr_series(candles, AUTO_FIB_ATR_LEN) if cfg.min_swing_atr > 0 else None
    turns: dict[str, list[int]] = {"high": [], "low": []}
    hi: tuple[int, float] | None = None
    lo: tuple[int, float] | None = None
    pairs: list[Pair] = []
    pair_of: list[int | None] = []
    for i in range(len(candles)):
        k = i - n
        if k >= 0:
            changed = False
            for kind in ("high", "low"):
                vals = highs if kind == "high" else lows
                if not _is_pivot_at(vals, k, n, kind == "high"):
                    continue
                turns[kind].append(k)
                if atr is not None:
                    atr_k = atr[k]
                    if atr_k is None:
                        continue
                    opposite = turns["low" if kind == "high" else "high"]
                    if not _is_significant_swing(highs, lows, opposite, k, kind, atr_k, cfg.min_swing_atr):
                        continue
                if kind == "high":
                    hi = (k, highs[k])
                else:
                    lo = (k, lows[k])
                changed = True
            if changed and hi is not None and lo is not None:
                if hi[0] > lo[0]:
                    direction = 1
                elif hi[0] < lo[0]:
                    direction = -1
                else:
                    direction = 1 if candles[k].close >= candles[k].open else -1
                pairs.append(Pair(hi[0], hi[1], lo[0], lo[1], direction))
        pair_of.append(len(pairs) - 1 if pairs else None)
    return pair_of, pairs


def auto_fib_outputs(cfg: AutoFibConfig) -> tuple[str, ...]:
    """high/low/dir first (the chart click-to-insert token emits outputs[0]),
    then one name per enabled level."""
    return BASE_OUTPUTS + tuple(name for name, _ in cfg.levels)


# The last pair walk: a rule reading several outputs of one instance asks for
# each separately over the same candle list, and only pivot_len and
# min_swing_atr feed the walk. One entry, holding the list itself so its id
# cannot be reused; the length and the last bar catch a list that grew or had
# its forming bar updated in place. Replaced as one tuple, so a concurrent
# reader sees either the old entry or the new one.
_last_walk: tuple | None = None


def _pairs_for(cfg: AutoFibConfig, candles: Sequence[Candle]) -> tuple[list[int | None], list[Pair]]:
    global _last_walk
    tail = candles[-1] if candles else None
    key = (cfg.pivot_len, cfg.min_swing_atr, len(candles),
           (tail.time, tail.open, tail.high, tail.low, tail.close) if tail else None)
    hit = _last_walk
    if hit is not None and hit[0] is candles and hit[1] == key:
        return hit[2]
    walk = compute_pairs(cfg, candles)
    _last_walk = (candles, key, walk)
    return walk


def auto_fib_series(
    cfg: AutoFibConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    # Dispatch on the NAME; an unknown one is the validation layer's error, so
    # it yields an all-None series here.
    pair_of, pairs = _pairs_for(cfg, candles)
    ratio = dict(cfg.levels).get(output)
    out: list[float | None] = []
    for p in pair_of:
        if p is None:
            out.append(None)
            continue
        q = pairs[p]
        if output == "high":
            out.append(q.hi_price)
        elif output == "low":
            out.append(q.lo_price)
        elif output == "dir":
            out.append(float(q.direction))
        elif ratio is not None:
            out.append(fib_level_price(q.hi_price, q.lo_price, q.direction, cfg.reverse, ratio))
        else:
            out.append(None)
    return out


def auto_fib_warmup(cfg: AutoFibConfig, output: str) -> int:
    """ATR(14) warm-up, one full pivot window and the pair reach; 0 for an
    output this config does not expose."""
    if output not in auto_fib_outputs(cfg):
        return 0
    return AUTO_FIB_ATR_LEN + 2 * cfg.pivot_len + AUTO_FIB_PAIR_REACH
