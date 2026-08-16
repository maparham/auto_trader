"""Generic series-indicator descriptors. This module is the ONLY thing
strategy/expr/ may import from the indicator layer: the expression evaluator
resolves an IndicatorRef through a spec and never learns what a slope is.

Registering a new referenceable indicator means adding one entry here plus its
own module — no expression-layer edit."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from auto_trader.core.models import Candle
from auto_trader.indicators import atr as _atr
from auto_trader.indicators import slope as _slope
from auto_trader.indicators import sr_levels as _sr


@dataclass(frozen=True, slots=True)
class IndicatorSeriesSpec:
    # (calcParams, extendData) -> an opaque config object
    parse_config: Callable[[Any, Any], Any]
    # config -> the legal output names, in pane order
    outputs: Callable[[Any], tuple[str, ...]]
    # (config, output, candles, bar_hours) -> per-bar values
    series: Callable[[Any, str, Sequence[Candle], float], list[float | None]]
    # (config, output) -> warm-up bars
    warmup: Callable[[Any, str], int]
    # config -> the instance's own timeframe pin, or None
    timeframe: Callable[[Any], str | None]


SERIES_INDICATORS: dict[str, IndicatorSeriesSpec] = {
    "ATR": IndicatorSeriesSpec(
        parse_config=_atr.parse_atr_config,
        outputs=_atr.atr_outputs,
        series=_atr.atr_pane_series,
        warmup=_atr.atr_warmup,
        timeframe=lambda cfg: None,
    ),
    "SR_LEVELS": IndicatorSeriesSpec(
        parse_config=_sr.parse_sr_config,
        outputs=_sr.sr_outputs,
        series=_sr.sr_series,
        warmup=_sr.sr_warmup,
        timeframe=lambda cfg: cfg.timeframe,
    ),
    "SLOPE": IndicatorSeriesSpec(
        parse_config=_slope.parse_slope_config,
        outputs=_slope.slope_outputs,
        series=_slope.slope_series,
        warmup=_slope.slope_warmup,
        timeframe=lambda cfg: cfg.timeframe,
    ),
}


@dataclass(frozen=True, slots=True)
class ResolvedInstance:
    type: str
    config: Any
    spec: IndicatorSeriesSpec


def instance_type_of(instance_id: str) -> str:
    """Best-effort fallback for a payload that omits `type` (the frontend's
    collectExprInstances never does). `mintInstanceId` (frontend indicators.ts)
    names the first instance after its type; later instances get a sequential
    number ("SLOPE2", "ATR1") which this split cannot decode — only legacy
    "#<rand>" ids from earlier builds are recoverable here."""
    return instance_id.split("#", 1)[0]


def resolve_instances(raw: dict[str, dict]) -> dict[str, ResolvedInstance]:
    """Parse the request's instance map. Unregistered types are skipped, not
    raised: a chart legitimately carries MACD/BOLL panes that no rule can
    reference, and shipping them must not 500."""
    out: dict[str, ResolvedInstance] = {}
    for instance_id, payload in (raw or {}).items():
        payload = payload or {}
        ind_type = payload.get("type") or instance_type_of(instance_id)
        spec = SERIES_INDICATORS.get(ind_type)
        if spec is None:
            continue
        cfg = spec.parse_config(payload.get("calcParams"), payload.get("extendData"))
        out[instance_id] = ResolvedInstance(ind_type, cfg, spec)
    return out
