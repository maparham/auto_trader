"""Expression-rule strategy: runs compiled expression rows against the engine.

Each of the four groups (long/short entry/exit) is a list of CompiledRow; the
rows in a group combine with AND. Entries are gated on `trade_from_time`; exits
fire only while the side is held, passing the position's entry price into each
row so an exit expression's `entry` operand resolves. Mirrors RuleStrategy's
emit idiom (Signal(Side.X, qty, "", leg=...)).
"""

from __future__ import annotations

from auto_trader.core.models import Side, Signal
from auto_trader.strategy.base import Context, Strategy
from auto_trader.strategy.expr.evaluate import CompiledRow


class ExprRuleStrategy(Strategy):
    def __init__(
        self,
        long_entry: list[CompiledRow],
        long_exit: list[CompiledRow],
        short_entry: list[CompiledRow],
        short_exit: list[CompiledRow],
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
        self.quantity = quantity
        self.trade_from_time = trade_from_time
        self.long_enabled = long_enabled
        self.short_enabled = short_enabled

    @staticmethod
    def _passes(rows: list[CompiledRow], i: int, entry: float | None) -> bool:
        # An empty group never fires (no entry rules -> no entries; no exit rules
        # -> the position only leaves via risk/range-end), matching RuleStrategy.
        return bool(rows) and all(r.evaluate(i, entry) for r in rows)

    def on_bar(self, ctx: Context) -> list[Signal]:
        i = len(ctx.history) - 1
        gated = (
            self.trade_from_time is not None
            and ctx.bar.time.timestamp() < self.trade_from_time
        )
        out: list[Signal] = []
        if self.long_enabled:
            if not gated and self._passes(self.long_entry, i, None):
                out.append(Signal(Side.BUY, self.quantity, "", leg="long"))
            if ctx.position_long > 0 and self._passes(self.long_exit, i, ctx.long_entry_price):
                out.append(Signal(Side.SELL, self.quantity, "", leg="long"))
        if self.short_enabled:
            if not gated and self._passes(self.short_entry, i, None):
                out.append(Signal(Side.SELL, self.quantity, "", leg="short"))
            if ctx.position_short > 0 and self._passes(self.short_exit, i, ctx.short_entry_price):
                out.append(Signal(Side.BUY, self.quantity, "", leg="short"))
        return out
