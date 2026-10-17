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

from auto_trader.core.alert_bars import candle_ms
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


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


_SOURCES = ("close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4")


def _js_truthy(v: object) -> bool:
    """JavaScript truthiness for a JSON value: [] and {} are truthy there."""
    if isinstance(v, (list, dict)):
        return True
    return bool(v)


def parse_avwap_config(calc_params: object, extend_data: object) -> VwapConfig:
    """AVWAP_TEMPLATE.calc's reading: anchor (epoch ms) in calcParams[0]
    (`Number || 0`, <= 0 unplaced); source, bandMode, bands on extendData.
    lineHidden and slopeColor are display only."""
    p = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    a = _num(p[0]) if p else None
    ext = extend_data if isinstance(extend_data, dict) else {}
    source = ext.get("source") if ext.get("source") in _SOURCES else "hlc3"
    band_mode = "percentage" if ext.get("bandMode") == "percentage" else "stdev"
    # vwapFrom's reading: any length, a missing index is off, `on` is truthy;
    # defaults only when bands is absent or not a list. An off band (or one
    # whose mult is not a finite number) is stored as off with its default
    # mult, so equal panes share one canonical config.
    raw = ext.get("bands")
    bands = DEFAULT_BANDS
    if isinstance(raw, list):
        parsed = []
        for i, (_, d_mult) in enumerate(DEFAULT_BANDS):
            b = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
            m = _num(b.get("mult"))
            # Ruling F3: a truthy `on` with a null, boolean or non-finite mult parses
            # as off here, where vwapFrom's `bands[b].mult * stdev` (or `/ 100`) still
            # coerces that mult to a number and draws a band from it; only reachable
            # with a hand-written extendData payload, never from the settings modal.
            on = _js_truthy(b.get("on")) and m is not None
            parsed.append((True, float(m)) if on else (False, d_mult))
        bands = tuple(parsed)
    return VwapConfig(source=source, band_mode=band_mode, bands=bands, anchor_ms=int(a) if a else 0)


def avwap_outputs(cfg: VwapConfig) -> tuple[str, ...]:
    out = ["vwap"]
    for b, (on, _) in enumerate(cfg.bands):
        if on:
            out += [f"up{b + 1}", f"dn{b + 1}"]
    return tuple(out)


def avwap_start(candles: Sequence[Candle], anchor_ms: int) -> int:
    """First bar whose open time is at or after the anchor; len() if none
    (core.avwap_series' rule)."""
    for i, c in enumerate(candles):
        if candle_ms(c) >= anchor_ms:
            return i
    return len(candles)


def avwap_pane_series(cfg: VwapConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    if output not in avwap_outputs(cfg):
        raise ValueError(f"unknown AVWAP output {output!r}")
    if cfg.anchor_ms <= 0 or not candles or candle_ms(candles[0]) > cfg.anchor_ms:
        # Unplaced, or anchored before the first bar held: accumulating from the
        # window start would be a different VWAP than the chart's, so wait blank
        # (the alert hub keeps a bounded seed; old anchors fall off its front).
        return [None] * len(candles)
    return vwap_from(candles, avwap_start(candles, cfg.anchor_ms), cfg)[output]
