"""Exit rule groups riding along on a coded run (panel exits for coded mode)."""

from datetime import datetime, timedelta, timezone
from types import ModuleType

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.coded import CodedStrategy, CodedWithRuleExits
from auto_trader.strategy.rule import Operand, Rule, RuleGroup, RuleStrategy

HOLD_FOREVER = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return []
'''

CLOSES_ITSELF = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return [ctx.close_long(reason="own exit")]
'''


def make_candles(n=20):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [Candle(time=t0 + timedelta(hours=i), open=100, high=101, low=99,
                   close=100, volume=10) for i in range(n)]


def exec_module(src: str) -> ModuleType:
    m = ModuleType("m")
    exec(src, m.__dict__)
    return m


def exits_only_rule_strategy(exit_rule: Rule, series) -> RuleStrategy:
    empty = RuleGroup(combine="AND", rules=[])
    exit_group = RuleGroup(combine="AND", rules=[exit_rule])
    return RuleStrategy(empty, exit_group, empty, RuleGroup(combine="AND", rules=[]),
                        series, quantity=1.0)


def test_rule_exit_closes_coded_position():
    candles = make_candles(20)
    # Series that flips above 0 at bar 10 — rule: SIG > 0 exits.
    series = {"SIG": [(-1.0 if i < 10 else 1.0) for i in range(20)]}
    rule = Rule(left=Operand(kind="series", series_key="SIG"), op="gt",
                right=Operand(kind="const", value=0.0))
    coded = CodedStrategy(exec_module(HOLD_FOREVER), candles, quantity=1.0)
    strat = CodedWithRuleExits(coded, exits_only_rule_strategy(rule, series))
    result = BacktestEngine(strat).run(candles)
    assert result.trades, "rule exit should have closed the coded entry"
    assert result.trades[0].reason_out and "own exit" not in result.trades[0].reason_out


def test_one_close_per_leg_when_both_fire():
    candles = make_candles(20)
    series = {"SIG": [1.0] * 20}                       # rule exit true every bar
    rule = Rule(left=Operand(kind="series", series_key="SIG"), op="gt",
                right=Operand(kind="const", value=0.0))
    coded = CodedStrategy(exec_module(CLOSES_ITSELF), candles, quantity=1.0)
    strat = CodedWithRuleExits(coded, exits_only_rule_strategy(rule, series))
    # Run through the engine; if both closes emitted per bar the engine would
    # see a second close on a flat book — assert trades come out 1 close each.
    result = BacktestEngine(strat).run(candles)
    for t in result.trades:
        if t.reason_out == "range end":
            continue  # mechanical force-close of the still-open last-bar entry
        assert t.reason_out == "own exit"              # coded close wins (emitted first)


def test_no_zero_size_close_on_the_entry_bar():
    # Rule exit is TRUE on the very bar the coded strategy signals its entry
    # (flat → buy). The position hasn't filled yet, so the rule exit's size is
    # 0 — it must be skipped, not emitted; the exit then fires the NEXT bar.
    candles = make_candles(20)
    series = {"SIG": [1.0] * 20}
    rule = Rule(left=Operand(kind="series", series_key="SIG"), op="gt",
                right=Operand(kind="const", value=0.0))
    coded = CodedStrategy(exec_module(HOLD_FOREVER), candles, quantity=1.0)
    strat = CodedWithRuleExits(coded, exits_only_rule_strategy(rule, series))
    result = BacktestEngine(strat).run(candles)
    assert result.trades, "positions should open and be rule-exited"
    for t in result.trades:
        assert t.quantity > 0
        if t.reason_out == "range end":
            continue  # mechanical force-close of the still-open last-bar entry
        assert t.exit_time > t.entry_time              # never closed on the entry bar
