"""PIVOT_ANALYSIS instances (`PIVOT_ANALYSIS#id.pivotHigh` / `.pivotLow` /
`.deltaPct` / `.deltaT`): forward-filled fractal-pivot operand values, after
LuxAlgo's "Pivots High/Low Analysis & Forecast". Ported operation-for-operation
from frontend lib/indicators/pivotAnalysis.ts (computePivotAnalysis) — keep the
arithmetic order identical, per the parity contract in indicators/core.py.
Chart-timeframe only (no MTF pin — PivotAnalysisExtend carries none).

Causal by construction: a fractal pivot at bar i depends on the N bars to its
right, so it only confirms at i+N; pivotHigh/pivotLow/deltaPct/deltaT all step
at the CONFIRMATION bar, never at the swing bar itself. deltaPct/deltaT track
whichever side (high or low) confirmed most recently — a high confirming after
a low updates them from the high's own delta, and vice versa.

Pivot-high and pivot-low detection use INDEPENDENT lengths (n_high/n_low): each
side confirms n bars after its OWN swing bar, on its own schedule.

min_pct_high/min_pct_low (default 0 = off) filter out small swings: a
candidate pivot only counts — confirms, and becomes the new baseline for the
NEXT same-side Δ% — if it's the first pivot of its side, or its |Δ%| vs the
prior COUNTED same-side pivot meets the threshold. A rejected candidate is
treated as noise: it neither steps the output nor becomes the baseline, so the
next candidate compares against the last pivot that DID count."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle

# Forward-filled operand values, in pane order. `pivotHigh` first — the chart
# click-to-insert token emits outputs[0].
PIVOT_ANALYSIS_OUTPUTS: tuple[str, ...] = ("pivotHigh", "pivotLow", "deltaPct", "deltaT")

_OUTPUT_INDEX = {"pivotHigh": 0, "pivotLow": 1, "deltaPct": 2, "deltaT": 3}

_DEFAULT_LENGTH = 50.0


@dataclass(frozen=True, slots=True)
class PivotAnalysisConfig:
    n_high: int  # pivot-high fractal strength; confirm lag = this many bars
    n_low: int  # pivot-low fractal strength; confirm lag = this many bars
    min_pct_high: float = 0.0  # 0 = off
    min_pct_low: float = 0.0  # 0 = off


def parse_pivot_analysis_config(calc_params: object, extend_data: object) -> PivotAnalysisConfig:
    """Mirrors frontend PIVOT_ANALYSIS_TEMPLATE.calc: calcParams[0]/[1] fall
    back to 50 on anything non-finite or falsy (Math.max(1, Number(x) || 50)),
    else floored and clamped to >= 1; calcParams[2]/[3] fall back to 0
    (Math.max(0, Number(x) || 0)). calcParams order: [highLength, lowLength,
    minPctHigh, minPctLow]. `extend_data` is accepted (not read) to match the
    two-argument IndicatorSeriesSpec.parse_config signature."""
    del extend_data
    p = calc_params if isinstance(calc_params, (list, tuple)) else []

    def len_at(i: int) -> int:
        try:
            v = float(p[i])
        except (IndexError, TypeError, ValueError):
            v = float("nan")
        if not math.isfinite(v) or v == 0:
            v = _DEFAULT_LENGTH
        return max(1, math.floor(v))

    def pct_at(i: int) -> float:
        try:
            v = float(p[i])
        except (IndexError, TypeError, ValueError):
            v = float("nan")
        if not math.isfinite(v):
            v = 0.0
        return max(0.0, v)

    return PivotAnalysisConfig(
        n_high=len_at(0),
        n_low=len_at(1),
        min_pct_high=pct_at(2),
        min_pct_low=pct_at(3),
    )


def _is_pivot_at(values: Sequence[float], i: int, n: int, want_high: bool) -> bool:
    """pivots.ts isPivotAt with strict=True (no flat extremes), lbL = lbR = n."""
    v = values[i]
    if i - n < 0 or i + n >= len(values):
        return False
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


def _compute_points(
    cfg: PivotAnalysisConfig, candles: Sequence[Candle]
) -> list[tuple[float | None, float | None, float | None, float | None]]:
    """Per-bar (pivotHigh, pivotLow, deltaPct, deltaT) — the TS
    computePivotAnalysis operand path (swing-bar events are draw-only and are
    not ported here)."""
    n_high, n_low = cfg.n_high, cfg.n_low
    length = len(candles)
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]

    # (confirm_at, is_high, price, deltaPct, deltaT), built walking bars in
    # order exactly like the TS loop: a high confirm is queued before a low
    # confirm on the same swing bar.
    confirms: list[tuple[int, bool, float, float | None, float | None]] = []
    prev_high: tuple[int, float] | None = None
    prev_low: tuple[int, float] | None = None

    for i in range(length):
        if _is_pivot_at(highs, i, n_high, True):
            price = highs[i]
            delta_pct = (price - prev_high[1]) / prev_high[1] * 100 if prev_high else None
            # A candidate with a prior baseline counts only if it clears the
            # threshold; a rejected candidate leaves prev_high untouched, so
            # it neither steps the output nor becomes the next baseline.
            if prev_high is None or abs(delta_pct) >= cfg.min_pct_high:  # type: ignore[arg-type]
                delta_t = float(i - prev_high[0]) if prev_high else None
                confirms.append((i + n_high, True, price, delta_pct, delta_t))
                prev_high = (i, price)
        if _is_pivot_at(lows, i, n_low, False):
            price = lows[i]
            delta_pct = (price - prev_low[1]) / prev_low[1] * 100 if prev_low else None
            if prev_low is None or abs(delta_pct) >= cfg.min_pct_low:  # type: ignore[arg-type]
                delta_t = float(i - prev_low[0]) if prev_low else None
                confirms.append((i + n_low, False, price, delta_pct, delta_t))
                prev_low = (i, price)

    # Stable sort by confirm bar only — matches TS Array.sort((a,b)=>a.at-b.at),
    # which is a stable sort, so same-bar high/low keep their emit order.
    confirms.sort(key=lambda c: c[0])

    out: list[tuple[float | None, float | None, float | None, float | None]] = []
    ci = 0
    cur_high: float | None = None
    cur_low: float | None = None
    cur_delta_pct: float | None = None
    cur_delta_t: float | None = None
    for i in range(length):
        while ci < len(confirms) and confirms[ci][0] == i:
            _, is_high, price, delta_pct, delta_t = confirms[ci]
            if is_high:
                cur_high = price
            else:
                cur_low = price
            cur_delta_pct = delta_pct
            cur_delta_t = delta_t
            ci += 1
        out.append((cur_high, cur_low, cur_delta_pct, cur_delta_t))
    return out


def pivot_analysis_outputs(cfg: PivotAnalysisConfig) -> tuple[str, ...]:
    return PIVOT_ANALYSIS_OUTPUTS


def pivot_analysis_series(
    cfg: PivotAnalysisConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    points = _compute_points(cfg, candles)
    idx = _OUTPUT_INDEX.get(output, 0)
    return [p[idx] for p in points]


def pivot_analysis_warmup(cfg: PivotAnalysisConfig, output: str) -> int:
    """Bars before the first pivot can possibly exist on EITHER side: the
    larger of the two confirm lags. deltaPct/deltaT need a SECOND same-side
    pivot, but per the other specs' convention the floor tracks the
    first-possible-value bar, not the strictest output. The % filter changes
    WHICH pivots count, not the confirm lag, so it does not affect this floor.
    0 for an output this config does not expose (validation layer's error to
    report)."""
    return max(cfg.n_high, cfg.n_low) if output in _OUTPUT_INDEX else 0
