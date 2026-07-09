"""Per-signal stop/target levels (coded strategies): a Signal carrying
stop_level/target_level seeds the opened position's bracket, and the engine's
existing intra-bar exit machinery closes on them."""

import types
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
from auto_trader.strategy.base import Context, Strategy
from auto_trader.strategy.coded import CodedStrategy


def bars(prices: list[tuple[float, float, float, float]]) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=o, high=h, low=l, close=c)
        for i, (o, h, l, c) in enumerate(prices)
    ]


class OneBuyWithBracket(Strategy):
    """BUY once on the first bar, with an absolute stop at 95 and target 110."""

    def __init__(self) -> None:
        self.fired = False

    def on_bar(self, ctx: Context) -> list[Signal]:
        if self.fired:
            return []
        self.fired = True
        return [Signal(Side.BUY, 1.0, "entry", leg="long", stop_level=95.0, target_level=110.0)]


def test_signal_stop_level_exits_intrabar():
    # Bar 0 signals; fills at bar 1 open (100). Bar 2 dips low to 94 -> stop 95 hits.
    candles = bars([
        (100, 101, 99, 100),
        (100, 102, 98, 101),
        (101, 102, 94, 96),
        (96, 97, 95, 96),
    ])
    result = BacktestEngine(OneBuyWithBracket()).run(candles)
    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.reason_out == "stop"
    assert t.exit_price == 95.0
    assert t.stop_initial == 95.0 and t.target == 110.0


def test_signal_target_level_exits_intrabar():
    candles = bars([
        (100, 101, 99, 100),
        (100, 102, 98, 101),
        (101, 111, 100, 108),  # high 111 >= target 110
        (108, 109, 107, 108),
    ])
    result = BacktestEngine(OneBuyWithBracket()).run(candles)
    assert len(result.trades) == 1
    assert result.trades[0].reason_out == "target"
    assert result.trades[0].exit_price == 110.0


def test_signal_without_levels_unchanged():
    class PlainBuy(OneBuyWithBracket):
        def on_bar(self, ctx):
            sigs = super().on_bar(ctx)
            return [Signal(s.side, s.quantity, s.reason, leg=s.leg) for s in sigs]

    candles = bars([
        (100, 101, 99, 100),
        (100, 102, 98, 101),
        (101, 102, 94, 96),
        (96, 97, 95, 96),
    ])
    result = BacktestEngine(PlainBuy()).run(candles)
    # No bracket, no risk config -> held to range end.
    assert len(result.trades) == 1
    assert result.trades[0].reason_out == "range end"


def test_signal_stop_not_ratcheted_by_side_level_trailing_risk():
    # Side-level risk is TRAILING, but this position's bracket came from the
    # signal, which must fully override side-level risk: the static 95.0 stop
    # is never ratcheted up by the trailing config, and its exit always reports
    # "stop" (never "trail") even though the side risk is a trailing kind.
    # Bar 2 runs the high to 109 (below the signal's 110 target, so it doesn't
    # exit early; a trailing 10% stop would still ratchet to ~98.1), then bar 3
    # dips low to 94 -> the untouched 95.0 signal stop hits.
    risk = RiskConfig(StopSpec("trailPct", value=10.0), TargetSpec("none"))
    candles = bars([
        (100, 101, 99, 100),
        (100, 102, 98, 101),
        (101, 109, 100, 105),
        (105, 106, 94, 96),
    ])
    result = BacktestEngine(OneBuyWithBracket(), long_risk=risk).run(candles)
    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.stop_initial == 95.0
    assert t.stop_final == 95.0
    assert t.reason_out == "stop"


def make_candles(n: int = 40) -> list[Candle]:
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


def exec_module(source: str) -> types.ModuleType:
    mod = types.ModuleType("user_strategy_bracket_test")
    exec(compile(source, "<bracket-test-strategy>", "exec"), mod.__dict__)
    return mod


BRACKET_STRAT = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(sl=ctx.close * 0.99, tp=ctx.close * 1.01, reason="in")]
    return []
'''


def test_panel_risk_strips_file_brackets():
    candles = make_candles(40)
    mod = exec_module(BRACKET_STRAT)
    strat = CodedStrategy(mod, candles, quantity=1.0, panel_risk_legs=frozenset({"long"}))
    risk = RiskConfig(StopSpec("pct", 5.0), TargetSpec("pct", 10.0))
    result = BacktestEngine(strat, long_risk=risk).run(candles)
    assert strat.file_brackets_overridden is True
    # Engine applied the 5% panel stop, not the 1% file stop.
    t = result.trades[0]
    assert t.stop_initial is not None
    assert abs(t.stop_initial / t.entry_price - 0.95) < 0.005


def test_no_panel_risk_keeps_file_brackets():
    candles = make_candles(40)
    mod = exec_module(BRACKET_STRAT)
    strat = CodedStrategy(mod, candles, quantity=1.0)
    result = BacktestEngine(strat).run(candles)
    assert strat.file_brackets_overridden is False
    t = result.trades[0]
    assert abs(t.stop_initial / t.entry_price - 0.99) < 0.005
