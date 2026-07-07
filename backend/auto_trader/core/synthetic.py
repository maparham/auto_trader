"""Pure parser + evaluator for synthetic (arithmetic-combination) charts.

An expression combines instrument symbols and numeric constants with + - * / and
parentheses, e.g. "OIL_CRUDE/DXY" or "(AAPL+MSFT)/2". This module has NO I/O:
`parse` builds an AST, `symbols` lists the instruments to fetch, and `combine`
folds each symbol's OHLC candles into one synthetic series (element-wise over a
forward-filled union timeline, H/L clamped, divide-by-zero dropped).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone

from auto_trader.core.models import Candle


class SyntheticError(ValueError):
    """Malformed expression or unresolvable structure. Surfaced to the client."""


# --- AST -------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Symbol:
    name: str


@dataclass(frozen=True, slots=True)
class Const:
    value: float


@dataclass(frozen=True, slots=True)
class BinOp:
    op: str  # one of + - * /
    left: "Node"
    right: "Node"


@dataclass(frozen=True, slots=True)
class Neg:
    operand: "Node"


Node = Symbol | Const | BinOp | Neg

# A symbol token: letters/digits/underscore/dot, not a pure number. Numbers are
# matched first by the tokenizer so "US500" stays a symbol but "500" is a Const.
_TOKEN = re.compile(r"\s*(?:(?P<num>\d+(?:\.\d+)?)|(?P<symbol>[A-Za-z_][A-Za-z0-9_.]*)|(?P<op>[()+\-*/]))")


def _tokenize(expr: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    i = 0
    while i < len(expr):
        if expr[i].isspace():
            i += 1
            continue
        m = _TOKEN.match(expr, i)
        if not m or m.start() == m.end():
            raise SyntheticError(f"unexpected character at {i!r}: {expr[i:i+8]!r}")
        i = m.end()
        if m.group("num") is not None:
            tokens.append(("num", m.group("num")))
        elif m.group("symbol") is not None:
            tokens.append(("symbol", m.group("symbol").upper()))
        else:
            tokens.append(("op", m.group("op")))
    if not tokens:
        raise SyntheticError("empty expression")
    return tokens


class _Parser:
    """Recursive-descent: expr = term (+|-) term; term = factor (*|/) factor."""

    def __init__(self, tokens: list[tuple[str, str]]):
        self.toks = tokens
        self.pos = 0

    def _peek(self) -> tuple[str, str] | None:
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def _next(self) -> tuple[str, str]:
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def parse(self) -> Node:
        node = self._expr()
        if self.pos != len(self.toks):
            raise SyntheticError(f"unexpected token: {self.toks[self.pos]}")
        return node

    def _expr(self) -> Node:
        node = self._term()
        while (t := self._peek()) is not None and t[0] == "op" and t[1] in ("+", "-"):
            op = self._next()[1]
            node = BinOp(op, node, self._term())
        return node

    def _term(self) -> Node:
        node = self._factor()
        while (t := self._peek()) is not None and t[0] == "op" and t[1] in ("*", "/"):
            op = self._next()[1]
            node = BinOp(op, node, self._factor())
        return node

    def _factor(self) -> Node:
        t = self._peek()
        if t is None:
            raise SyntheticError("unexpected end of expression")
        if t == ("op", "-"):
            self._next()
            return Neg(self._factor())
        if t == ("op", "("):
            self._next()
            node = self._expr()
            if self._peek() != ("op", ")"):
                raise SyntheticError("unbalanced parentheses")
            self._next()
            return node
        kind, val = self._next()
        if kind == "num":
            return Const(float(val))
        if kind == "symbol":
            return Symbol(val)
        raise SyntheticError(f"unexpected token: {(kind, val)}")


def parse(expr: str) -> Node:
    return _Parser(_tokenize(expr)).parse()


def symbols(node: Node) -> list[str]:
    out: list[str] = []

    def walk(n: Node) -> None:
        if isinstance(n, Symbol):
            if n.name not in out:
                out.append(n.name)
        elif isinstance(n, BinOp):
            walk(n.left)
            walk(n.right)
        elif isinstance(n, Neg):
            walk(n.operand)

    walk(node)
    return out


# One aligned frame per symbol at a given timestamp: (open, high, low, close).
_Frame = tuple[float, float, float, float]


def _eval_field(node: Node, frame: dict[str, float]) -> float:
    """Evaluate the expression for ONE OHLC field. `frame` maps symbol -> that
    field's value at the current timestamp."""
    if isinstance(node, Const):
        return node.value
    if isinstance(node, Symbol):
        return frame[node.name]
    if isinstance(node, Neg):
        return -_eval_field(node.operand, frame)
    if isinstance(node, BinOp):
        lhs = _eval_field(node.left, frame)
        rhs = _eval_field(node.right, frame)
        if node.op == "+":
            return lhs + rhs
        if node.op == "-":
            return lhs - rhs
        if node.op == "*":
            return lhs * rhs
        return lhs / rhs  # "/": may raise ZeroDivisionError, caught by caller
    raise SyntheticError(f"bad node: {node!r}")


def combine(node: Node, per_symbol: dict[str, list[Candle]]) -> list[Candle]:
    names = symbols(node)
    if not names:
        # Constant-only expression: single bar at epoch 0 (unit-test convenience).
        v = _eval_field(node, {})
        t = datetime.fromtimestamp(0, tz=timezone.utc)
        return [Candle(t, v, v, v, v, 0.0)]

    # Index each symbol by timestamp (unix seconds) for O(1) lookup + forward-fill.
    indexed: dict[str, dict[int, Candle]] = {}
    for name in names:
        bars = per_symbol.get(name, [])
        indexed[name] = {int(c.time.timestamp()): c for c in bars}

    # Union of all timestamps, ascending.
    all_ts = sorted({ts for idx in indexed.values() for ts in idx})

    last: dict[str, Candle] = {}     # most recent bar per symbol (forward-fill state)
    out: list[Candle] = []
    for ts in all_ts:
        for name in names:
            bar = indexed[name].get(ts)
            if bar is not None:
                last[name] = bar
        # Leading-seed: skip until EVERY symbol has produced a bar at//before ts.
        if len(last) < len(names):
            continue
        opens = {n: last[n].open for n in names}
        highs = {n: last[n].high for n in names}
        lows = {n: last[n].low for n in names}
        closes = {n: last[n].close for n in names}
        try:
            o = _eval_field(node, opens)
            h = _eval_field(node, highs)
            lo = _eval_field(node, lows)
            c = _eval_field(node, closes)
        except ZeroDivisionError:
            continue  # divide-by-zero -> gap
        if not all(math.isfinite(x) for x in (o, h, lo, c)):
            continue  # non-finite -> gap
        hi = max(o, h, lo, c)
        lolo = min(o, h, lo, c)
        out.append(
            Candle(datetime.fromtimestamp(ts, tz=timezone.utc), o, hi, lolo, c, 0.0)
        )
    return out
