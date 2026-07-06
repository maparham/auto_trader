"""RuleStrategy: rule-driven long-only entry/exit against precomputed series."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.rule import Operand, Rule, RuleGroup, RuleStrategy, series_name


def _series(closes: list[float]) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(t0 + timedelta(minutes=i), c, c, c, c, 0.0) for i, c in enumerate(closes)
    ]


def _ind(name: str, length: int | None = None, anchor: int | None = None) -> Operand:
    return Operand(kind="indicator", indicator=name, length=length, anchor=anchor)


def _price(field: str) -> Operand:
    return Operand(kind="price", field=field)


def _const(value: float) -> Operand:
    return Operand(kind="const", value=value)


def _entry() -> Operand:
    return Operand(kind="entry")


def _rule(left, op, right):
    return Rule(left, op, right)


def _always_entry() -> RuleGroup:
    return RuleGroup("AND", [Rule(_const(1), "gt", _const(0))])  # true every bar


def test_series_name_contract():
    assert series_name(_ind("EMA", 9)) == "EMA_9"
    assert series_name(_ind("RSI", 14)) == "RSI_14"
    assert series_name(_ind("AVWAP")) == "AVWAP_0"
    assert series_name(_ind("AVWAP", anchor=1_700_000_000_000)) == "AVWAP_1700000000000"
    assert series_name(_ind("VOL")) == "VOL"
    assert series_name(_price("close")) is None
    assert series_name(_const(5)) is None


def test_crosses_above_entry_fills_at_next_open():
    # fast <= slow through index 1, fast > slow at index 2 -> cross at i=2.
    candles = _series([10, 10, 10, 10, 10])
    series = {
        "EMA_5": [1.0, 1.0, 3.0, 3.0, 3.0],
        "EMA_9": [2.0, 2.0, 2.0, 2.0, 2.0],
    }
    entry = RuleGroup("AND", [Rule(_ind("EMA", 5), "crossesAbove", _ind("EMA", 9))])
    exit_ = RuleGroup("AND", [])
    strategy = RuleStrategy(entry, exit_, RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    # Entry only; the still-open position adds a "range end" exit fill at the last bar.
    assert len([f for f in result.fills if f.reason != "range end"]) == 1
    assert result.fills[0].side is Side.BUY
    assert result.fills[0].time == candles[3].time  # signal at i=2 fills at i=3's open
    assert "EMA_5 crossesAbove EMA_9" in result.fills[0].reason


def test_crosses_below_exit_round_trip():
    candles = _series([10, 10, 10, 10, 10, 10])
    series = {
        "EMA_5": [1.0, 1.0, 3.0, 3.0, 1.0, 1.0],
        "EMA_9": [2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
    }
    entry = RuleGroup("AND", [Rule(_ind("EMA", 5), "crossesAbove", _ind("EMA", 9))])
    exit_ = RuleGroup("AND", [Rule(_ind("EMA", 5), "crossesBelow", _ind("EMA", 9))])
    strategy = RuleStrategy(entry, exit_, RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    # enters at i=2 (fills i=3), exits at i=4 (fills i=5)
    assert len(result.fills) == 2
    assert result.fills[0].side is Side.BUY
    assert result.fills[1].side is Side.SELL
    assert len(result.trades) == 1


def test_and_requires_both_rules_true():
    candles = _series([10] * 4)
    series = {"EMA_5": [1.0, 3.0, 3.0, 3.0], "EMA_9": [2.0, 2.0, 2.0, 2.0]}
    # second rule (const 100 > 0, always true) doesn't matter; gt rule never true.
    entry = RuleGroup(
        "AND",
        [
            Rule(_ind("EMA", 5), "gt", _ind("EMA", 9)),
            Rule(_const(0), "gt", _const(100)),
        ],
    )
    strategy = RuleStrategy(entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    assert result.fills == []  # second rule is always false -> AND never fires


def test_or_fires_with_either_rule():
    candles = _series([10] * 4)
    series = {"EMA_5": [3.0, 3.0, 3.0, 3.0], "EMA_9": [2.0, 2.0, 2.0, 2.0]}
    entry = RuleGroup(
        "OR",
        [
            Rule(_ind("EMA", 5), "gt", _ind("EMA", 9)),  # true from bar 0
            Rule(_const(0), "gt", _const(100)),  # always false
        ],
    )
    strategy = RuleStrategy(entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    # Entry only; the still-open position adds a "range end" exit fill at the last bar.
    assert len([f for f in result.fills if f.reason != "range end"]) == 1
    assert result.fills[0].time == candles[1].time  # true at i=0, fills at i=1 open


def test_warmup_none_is_false_under_and():
    # D2: a None operand makes the rule False -> AND group can't fire on the one
    # warm rule while the other is still warming up.
    candles = _series([10] * 3)
    series = {"EMA_5": [None, 3.0, 3.0], "EMA_9": [2.0, 2.0, 2.0]}
    entry = RuleGroup("AND", [Rule(_ind("EMA", 5), "gt", _ind("EMA", 9))])
    strategy = RuleStrategy(entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    # true only once EMA_5 warms at i=1 -> fills at i=2's open
    # Entry only; the still-open position adds a "range end" exit fill at the last bar.
    assert len([f for f in result.fills if f.reason != "range end"]) == 1
    assert result.fills[0].time == candles[2].time


def test_cross_guard_at_first_bar():
    # i==0 has no previous bar; a cross rule must be False there even though the
    # raw values would look like "already crossed".
    candles = _series([10] * 3)
    series = {"EMA_5": [3.0, 3.0, 3.0], "EMA_9": [1.0, 1.0, 1.0]}
    entry = RuleGroup("AND", [Rule(_ind("EMA", 5), "crossesAbove", _ind("EMA", 9))])
    strategy = RuleStrategy(entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    assert result.fills == []  # never actually crosses (both series are flat)


def test_price_and_const_operand():
    candles = _series([1, 1, 50, 50])
    entry = RuleGroup("AND", [Rule(_price("close"), "gt", _const(10))])
    strategy = RuleStrategy(entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []), {}, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    # Entry only; the still-open position adds a "range end" exit fill at the last bar.
    assert len([f for f in result.fills if f.reason != "range end"]) == 1
    assert result.fills[0].time == candles[3].time  # true at i=2, fills at i=3


def test_price_crosses_above_indicator_uses_history_for_prev():
    candles = _series([1, 1, 50, 50])  # close crosses above EMA(=10) at i=2
    series = {"EMA_5": [10.0, 10.0, 10.0, 10.0]}
    entry = RuleGroup("AND", [Rule(_price("close"), "crossesAbove", _ind("EMA", 5))])
    strategy = RuleStrategy(entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    # Entry only; the still-open position adds a "range end" exit fill at the last bar.
    assert len([f for f in result.fills if f.reason != "range end"]) == 1
    assert result.fills[0].time == candles[3].time


def test_long_only_lifecycle_no_double_entry_no_exit_while_flat():
    candles = _series([10] * 5)
    # entry always true, exit always true -> without long-only gating this would
    # buy/sell every bar; D3 says buy once (flat->long), then only sell (long->flat).
    entry = RuleGroup("AND", [Rule(_const(1), "gt", _const(0))])
    exit_ = RuleGroup("AND", [Rule(_const(1), "gt", _const(0))])
    strategy = RuleStrategy(entry, exit_, RuleGroup("AND", []), RuleGroup("AND", []), {}, quantity=1.0)
    result = BacktestEngine(strategy).run(candles)
    # buy fills at i=1's open, sell fills at i=2's open, then flat again ->
    # buy fills again at i=3's open, sell at i=4's open.
    sides = [f.side for f in result.fills]
    assert sides == [Side.BUY, Side.SELL, Side.BUY, Side.SELL]


def test_trade_from_time_gates_entries_not_exits():
    candles = _series([10] * 5)
    entry = RuleGroup("AND", [Rule(_const(1), "gt", _const(0))])  # always true
    strategy = RuleStrategy(
        entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []), {}, quantity=1.0,
        trade_from_time=int(candles[2].time.timestamp()),
    )
    result = BacktestEngine(strategy).run(candles)
    # entry true from i=0, but gated until bar i=2 (time >= trade_from_time) ->
    # first BUY signal at i=2, filled at i=3's open.
    # Entry only; the still-open position adds a "range end" exit fill at the last bar.
    assert len([f for f in result.fills if f.reason != "range end"]) == 1
    assert result.fills[0].side is Side.BUY
    assert result.fills[0].time == candles[3].time


def test_short_entry_sells_to_open_and_exit_buys_to_close():
    candles = _series([10, 10, 10, 10, 10, 10])
    series = {
        "EMA_5": [1.0, 1.0, 3.0, 3.0, 1.0, 1.0],
        "EMA_9": [2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
    }
    # short entry when EMA5 crosses BELOW EMA9 (i=1->2? here 3->1 at i=4); exit on cross above
    short_entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "crossesBelow", _ind("EMA", 9))])
    short_exit = RuleGroup("AND", [_rule(_ind("EMA", 5), "crossesAbove", _ind("EMA", 9))])
    strat = RuleStrategy(
        RuleGroup("AND", []), RuleGroup("AND", []), short_entry, short_exit,
        series, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert any(f.side is Side.SELL for f in result.fills)  # short opened with a SELL
    assert all(t.leg == "short" for t in result.trades)


def test_long_and_short_entry_fire_same_bar():
    candles = _series([10] * 4)
    series = {"EMA_5": [3.0, 3.0, 3.0, 3.0], "EMA_9": [2.0, 2.0, 2.0, 2.0]}
    long_entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "gt", _ind("EMA", 9))])
    short_entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "gt", _ind("EMA", 9))])
    strat = RuleStrategy(
        long_entry, RuleGroup("AND", []), short_entry, RuleGroup("AND", []),
        series, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    # first tradeable bar i=0 true -> both fill at i=1 open
    sides = sorted(f.side.value for f in result.fills[:2])
    assert sides == ["buy", "sell"]


def test_trade_from_time_gates_both_entries():
    candles = _series([10] * 5)
    always = RuleGroup("AND", [_rule(_const(1), "gt", _const(0))])
    strat = RuleStrategy(
        always, RuleGroup("AND", []), always, RuleGroup("AND", []),
        {}, quantity=1.0, trade_from_time=int(candles[2].time.timestamp()),
    )
    result = BacktestEngine(strat).run(candles)
    # both entries gated until bar i=2 -> first fills at i=3 open, none earlier
    assert result.fills
    assert min(f.time for f in result.fills) == candles[3].time


def test_long_disabled_skips_long_even_with_entry_rules():
    # The switch's whole point: a populated long side that's turned OFF must not
    # trade, while the enabled short side still fires. (Distinguishes the enable
    # flag from "empty the rule group".)
    candles = _series([10] * 4)
    series = {"EMA_5": [3.0, 3.0, 3.0, 3.0], "EMA_9": [2.0, 2.0, 2.0, 2.0]}
    entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "gt", _ind("EMA", 9))])  # always true
    strat = RuleStrategy(
        entry, RuleGroup("AND", []), entry, RuleGroup("AND", []),
        series, quantity=1.0, long_enabled=False, short_enabled=True,
    )
    result = BacktestEngine(strat).run(candles)
    assert not any(f.leg == "long" for f in result.fills)  # long never even opened
    assert any(f.leg == "short" for f in result.fills)  # short still fired


def test_entry_price_operand_exits_when_close_dips_below_entry():
    # Always-true entry -> BUY at i=0 fills at i=1's open = 10 (the entry price).
    # Exit rule `close < entryPrice` fires the first bar close drops below 10.
    candles = _series([10, 10, 9, 9])
    exit_ = RuleGroup("AND", [Rule(_price("close"), "lt", _entry())])
    strat = RuleStrategy(
        _always_entry(), exit_, RuleGroup("AND", []), RuleGroup("AND", []),
        {}, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert len(result.trades) == 1
    tr = result.trades[0]
    assert tr.entry_price == 10.0
    assert tr.exit_price == 9.0  # close<entry at i=2 -> SELL fills at i=3's open
    assert "entryPrice" in tr.reason_out


def test_count_is_cumulative_fires_on_nth_non_consecutive_close():
    # Entry price 10. `close < entryPrice` with count=3 must ignore the 1st and
    # 2nd dips (non-consecutive) and fire only on the 3rd below-entry close.
    #   i: 1   2   3    4   5    6   7
    #   c: 10  9   11   9   11   9   9
    #      hold t1  --   t2  --   t3(fire)
    candles = _series([10, 10, 9, 11, 9, 11, 9, 9])
    exit_ = RuleGroup("AND", [Rule(_price("close"), "lt", _entry(), count=3)])
    strat = RuleStrategy(
        _always_entry(), exit_, RuleGroup("AND", []), RuleGroup("AND", []),
        {}, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert len(result.trades) == 1
    # 3rd below-entry close is at i=6 -> SELL fills at i=7's open = 9.
    assert result.trades[0].exit_time == candles[7].time
    assert result.trades[0].exit_price == 9.0


def test_count_without_modifier_fires_on_first_occurrence():
    # Same shape as above but no count -> exits on the FIRST dip below entry (i=2).
    candles = _series([10, 10, 9, 11, 9, 11, 9, 9])
    exit_ = RuleGroup("AND", [Rule(_price("close"), "lt", _entry())])
    strat = RuleStrategy(
        _always_entry(), exit_, RuleGroup("AND", []), RuleGroup("AND", []),
        {}, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert result.trades[0].exit_time == candles[3].time  # dip at i=2 fills i=3


def test_crosses_operator_either_direction_with_count():
    # Entry price 10. `close crosses entryPrice` count=2: 1st cross is a down-cross
    # (i=2), 2nd is an up-cross (i=3) -> fires at i=3, fills at i=4's open = 11.
    candles = _series([10, 10, 9, 11, 11])
    exit_ = RuleGroup("AND", [Rule(_price("close"), "crosses", _entry(), count=2)])
    strat = RuleStrategy(
        _always_entry(), exit_, RuleGroup("AND", []), RuleGroup("AND", []),
        {}, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert len(result.trades) == 1
    assert result.trades[0].exit_time == candles[4].time


def test_count_resets_across_positions():
    # Two round-trips, each exited by count=2. If the tally leaked across
    # positions, the 2nd trade would exit one bar early. Entry always true.
    #  i:  1   2   3    4    5    6    7    8
    #  c:  10  9   9    12   12   11   11   11
    #  pos1 hold t1  t2(fire@i3->fill i4=12)
    #                    re-enter@12(fill i5) hold t1  t2(fire@i7->fill i8=11)
    candles = _series([10, 10, 9, 9, 12, 12, 11, 11, 11])
    exit_ = RuleGroup("AND", [Rule(_price("close"), "lt", _entry(), count=2)])
    strat = RuleStrategy(
        _always_entry(), exit_, RuleGroup("AND", []), RuleGroup("AND", []),
        {}, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert len(result.trades) == 2
    assert result.trades[0].exit_time == candles[4].time
    assert result.trades[1].entry_price == 12.0
    assert result.trades[1].exit_time == candles[8].time  # NOT candles[7]


def test_short_entry_price_operand_and_count():
    # Short mirror: enter short at 10, `close > entryPrice` count=2 fires on the
    # 2nd close above 10.  c: 10 11 9 11 11 -> aboves at i=2 (t1) and i=4 (t2)...
    # use i:1..: 10(hold) 11(t1) 9 11(t2 fire@i4->fill i5)
    candles = _series([10, 10, 11, 9, 11, 11])
    exit_ = RuleGroup("AND", [Rule(_price("close"), "gt", _entry(), count=2)])
    strat = RuleStrategy(
        RuleGroup("AND", []), RuleGroup("AND", []), _always_entry(), exit_,
        {}, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert len(result.trades) == 1
    assert result.trades[0].leg == "short"
    assert result.trades[0].exit_time == candles[5].time


def test_short_disabled_skips_short_even_with_entry_rules():
    candles = _series([10] * 4)
    series = {"EMA_5": [3.0, 3.0, 3.0, 3.0], "EMA_9": [2.0, 2.0, 2.0, 2.0]}
    entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "gt", _ind("EMA", 9))])  # always true
    strat = RuleStrategy(
        entry, RuleGroup("AND", []), entry, RuleGroup("AND", []),
        series, quantity=1.0, long_enabled=True, short_enabled=False,
    )
    result = BacktestEngine(strat).run(candles)
    assert not any(f.leg == "short" for f in result.fills)  # short never even opened
    assert any(f.leg == "long" for f in result.fills)  # long still fired
