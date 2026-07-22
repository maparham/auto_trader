from __future__ import annotations

import dataclasses
from dataclasses import dataclass

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.registry import INDICATORS, WRAPPERS


@dataclass(frozen=True, slots=True)
class Literal:
    ordinal: int
    value: float
    start: int
    end: int
    label: str


def _render(node: N.Node) -> str:
    if isinstance(node, N.Call):
        args = ", ".join(_render(a) for a in node.args)
        return f"{node.name}({args})" if node.args else node.name
    if isinstance(node, N.Num):
        return f"{node.value:g}"
    if isinstance(node, N.Candle):
        return f"candle.{node.field}" if node.field else "candle"
    if isinstance(node, N.Entry):
        return "entry"
    if isinstance(node, N.Field):
        return f"{_render(node.base)}.{node.name}"
    if isinstance(node, N.Offset):
        return f"{_render(node.base)}[-{node.n}]"
    if isinstance(node, N.Tf):
        return f"{_render(node.base)}@{node.tf}"
    if isinstance(node, N.Unary):
        return f"-{_render(node.operand)}"
    if isinstance(node, N.Binary):
        return f"{_render(node.left)} {node.op} {_render(node.right)}"
    return "?"


def _has_indicator(node: N.Node) -> bool:
    if isinstance(node, N.Call) and node.name in INDICATORS:
        return True
    if isinstance(node, N.Call):
        return any(_has_indicator(a) for a in node.args)
    if isinstance(node, (N.Field, N.Offset, N.Tf)):
        return _has_indicator(node.base)
    if isinstance(node, N.Unary):
        return _has_indicator(node.operand)
    if isinstance(node, N.Binary):
        return _has_indicator(node.left) or _has_indicator(node.right)
    return False


def _collect(node: N.Node, label: str, out: list[tuple[N.Num, str]]) -> None:
    if isinstance(node, N.Num):
        out.append((node, label))
        return
    if isinstance(node, (N.Candle, N.Entry)):
        return
    if isinstance(node, N.Field):
        _collect(node.base, label, out)
        return
    if isinstance(node, N.Offset):
        _collect(node.base, label, out)
        # The parser stores the bar offset as an int and drops the numeric
        # token span, so synthesize it from the Offset span: the digits sit
        # just before the closing "]" (node.end points one past it).
        synth_end = node.end - 1
        synth_start = synth_end - len(str(node.n))
        out.append((N.Num(float(node.n), synth_start, synth_end), "bar offset"))
        return
    if isinstance(node, N.Tf):
        _collect(node.base, label, out)
        return
    if isinstance(node, N.Unary):
        _collect(node.operand, label, out)
        return
    if isinstance(node, N.Binary):
        if node.op == "*":
            # a numeric factor multiplied by an indicator-bearing term is a multiplier
            for a, b in ((node.left, node.right), (node.right, node.left)):
                if isinstance(a, N.Num) and _has_indicator(b):
                    out.append((a, f"multiplier of {_render(b)}"))
                else:
                    _collect(a, "constant", out) if isinstance(a, N.Num) else _collect(a, label, out)
            return
        _collect(node.left, label, out)
        _collect(node.right, label, out)
        return
    if isinstance(node, N.Call):
        if node.name in WRAPPERS:
            _collect(node.args[0], label, out)
            if isinstance(node.args[1], N.Num):
                out.append((node.args[1], f"{node.name} window"))
            else:
                _collect(node.args[1], "constant", out)
            return
        if node.name in INDICATORS:
            kind = "anchor" if node.name == "AVWAP" else "length"
            for a in node.args:
                if isinstance(a, N.Num):
                    out.append((a, f"{node.name} {kind}"))
                else:
                    _collect(a, label, out)
            return
    return


def literals(node: N.Compare | N.Cross | N.Chain) -> list[Literal]:
    out: list[tuple[N.Num, str]] = []
    if isinstance(node, N.Chain):
        _collect_side(node.parts[0].left, out)
        for p in node.parts:
            _collect_side(p.right, out)
    elif isinstance(node, N.Compare):
        _collect_side(node.left, out)
        _collect_side(node.right, out)
    else:
        _collect(node.a, "constant", out)
        _collect(node.b, "constant", out)
    out.sort(key=lambda pair: pair[0].start)
    return [Literal(k, num.value, num.start, num.end, label) for k, (num, label) in enumerate(out)]


def _collect_side(side: N.Node, out: list[tuple[N.Num, str]]) -> None:
    # a bare numeric operand of the top comparison is a threshold
    if isinstance(side, N.Num):
        out.append((side, "threshold"))
        return
    _collect(side, "threshold", out)


def substitute(node: N.Compare | N.Cross | N.Chain, overrides: dict[int, float]) -> N.Compare | N.Cross | N.Chain:
    if not overrides:
        return node
    lits = literals(node)
    by_pos = {lit.start: overrides[lit.ordinal] for lit in lits if lit.ordinal in overrides}

    def rewrite(n: N.Node) -> N.Node:
        if isinstance(n, N.Num):
            if n.start in by_pos:
                return dataclasses.replace(n, value=by_pos[n.start])
            return n
        if isinstance(n, (N.Candle, N.Entry)):
            return n
        if isinstance(n, N.Field):
            return dataclasses.replace(n, base=rewrite(n.base))
        if isinstance(n, N.Offset):
            synth_start = n.end - 1 - len(str(n.n))
            new_n = int(by_pos[synth_start]) if synth_start in by_pos else n.n
            return dataclasses.replace(n, base=rewrite(n.base), n=new_n)
        if isinstance(n, N.Tf):
            return dataclasses.replace(n, base=rewrite(n.base))
        if isinstance(n, N.Unary):
            return dataclasses.replace(n, operand=rewrite(n.operand))
        if isinstance(n, N.Binary):
            return dataclasses.replace(n, left=rewrite(n.left), right=rewrite(n.right))
        if isinstance(n, N.Call):
            return dataclasses.replace(n, args=[rewrite(a) for a in n.args])
        if isinstance(n, N.Compare):
            return dataclasses.replace(n, left=rewrite(n.left), right=rewrite(n.right))
        if isinstance(n, N.Cross):
            return dataclasses.replace(n, a=rewrite(n.a), b=rewrite(n.b))
        if isinstance(n, N.Chain):
            return dataclasses.replace(n, parts=[rewrite(p) for p in n.parts])
        return n

    return rewrite(node)  # type: ignore[return-value]
