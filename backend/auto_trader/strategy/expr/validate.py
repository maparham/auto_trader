from __future__ import annotations

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.registry import CROSSES, INDICATORS, WRAPPERS


def validate(node: N.Compare | N.Cross, *, is_exit: bool) -> None:
    if isinstance(node, N.Cross):
        _walk(node.a, is_exit=is_exit)
        _walk(node.b, is_exit=is_exit)
        return
    _walk(node.left, is_exit=is_exit)
    _walk(node.right, is_exit=is_exit)


def _candle_root(node: N.Node) -> N.Node:
    """Unwrap Offset/Tf wrappers to find the base a postfix chain bottoms out in.

    `candle@D.high` parses to Field(Tf(Candle, "D"), "high") and
    `candle[-1].open` to Field(Offset(Candle, 1), "open"): the Field's base is a
    wrapper chain rooted in a Candle (or a Call, for indicators)."""
    while isinstance(node, (N.Offset, N.Tf)):
        node = node.base
    return node


def _walk(node: N.Node, *, is_exit: bool) -> None:
    if isinstance(node, N.Num):
        return
    if isinstance(node, N.Entry):
        if not is_exit:
            raise ExprError("entry_in_entry_rule", "entry is only available in exit rules.", node.start, node.end)
        return
    if isinstance(node, N.Candle):
        # A Candle reached directly as an operand must carry a real field. A
        # Candle(field=None) is legitimate only as the candle-base under a Field
        # (handled below), which never recurses into it.
        if node.field is None or node.field not in N.CANDLE_FIELDS:
            raise ExprError("bad_candle_field", "candle needs a field, like candle.close.", node.start, node.end)
        return
    if isinstance(node, N.Field):
        root = _candle_root(node.base)
        if isinstance(root, N.Candle):
            # Candle-rooted field access (candle.x / candle@D.x / candle[-1].x):
            # the field name lives on this Field node and must be a real candle
            # field. The inner Candle(field=None) is valid and is not recursed
            # into, so it does not trip the bad_candle_field check above.
            if node.name not in N.CANDLE_FIELDS:
                raise ExprError("bad_candle_field", "candle needs a field, like candle.close.", node.start, node.end)
            return
        if isinstance(root, N.Call) and root.name in {*INDICATORS, *WRAPPERS}:
            # A field access on a call (e.g. EMA(9).signal): no registered
            # indicator exposes named outputs in v1, so this is always an error.
            raise ExprError("field_on_call", f"{root.name} has no named outputs.", node.start, node.end)
        _walk(node.base, is_exit=is_exit)
        return
    if isinstance(node, (N.Offset, N.Tf)):
        _walk(node.base, is_exit=is_exit)
        return
    if isinstance(node, N.Unary):
        _walk(node.operand, is_exit=is_exit)
        return
    if isinstance(node, N.Binary):
        _walk(node.left, is_exit=is_exit)
        _walk(node.right, is_exit=is_exit)
        return
    if isinstance(node, (N.Compare, N.Cross)):
        raise ExprError("cross_not_toplevel", "A comparison or cross can only be the whole row.", node.start, node.end)
    if isinstance(node, N.Call):
        if node.name in CROSSES:
            raise ExprError("cross_not_toplevel", f"{node.name} can only be the whole row.", node.start, node.end)
        if node.name in INDICATORS:
            spec = INDICATORS[node.name]
            if len(node.args) != spec.arity:
                raise ExprError("bad_arity", f"{node.name} takes {spec.arity} argument(s).", node.start, node.end)
            for a in node.args:
                _walk(a, is_exit=is_exit)
            return
        if node.name in WRAPPERS:
            if len(node.args) != WRAPPERS[node.name]:
                raise ExprError("bad_arity", f"{node.name} takes {WRAPPERS[node.name]} arguments.", node.start, node.end)
            for a in node.args:
                _walk(a, is_exit=is_exit)
            return
        raise ExprError("unknown_name", f"Unknown name {node.name}.", node.start, node.end)
    raise ExprError("unknown_name", "Unknown expression.", node.start, node.end)
