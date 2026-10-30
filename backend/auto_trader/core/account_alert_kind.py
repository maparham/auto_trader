"""The `account` alert kind: validation, duplicate signature and the tier
state machine. Deliberately NOT registered in `alert_kinds.KINDS`: the price
engine calls bar_resolution/indicator_key on every kind it holds and an
account alert has no bars. The router dispatches on kind == "account" and
`AccountMonitor` is the only evaluator."""
from __future__ import annotations

import json
import math

MONITORABLE_BROKERS = frozenset({"capital", "capital-live", "ig-demo", "ig-live"})
_ACCOUNT_LABELS = {"capital": "Capital demo", "capital-live": "Capital live",
                   "ig-demo": "IG demo", "ig-live": "IG live"}
METRICS = ("marginLevel", "openPnl", "openPnlPct", "equity", "available", "drawdown")
FALLING = frozenset({"marginLevel", "equity", "available", "openPnl", "openPnlPct"})
PCT_METRICS = frozenset({"marginLevel", "openPnlPct", "drawdown"})
TIER_LABELS = ("warn", "danger", "critical")
BASELINES = ("daily", "sinceCreated")
METRIC_LABELS = {"marginLevel": "MARGIN LEVEL", "openPnl": "OPEN P/L", "openPnlPct": "OPEN P/L %",
                 "equity": "EQUITY", "available": "AVAILABLE", "drawdown": "DRAWDOWN"}
NEAR_FRACTION = 0.2


def account_label(key: str) -> str:
    return _ACCOUNT_LABELS.get(key.split(":", 1)[0], key)


def is_monitorable(key: str, env: str) -> bool:
    return key.split(":", 1)[0] in MONITORABLE_BROKERS and env != "paper"


def cash_balance(key: str) -> bool:
    """IG's balance excludes open P/L; Capital's includes it (accountStats.ts:91)."""
    return key.split(":", 1)[0].startswith("ig")


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class AccountAlertKind:
    def validate(self, params: dict) -> None:
        metric = params.get("metric")
        if metric not in METRICS:
            raise ValueError(f"unknown account metric: {metric!r}")
        tiers = params.get("tiers")
        if not isinstance(tiers, list) or not 1 <= len(tiers) <= 3:
            raise ValueError("tiers must hold 1 to 3 entries")
        levels: list[float] = []
        for t in tiers:
            if not isinstance(t, dict) or not _finite(t.get("level")) or t.get("label") not in TIER_LABELS:
                raise ValueError("each tier needs a finite level and a label of warn, danger or critical")
            levels.append(float(t["level"]))
        ordered = levels == sorted(levels, reverse=metric in FALLING) and len(set(levels)) == len(levels)
        if not ordered:
            raise ValueError("tiers must be strictly ordered in the firing direction")
        if metric == "drawdown":
            if params.get("baseline") not in BASELINES:
                raise ValueError("drawdown needs baseline daily or sinceCreated")
            if any(lv <= 0 for lv in levels):
                raise ValueError("drawdown tiers are positive percentages")
        elif "baseline" in params and params["baseline"] is not None:
            raise ValueError("baseline only applies to drawdown")

    def sig(self, params: dict) -> str:
        levels = sorted(float(t["level"]) for t in params["tiers"])
        return json.dumps([params["metric"], params.get("baseline"), levels])


ACCOUNT_KIND = AccountAlertKind()


def hysteresis(metric: str, level: float) -> float:
    return 3.0 if metric in PCT_METRICS else abs(level) * 0.02


def _past(metric: str, value: float, level: float) -> bool:
    return value < level if metric in FALLING else value > level


def _recovered(metric: str, value: float, level: float) -> bool:
    band = hysteresis(metric, level)
    return value >= level + band if metric in FALLING else value <= level - band


def _severity(tiers: list[dict]) -> dict[float, int]:
    return {float(t["level"]): TIER_LABELS.index(t["label"]) for t in tiers}


def crossed_now(metric: str, tiers: list[dict], value: float) -> set[float]:
    return {float(t["level"]) for t in tiers if _past(metric, value, float(t["level"]))}


def evaluate_tiers(
    metric: str, tiers: list[dict], value: float, fired: set[float]
) -> tuple[set[float], float | None]:
    levels = {float(t["level"]) for t in tiers}
    new_fired = {lv for lv in fired if lv in levels and not _recovered(metric, value, lv)}
    newly = [lv for lv in levels if lv not in new_fired and _past(metric, value, lv)]
    new_fired |= set(newly)
    if not newly:
        return new_fired, None
    sev = _severity(tiers)
    return new_fired, max(newly, key=lambda lv: sev[lv])


def near_tier(metric: str, tiers: list[dict], value: float, fired: set[float]) -> bool:
    pending = [float(t["level"]) for t in tiers
               if float(t["level"]) not in fired and not _past(metric, value, float(t["level"]))]
    if not pending:
        return False
    nxt = max(pending) if metric in FALLING else min(pending)
    return abs(value - nxt) <= NEAR_FRACTION * max(abs(nxt), 1e-9)


def tier_label(tiers: list[dict], level: float) -> str:
    return next((t["label"] for t in tiers if float(t["level"]) == level), "warn")


def fmt_value(metric: str, value: float, currency: str | None) -> str:
    # Round to the display precision FIRST, then decide whether to show a
    # fraction: deciding from the raw value (`value != int(value)`) treats
    # float noise from the equity/margin arithmetic (e.g. 1100.0/1000.0*100
    # == 110.00000000000001) as a real fraction, and also leaves a value
    # that rounds up to the next whole unit (99.97 -> "100.0") unstripped.
    if metric in PCT_METRICS:
        s = f"{value:.1f}"
        if s.endswith(".0"):
            s = s[:-2]
        return f"{s}%"
    amount = f"{value:,.2f}"
    if amount.endswith(".00"):
        amount = amount[:-3]
    return f"{amount} {currency}" if currency else amount


def headline(
    metric: str, value: float, level: float, label: str, key: str,
    currency: str | None, equity: float | None,
) -> str:
    op = "<" if metric in FALLING else ">"
    parts = [f"{METRIC_LABELS[metric]} {fmt_value(metric, value, currency)} {op} "
             f"{fmt_value(metric, level, currency)} ({label})", account_label(key)]
    if metric != "equity" and equity is not None:
        parts.append(f"equity {fmt_value('equity', equity, currency)}")
    return " · ".join(parts)
