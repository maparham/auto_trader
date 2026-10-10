"""Alert kinds: everything that differs between price-level and indicator
alerts lives here, behind one protocol. The engine, the evaluator and the
fire path only see `(subject, level)` pairs, so a new kind (events, drawings)
is a new class in this module, not an engine change."""
from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any, Protocol

from auto_trader.core import timeframe as _tf
from auto_trader.core.alert_bars import alert_resolution
from auto_trader.core.alert_eval import Pair
from auto_trader.indicators.alertable import (
    IndicatorKey, indicator_label, validate_indicator, volume_weighted,
)

CONDITIONS = frozenset({"crossing", "crossing_up", "crossing_down", "greater", "less"})
TRIGGERS = frozenset({"once", "every"})
_EVAL_ON = ("close", "intrabar")


def _finite_number(v: Any) -> bool:
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)


def _validate_common(params: dict) -> None:
    if params.get("condition") not in CONDITIONS:
        raise ValueError(f"unknown condition: {params.get('condition')!r}")
    if params.get("trigger") not in TRIGGERS:
        raise ValueError(f"unknown trigger: {params.get('trigger')!r}")


class AlertKind(Protocol):
    def validate(self, params: dict, streams: Callable[[], bool]) -> None: ...
    def bar_resolution(self, params: dict) -> str: ...
    def eval_on(self, params: dict) -> str: ...
    def indicator_key(self, params: dict) -> IndicatorKey | None: ...
    def resolve(self, params: dict, price: float, values: dict[str, float | None] | None) -> Pair | None: ...
    def label(self, params: dict) -> str | None: ...
    def sig(self, params: dict) -> str: ...
    def payload_extras(self, params: dict, pair: Pair) -> dict: ...


class PriceLevelKind:
    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        # Strict type check (not just float()-coercible): a JSON string like
        # "100" would otherwise land in the row as a str and break evaluation.
        if not _finite_number(params.get("level")):
            raise ValueError("params.level must be a finite number")
        _validate_common(params)
        # Optional: the chart timeframe the alert was created from (drives the
        # Telegram snapshot and the once-per-bar clock).
        tf = params.get("timeframe")
        if tf is not None:
            if not isinstance(tf, str) or not (1 <= len(tf) <= 20):
                raise ValueError("params.timeframe must be a short string")
            try:
                params["timeframe"] = _tf.canonicalize(tf)
            except _tf.TimeframeError as e:
                raise ValueError(f"params.timeframe: {e}") from None

    def bar_resolution(self, params: dict) -> str:
        return alert_resolution(params.get("timeframe"))

    def eval_on(self, params: dict) -> str:
        return "intrabar"

    def indicator_key(self, params: dict) -> IndicatorKey | None:
        return None

    def resolve(self, params, price, values):
        return (price, params["level"])

    def label(self, params: dict) -> str | None:
        return None

    def sig(self, params: dict) -> str:
        return f"{params.get('level')}|{params.get('condition')}|{params.get('trigger')}"

    def payload_extras(self, params: dict, pair: Pair) -> dict:
        return {}


class IndicatorKind:
    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        params["config"] = validate_indicator(
            params.get("indicator"), params.get("calcParams"), params.get("config", {}),
            params.get("line"), params.get("target"),
        )
        _validate_common(params)
        tf = params.get("timeframe")
        try:
            canon = _tf.canonicalize(tf) if isinstance(tf, str) else None
        except _tf.TimeframeError:
            canon = None
        if canon is None or not _tf.is_native(canon):
            raise ValueError("params.timeframe must be a native timeframe (1m to 1W)")
        params["timeframe"] = canon
        if params.get("evalOn") not in _EVAL_ON:
            raise ValueError("params.evalOn must be 'close' or 'intrabar'")
        if params["target"] == "value":
            if not _finite_number(params.get("value")):
                raise ValueError("params.value must be a finite number")
        else:
            params["value"] = None
        link = params.get("link")
        if link is not None and not (
            isinstance(link, dict)
            and isinstance(link.get("scope"), str) and 0 < len(link["scope"]) <= 200
            and isinstance(link.get("instanceId"), str) and 0 < len(link["instanceId"]) <= 64
        ):
            raise ValueError("params.link must be {scope, instanceId} strings or null")
        key = IndicatorKey.of(params)
        if params["evalOn"] == "intrabar" and volume_weighted(key) and not streams():
            raise ValueError(
                "params.evalOn 'intrabar' needs live volume; this broker only has quotes"
            )

    def bar_resolution(self, params: dict) -> str:
        return params["timeframe"]

    def eval_on(self, params: dict) -> str:
        return params["evalOn"]

    def indicator_key(self, params: dict) -> IndicatorKey:
        return IndicatorKey.of(params)

    def resolve(self, params, price, values):
        line = (values or {}).get(params["line"])
        if line is None or not math.isfinite(line):
            return None
        if params["target"] == "price":
            return (price, line)
        return (line, params["value"])

    def label(self, params: dict) -> str:
        return f"{indicator_label(IndicatorKey.of(params))} ({_tf.label(params['timeframe'])})"

    def sig(self, params: dict) -> str:
        keys = ("indicator", "calcParams", "config", "line", "target", "value",
                "timeframe", "evalOn", "condition", "trigger")
        return json.dumps({k: params.get(k) for k in keys}, sort_keys=True)

    def payload_extras(self, params: dict, pair: Pair) -> dict:
        return {
            "label": self.label(params),
            "target": params["target"],
            "subject": pair[0],
            "evalOn": params["evalOn"],
        }


PRICE_LEVEL = PriceLevelKind()
INDICATOR = IndicatorKind()
KINDS: dict[str, AlertKind] = {"price_level": PRICE_LEVEL, "indicator": INDICATOR}


def kind_of(row: dict) -> AlertKind | None:
    return KINDS.get(row.get("kind", "price_level"))
