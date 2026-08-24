"""PIVOT_BANDS instances (`PIVOT_BANDS#id.pivotHigh` / `.pivotLow`): two
step-lines tracking the most recently confirmed fractal swing high/low (or the
average of the newest K). Ported operation-for-operation from frontend
lib/indicators/pivotBands.ts (computePivotBands) — keep the arithmetic order
identical, per the parity contract in indicators/core.py.

Causal by construction: a fractal pivot at bar i depends on the N bars to its
right, so it is only known at bar i+N; each line holds its prior value across
bars i..i+N-1 and steps to the new value at i+N.

Mode ("last" default / "avg"): carry the newest confirmed pivot, or the mean
of the newest K (calcParams[1]) — averaged over however many exist before K
accumulate.

Source ("hl" default, extendData.source): pivot-highs off each bar's high and
pivot-lows off its low. Any other PriceSource drives BOTH lines off that
single series (mirrors PivotBandsSource in pivotBands.ts).

The math here is chart-agnostic: a settings-pinned timeframe
(extendData.mtf.timeframe) needs no change below the config — the evaluator
computes on that timeframe's own candles and aligns the result onto the base
bars, exactly as it does for SR_LEVELS/TRENDLINES."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from auto_trader.core.models import Candle
from auto_trader.indicators.core import price_of

Mode = Literal["last", "avg"]

_DEFAULTS = (5.0, 3.0)

# Fixed names (no length suffix): the params shape the SAME two series rather
# than selecting different ones, so retuning keeps rules valid. `pivotHigh`
# first — the chart click-to-insert token emits outputs[0].
PIVOT_BANDS_OUTPUTS: tuple[str, ...] = ("pivotHigh", "pivotLow")


@dataclass(frozen=True, slots=True)
class PivotBandsConfig:
    n: int  # fractal strength; confirm lag = this many bars
    k: int  # avg window (mode == "avg")
    mode: Mode
    source: str | None  # None = "hl" (asymmetric high/low); else one PriceSource for both lines
    # Settings-pinned timeframe (extendData.mtf.timeframe, like SLOPE/SR_LEVELS).
    timeframe: str | None = None


def parse_pivot_bands_config(calc_params: object, extend_data: object) -> PivotBandsConfig:
    """Mirrors frontend PIVOT_BANDS_TEMPLATE.calc: calcParams[0]/[1] fall back
    to 5/3 on anything non-finite or falsy (Math.max(1, Number(x) || default)),
    else floored and clamped to >= 1. calcParams order: [N (strength), K (avg
    window)]."""
    p = calc_params if isinstance(calc_params, (list, tuple)) else []

    def int_at(i: int, default: float) -> int:
        try:
            v = float(p[i])
        except (IndexError, TypeError, ValueError):
            v = float("nan")
        if not math.isfinite(v) or v == 0:
            v = default
        return max(1, math.floor(v))

    ext = extend_data if isinstance(extend_data, dict) else {}
    mode: Mode = "avg" if ext.get("mode") == "avg" else "last"
    source = ext.get("source")
    source = source if isinstance(source, str) and source and source != "hl" else None
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    return PivotBandsConfig(
        n=int_at(0, _DEFAULTS[0]),
        k=int_at(1, _DEFAULTS[1]),
        mode=mode,
        source=source,
        timeframe=tf if isinstance(tf, str) and tf and tf != "chart" else None,
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


def _held_value(pivots: Sequence[float], mode: Mode, k: int) -> float:
    """The value held for one side given the confirmed pivot prices SO FAR
    (most recent last). TS heldValue."""
    if mode == "avg":
        window = pivots[max(0, len(pivots) - k) :]
        return sum(window) / len(window)
    return pivots[-1]


def _compute_points(
    cfg: PivotBandsConfig, candles: Sequence[Candle]
) -> list[tuple[float | None, float | None]]:
    """Per-bar (pivotHigh, pivotLow) — the TS computePivotBands main loop."""
    length = len(candles)
    if cfg.source is None:
        highs = [c.high for c in candles]
        lows = [c.low for c in candles]
    else:
        highs = [price_of(c, cfg.source) for c in candles]
        lows = highs

    high_pivot_at_confirm: dict[int, float] = {}
    low_pivot_at_confirm: dict[int, float] = {}
    for i in range(length):
        if _is_pivot_at(highs, i, cfg.n, True):
            high_pivot_at_confirm[i + cfg.n] = highs[i]
        if _is_pivot_at(lows, i, cfg.n, False):
            low_pivot_at_confirm[i + cfg.n] = lows[i]

    high_pivots: list[float] = []
    low_pivots: list[float] = []
    out: list[tuple[float | None, float | None]] = []
    for i in range(length):
        h = high_pivot_at_confirm.get(i)
        if h is not None:
            high_pivots.append(h)
        low = low_pivot_at_confirm.get(i)
        if low is not None:
            low_pivots.append(low)
        out.append(
            (
                _held_value(high_pivots, cfg.mode, cfg.k) if high_pivots else None,
                _held_value(low_pivots, cfg.mode, cfg.k) if low_pivots else None,
            )
        )
    return out


def pivot_bands_outputs(cfg: PivotBandsConfig) -> tuple[str, ...]:
    return PIVOT_BANDS_OUTPUTS


def pivot_bands_series(
    cfg: PivotBandsConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    points = _compute_points(cfg, candles)
    idx = 0 if output == "pivotHigh" else 1
    return [p[idx] for p in points]


def pivot_bands_warmup(cfg: PivotBandsConfig, output: str) -> int:
    """Confirm lag N before the first pivot can possibly exist. Values keep
    stepping after that, so this is the floor, matching the other specs'
    convention. 0 for an output this config does not expose (validation
    layer's error to report)."""
    return cfg.n if output in PIVOT_BANDS_OUTPUTS else 0
