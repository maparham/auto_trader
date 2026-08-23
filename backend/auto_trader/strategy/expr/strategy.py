"""Expression-rule strategy: runs compiled expression rows against the engine.

Each of the four groups (long/short entry/exit) is a list of CompiledRow; the
rows in a group combine with the group's AND/OR setting (AND by default, so an
omitted setting behaves as it always did). Entries are gated on `trade_from_time`; exits
fire only while the side is held, passing the position's entry price into each
row so an exit expression's `entry` operand resolves.

A firing group stamps its Signal with provenance, like the structured engine
did: `reason` is the PASSING rows' expression text joined with the group's
conjunction (the trades table's Reason column and the fill markers read it),
`terms` are those rows' captured comparison values at the signal bar (the
chart's signal-candle caret + popover read those; empty terms = no caret), and
`combine` names the conjunction so the popover reads the terms correctly.
"""

from __future__ import annotations

import bisect

from auto_trader.core.models import RuleTerm, Side, Signal
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
        # How each group's rows combine: "AND" (default) | "OR".
        long_entry_combine: str = "AND",
        long_exit_combine: str = "AND",
        short_entry_combine: str = "AND",
        short_exit_combine: str = "AND",
        # Epoch seconds parallel to the candle list the engine will run over.
        # ctx.history is that list's prefix even under start_index fast-forward,
        # so bar i's epoch is epochs[i]; this drops the per-bar .timestamp() in
        # the entry gate and the datetime-keyed bisect in _entry_index. None =
        # legacy per-bar datetime math (identical results either way).
        epochs: list[float] | None = None,
    ) -> None:
        self.long_entry = long_entry
        self.long_exit = long_exit
        self.short_entry = short_entry
        self.short_exit = short_exit
        self.quantity = quantity
        self.trade_from_time = trade_from_time
        self.long_enabled = long_enabled
        self.short_enabled = short_enabled
        self.long_entry_combine = long_entry_combine
        self.long_exit_combine = long_exit_combine
        self.short_entry_combine = short_entry_combine
        self.short_exit_combine = short_exit_combine
        self.epochs = epochs

    @staticmethod
    def _passes(rows: list[CompiledRow], i: int, entry: float | None,
                entry_i: int | None = None, combine: str = "AND") -> bool:
        # An empty group never fires (no entry rules -> no entries; no exit rules
        # -> the position only leaves via risk/range-end), matching RuleStrategy —
        # also in OR mode (any([]) is False, but keep the explicit guard).
        if not rows:
            return False
        fold = any if combine == "OR" else all
        return fold(r.evaluate(i, entry, entry_i) for r in rows)

    @staticmethod
    def _provenance(
        rows: list[CompiledRow], i: int, entry: float | None, entry_i: int | None,
        combine: str = "AND",
    ) -> tuple[str, tuple[RuleTerm, ...]]:
        """(reason, terms) for a group that just passed at bar `i`. Only rows
        that PASSED contribute — in AND mode that is every row; in OR mode the
        failing rows' terms would misattribute the signal. Row evaluation is a
        pure function of the bar index (CompiledRow memoizes by node/bar), so
        re-evaluating after an `any()` short-circuit is safe."""
        passing = [r for r in rows if r.evaluate(i, entry, entry_i)]
        reason = f" {combine} ".join(r.source for r in passing if r.source)
        terms = tuple(t for r in passing for t in r.terms_at(i, entry, entry_i))
        return reason, terms

    def _entry_index(self, ctx: Context, entry_time) -> int | None:
        """Index of the bar containing `entry_time` (last bar at or before it),
        feeding barsSinceEntry. None when flat or before all history. Bisecting
        the epoch array is ordering-identical to bisecting history by c.time
        (UTC datetimes map monotonically to their epochs)."""
        if entry_time is None:
            return None
        if self.epochs is not None:
            idx = bisect.bisect_right(
                self.epochs, entry_time.timestamp(), 0, len(ctx.history)) - 1
        else:
            idx = bisect.bisect_right(ctx.history, entry_time, key=lambda c: c.time) - 1
        return idx if idx >= 0 else None

    def on_bar(self, ctx: Context) -> list[Signal]:
        i = len(ctx.history) - 1
        gated = (
            self.trade_from_time is not None
            and (self.epochs[i] if self.epochs is not None
                 else ctx.bar.time.timestamp()) < self.trade_from_time
        )
        out: list[Signal] = []
        if self.long_enabled:
            if not gated and self._passes(self.long_entry, i, None, combine=self.long_entry_combine):
                reason, terms = self._provenance(
                    self.long_entry, i, None, None, self.long_entry_combine)
                out.append(Signal(Side.BUY, self.quantity, reason, leg="long", terms=terms,
                                  combine=self.long_entry_combine))
            long_entry_i = self._entry_index(ctx, ctx.long_entry_time)
            if ctx.position_long > 0 and self._passes(
                self.long_exit, i, ctx.long_entry_price, long_entry_i, self.long_exit_combine
            ):
                reason, terms = self._provenance(
                    self.long_exit, i, ctx.long_entry_price, long_entry_i, self.long_exit_combine)
                out.append(Signal(Side.SELL, self.quantity, reason, leg="long", terms=terms,
                                  combine=self.long_exit_combine))
        if self.short_enabled:
            if not gated and self._passes(self.short_entry, i, None, combine=self.short_entry_combine):
                reason, terms = self._provenance(
                    self.short_entry, i, None, None, self.short_entry_combine)
                out.append(Signal(Side.SELL, self.quantity, reason, leg="short", terms=terms,
                                  combine=self.short_entry_combine))
            short_entry_i = self._entry_index(ctx, ctx.short_entry_time)
            if ctx.position_short > 0 and self._passes(
                self.short_exit, i, ctx.short_entry_price, short_entry_i, self.short_exit_combine
            ):
                reason, terms = self._provenance(
                    self.short_exit, i, ctx.short_entry_price, short_entry_i, self.short_exit_combine)
                out.append(Signal(Side.BUY, self.quantity, reason, leg="short", terms=terms,
                                  combine=self.short_exit_combine))
        return out
