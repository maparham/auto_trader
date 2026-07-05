"""Rule-based strategy driven by a frontend-built rule set.

The engine does no indicator math: the frontend computes each indicator series
from the exact candles being backtested and posts them alongside the rules.
This module only evaluates rules against those series (plus bar price and
constants).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from auto_trader.core.models import Side, Signal
from auto_trader.strategy.base import Context, Strategy


@dataclass(frozen=True, slots=True)
class Operand:
    """One side of a Rule. Exactly one of the kind-specific fields is used:
    kind="indicator" -> indicator/length (+ anchor for AVWAP); kind="price" -> field; kind="const" -> value.
    """

    kind: str  # "indicator" | "price" | "const"
    indicator: str | None = None
    length: int | None = None
    field: str | None = None
    value: float | None = None
    anchor: int | None = None  # AVWAP only: anchor epoch-ms; keys the series
    timeframe: str | None = None  # higher timeframe this indicator runs on; keys the series (None ⇒ base)


@dataclass(frozen=True, slots=True)
class Rule:
    left: Operand
    op: str  # "crossesAbove" | "crossesBelow" | "gt" | "lt" | "gte" | "lte"
    right: Operand


@dataclass(frozen=True, slots=True)
class RuleGroup:
    combine: str  # "AND" | "OR"
    rules: list[Rule] = field(default_factory=list)


def series_name(op: Operand) -> str | None:
    """The payload key this operand's series lives under, or None if it has no
    series (price/const are read straight off the candle). AVWAP is keyed by its
    anchor (epoch-ms) so distinct anchors are distinct series; VOL has no param;
    the rest are keyed by length."""
    if op.kind != "indicator":
        return None
    if op.indicator == "VOL":
        base = "VOL"
    elif op.indicator == "AVWAP":
        base = f"AVWAP_{op.anchor or 0}"
    else:
        base = f"{op.indicator}_{op.length}"
    # A per-operand timeframe qualifies the key so a base-timeframe indicator and
    # the same indicator on a higher timeframe are distinct series. None ⇒ base ⇒
    # the bare key. Must match the frontend's seriesName (backtestConfig.ts).
    return f"{base}@{op.timeframe}" if op.timeframe else base


def _operand_name(op: Operand) -> str:
    name = series_name(op)
    if name is not None:
        return name
    if op.kind == "price":
        return op.field or "price"
    return str(op.value)


CROSS_OPS = {"crossesAbove", "crossesBelow"}


class RuleStrategy(Strategy):
    """Hedging rule strategy: four independent rule groups drive two buckets.

    Long: `long_entry` emits a BUY (leg=long) whenever the entry rule passes —
    the ENGINE decides whether that opens a new position or is rejected by the
    cap/spacing — and `long_exit` emits a SELL (leg=long) while the side holds.
    Short mirrors it (SELL to open, BUY to close). Long and short are
    independent — the strategy can hold both at once.

    `long_enabled` / `short_enabled` turn a whole side off: when a side is
    disabled its bucket is skipped entirely — no entries AND no exits — so it
    never trades even if its rule groups are populated. This is an explicit
    switch, distinct from an empty rule group: the user keeps their rules while
    the side is parked. A disabled side never opens a position, so skipping its
    exit is moot (nothing to close). Both default on.

    `trade_from_time` (unix seconds, optional) gates BOTH entry legs (D6): bars
    before it are history loaded purely to warm the series up. Exits are never
    gated — no bucket can hold anything there, since no entry could have fired.
    """

    def __init__(
        self,
        long_entry: RuleGroup,
        long_exit: RuleGroup,
        short_entry: RuleGroup,
        short_exit: RuleGroup,
        series: dict[str, list[float | None]],
        quantity: float,
        trade_from_time: int | None = None,
        *,
        long_enabled: bool = True,
        short_enabled: bool = True,
    ) -> None:
        self.long_entry = long_entry
        self.long_exit = long_exit
        self.short_entry = short_entry
        self.short_exit = short_exit
        self.series = series
        self.quantity = quantity
        self.trade_from_time = trade_from_time
        self.long_enabled = long_enabled
        self.short_enabled = short_enabled

    def on_bar(self, ctx: Context) -> list[Signal]:
        i = len(ctx.history) - 1
        gated = (
            self.trade_from_time is not None
            and ctx.bar.time.timestamp() < self.trade_from_time
        )
        signals: list[Signal] = []

        # Long: entry fires whenever the rule passes (the ENGINE caps how many
        # positions open); exit fires only while the side is holding.
        if self.long_enabled:
            if not gated:
                passed, results = self._eval_group(self.long_entry, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.BUY, self.quantity, self._reason(self.long_entry, results), leg="long")
                    )
            if ctx.position_long > 0:
                passed, results = self._eval_group(self.long_exit, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.SELL, self.quantity, self._reason(self.long_exit, results), leg="long")
                    )

        if self.short_enabled:
            if not gated:
                passed, results = self._eval_group(self.short_entry, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.SELL, self.quantity, self._reason(self.short_entry, results), leg="short")
                    )
            if ctx.position_short > 0:
                passed, results = self._eval_group(self.short_exit, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.BUY, self.quantity, self._reason(self.short_exit, results), leg="short")
                    )

        return signals

    # --- evaluation ---------------------------------------------------------

    def _eval_group(self, group: RuleGroup, ctx: Context, i: int) -> tuple[bool, list[bool]]:
        if not group.rules:
            return False, []
        results = [self._eval_rule(r, ctx, i) for r in group.rules]
        passed = all(results) if group.combine == "AND" else any(results)
        return passed, results

    def _eval_rule(self, rule: Rule, ctx: Context, i: int) -> bool:
        lnow, lprev = self._operand_values(rule.left, ctx, i)
        rnow, rprev = self._operand_values(rule.right, ctx, i)

        if rule.op in CROSS_OPS:
            # D2: needs a previous bar and every value present, or it's False.
            if i == 0 or None in (lnow, lprev, rnow, rprev):
                return False
            if rule.op == "crossesAbove":
                return lprev <= rprev and lnow > rnow
            return lprev >= rprev and lnow < rnow

        # D2: a non-cross comparison with a None operand is False, not omitted.
        if lnow is None or rnow is None:
            return False
        if rule.op == "gt":
            return lnow > rnow
        if rule.op == "lt":
            return lnow < rnow
        if rule.op == "gte":
            return lnow >= rnow
        if rule.op == "lte":
            return lnow <= rnow
        raise ValueError(f"unknown operator '{rule.op}'")

    def _operand_values(
        self, op: Operand, ctx: Context, i: int
    ) -> tuple[float | None, float | None]:
        if op.kind == "const":
            return op.value, op.value
        if op.kind == "price":
            now = getattr(ctx.bar, op.field)
            prev = getattr(ctx.history[i - 1], op.field) if i > 0 else None
            return now, prev
        # indicator
        name = series_name(op)
        arr = self.series.get(name, [])
        now = arr[i] if i < len(arr) else None
        prev = arr[i - 1] if 0 < i and i - 1 < len(arr) else None
        return now, prev

    def _reason(self, group: RuleGroup, results: list[bool]) -> str:
        joiner = " AND " if group.combine == "AND" else " OR "
        parts = [
            f"{_operand_name(r.left)} {r.op} {_operand_name(r.right)}"
            for r, passed in zip(group.rules, results)
            if passed
        ]
        return joiner.join(parts) if parts else ""
