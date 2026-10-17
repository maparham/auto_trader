"""LR pane (registry type `LR`) for rules and alerts: the ROLLING least-squares
endpoint (TradingView ta.linreg, offset 0). Value at bar i is the fit over the
`length` bars ending at i, evaluated at i; up/dn add and subtract mult times
that window's RMS residual. The chart draws one fit over the newest window
instead (lib/indicators/lr.ts computeLr). Ported operation for operation from
lib/indicators/lrOutputs.ts lrSeries; the parity fixture pins the two."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import PRICE_SOURCES, price_of

LR_OUTPUTS: tuple[str, ...] = ("lr", "up", "dn")


@dataclass(frozen=True, slots=True)
class LrConfig:
    length: int
    mult: float
    source: str


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def parse_lr_config(calc_params: object, extend_data: object) -> LrConfig:
    """calcParams = [length, mult] with the template's `|| default` fallbacks;
    length floors at 2 (a fit needs two points). lineHidden is display only."""
    p = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    n = _num(p[0]) if p else None
    m = _num(p[1]) if len(p) > 1 else None
    ext = extend_data if isinstance(extend_data, dict) else {}
    source = ext.get("source") if ext.get("source") in PRICE_SOURCES else "close"
    return LrConfig(length=max(2, math.floor(n)) if n else 100, mult=float(m) if m else 2.0, source=source)


def lr_outputs(cfg: LrConfig) -> tuple[str, ...]:
    return LR_OUTPUTS


def lr_series(cfg: LrConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output not in LR_OUTPUTS:
        raise ValueError(f"unknown LR output {output!r}")
    n = len(candles)
    size = cfg.length
    out: list[float | None] = [None] * n
    if size > n:
        return out
    ys = [price_of(c, cfg.source) for c in candles]
    for i in range(size - 1, n):
        start = i - size + 1
        sx = sy = sxy = sxx = 0.0
        for k in range(size):
            y = ys[start + k]
            sx += k
            sy += y
            sxy += k * y
            sxx += k * k
        denom = size * sxx - sx * sx
        slope = (size * sxy - sx * sy) / denom if denom != 0 else 0.0
        intercept = (sy - slope * sx) / size
        end = intercept + slope * (size - 1)
        if output == "lr":
            out[i] = end
            continue
        sse = 0.0
        for k in range(size):
            fit = intercept + slope * k
            d = ys[start + k] - fit
            sse += d * d
        width = cfg.mult * math.sqrt(sse / size)
        out[i] = end + width if output == "up" else end - width
    return out


def lr_warmup(cfg: LrConfig, output: str) -> int:
    return cfg.length if output in LR_OUTPUTS else 0
