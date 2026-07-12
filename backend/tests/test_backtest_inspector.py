"""Bar rule inspector: per-bar trace of all rule groups + engine gate outcomes."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.schedule import RecurrenceMask
from auto_trader.strategy.base import Context
from auto_trader.strategy.rule import Operand, Rule, RuleGroup, RuleStrategy


def _candles(n: int) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [Candle(t0 + timedelta(minutes=i), 100, 100, 100, 100, 0.0) for i in range(n)]


def _ind(name: str, length: int) -> Operand:
    return Operand(kind="indicator", indicator=name, length=length)


def _const(v: float) -> Operand:
    return Operand(kind="const", value=v)


def _ctx(candles: list[Candle], up_to: int) -> Context:
    ctx = Context()
    ctx.history = candles[: up_to + 1]
    return ctx


def test_inspect_groups_captures_all_terms_with_pass_fail():
    candles = _candles(3)
    long_entry = RuleGroup(
        "AND",
        [Rule(_ind("EMA", 9), "gt", _const(10)), Rule(_ind("EMA", 21), "gt", _const(100))],
    )
    strat = RuleStrategy(
        long_entry, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []),
        {"EMA_9": [0, 0, 15.0], "EMA_21": [0, 0, 50.0]}, 1,
        base_timeframe="MINUTE",
    )
    groups = strat.inspect_groups(_ctx(candles, 2), 2)

    assert tuple(g.group for g in groups) == ("longEntry", "shortEntry", "longExit", "shortExit")
    le = groups[0]
    assert le.combine == "AND"
    assert le.passed is False  # 15>10 True, 50>100 False -> AND False
    assert len(le.terms) == 2
    assert le.terms[0].passed is True and le.terms[0].left_val == 15.0
    assert le.terms[1].passed is False and le.terms[1].left_val == 50.0
    # empty groups still present, no terms
    assert groups[1].terms == () and groups[1].passed is False


def test_inspect_groups_or_rollup():
    candles = _candles(2)
    grp = RuleGroup(
        "OR",
        [Rule(_ind("EMA", 9), "gt", _const(10)), Rule(_ind("EMA", 21), "gt", _const(100))],
    )
    strat = RuleStrategy(
        grp, RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []),
        {"EMA_9": [0, 15.0], "EMA_21": [0, 50.0]}, 1,
        base_timeframe="MINUTE",
    )
    groups = strat.inspect_groups(_ctx(candles, 1), 1)
    assert groups[0].passed is True  # one term true under OR


def _always_long_strat() -> RuleStrategy:
    # longEntry always true; no exit -> opens once, then holds forever.
    return RuleStrategy(
        RuleGroup("AND", [Rule(_const(1), "gt", _const(0))]),
        RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []),
        {}, 1, base_timeframe="MINUTE",
    )


def test_engine_trace_off_by_default():
    result = BacktestEngine(_always_long_strat()).run(_candles(4))
    assert result.bar_traces == []


def test_engine_trace_opened_then_suppressed_already_in_position():
    candles = _candles(5)
    result = BacktestEngine(_always_long_strat(), inspect=True).run(candles)
    traces = {t.bar_index: t for t in result.bar_traces}

    # bar 0 signal fills at bar 1 open -> the opening fill's signal_time is bar 0.
    assert traces[0].action == "opened"
    # bar 1 onward: position is held, entry still true -> suppressed.
    assert traces[1].action == "suppressed"
    assert traces[1].reason == "already in position"
    assert traces[1].in_position_long is True


def test_engine_trace_masked_bar_reason():
    candles = _candles(4)  # 2024-01-01 is a Monday (JS weekday 1)
    mask = RecurrenceMask(enabled=True, days_of_week=(0,))  # Sundays only -> never active
    result = BacktestEngine(_always_long_strat(), inspect=True, mask=mask).run(candles)
    traces = {t.bar_index: t for t in result.bar_traces}
    # entry rule passes but the window is inactive -> suppressed for that reason.
    assert traces[0].action == "suppressed"
    assert traces[0].reason == "outside session window"
    assert traces[0].window_active is False


def _price_gt_strat(threshold: float, *, long_enabled: bool = True) -> RuleStrategy:
    return RuleStrategy(
        RuleGroup("AND", [Rule(Operand(kind="price", field="close"), "gt", _const(threshold))]),
        RuleGroup("AND", []), RuleGroup("AND", []), RuleGroup("AND", []),
        {}, 1, base_timeframe="MINUTE", long_enabled=long_enabled,
    )


def test_engine_trace_last_bar_passing_entry_is_none_not_masked():
    # Entry true ONLY on the last bar, flat throughout, NO mask. The last bar never
    # calls on_bar (no next-open to fill), so no signal is emitted -> action "none",
    # NOT a bogus "outside session window" (regression: reason was inferred from
    # group.passed instead of an emitted signal).
    candles = [
        Candle(datetime(2024, 1, 1, tzinfo=timezone.utc), 10, 10, 10, 10, 0.0),
        Candle(datetime(2024, 1, 1, 0, 1, tzinfo=timezone.utc), 10, 10, 10, 10, 0.0),
        Candle(datetime(2024, 1, 1, 0, 2, tzinfo=timezone.utc), 20, 20, 20, 20, 0.0),
    ]
    result = BacktestEngine(_price_gt_strat(15), inspect=True).run(candles)
    traces = {t.bar_index: t for t in result.bar_traces}
    assert traces[2].groups[0].passed is True  # long entry evaluates true here
    assert traces[2].action == "none"
    assert traces[2].reason is None


def test_engine_trace_disabled_side_passing_entry_is_none():
    # Long side parked (long_enabled=False) but its rule is true — no signal is
    # emitted, so the bar must not be mislabelled suppressed/already-in-position.
    result = BacktestEngine(_price_gt_strat(5, long_enabled=False), inspect=True).run(_candles(4))
    traces = {t.bar_index: t for t in result.bar_traces}
    assert traces[0].groups[0].passed is True
    assert traces[0].action == "none"
