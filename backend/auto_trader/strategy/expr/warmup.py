from __future__ import annotations

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.registry import INDICATORS, WRAPPERS


def warmup_bars(node: N.Node) -> int:
    if isinstance(node, N.Chain):
        return max(warmup_bars(p) for p in node.parts)
    if isinstance(node, (N.Compare,)):
        return max(warmup_bars(node.left), warmup_bars(node.right))
    if isinstance(node, N.Cross):
        return max(warmup_bars(node.a), warmup_bars(node.b))
    if isinstance(node, (N.Num, N.Candle, N.Entry)):
        return 0
    if isinstance(node, N.Field):
        return warmup_bars(node.base)
    if isinstance(node, N.Offset):
        return warmup_bars(node.base) + node.n
    if isinstance(node, N.Tf):
        return warmup_bars(node.base)
    if isinstance(node, N.Unary):
        return warmup_bars(node.operand)
    if isinstance(node, N.Binary):
        return max(warmup_bars(node.left), warmup_bars(node.right))
    if isinstance(node, N.Call):
        if node.name in WRAPPERS:
            # wrapper window (2nd arg literal) + the inner term's warm-up
            n = int(node.args[1].value) if isinstance(node.args[1], N.Num) else 0
            return warmup_bars(node.args[0]) + n
        if node.name in INDICATORS and INDICATORS[node.name].arg_kind == "length" and node.args:
            length = int(node.args[0].value) if isinstance(node.args[0], N.Num) else 0
            return length
        return 0
    return 0
