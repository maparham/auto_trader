"""StrategyContext + CodedStrategy: indicator memoization, netted gating,
stateless per-bar evaluation, and Action -> Signal translation."""

import types
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from auto_trader.core.models import Candle, Side
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.indicators.core import ema_series, rsi_series
from auto_trader.strategy.base import Context
from auto_trader.strategy.coded import CodedStrategy, StrategyRuntimeError


def make_candles(n: int = 60) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    px = 100.0
    for i in range(n):
        px += (1 if i % 3 else -1) * 0.5
        out.append(Candle(
            time=t0 + timedelta(hours=i),
            open=px, high=px + 1, low=px - 1, close=px + 0.3, volume=100 + i,
        ))
    return out


def module_from(fn, hedged=False) -> types.ModuleType:
    mod = types.ModuleType("user_strategy_test")
    mod.on_bar = fn
    if hedged:
        mod.meta = {"hedged": True}
    return mod


def run_engine(fn, candles, hedged=False, quantity=1.0):
    strat = CodedStrategy(module_from(fn, hedged), candles, quantity=quantity)
    return BacktestEngine(strat).run(candles)


def test_ctx_price_history_and_indicators():
    candles = make_candles()
    seen = {}

    def on_bar(ctx):
        i = len(ctx.closes) - 1
        if i == 30:
            seen["close"] = ctx.close
            seen["ema9"] = ctx.ema(9)
            seen["rsi14"] = ctx.rsi(14)
            seen["closes_len"] = len(ctx.closes)
            seen["closes_type"] = type(ctx.closes)
        return []

    run_engine(on_bar, candles)
    assert seen["close"] == candles[30].close
    closes = [c.close for c in candles]
    assert seen["ema9"] == ema_series(closes, 9)[30]      # matches the layer at bar i
    assert seen["rsi14"] == rsi_series(closes, 14)[30]
    assert seen["closes_len"] == 31                        # bars 0..30 only — no lookahead
    assert seen["closes_type"] is np.ndarray


def test_indicator_memoization():
    """ctx.ema(9) computes the full series ONCE per run, not once per bar."""
    candles = make_candles()
    calls = {"n": 0}
    import auto_trader.strategy.coded as coded
    real = coded.ema_series

    def counting(values, length):
        calls["n"] += 1
        return real(values, length)

    coded.ema_series = counting
    try:
        run_engine(lambda ctx: [] if ctx.ema(9) else [], candles)
    finally:
        coded.ema_series = real
    assert calls["n"] == 1


def test_buy_close_round_trip_and_netted_gating():
    candles = make_candles()

    def on_bar(ctx):
        if ctx.position.is_flat:
            return [ctx.buy(reason="in")]     # fires EVERY flat bar; scale-in must be suppressed
        if ctx.bars_since_entry is not None and ctx.bars_since_entry >= 3:
            return [ctx.close_long(reason="out")]
        return []

    result = run_engine(on_bar, candles)
    assert result.n_trades >= 2
    for t in result.trades:
        assert t.reason_in == "in"
    # Every trade except possibly the last must close on the strategy's own
    # signal ("out"); the last may instead be "range end" if the position was
    # still open when the run ended (or its exit signal landed on the final
    # bar, which the engine drops — no next bar to fill on).
    for t in result.trades[:-1]:
        assert t.reason_out == "out"
    assert result.trades[-1].reason_out in ("out", "range end")
    # Netted: never more than one position open -> no overlapping trades.
    for a, b in zip(result.trades, result.trades[1:]):
        assert a.exit_time <= b.entry_time


def test_entries_suppressed_while_opposite_side_held():
    """Netted: a short entry attempted on every bar is gated while long is held.
    The long actually opens and closes (bars_since_entry >= 3) so the gate is
    exercised, not vacuously satisfied. Shorts may legitimately appear once the
    long is flat again; the invariant is that no short trade overlaps a long
    trade's [entry_time, exit_time)."""
    candles = make_candles()

    def on_bar(ctx):
        out = []
        if ctx.position.is_flat:
            out.append(ctx.buy(reason="long in"))
        elif ctx.position.is_long and ctx.bars_since_entry is not None and ctx.bars_since_entry >= 3:
            out.append(ctx.close_long(reason="long out"))
        out.append(ctx.sell(reason="short in"))  # always tries; must be gated while long held
        return out

    result = run_engine(on_bar, candles)
    longs = [t for t in result.trades if t.leg == "long"]
    shorts = [t for t in result.trades if t.leg == "short"]
    assert longs  # non-vacuous: the gate actually had something to gate against
    assert all(
        not (s.entry_time < l.exit_time and l.entry_time < s.exit_time)
        for s in shorts for l in longs
    )


def test_hedged_meta_allows_both_sides():
    candles = make_candles()

    def on_bar(ctx):
        out = []
        if ctx.position_long_qty == 0:
            out.append(ctx.buy(reason="l"))
        if ctx.position_short_qty == 0:
            out.append(ctx.sell(reason="s"))
        return out

    strat = CodedStrategy(module_from(on_bar, hedged=True), candles, quantity=1.0)
    assert strat.hedged is True
    result = BacktestEngine(strat).run(candles)
    assert {t.leg for t in result.trades} == {"long", "short"}


def test_hedged_same_bar_same_side_scale_in_is_gated():
    """Hedged: two same-side opens (buy, buy) in one bar must not both fire —
    only the first long open counts; the opposite-side open still fires."""
    candles = make_candles()
    strat = CodedStrategy(
        module_from(lambda ctx: [ctx.buy(), ctx.buy(), ctx.sell()], hedged=True),
        candles, quantity=1.0,
    )
    ctx = Context()
    ctx.history = candles[:10]
    signals = strat.on_bar(ctx)
    assert len(signals) == 2
    assert {s.leg for s in signals} == {"long", "short"}


def test_bracket_and_note_flow_to_signal():
    candles = make_candles()
    captured = []

    def on_bar(ctx):
        if ctx.position.is_flat and not captured:
            a = ctx.buy(sl=ctx.close * 0.9, tp=ctx.close * 1.1, reason="r", note={"x": 1.5})
            captured.append(a)
            return [a]
        return []

    strat = CodedStrategy(module_from(on_bar), candles, quantity=2.0)
    ctx = Context()
    ctx.history = candles[:10]
    signals = strat.on_bar(ctx)
    assert len(signals) == 1
    s = signals[0]
    assert s.side is Side.BUY and s.leg == "long" and s.quantity == 2.0
    assert s.stop_level == pytest.approx(candles[9].close * 0.9)
    assert s.target_level == pytest.approx(candles[9].close * 1.1)
    assert s.reason == "r"
    assert len(s.terms) == 1 and s.terms[0].left_label == "x" and s.terms[0].left_val == 1.5


def test_close_any_expands_to_held_side():
    candles = make_candles()
    strat = CodedStrategy(module_from(lambda ctx: [ctx.exit(reason="bail")]), candles, quantity=1.0)
    ctx = Context()
    ctx.history = candles[:10]
    ctx.position_short = 1.0
    ctx.short_entry_price = 100.0
    ctx.short_entry_time = candles[5].time
    signals = strat.on_bar(ctx)
    assert len(signals) == 1
    assert signals[0].leg == "short" and signals[0].side is Side.BUY


def test_exit_when_flat_is_dropped():
    candles = make_candles()
    strat = CodedStrategy(module_from(lambda ctx: [ctx.close_long()]), candles, quantity=1.0)
    ctx = Context()
    ctx.history = candles[:10]
    assert strat.on_bar(ctx) == []


def test_trade_from_time_gates_entries():
    candles = make_candles()
    gate = int(candles[30].time.timestamp())
    result_all = run_engine(lambda ctx: [ctx.buy()] if ctx.position.is_flat else [], candles)
    strat = CodedStrategy(
        module_from(lambda ctx: [ctx.buy()] if ctx.position.is_flat else []),
        candles, quantity=1.0, trade_from_time=gate,
    )
    result_gated = BacktestEngine(strat).run(candles)
    assert result_gated.trades[0].entry_time >= candles[30].time
    assert result_all.trades[0].entry_time < result_gated.trades[0].entry_time


def test_user_exception_wrapped_with_bar_info():
    candles = make_candles()

    def on_bar(ctx):
        if len(ctx.closes) - 1 == 5:
            raise ValueError("boom")
        return []

    with pytest.raises(StrategyRuntimeError) as ei:
        run_engine(on_bar, candles)
    assert "boom" in str(ei.value) and "bar 5" in str(ei.value)


def test_bad_return_type_is_an_error():
    candles = make_candles()
    with pytest.raises(StrategyRuntimeError, match="Action"):
        run_engine(lambda ctx: ["not an action"], candles)
