from __future__ import annotations

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.registry import INDICATORS, WRAPPERS


def warmup_bars(node: N.Node, resolution: str | None = None) -> int:
    """Warm-up a row needs from the BASE candle history before its first honest
    value, in base bars.

    `resolution` is the base timeframe the row runs on. When given, an @tf pin
    contributes ZERO base bars: the pinned series is computed from its own
    higher-timeframe candles — sourced and sufficiency-checked by the routes
    (expr.py::_ensure_htf), never derived from the base history — so demanding
    scaled base bars for it would only inflate the base ask (EMA(200)@4H on 5m
    would demand ~9,650 base bars a broker may not even serve) without making
    anything warmer. Terms OUTSIDE the pin (offsets, wrappers) still count in
    base bars, since they operate on the base-aligned series. Without a
    resolution (legacy callers that only ever see base-timeframe rows), a pin
    passes through unscaled. Mirrored by the frontend (lib/expr/parser.ts
    warmupOf)."""
    if isinstance(node, N.Chain):
        return max(warmup_bars(p, resolution) for p in node.parts)
    if isinstance(node, (N.Compare,)):
        return max(warmup_bars(node.left, resolution), warmup_bars(node.right, resolution))
    if isinstance(node, N.Cross):
        return max(warmup_bars(node.a, resolution), warmup_bars(node.b, resolution))
    if isinstance(node, (N.Num, N.Candle, N.Entry)):
        return 0
    if isinstance(node, N.Field):
        return warmup_bars(node.base, resolution)
    if isinstance(node, N.Offset):
        return warmup_bars(node.base, resolution) + node.n
    if isinstance(node, N.Tf):
        if resolution is None:
            return warmup_bars(node.base, None)
        return 0
    if isinstance(node, N.Unary):
        return warmup_bars(node.operand, resolution)
    if isinstance(node, N.Binary):
        return max(warmup_bars(node.left, resolution), warmup_bars(node.right, resolution))
    if isinstance(node, N.Call):
        if node.name in WRAPPERS:
            # wrapper window (2nd arg literal) + the inner term's warm-up
            n = int(node.args[1].value) if isinstance(node.args[1], N.Num) else 0
            return warmup_bars(node.args[0], resolution) + n
        if node.name in INDICATORS and INDICATORS[node.name].arg_kind == "length" and node.args:
            length = int(node.args[0].value) if isinstance(node.args[0], N.Num) else 0
            return length
        return 0
    return 0
