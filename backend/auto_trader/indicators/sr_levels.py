"""SR_LEVELS instances (`SR_LEVELS#id.support` / `.resistance`): major
support/resistance zones from clustered fractal pivots. Ported
operation-for-operation from frontend lib/indicators/srLevels.ts
(computeSrLevels / parseSrConfig) — keep the arithmetic order identical, per
the parity contract in indicators/core.py. Chart-timeframe only.

Causal by construction: a strict fractal pivot at bar i confirms at i+N, and
every cluster mutation happens at confirm bars, so values at bar i depend only
on bars [0..i]. A confirmed pivot merges into the nearest level within
tolerance = ATR(14) x atr_mult at the confirm bar, else seeds a new level;
pivots confirming before ATR(14) is warm are skipped. A level is major with
>= min_touches members and a touch within the trailing max_bars window; only
the strongest max_levels are live. Outputs per bar: `support` (nearest major
level price at/below close), `resistance` (nearest above close)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

SR_ATR_LEN = 14

_DEFAULTS = (15.0, 0.5, 2.0, 8.0, 500.0)


@dataclass(frozen=True, slots=True)
class SrConfig:
    pivot_len: int
    atr_mult: float
    min_touches: int
    max_levels: int
    max_bars: int
    # Settings-pinned timeframe (extendData.mtf.timeframe, like SLOPE); the
    # evaluator then feeds sr_series that timeframe's candles and aligns the
    # result onto the base bars (evaluate.py's pinned-IndicatorRef branch).
    timeframe: str | None = None


def parse_sr_config(calc_params: object, extend_data: object) -> SrConfig:
    """Mirrors frontend parseSrConfig: per-field fallback to the defaults on
    anything non-finite or <= 0 — resolve_instances must not 500 on chart
    state. calcParams order: [pivotLen, atrMult, minTouches, maxLevels,
    maxBars]."""
    p = calc_params if isinstance(calc_params, (list, tuple)) else []

    def num_at(i: int, default: float) -> float:
        try:
            v = float(p[i])
        except (IndexError, TypeError, ValueError):
            return default
        return v if math.isfinite(v) and v > 0 else default

    ext = extend_data if isinstance(extend_data, dict) else {}
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    return SrConfig(
        pivot_len=max(1, math.floor(num_at(0, _DEFAULTS[0]))),
        atr_mult=num_at(1, _DEFAULTS[1]),
        min_touches=max(1, math.floor(num_at(2, _DEFAULTS[2]))),
        max_levels=max(1, math.floor(num_at(3, _DEFAULTS[3]))),
        max_bars=max(1, math.floor(num_at(4, _DEFAULTS[4]))),
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


class _Cluster:
    __slots__ = ("sum", "touches", "first_idx", "last_confirm", "half_width")

    def __init__(self, price: float, first_idx: int, confirm_idx: int, tol: float) -> None:
        self.sum = price
        self.touches = 1
        self.first_idx = first_idx
        self.last_confirm = confirm_idx
        self.half_width = tol

    @property
    def price(self) -> float:
        return self.sum / self.touches


def _compute_points(
    cfg: SrConfig, candles: Sequence[Candle]
) -> list[tuple[float | None, float | None]]:
    """Per-bar (support, resistance) — the TS computeSrLevels main loop."""
    length = len(candles)
    n = cfg.pivot_len
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    atr = atr_series(candles, SR_ATR_LEN)

    high_at: dict[int, int] = {}
    low_at: dict[int, int] = {}
    for i in range(length):
        if _is_pivot_at(highs, i, n, True):
            high_at[i + n] = i
        if _is_pivot_at(lows, i, n, False):
            low_at[i + n] = i

    clusters: list[_Cluster] = []

    def touch(price: float, pivot_idx: int, confirm_idx: int, tol: float) -> None:
        best: _Cluster | None = None
        best_dist = math.inf
        for c in clusters:
            dist = abs(price - c.price)
            if dist <= tol and dist < best_dist:
                best = c
                best_dist = dist
        if best is not None:
            best.sum += price
            best.touches += 1
            best.last_confirm = confirm_idx
            best.half_width = tol
        else:
            clusters.append(_Cluster(price, pivot_idx, confirm_idx, tol))

    def major_at(i: int) -> list[_Cluster]:
        live = [c for c in clusters if c.touches >= cfg.min_touches and c.last_confirm >= i - cfg.max_bars]
        live.sort(key=lambda c: (-c.touches, -c.last_confirm, c.first_idx, c.price))
        return live[: cfg.max_levels]

    out: list[tuple[float | None, float | None]] = []
    for i in range(length):
        tol_atr = atr[i]
        if tol_atr is not None:
            tol = tol_atr * cfg.atr_mult
            h = high_at.get(i)
            if h is not None:
                touch(highs[h], h, i, tol)
            low = low_at.get(i)
            if low is not None:
                touch(lows[low], low, i, tol)
        close = candles[i].close
        support: float | None = None
        resistance: float | None = None
        for c in major_at(i):
            p = c.price
            if p <= close:
                if support is None or p > support:
                    support = p
            elif resistance is None or p < resistance:
                resistance = p
        out.append((support, resistance))
    return out


def sr_outputs(cfg: SrConfig) -> tuple[str, ...]:
    """Fixed names (no length suffix): the params shape the SAME two series
    rather than selecting different ones, so retuning keeps rules valid.
    `support` first — the chart click-to-insert token emits outputs[0]."""
    return ("support", "resistance")


def sr_series(
    cfg: SrConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    points = _compute_points(cfg, candles)
    idx = 0 if output == "support" else 1
    return [p[idx] for p in points]


def sr_warmup(cfg: SrConfig, output: str) -> int:
    """ATR(14) warm-up plus one full pivot window (extreme + confirm lag)
    before the first touch can possibly exist. Levels keep accumulating after
    that, so this is the floor, matching the other specs' convention. 0 for an
    output this config does not expose (validation layer's error to report)."""
    return SR_ATR_LEN + 2 * cfg.pivot_len if output in ("support", "resistance") else 0
