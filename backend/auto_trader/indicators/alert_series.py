"""Alert-side view of the series registry: the hub's key, its compute, its
seed/readiness numbers. Values come from SERIES_INDICATORS (or, for the
Trendlines nearest line, ALERT_SPECS' side series); nothing is computed here."""
from __future__ import annotations

import dataclasses
import json
import typing
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from auto_trader.core.alert_bars import candle_ms
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS
from auto_trader.indicators.registry import SERIES_INDICATORS

SEED_CAP = 2000
MAX_WARMUP = SEED_CAP - 50


@dataclass(frozen=True)
class IndicatorKey:
    indicator: str               # registry type, or "LINE"
    config: str = ""             # config_json of the parsed config
    output: str = "value"
    bar_hours: float = 0.0
    calc: tuple[float, ...] = ()  # LINE only: (tRef, pRef, slope)


def line_key(t_ref: int, p_ref: float, slope: float) -> IndicatorKey:
    """The hub need for a `line` alert: a straight line in bars from tRef."""
    return IndicatorKey("LINE", calc=(float(t_ref), float(p_ref), float(slope)))


def config_json(cfg: Any) -> str:
    return json.dumps(dataclasses.asdict(cfg), sort_keys=True, allow_nan=False)


def _tupleize(v: Any) -> Any:
    if isinstance(v, list):
        return tuple(_tupleize(x) for x in v)
    if isinstance(v, dict):
        return {k: _tupleize(x) for k, x in v.items()}
    return v


def _build(cls: type, data: dict) -> Any:
    """A stored config dict predates a field added to the dataclass since it
    was saved (e.g. SWEEP's use_prev_bar): that field falls back to its
    dataclass default (or default_factory), matching the chart's own
    "absent means on"/"absent means default" parsing. A field with no
    default still raises, as before."""
    hints = typing.get_type_hints(cls)
    kw = {}
    for f in dataclasses.fields(cls):
        if f.name not in data:
            if f.default is not dataclasses.MISSING:
                kw[f.name] = f.default
                continue
            if f.default_factory is not dataclasses.MISSING:  # type: ignore[misc]
                kw[f.name] = f.default_factory()
                continue
            raise KeyError(f.name)
        v, t = data[f.name], hints[f.name]
        kw[f.name] = _build(t, v) if dataclasses.is_dataclass(t) and isinstance(v, dict) else _tupleize(v)
    return cls(**kw)


@lru_cache(maxsize=512)
def config_of(indicator: str, config: str) -> Any:
    """The parsed config back from its JSON (raises KeyError/TypeError on a
    config that is not this type's)."""
    cls = type(SERIES_INDICATORS[indicator].parse_config(None, None))
    return _build(cls, json.loads(config))


def key_of(params: dict) -> IndicatorKey:
    """Stored indicator-alert params -> the hub key."""
    return IndicatorKey(
        params["type"],
        json.dumps(params["config"], sort_keys=True, allow_nan=False),
        params["output"],
        resolution_seconds(params["timeframe"]) / 3600.0,
    )


def compute(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    if key.indicator == "LINE":
        t_ref, p_ref, slope = key.calc
        times = [candle_ms(c) for c in candles]
        try:
            j = times.index(int(t_ref))
        except ValueError:
            return {"value": [None] * len(candles)}
        return {"value": [None if k < j else p_ref + slope * (k - j) for k in range(len(candles))]}
    cfg = config_of(key.indicator, key.config)
    side = ALERT_SPECS[key.indicator].side_series
    if side is not None:
        return side(cfg, key.output, candles)
    return {"value": SERIES_INDICATORS[key.indicator].series(cfg, key.output, candles, key.bar_hours)}


def warmup(key: IndicatorKey) -> int:
    """Seed target: the deepest history the cap allows, for every series
    (plan ruling 3). Readiness is min_bars."""
    return MAX_WARMUP


def min_bars(key: IndicatorKey) -> int:
    if key.indicator == "LINE":
        return 1
    cfg = config_of(key.indicator, key.config)
    return max(1, SERIES_INDICATORS[key.indicator].warmup(cfg, key.output))


def sparse(key: IndicatorKey) -> bool:
    return key.indicator != "LINE" and ALERT_SPECS[key.indicator].sparse


def heavy(key: IndicatorKey) -> bool:
    return key.indicator != "LINE" and ALERT_SPECS[key.indicator].heavy


def projects_intrabar(key: IndicatorKey) -> bool:
    """Intrabar projects the held line one bar on (Trendlines nearest)."""
    return key.indicator != "LINE" and ALERT_SPECS[key.indicator].side_series is not None
