"""RSI pane instances (`RSI.value`, `RSI.bullDiv`, `RSI.bearDiv`,
`RSI.hBullDiv`, `RSI.hBearDiv`). Mirrors the frontend pane
(lib/indicators/rsi.ts computeRsi / detectDivergences, lib/indicators/
rsiOutputs.ts parse/outputs/warm-up). Chart-timeframe only (no MTF pin).

The divergence outputs are per-bar 0/1 event series. A divergence fires 1.0 on
the bar it becomes KNOWN: its right pivot plus `lookbackRight` bars, the bar
that confirms the pivot. The chart draws the line back to the pivot bar, but a
backtest acting there would read `lookbackRight` bars of the future.

Each output force-detects its own kind, whatever the pane's `on` switch and
per-kind display toggles say: the toggles decide what the chart DRAWS, not
what a rule may read. Kinds are detected independently in the TS emit loop,
so forcing one kind gives exactly the segments the chart draws for it."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import PRICE_SOURCES, price_of, rsi_series

# Value line first, then the four divergence kinds in the chart's order.
RSI_OUTPUTS: tuple[str, ...] = ("value", "bullDiv", "bearDiv", "hBullDiv", "hBearDiv")

_KIND_OF = {
    "bullDiv": "bullish",
    "bearDiv": "bearish",
    "hBullDiv": "hiddenBullish",
    "hBearDiv": "hiddenBearish",
}


@dataclass(frozen=True, slots=True)
class RsiConfig:
    length: int = 14
    source: str = "close"
    lookback_left: int = 5
    lookback_right: int = 5
    range_min: int = 5
    range_max: int = 60
    pivot_depth: int = 3


def _floor_or(v: object, default: int) -> int:
    """JS `Math.floor(Number(v)) || default`: NaN, ±inf and 0 take the default."""
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if not math.isfinite(f):
        return default
    return math.floor(f) or default


def parse_rsi_config(calc_params: object, extend_data: object) -> RsiConfig:
    """Length in calcParams[0], divergence tuning on extendData.divergence,
    merged over RSI_DIVERGENCE_DEFAULTS with detectDivergences' clamps.
    Mirrors rsiOutputs.ts parseRsiRefConfig; malformed input takes defaults."""
    length = 14
    if isinstance(calc_params, (list, tuple)) and calc_params:
        length = max(1, _floor_or(calc_params[0], 14))
    ext = extend_data if isinstance(extend_data, dict) else {}
    src = ext.get("source")
    div = ext.get("divergence")
    div = div if isinstance(div, dict) else {}
    lbl = max(1, _floor_or(div.get("lookbackLeft", 5), 1))
    lbr = max(1, _floor_or(div.get("lookbackRight", 5), 1))
    lo = max(1, _floor_or(div.get("rangeMin", 5), 1))
    hi = max(lo, _floor_or(div.get("rangeMax", 60), lo))
    depth = max(1, _floor_or(div.get("pivotDepth", 3), 1))
    return RsiConfig(
        length=length,
        source=src if src in PRICE_SOURCES else "close",
        lookback_left=lbl,
        lookback_right=lbr,
        range_min=lo,
        range_max=hi,
        pivot_depth=depth,
    )


def rsi_outputs(cfg: RsiConfig) -> tuple[str, ...]:
    return RSI_OUTPUTS


def _is_pivot(v: Sequence[float | None], i: int, lbl: int, lbr: int, want: str) -> bool:
    """pivots.ts isPivotAt with strict=false: ties allowed, an undefined
    neighbour rejects."""
    x = v[i]
    if x is None or i - lbl < 0 or i + lbr >= len(v):
        return False
    for j in range(i - lbl, i + lbr + 1):
        if j == i:
            continue
        w = v[j]
        if w is None:
            return False
        if want == "low" and w < x:
            return False
        if want == "high" and w > x:
            return False
    return True


def divergence_pivots(
    candles: Sequence[Candle], rsi: Sequence[float | None], cfg: RsiConfig, kind: str
) -> list[tuple[int, int]]:
    """(from pivot index, to pivot index) per confirmed divergence of `kind`,
    exactly the confirmed segments detectDivergences emits for that kind."""
    side = "low" if kind in ("bullish", "hiddenBullish") else "high"
    lbl, lbr = cfg.lookback_left, cfg.lookback_right
    lo, hi, depth = cfg.range_min, cfg.range_max, cfg.pivot_depth

    def test(p: tuple[int, float, float], cur: tuple[int, float, float]) -> bool:
        if kind == "bullish":
            return cur[1] > p[1] and cur[2] < p[2]
        if kind == "hiddenBullish":
            return cur[1] < p[1] and cur[2] > p[2]
        if kind == "bearish":
            return cur[1] < p[1] and cur[2] > p[2]
        return cur[1] > p[1] and cur[2] < p[2]  # hiddenBearish

    def pierced(prev: list[tuple[int, float, float]], k: int, cur: tuple[int, float, float]) -> bool:
        a = prev[k]
        slope = (cur[1] - a[1]) / (cur[0] - a[0])
        for q in prev[k + 1:]:
            if q[0] >= cur[0]:
                break
            line = a[1] + slope * (q[0] - a[0])
            if (q[1] < line) if side == "low" else (q[1] > line):
                return True
        return False

    out: list[tuple[int, int]] = []
    prev: list[tuple[int, float, float]] = []  # (index, rsi, price)
    for i in range(len(rsi)):
        if not _is_pivot(rsi, i, lbl, lbr, side):
            continue
        c = candles[i]
        cur = (i, float(rsi[i]), c.low if side == "low" else c.high)  # type: ignore[arg-type]
        tried = 0
        k = len(prev) - 1
        while k >= 0 and tried < depth:
            p = prev[k]
            dist = cur[0] - p[0]
            if dist > hi:
                break
            if dist >= lo and test(p, cur) and not pierced(prev, k, cur):
                out.append((p[0], cur[0]))
                break
            k -= 1
            tried += 1
        prev.append(cur)
    return out


def rsi_series_for(cfg: RsiConfig, candles: Sequence[Candle]) -> list[float | None]:
    return rsi_series([price_of(c, cfg.source) for c in candles], cfg.length)


def rsi_pane_series(
    cfg: RsiConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    rsi = rsi_series_for(cfg, candles)
    if output == "value":
        return rsi
    kind = _KIND_OF.get(output)
    n = len(candles)
    if kind is None:
        return [None] * n
    out: list[float | None] = [None if v is None else 0.0 for v in rsi]
    for _, to in divergence_pivots(candles, rsi, cfg, kind):
        at = to + cfg.lookback_right  # the confirming bar; always < n
        out[at] = 1.0
    return out


def rsi_warmup(cfg: RsiConfig, output: str) -> int:
    """value: the RSI length. Divergences: the RSI length plus the farthest
    earlier pivot (range_max) plus both pivot windows. 0 for an unknown output."""
    if output == "value":
        return cfg.length
    if output in _KIND_OF:
        return cfg.length + cfg.range_max + cfg.lookback_left + cfg.lookback_right
    return 0
