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
from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import (
    TRENDLINES_REFUSED_TF, IndicatorKey, indicator_label, line_key, validate_indicator, volume_weighted,
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


def _resolve_close_default(kind, params, last, before, vals, pvals):
    """Close mode's two pairs: this close vs this bar's level, and the
    previous close vs the previous bar's level."""
    cur = kind.resolve(params, last.close, vals) if last is not None and vals else None
    prev = kind.resolve(params, before.close, pvals) if before is not None and pvals else None
    return cur, prev


def _validate_series_params(params: dict) -> None:
    """Native timeframe (canonicalised) and evalOn: shared by the kinds that
    read closed bars."""
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


class AlertKind(Protocol):
    def validate(self, params: dict, streams: Callable[[], bool]) -> None: ...
    def bar_resolution(self, params: dict) -> str: ...
    def eval_on(self, params: dict) -> str: ...
    def indicator_key(self, params: dict) -> IndicatorKey | None: ...
    def resolve(self, params: dict, price: float, values: dict[str, float | None] | None) -> Pair | None: ...
    def resolve_close(
        self, params: dict, last: Candle | None, before: Candle | None,
        vals: dict[str, float | None] | None, pvals: dict[str, float | None] | None,
    ) -> tuple[Pair | None, Pair | None]: ...
    def level_sig(self, params: dict, values: dict[str, float | None] | None) -> tuple | None: ...
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

    def resolve_close(self, params, last, before, vals, pvals):
        return _resolve_close_default(self, params, last, before, vals, pvals)

    def level_sig(self, params, values):
        return None

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
        _validate_series_params(params)
        if params["indicator"] == "TRENDLINES" and params["timeframe"] in TRENDLINES_REFUSED_TF:
            raise ValueError("params.timeframe: nearest-line alerts need 5m or longer")
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

    def resolve_close(self, params, last, before, vals, pvals):
        if params.get("indicator") != "TRENDLINES":
            return _resolve_close_default(self, params, last, before, vals, pvals)
        # The line nearest at the previous close, at both bars: `held` is it
        # projected to this bar, the previous `value` is it at its own bar.
        # A switch to another line is therefore never read as a cross.
        held = (vals or {}).get("held")
        was = (pvals or {}).get("value")
        cur = (last.close, held) if last is not None and held is not None and math.isfinite(held) else None
        prev = (before.close, was) if before is not None and was is not None and math.isfinite(was) else None
        return cur, prev

    def level_sig(self, params, values):
        if params.get("indicator") != "TRENDLINES" or not values:
            return None
        return (values.get("a1"), values.get("a2"))

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


class LineKind:
    """A frozen straight line in bars of `timeframe` (a right-clicked
    trendline): level = pRef + slope * (bars since tRef). tRef/pRef roll
    forward (engine rebase), so they are not part of `sig`."""

    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        t_ref = params.get("tRef")
        if not _finite_number(t_ref) or t_ref <= 0 or t_ref != int(t_ref):
            raise ValueError("params.tRef must be a bar open time in ms")
        params["tRef"] = int(t_ref)
        for f in ("pRef", "slope"):
            if not _finite_number(params.get(f)):
                raise ValueError(f"params.{f} must be a finite number")
        a = params.get("anchors")
        if not isinstance(a, dict) or not all(_finite_number(a.get(k)) for k in ("t1", "p1", "t2", "p2")):
            raise ValueError("params.anchors must be {t1, p1, t2, p2} numbers")
        _validate_common(params)
        _validate_series_params(params)
        link = params.get("link")
        if link is not None and not (
            isinstance(link, dict)
            and isinstance(link.get("scope"), str) and 0 < len(link["scope"]) <= 200
            and isinstance(link.get("instanceId"), str) and 0 < len(link["instanceId"]) <= 64
            and isinstance(link.get("lineKey"), str) and 0 < len(link["lineKey"]) <= 64
        ):
            raise ValueError("params.link must be {scope, instanceId, lineKey} strings or null")

    def bar_resolution(self, params: dict) -> str:
        return params["timeframe"]

    def eval_on(self, params: dict) -> str:
        return params["evalOn"]

    def indicator_key(self, params: dict) -> IndicatorKey:
        return line_key(params["tRef"], params["pRef"], params["slope"])

    def resolve(self, params, price, values):
        level = (values or {}).get("value")
        if level is None or not math.isfinite(level):
            return None
        return (price, level)

    def resolve_close(self, params, last, before, vals, pvals):
        return _resolve_close_default(self, params, last, before, vals, pvals)

    def level_sig(self, params, values):
        return None

    def label(self, params: dict) -> str:
        return f"Trendline ({_tf.label(params['timeframe'])})"

    def sig(self, params: dict) -> str:
        keys = ("slope", "anchors", "timeframe", "evalOn", "condition", "trigger")
        return json.dumps({k: params.get(k) for k in keys}, sort_keys=True)

    def payload_extras(self, params: dict, pair: Pair) -> dict:
        return {"label": self.label(params), "target": "price", "subject": pair[0], "evalOn": params["evalOn"]}


PRICE_LEVEL = PriceLevelKind()
INDICATOR = IndicatorKind()
LINE = LineKind()
KINDS: dict[str, AlertKind] = {"price_level": PRICE_LEVEL, "indicator": INDICATOR, "line": LINE}


def kind_of(row: dict) -> AlertKind | None:
    return KINDS.get(row.get("kind", "price_level"))
