from __future__ import annotations

from dataclasses import dataclass

from auto_trader.strategy.expr.registry import PATTERN_FN_NAMES


@dataclass(frozen=True, slots=True)
class Num:
    value: float
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Candle:
    field: str | None
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Entry:
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Call:
    name: str
    args: list["Node"]
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Field:
    base: "Node"
    name: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Offset:
    base: "Node"
    n: int
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Tf:
    base: "Node"
    tf: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Unary:
    operand: "Node"
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Binary:
    op: str
    left: "Node"
    right: "Node"
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Compare:
    op: str
    left: "Node"
    right: "Node"
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Cross:
    fn: str
    a: "Node"
    b: "Node"
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Chain:
    parts: list["Compare | Cross"]
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Predicate:
    fn: str  # "bullish" | "bearish" | a candle pattern name
    base: "Node"  # candle-rooted expression (candle, candle[-1], candle@1H, ...)
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Count:
    cond: "Compare | Cross | Predicate"
    window: "Node"
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class BarsSinceEntry:
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class IndicatorRef:
    """A configured chart-indicator instance's output, e.g. SLOPE#a1b2c3.slope0.
    Carries NO parameters: the pane's settings are the single source of truth
    and travel on the request's `indicators` map."""
    instance: str
    output: str
    start: int
    end: int


Node = (
    Num | Candle | Entry | Call | Field | Offset | Tf | Unary | Binary | Compare | Cross | Chain
    | Predicate | Count | BarsSinceEntry | IndicatorRef
)

# A parsed row: what parse() returns and validate()/compile_row() accept.
Row = Compare | Cross | Chain | Predicate

CROSS_FNS = ("crossAbove", "crossBelow")
PREDICATE_FNS = ("bullish", "bearish", *PATTERN_FN_NAMES)
CANDLE_FIELDS = ("open", "high", "low", "close", "volume", "body", "range", "wickTop", "wickBottom")


def contains_tf(node: Node) -> bool:
    if isinstance(node, Tf):
        return True
    if isinstance(node, (Field, Offset, Unary)):
        return contains_tf(node.base if not isinstance(node, Unary) else node.operand)
    if isinstance(node, Call):
        return any(contains_tf(a) for a in node.args)
    if isinstance(node, (Binary, Compare)):
        return contains_tf(node.left) or contains_tf(node.right)
    if isinstance(node, Cross):
        return contains_tf(node.a) or contains_tf(node.b)
    if isinstance(node, Chain):
        return any(contains_tf(p) for p in node.parts)
    if isinstance(node, Predicate):
        return contains_tf(node.base)
    if isinstance(node, Count):
        return contains_tf(node.cond) or contains_tf(node.window)
    return False


def contains_bars_since_entry(node: Node) -> bool:
    if isinstance(node, BarsSinceEntry):
        return True
    if isinstance(node, (Field, Offset, Unary)):
        return contains_bars_since_entry(node.base if not isinstance(node, Unary) else node.operand)
    if isinstance(node, Call):
        return any(contains_bars_since_entry(a) for a in node.args)
    if isinstance(node, (Binary, Compare)):
        return contains_bars_since_entry(node.left) or contains_bars_since_entry(node.right)
    if isinstance(node, Cross):
        return contains_bars_since_entry(node.a) or contains_bars_since_entry(node.b)
    if isinstance(node, Chain):
        return any(contains_bars_since_entry(p) for p in node.parts)
    if isinstance(node, Predicate):
        return contains_bars_since_entry(node.base)
    if isinstance(node, Count):
        return contains_bars_since_entry(node.cond) or contains_bars_since_entry(node.window)
    return False


def part_operands(part: "Compare | Cross") -> "tuple[Node, Node]":
    """A chain part's (left, right) operands regardless of its shape."""
    if isinstance(part, Cross):
        return part.a, part.b
    return part.left, part.right
