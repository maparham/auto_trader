"""EMA / MA panes (registry types `EMA` and `MA`). Mirrors the chart-timeframe
path of frontend lib/indicators/ma.ts computeMa: length in calcParams[0],
maType/source/offset/smoothing/envelope on extendData, a pin in
extendData.mtf.timeframe (whoever feeds this the pin's bars computes on
them; a pinned pane draws no envelope, as on the chart)."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import PRICE_SOURCES, ema_series, sma_series
from auto_trader.indicators.slope import MA_KINDS, ma_base

_SMOOTH_TYPES = ("sma", "ema")


@dataclass(frozen=True, slots=True)
class MaConfig:
    length: int
    ma_type: str
    source: str
    offset: int
    smoothing: tuple[str, int] | None
    envelope: bool
    timeframe: str | None


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def parse_ma_config(calc_params: object, extend_data: object, *, template: str) -> MaConfig:
    """`Number(calcParams[0]) || default` like the template's calc; every other
    field falls back to the chart's own default on anything malformed."""
    p = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    n = _num(p[0]) if p else None
    length = int(n) if n else (9 if template == "ema" else 20)
    ext = extend_data if isinstance(extend_data, dict) else {}
    ma_type = ext.get("maType") if ext.get("maType") in MA_KINDS else template
    source = ext.get("source") if ext.get("source") in PRICE_SOURCES else "close"
    off = _num(ext.get("offset"))
    offset = int(off) if off else 0
    sm = ext.get("smoothing")
    smoothing: tuple[str, int] | None = None
    if isinstance(sm, dict) and sm.get("type") in _SMOOTH_TYPES:
        sl = _num(sm.get("length"))
        if sl and sl > 0:
            smoothing = (sm["type"], int(sl))
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    return MaConfig(
        length=length, ma_type=ma_type, source=source, offset=offset, smoothing=smoothing,
        envelope=bool(ext.get("envelope")), timeframe=tf if isinstance(tf, str) and tf else None,
    )


def ma_outputs(cfg: MaConfig) -> tuple[str, ...]:
    out = ("ma",)
    if cfg.smoothing is not None:
        out += ("smoothingMa",)
    if cfg.envelope and cfg.timeframe is None:
        out += ("bandHi", "bandLo")
    return out


def _shift(series: list[float | None], k: int) -> list[float | None]:
    """mtf.ts applyOffset: offset > 0 plots the line k bars later."""
    if not k:
        return series
    out: list[float | None] = [None] * len(series)
    for i, v in enumerate(series):
        j = i + k
        if 0 <= j < len(series):
            out[j] = v
    return out


def _smooth(base: list[float | None], s: tuple[str, int]) -> list[float | None]:
    """mtf.ts maSeries smoothing: smooth only the defined tail, keep the gap."""
    start = next((i for i, v in enumerate(base) if v is not None), None)
    out: list[float | None] = [None] * len(base)
    if start is None:
        return out
    defined = [float(v) for v in base[start:]]  # contiguous once defined
    kind, length = s
    smoothed = ema_series(defined, length) if kind == "ema" else sma_series(defined, length)
    for i, v in enumerate(smoothed):
        out[start + i] = v
    return out


def ma_pane_series(cfg: MaConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    """bar_hours is unused; the IndicatorSeriesSpec signature requires it."""
    if output not in ma_outputs(cfg):
        return [None] * len(candles)
    if output == "bandHi":
        return ma_base(candles, cfg.ma_type, cfg.length, "high")
    if output == "bandLo":
        return ma_base(candles, cfg.ma_type, cfg.length, "low")
    base = ma_base(candles, cfg.ma_type, cfg.length, cfg.source)
    if output == "smoothingMa":
        return _smooth(base, cfg.smoothing)  # type: ignore[arg-type]  # outputs() guarantees it
    return _shift(base, cfg.offset)


def ma_warmup(cfg: MaConfig, output: str) -> int:
    if output not in ma_outputs(cfg):
        return 0
    if output == "ma":
        return cfg.length + max(cfg.offset, 0)
    if output == "smoothingMa":
        return cfg.length + cfg.smoothing[1]  # type: ignore[index]
    return cfg.length
