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
    cond: "Node"  # a condition (CONDITION_KINDS)
    window: "Node"
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class BarsSinceEntry:
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class IndicatorRef:
    """A configured chart-indicator instance's output, e.g. SLOPE#a1b2c3.9.
    Carries NO parameters: the pane's settings are the single source of truth
    and travel on the request's `indicators` map."""
    instance: str
    output: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class BoolOp:
    op: str  # "and" | "or"
    parts: list["Node"]  # each a condition (CONDITION_KINDS)
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Not:
    operand: "Node"  # a condition (CONDITION_KINDS)
    start: int
    end: int


Node = (
    Num | Candle | Entry | Call | Field | Offset | Tf | Unary | Binary | Compare | Cross | Chain
    | Predicate | Count | BarsSinceEntry | IndicatorRef | BoolOp | Not
)

# A parsed row: what parse() returns and validate()/compile_row() accept.
Row = Compare | Cross | Chain | Predicate | BoolOp | Not

# The node kinds that ARE conditions (usable as a row, an and/or/not operand,
# or count's first argument) as opposed to numeric values.
CONDITION_KINDS = (Compare, Cross, Chain, Predicate, BoolOp, Not)

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
    if isinstance(node, BoolOp):
        return any(contains_tf(p) for p in node.parts)
    if isinstance(node, Not):
        return contains_tf(node.operand)
    return False


def first_tf(node: Node) -> str | None:
    """The first @tf pin alias in the subtree (reading order), or None. An
    operand pinned anywhere runs on that timeframe, so term attribution
    (RuleTerm.*_tf) takes the pin over the run's base resolution."""
    if isinstance(node, Tf):
        return node.tf
    if isinstance(node, (Field, Offset)):
        return first_tf(node.base)
    if isinstance(node, Unary):
        return first_tf(node.operand)
    if isinstance(node, Call):
        for a in node.args:
            tf = first_tf(a)
            if tf is not None:
                return tf
        return None
    if isinstance(node, (Binary, Compare)):
        return first_tf(node.left) or first_tf(node.right)
    if isinstance(node, Cross):
        return first_tf(node.a) or first_tf(node.b)
    if isinstance(node, Chain):
        for p in node.parts:
            tf = first_tf(p)
            if tf is not None:
                return tf
        return None
    if isinstance(node, Predicate):
        return first_tf(node.base)
    if isinstance(node, Count):
        return first_tf(node.cond) or first_tf(node.window)
    if isinstance(node, BoolOp):
        for p in node.parts:
            tf = first_tf(p)
            if tf is not None:
                return tf
        return None
    if isinstance(node, Not):
        return first_tf(node.operand)
    return None


def contains_series(node: Node) -> bool:
    """True when the subtree computes an indicator/series (a Call like EMA(9),
    slope(...), count(...), or a chart-pane IndicatorRef) — the operand kinds
    that run ON a timeframe. Price/const/entry operands stay timeframe-less
    (mirrors the structured engine's _operand_timeframe)."""
    if isinstance(node, (Call, IndicatorRef, Count)):
        return True
    if isinstance(node, (Field, Offset, Tf)):
        return contains_series(node.base)
    if isinstance(node, Unary):
        return contains_series(node.operand)
    if isinstance(node, (Binary, Compare)):
        return contains_series(node.left) or contains_series(node.right)
    if isinstance(node, Cross):
        return contains_series(node.a) or contains_series(node.b)
    if isinstance(node, Chain):
        return any(contains_series(p) for p in node.parts)
    if isinstance(node, Predicate):
        return contains_series(node.base)
    if isinstance(node, BoolOp):
        return any(contains_series(p) for p in node.parts)
    if isinstance(node, Not):
        return contains_series(node.operand)
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
    if isinstance(node, BoolOp):
        return any(contains_bars_since_entry(p) for p in node.parts)
    if isinstance(node, Not):
        return contains_bars_since_entry(node.operand)
    return False


def part_operands(part: "Compare | Cross") -> "tuple[Node, Node]":
    """A chain part's (left, right) operands regardless of its shape."""
    if isinstance(part, Cross):
        return part.a, part.b
    return part.left, part.right
