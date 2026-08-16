"""FVG instances (`FVG#id.bull_top` / `.bull_bottom` / `.bear_top` /
`.bear_bottom`): fair value gaps (3-candle imbalances) as live,
mitigation-tracked zones. Ported operation-for-operation from frontend
lib/indicators/fvg.ts (computeFvg / parseFvgConfig) — keep the arithmetic order
identical, per the parity contract in indicators/core.py.

Causal by construction: a gap is confirmed BY the third bar of its pattern and
every later mutation is driven by that later bar's own wick, so values at bar i
depend only on bars [0..i].

    bullish  low[i]  > high[i-2]  -> zone [high[i-2], low[i]]
    bearish  high[i] < low[i-2]   -> zone [high[i],   low[i-2]]

A gap is kept only if its height >= min_size x ATR(14) at the confirm bar; gaps
confirming before ATR(14) is warm are skipped regardless of min_size, which is
what keeps fvg_warmup honest.

Mitigation is WICK-driven, not close-driven: a later bar's low (bullish) or high
(bearish) that reaches or passes the FAR edge kills the gap, one that stops
inside shrinks the zone to the unfilled remainder. Shrinking is what makes the
outputs total — a close is never strictly inside a live zone, so "nearest live
gap below the close" (bullish) and "above the close" (bearish) always resolve.
A gap also expires max_bars after its confirm bar, and only the newest max_gaps
per side stay live."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

FVG_ATR_LEN = 14

_DEFAULTS = (0.25, 500.0, 10.0)


@dataclass(frozen=True, slots=True)
class FvgConfig:
    min_size: float
    max_bars: int
    max_gaps: int
    # Settings-pinned timeframe (extendData.mtf.timeframe, like SLOPE/SR_LEVELS);
    # the evaluator then feeds fvg_series that timeframe's candles and aligns the
    # result onto the base bars (evaluate.py's pinned-IndicatorRef branch).
    timeframe: str | None = None


def parse_fvg_config(calc_params: object, extend_data: object) -> FvgConfig:
    """Mirrors frontend parseFvgConfig: per-field fallback to the defaults on
    anything non-finite or out of range — resolve_instances must not 500 on chart
    state. calcParams order: [min_size, max_bars, max_gaps].

    min_size accepts ZERO (the documented "filter off" value) so it validates on
    `>= 0`, while the two count params keep the usual `> 0` rule. Getting this
    wrong silently restores the default filter, so both runtimes test it."""
    p = calc_params if isinstance(calc_params, (list, tuple)) else []

    def num_at(i: int, default: float, allow_zero: bool) -> float:
        try:
            v = float(p[i])
        except (IndexError, TypeError, ValueError):
            return default
        if not math.isfinite(v):
            return default
        return v if (v >= 0 if allow_zero else v > 0) else default

    ext = extend_data if isinstance(extend_data, dict) else {}
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    return FvgConfig(
        min_size=num_at(0, _DEFAULTS[0], True),
        max_bars=max(1, math.floor(num_at(1, _DEFAULTS[1], False))),
        max_gaps=max(1, math.floor(num_at(2, _DEFAULTS[2], False))),
        timeframe=tf if isinstance(tf, str) and tf and tf != "chart" else None,
    )


class _Gap:
    __slots__ = ("side", "top", "bottom", "created_idx")

    def __init__(self, side: str, bottom: float, top: float, created_idx: int) -> None:
        self.side = side
        self.bottom = bottom
        self.top = top
        self.created_idx = created_idx


def _cap_per_side(live: Sequence[_Gap], max_gaps: int) -> list[_Gap]:
    """The newest max_gaps per side, in CREATION order (TS capPerSide)."""
    bull = 0
    bear = 0
    keep: list[_Gap] = []
    for g in reversed(live):
        if g.side == "bull":
            bull += 1
            n = bull
        else:
            bear += 1
            n = bear
        if n <= max_gaps:
            keep.append(g)
    keep.reverse()
    return keep


def _point_from(live: Sequence[_Gap]) -> tuple[float | None, float | None, float | None, float | None]:
    """Nearest live gap on each side: highest bullish top / lowest bearish bottom,
    ties to the more recent gap (a total order, so both runtimes agree without
    relying on sort stability). TS pointFrom."""
    bull: _Gap | None = None
    bear: _Gap | None = None
    for g in live:
        if g.side == "bull":
            if (
                bull is None
                or g.top > bull.top
                or (g.top == bull.top and g.created_idx > bull.created_idx)
            ):
                bull = g
        elif (
            bear is None
            or g.bottom < bear.bottom
            or (g.bottom == bear.bottom and g.created_idx > bear.created_idx)
        ):
            bear = g
    return (
        bull.top if bull else None,
        bull.bottom if bull else None,
        bear.top if bear else None,
        bear.bottom if bear else None,
    )


def _compute_points(
    cfg: FvgConfig, candles: Sequence[Candle]
) -> list[tuple[float | None, float | None, float | None, float | None]]:
    """Per-bar (bull_top, bull_bottom, bear_top, bear_bottom) — the TS computeFvg
    main loop."""
    length = len(candles)
    atr = atr_series(candles, FVG_ATR_LEN)
    live: list[_Gap] = []
    out: list[tuple[float | None, float | None, float | None, float | None]] = []

    for i in range(length):
        bar = candles[i]
        # 1. Mitigate every OPEN gap with this bar's wick. A gap confirmed at this
        #    bar is appended in step 3, so its own pattern can never fill it.
        for k in range(len(live) - 1, -1, -1):
            g = live[k]
            if g.side == "bull":
                if bar.low <= g.bottom:
                    del live[k]
                elif bar.low < g.top:
                    g.top = bar.low
            elif bar.high >= g.top:
                del live[k]
            elif bar.high > g.bottom:
                g.bottom = bar.high
        # 2. Expire by age.
        for k in range(len(live) - 1, -1, -1):
            if i - live[k].created_idx > cfg.max_bars:
                del live[k]
        # 3. Detect this bar's gap. The two sides are mutually exclusive; bullish
        #    is tested first for a fixed cross-runtime order.
        a = atr[i]
        if i >= 2 and a is not None:
            min_height = a * cfg.min_size
            prev = candles[i - 2]
            if bar.low > prev.high:
                if bar.low - prev.high >= min_height:
                    live.append(_Gap("bull", prev.high, bar.low, i))
            elif bar.high < prev.low:
                if prev.low - bar.high >= min_height:
                    live.append(_Gap("bear", bar.high, prev.low, i))
        out.append(_point_from(_cap_per_side(live, cfg.max_gaps)))
    return out


def fvg_outputs(cfg: FvgConfig) -> tuple[str, ...]:
    """Fixed names (no length suffix): the params shape the SAME four series
    rather than selecting different ones, so retuning keeps rules valid.
    `bull_top` first — the chart click-to-insert token emits outputs[0], and the
    top of a bullish gap is its actionable (nearest-to-price) edge."""
    return ("bull_top", "bull_bottom", "bear_top", "bear_bottom")


_OUTPUT_INDEX = {"bull_top": 0, "bull_bottom": 1, "bear_top": 2, "bear_bottom": 3}


def fvg_series(
    cfg: FvgConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    points = _compute_points(cfg, candles)
    idx = _OUTPUT_INDEX.get(output, 0)
    return [p[idx] for p in points]


def fvg_warmup(cfg: FvgConfig, output: str) -> int:
    """ATR(14) warm-up plus the two bars the 3-candle pattern spans, before the
    first gap can possibly exist. Gaps keep forming after that, so this is the
    floor, matching the other specs' convention. 0 for an output this config does
    not expose (validation layer's error to report)."""
    return FVG_ATR_LEN + 2 if output in _OUTPUT_INDEX else 0
