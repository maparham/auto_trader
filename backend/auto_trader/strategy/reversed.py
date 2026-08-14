"""Mirror-image wrapper for the Reversed baseline.

The inner strategy runs unchanged and unaware: it reads a mirrored Context
(the engine's short book presented as its long book and vice versa) and its
signals are flipped on the way out (leg and side swapped), so every long
decision executes as the corresponding short decision. Per-signal bracket
levels swap roles too: a level on the loss side of a long is on the profit
side of the short at the same price.

The caller is responsible for swapping the SIDE-LEVEL configs the engine
applies (risk, scaling, panel exits) so the flipped legs keep the config that
governed them in the original run — see run_coded_sync(reverse=True).
"""
from __future__ import annotations

from dataclasses import replace

from auto_trader.core.models import Side, Signal
from auto_trader.strategy.base import Context, Strategy

_FLIP_LEG = {"long": "short", "short": "long"}
_FLIP_SIDE = {Side.BUY: Side.SELL, Side.SELL: Side.BUY}


class ReversedStrategy(Strategy):
    def __init__(self, inner: Strategy) -> None:
        self.inner = inner

    @property
    def file_brackets_overridden(self) -> bool:
        return getattr(self.inner, "file_brackets_overridden", False)

    def on_bar(self, ctx: Context) -> list[Signal]:
        return [self._flip(s) for s in self.inner.on_bar(self._mirror(ctx))]

    @staticmethod
    def _mirror(ctx: Context) -> Context:
        m = Context()
        # Shared on purpose: the engine appends each bar to one history list,
        # and the inner strategy indexes it by length (no copy per bar).
        m.history = ctx.history
        m.position_long = ctx.position_short
        m.position_short = ctx.position_long
        m.long_entry_price = ctx.short_entry_price
        m.short_entry_price = ctx.long_entry_price
        m.long_entry_time = ctx.short_entry_time
        m.short_entry_time = ctx.long_entry_time
        m.last_exit_leg = (
            _FLIP_LEG[ctx.last_exit_leg] if ctx.last_exit_leg else None
        )
        m.last_exit_time = ctx.last_exit_time
        m.last_exit_reason = ctx.last_exit_reason
        return m

    @staticmethod
    def _flip(s: Signal) -> Signal:
        return replace(
            s,
            side=_FLIP_SIDE[s.side],
            leg=_FLIP_LEG[s.leg],
            stop_level=s.target_level,
            target_level=s.stop_level,
        )
