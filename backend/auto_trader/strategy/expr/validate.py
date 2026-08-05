from __future__ import annotations

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.registry import CROSSES, INDICATORS, WRAPPERS
from auto_trader.strategy.expr.tfs import TF_RESOLUTIONS, tf_resolution


def validate(node: N.Row, *, is_exit: bool) -> None:
    if isinstance(node, N.Chain):
        for p in node.parts:
            _walk(p.left, is_exit=is_exit)
            _walk(p.right, is_exit=is_exit)
        return
    if isinstance(node, N.Cross):
        _walk(node.a, is_exit=is_exit)
        _walk(node.b, is_exit=is_exit)
        return
    if isinstance(node, N.Predicate):
        _check_predicate(node)
        return
    _walk(node.left, is_exit=is_exit)
    _walk(node.right, is_exit=is_exit)


def _check_predicate(node: N.Predicate) -> None:
    """A predicate's argument must bottom out in a bare `candle` (no field),
    wrapped only by offsets and at most one timeframe pin."""
    base = node.base
    while isinstance(base, (N.Offset, N.Tf)):
        if isinstance(base, N.Tf) and tf_resolution(base.tf) is None:
            raise ExprError(
                "unknown_tf",
                f"Unknown timeframe {base.tf}. Try one of: {', '.join(TF_RESOLUTIONS)}.",
                base.start, base.end,
            )
        base = base.base
    if not (isinstance(base, N.Candle) and base.field is None):
        raise ExprError(
            "bad_predicate_arg",
            f"{node.fn} takes a candle, like {node.fn}(candle).",
            node.start, node.end,
        )


def _contains_entry_kind(node: N.Node) -> bool:
    """True if `node`'s subtree contains an entry-based value (entry or
    barsSinceEntry) — used to keep those out of wrappers/indicators, which are
    expected to compute over a plain series and would otherwise crash trying to
    evaluate an entry-scoped operand with no active position."""
    if isinstance(node, (N.Entry, N.BarsSinceEntry)):
        return True
    if isinstance(node, (N.Field, N.Offset, N.Tf)):
        return _contains_entry_kind(node.base)
    if isinstance(node, N.Unary):
        return _contains_entry_kind(node.operand)
    if isinstance(node, (N.Binary, N.Compare)):
        return _contains_entry_kind(node.left) or _contains_entry_kind(node.right)
    if isinstance(node, N.Cross):
        return _contains_entry_kind(node.a) or _contains_entry_kind(node.b)
    if isinstance(node, N.Chain):
        return any(_contains_entry_kind(p) for p in node.parts)
    if isinstance(node, N.Predicate):
        return _contains_entry_kind(node.base)
    if isinstance(node, N.Count):
        return _contains_entry_kind(node.cond) or _contains_entry_kind(node.window)
    if isinstance(node, N.Call):
        return any(_contains_entry_kind(a) for a in node.args)
    return False


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
    if isinstance(node, N.Tf):
        if tf_resolution(node.tf) is None:
            raise ExprError(
                "unknown_tf",
                f"Unknown timeframe {node.tf}. Try one of: {', '.join(TF_RESOLUTIONS)}.",
                node.start, node.end,
            )
        _walk(node.base, is_exit=is_exit)
        return
    if isinstance(node, N.Offset):
        _walk(node.base, is_exit=is_exit)
        return
    if isinstance(node, N.Unary):
        _walk(node.operand, is_exit=is_exit)
        return
    if isinstance(node, N.Binary):
        _walk(node.left, is_exit=is_exit)
        _walk(node.right, is_exit=is_exit)
        return
    if isinstance(node, N.BarsSinceEntry):
        if not is_exit:
            raise ExprError("entry_in_entry_rule", "barsSinceEntry is only available in exit rules.", node.start, node.end)
        return
    if isinstance(node, N.Predicate):
        raise ExprError(
            "predicate_as_value",
            f"{node.fn}(...) is a condition — use it as a whole row or inside count(...).",
            node.start, node.end,
        )
    if isinstance(node, N.Count):
        cond = node.cond
        if isinstance(cond, N.Predicate):
            _check_predicate(cond)
        elif isinstance(cond, N.Cross):
            _walk(cond.a, is_exit=is_exit)
            _walk(cond.b, is_exit=is_exit)
        else:
            _walk(cond.left, is_exit=is_exit)
            _walk(cond.right, is_exit=is_exit)
        _walk(node.window, is_exit=is_exit)
        return
    if isinstance(node, (N.Compare, N.Cross, N.Chain)):
        raise ExprError("cross_not_toplevel", "A comparison or cross can only be the whole row.", node.start, node.end)
    if isinstance(node, N.Call):
        if node.name in CROSSES:
            raise ExprError("cross_not_toplevel", f"{node.name} can only be the whole row.", node.start, node.end)
        if node.name in INDICATORS:
            spec = INDICATORS[node.name]
            if len(node.args) != spec.arity:
                raise ExprError("bad_arity", f"{node.name} takes {spec.arity} argument(s).", node.start, node.end)
            if any(_contains_entry_kind(a) for a in node.args):
                raise ExprError(
                    "entry_in_wrapper",
                    f"{node.name} cannot take entry-based values like entry or barsSinceEntry.",
                    node.start, node.end,
                )
            for a in node.args:
                _walk(a, is_exit=is_exit)
            return
        if node.name in WRAPPERS:
            if len(node.args) != WRAPPERS[node.name]:
                raise ExprError("bad_arity", f"{node.name} takes {WRAPPERS[node.name]} arguments.", node.start, node.end)
            if any(_contains_entry_kind(a) for a in node.args):
                raise ExprError(
                    "entry_in_wrapper",
                    f"{node.name} cannot take entry-based values like entry or barsSinceEntry.",
                    node.start, node.end,
                )
            for a in node.args:
                _walk(a, is_exit=is_exit)
            return
        raise ExprError("unknown_name", f"Unknown name {node.name}.", node.start, node.end)
    raise ExprError("unknown_name", "Unknown expression.", node.start, node.end)
