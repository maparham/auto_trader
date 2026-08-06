from __future__ import annotations

from auto_trader.indicators.candle_patterns import PATTERN_FNS
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.registry import INDICATORS, WRAPPERS

# Bars a candle-pattern predicate needs before its first honest value: 14 for
# the epsilon series (0.05 * SMA14 of true range) + 4 for the deepest lookback
# (ladderBottom needs i >= 4). Below this a pattern doesn't merely go quiet —
# eps_series falls back to a different epsilon (1e-4 * close) for the first 14
# bars, so the _eq-tolerance patterns detect DIFFERENTLY rather than not at
# all. `bullish`/`bearish` are pure single-bar tests and stay at 0. Mirrored by
# the frontend's lib/expr/catalog.ts PATTERN_WARMUP.
PATTERN_WARMUP = 18


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
    if isinstance(node, N.Predicate):
        # Added OUTSIDE any @tf pin, so a pinned pattern still costs 18 BASE
        # bars. That is a floor charged to the base, not the pin's own
        # warm-up: evaluate.py::_hoist_predicate rewrites
        # Predicate(fn, Tf(...)) -> Tf(Predicate(fn, ...)), so the base series
        # never computes the pattern at all. The 18 bars a pinned pattern
        # really needs are HTF bars, and they are supplied by
        # api/routers/expr.py::_tf_inner_warmup feeding _ensure_htf. Do not
        # "simplify" that away on the strength of this line — dropping it
        # reintroduces the under-warm pinned-pattern bug.
        extra = PATTERN_WARMUP if node.fn in PATTERN_FNS else 0
        return extra + warmup_bars(node.base, resolution)
    if isinstance(node, N.BarsSinceEntry):
        return 0
    if isinstance(node, N.Count):
        n = int(node.window.value) if isinstance(node.window, N.Num) else 0
        return n + warmup_bars(node.cond, resolution)
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
