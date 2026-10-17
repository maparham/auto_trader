"""VWAP and AVWAP panes (registry types `VWAP` and `AVWAP`). Ported operation
for operation from frontend lib/indicators/vwap.ts vwapFrom: cumulative
price*volume over cumulative volume from a start bar, blank while cumulative
volume is 0, plus up to three stdev or percentage bands. The stdev is the
volume-weighted deviation, variance = sum(p*p*v)/sum(v) - vwap*vwap clamped
at 0. Plain VWAP starts at the first bar it is given with fixed settings (its
template passes only slopeColor). core.avwap_series is the expr function
AVWAP(anchor) and stays as is; test_avwap_pane.py pins that vwap_from's line
equals it for an hlc3 pane."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import price_of

VWAP_BAND_KEYS: tuple[str, ...] = ("up1", "dn1", "up2", "dn2", "up3", "dn3")
DEFAULT_BANDS: tuple[tuple[bool, float], ...] = ((True, 1.0), (False, 2.0), (False, 3.0))


@dataclass(frozen=True, slots=True)
class VwapConfig:
    source: str
    band_mode: str                         # "stdev" | "percentage"
    bands: tuple[tuple[bool, float], ...]  # three (on, mult) pairs
    anchor_ms: int                         # 0 for plain VWAP (from the first bar)


def vwap_from(candles: Sequence[Candle], start: int, cfg: VwapConfig) -> dict[str, list[float | None]]:
    n = len(candles)
    out: dict[str, list[float | None]] = {k: [None] * n for k in ("vwap", *VWAP_BAND_KEYS)}
    cum_pv = 0.0
    cum_ppv = 0.0
    cum_v = 0.0
    for i in range(start, n):
        c = candles[i]
        price = price_of(c, cfg.source)
        vol = c.volume
        cum_pv += price * vol
        cum_ppv += price * price * vol
        cum_v += vol
        if cum_v <= 0:
            continue
        vwap = cum_pv / cum_v
        out["vwap"][i] = vwap
        stdev = math.sqrt(max(0.0, cum_ppv / cum_v - vwap * vwap)) if cfg.band_mode == "stdev" else 0.0
        for b, (on, mult) in enumerate(cfg.bands):
            if not on:
                continue
            width = mult * stdev if cfg.band_mode == "stdev" else vwap * (mult / 100)
            out[f"up{b + 1}"][i] = vwap + width
            out[f"dn{b + 1}"][i] = vwap - width
    return out


def parse_vwap_config(calc_params: object, extend_data: object) -> VwapConfig:
    """Plain VWAP ignores its payload: the template never hands it a setting."""
    return VwapConfig(source="hlc3", band_mode="stdev", bands=DEFAULT_BANDS, anchor_ms=0)


def vwap_outputs(cfg: VwapConfig) -> tuple[str, ...]:
    return ("vwap",)


def vwap_series(cfg: VwapConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output != "vwap":
        raise ValueError(f"unknown VWAP output {output!r}")
    return vwap_from(candles, 0, cfg)["vwap"]


def vwap_warmup(cfg: VwapConfig, output: str) -> int:
    """Blank until cumulative volume is positive: a volume condition, not a
    bar count, so the floor is 0."""
    return 0
