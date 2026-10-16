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
from auto_trader.indicators.alert_series import MAX_WARMUP, IndicatorKey, config_json, config_of, key_of, line_key
from auto_trader.indicators.alert_specs import ALERT_SPECS, EVENT_LEVEL
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.indicators.trendlines import TL_NEAREST

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


_LEGACY = {
    # old indicator -> (type, extendData from old config, output from length)
    "MA": ("MA", lambda c: {"maType": c.get("maType", "sma"), "source": c.get("source", "close")}, lambda n: "ma"),
    "RSI": ("RSI", lambda c: {"source": c.get("source", "close")}, lambda n: "value"),
    "ATR": ("ATR", lambda c: {"smoothing": c.get("smoothing", "rma")}, lambda n: str(n)),
    "TRENDLINES": ("TRENDLINES", lambda c: {}, lambda n: TL_NEAREST),
}


def upgrade_params(params: dict) -> dict:
    """Old `{indicator, calcParams, config, line}` indicator params -> the
    registry shape. New-shape params come back unchanged. Used by the store
    migration, by re-arm from triggered history, and by the engine for any
    row it reads."""
    if "indicator" not in params:
        return params
    legacy = _LEGACY.get(params["indicator"])
    if legacy is None:
        raise ValueError(f"params.indicator {params['indicator']!r} is not alertable")
    type_, ext_of, out_of = legacy
    calc = list(params.get("calcParams") or [])
    ext = ext_of(params.get("config") or {})
    cfg = SERIES_INDICATORS[type_].parse_config(calc, ext)
    new = {k: v for k, v in params.items() if k not in ("indicator", "calcParams", "config", "line")}
    new.update(type=type_, config=json.loads(config_json(cfg)), output=out_of(int(calc[0]) if calc else 0))
    return new


def _parsed(params: dict) -> tuple[str, Any]:
    """(type, parsed config) from `instance` (consumed) or the stored pair."""
    inst = params.pop("instance", None)
    if inst is not None:
        if not isinstance(inst, dict):
            raise ValueError("params.instance must be {type, calcParams, extendData}")
        type_ = inst.get("type")
        if type_ not in ALERT_SPECS:
            raise ValueError(f"params.instance.type {type_!r} is not alertable")
        cfg = SERIES_INDICATORS[type_].parse_config(inst.get("calcParams"), inst.get("extendData"))
        params["type"], params["config"] = type_, json.loads(config_json(cfg))
        return type_, cfg
    type_ = params.get("type")
    if type_ not in ALERT_SPECS or not isinstance(params.get("config"), dict):
        raise ValueError("params.instance is required")
    try:
        return type_, config_of(type_, json.dumps(params["config"], sort_keys=True, allow_nan=False))
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"params.config is not a valid {type_} config") from None


class IndicatorKind:
    @staticmethod
    def refusal_for(type_: str, cfg: Any, timeframe: str) -> str | None:
        """Why an alert on this pane at this timeframe is refused, or None.
        Shared by validate and /api/alerts/describe."""
        try:
            canon = _tf.canonicalize(timeframe)
        except _tf.TimeframeError:
            canon = None
        if canon is None or not _tf.is_native(canon):
            return "Alerts on this timeframe are coming later"
        return ALERT_SPECS[type_].refusal(cfg, canon)

    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        params.update(upgrade_params(params))
        for stale in ("indicator", "calcParams", "line"):
            params.pop(stale, None)
        type_, cfg = _parsed(params)
        spec, alert = SERIES_INDICATORS[type_], ALERT_SPECS[type_]
        outs = alert.outputs(cfg)
        out = params.get("output")
        if out not in outs:
            raise ValueError(f"params.output must be one of {sorted(outs)}")
        pin = spec.timeframe(cfg)
        if pin:
            params["timeframe"] = pin
        o = outs[out]
        if o.kind == "event":
            if params.get("evalOn") == "intrabar":
                raise ValueError("params.evalOn: event alerts fire on a closed bar, not intrabar")
            params.update(target="value", value=EVENT_LEVEL, condition="crossing_up", evalOn="close")
        _validate_common(params)
        _validate_series_params(params)
        reason = self.refusal_for(type_, cfg, params["timeframe"])
        if reason:
            raise ValueError(reason)
        if spec.warmup(cfg, out) > MAX_WARMUP:
            raise ValueError("params: length too long for alerts")
        target = params.get("target")
        if target not in ("price", "value"):
            raise ValueError("params.target must be 'price' or 'value'")
        if o.price_only and target != "price":
            raise ValueError("params.target must be 'price' for this output")
        if target == "price" and not o.price_scale:
            raise ValueError("params.target 'price' needs an output on the price axis")
        if target == "value":
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
        if params["evalOn"] == "intrabar" and alert.needs_volume(cfg) and not streams():
            raise ValueError(
                "params.evalOn 'intrabar' needs live volume; this broker only has quotes"
            )

    def bar_resolution(self, params: dict) -> str:
        return params["timeframe"]

    def eval_on(self, params: dict) -> str:
        return params["evalOn"]

    def indicator_key(self, params: dict) -> IndicatorKey:
        return key_of(upgrade_params(params))

    def resolve(self, params, price, values):
        line = (values or {}).get("value")
        if line is None or not math.isfinite(line):
            return None
        if params["target"] == "price":
            return (price, line)
        return (line, params["value"])

    def _held_line(self, params: dict) -> bool:
        return ALERT_SPECS[upgrade_params(params)["type"]].side_series is not None

    def resolve_close(self, params, last, before, vals, pvals):
        if not self._held_line(params):
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
        if not values or not self._held_line(params):
            return None
        return (values.get("a1"), values.get("a2"))

    def label(self, params: dict) -> str:
        p = upgrade_params(params)
        cfg = config_of(p["type"], json.dumps(p["config"], sort_keys=True, allow_nan=False))
        return f"{ALERT_SPECS[p['type']].label(cfg, p['output'])} ({_tf.label(p['timeframe'])})"

    def sig(self, params: dict) -> str:
        p = upgrade_params(params)
        keys = ("type", "config", "output", "target", "value", "timeframe", "evalOn", "condition", "trigger")
        return json.dumps({k: p.get(k) for k in keys}, sort_keys=True)

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
