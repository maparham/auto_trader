"""Pure logic for SL/TP move rules: validate the action, work out the target
level, decide whether a move tightens the stop or limit, and word the result.
No broker or storage access here; the router and the executor call these."""
from __future__ import annotations

import json
import math

FIELDS = ("sl", "tp")
DIRECTIONS = ("BUY", "SELL")
DEAL_ID_MAX = 128
FIELD_LABEL = {"sl": "SL", "tp": "TP"}
DIRECTION_LABEL = {"BUY": "long", "SELL": "short"}


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_action(action: dict) -> None:
    """Check the action shape. `direction` is not checked here; the router sets it."""
    account = action.get("account")
    if not isinstance(account, str) or not account:
        raise ValueError("account must be a non-empty string")
    deal = action.get("dealId")
    if not isinstance(deal, str) or not 1 <= len(deal) <= DEAL_ID_MAX:
        raise ValueError(f"dealId must be a string of 1 to {DEAL_ID_MAX} characters")
    if action.get("field") not in FIELDS:
        raise ValueError("field must be sl or tp")
    target = action.get("target")
    if not isinstance(target, dict):
        raise ValueError("target must be an object")
    kind = target.get("type")
    if kind == "price":
        if not _finite(target.get("value")):
            raise ValueError("price target value must be a finite number")
    elif kind == "breakeven":
        offset = target.get("offset")
        if not _finite(offset) or offset < 0:
            raise ValueError("breakeven offset must be a finite number >= 0")
    else:
        raise ValueError("target type must be price or breakeven")


def target_level(target: dict, direction: str, open_level: float) -> float:
    """The level the rule wants. Breakeven is the open level plus the offset in
    the trade's favor: up for a long, down for a short."""
    if target["type"] == "price":
        return float(target["value"])
    offset = float(target["offset"])
    return open_level + offset if direction == "BUY" else open_level - offset


def decide(field: str, direction: str, current: float | None, target: float) -> str:
    """"move" when the target tightens the level, "skip" otherwise. Moves never
    loosen: an SL only goes toward profit, a TP only toward the price. No
    current level means the target is simply added."""
    if current is None:
        return "move"
    if field == "sl":
        tighter = target > current if direction == "BUY" else target < current
    else:
        tighter = target < current if direction == "BUY" else target > current
    return "move" if tighter else "skip"


def _level(v: float | None, precision: int) -> str:
    return "none" if v is None else f"{v:.{precision}f}"


def headline(
    outcome: str, epic: str, direction: str, field: str, *,
    new: float | None, old: float | None, reason: str = "", precision: int,
) -> str:
    label = FIELD_LABEL[field]
    side = DIRECTION_LABEL[direction]
    if outcome == "moved":
        return f"Moved {label} of {epic} {side} to {_level(new, precision)} (was {_level(old, precision)})"
    if outcome == "skipped":
        return (
            f"{label} of {epic} {side} already at {_level(old, precision)}, "
            f"not moved to {_level(new, precision)}"
        )
    if outcome == "failed":
        text = f"Could not move {label} of {epic} {side} to {_level(new, precision)}"
        return f"{text}: {reason}" if reason else text
    raise ValueError(f"unknown outcome {outcome!r}")


def action_sig(action: dict) -> str:
    """Duplicate key for a move rule: the account, deal and field. The target
    is left out, so a second rule on the same field counts as a duplicate."""
    return json.dumps([action["account"], action["dealId"], action["field"]])
