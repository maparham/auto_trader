"""ReversedStrategy: the mirror-image of a coded strategy. The inner strategy
sees a mirrored Context (long/short swapped) and its signals come out flipped
(leg and side swapped, per-signal stop/target levels exchanged), so a long
decision becomes the corresponding short decision without the inner strategy
knowing."""
from datetime import datetime, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.strategy.base import Context, Strategy
from auto_trader.strategy.reversed import ReversedStrategy


class _Probe(Strategy):
    """Emits canned signals; records the ctx it was shown."""

    def __init__(self, signals):
        self.signals = signals
        self.seen: Context | None = None

    def on_bar(self, ctx: Context) -> list[Signal]:
        self.seen = ctx
        return list(self.signals)


def _ctx() -> Context:
    ctx = Context()
    ctx.history.append(Candle(
        time=datetime(2026, 1, 1, tzinfo=timezone.utc),
        open=1.0, high=1.0, low=1.0, close=1.0, volume=1.0,
    ))
    ctx.position_long = 2.0
    ctx.position_short = 0.0
    ctx.long_entry_price = 101.0
    ctx.long_entry_time = datetime(2025, 12, 31, tzinfo=timezone.utc)
    ctx.last_exit_leg = "short"
    ctx.last_exit_time = datetime(2025, 12, 30, tzinfo=timezone.utc)
    ctx.last_exit_reason = "stop"
    return ctx


def test_flips_signal_leg_side_and_brackets():
    inner = _Probe([Signal(Side.BUY, 1.5, "entry", leg="long",
                           stop_level=95.0, target_level=110.0,
                           quantity_explicit=True)])
    out = ReversedStrategy(inner).on_bar(_ctx())
    assert len(out) == 1
    s = out[0]
    # Open-long becomes open-short...
    assert s.side is Side.SELL and s.leg == "short"
    # ...with the bracket mirrored: the long's stop side is the short's target side.
    assert s.stop_level == 110.0 and s.target_level == 95.0
    assert s.quantity == 1.5 and s.reason == "entry" and s.quantity_explicit is True


def test_flips_close_signals():
    inner = _Probe([Signal(Side.SELL, 2.0, "exit", leg="long")])
    out = ReversedStrategy(inner).on_bar(_ctx())
    # Close-long becomes close-short.
    assert out[0].side is Side.BUY and out[0].leg == "short"


def test_inner_sees_mirrored_context():
    inner = _Probe([])
    engine_ctx = _ctx()
    ReversedStrategy(inner).on_bar(engine_ctx)
    seen = inner.seen
    # The engine's long book reads as the inner strategy's short book.
    assert seen.position_short == 2.0 and seen.position_long == 0.0
    assert seen.short_entry_price == 101.0 and seen.long_entry_price is None
    assert seen.short_entry_time == engine_ctx.long_entry_time
    assert seen.long_entry_time is None
    assert seen.last_exit_leg == "long"
    assert seen.last_exit_time == engine_ctx.last_exit_time
    assert seen.last_exit_reason == "stop"
    # History is shared, not copied: the engine appends bars to one list.
    assert seen.history is engine_ctx.history
    # The engine's own ctx must not be mutated by the mirroring.
    assert engine_ctx.position_long == 2.0 and engine_ctx.last_exit_leg == "short"


def test_proxies_file_brackets_overridden():
    class _WithFlag(_Probe):
        file_brackets_overridden = True

    assert ReversedStrategy(_WithFlag([])).file_brackets_overridden is True
    assert ReversedStrategy(_Probe([])).file_brackets_overridden is False
