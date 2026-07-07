"""Signal-candle 'why this trade fired' terms: the engine keeps the exact operand
values it compared for each passing rule, stamped onto the Fill along with the
signal bar's time. Backend-authoritative — no frontend recompute."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import RuleTerm, Side
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
from auto_trader.strategy.rule import Operand, Rule, RuleGroup, RuleStrategy


def _series(closes: list[float]):
    from auto_trader.core.models import Candle

    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [Candle(t0 + timedelta(minutes=i), c, c, c, c, 0.0) for i, c in enumerate(closes)]


def _ind(name: str, length: int | None = None) -> Operand:
    return Operand(kind="indicator", indicator=name, length=length)


def _price(field: str) -> Operand:
    return Operand(kind="price", field=field)


def _const(v: float) -> Operand:
    return Operand(kind="const", value=v)


def _empty() -> RuleGroup:
    return RuleGroup("AND", [])


def test_entry_fill_carries_terms_and_signal_time():
    # EMA(2) sits above open only at bar 1 → the signal fires on bar 1 and fills
    # at bar 2's open. The Fill must carry the exact values compared as-of bar 1.
    candles = _series([100, 101, 102, 103])
    series = {"EMA_2": [50.0, 200.0, 60.0, 60.0]}
    entry = RuleGroup("AND", [Rule(_ind("EMA", 2), "gt", _price("open"))])
    strat = RuleStrategy(entry, _empty(), _empty(), _empty(), series, quantity=1.0, base_timeframe="MINUTE_15")
    result = BacktestEngine(strat, series=series).run(candles)

    entry_fill = result.fills[0]
    assert entry_fill.side is Side.BUY
    assert entry_fill.signal_time == candles[1].time
    assert entry_fill.combine == "AND"
    assert entry_fill.terms == (
        RuleTerm(
            left_label="EMA(2)",
            left_val=200.0,
            op="gt",
            right_label="open",
            right_val=101.0,
            left_tf="MINUTE_15",
            right_tf=None,
        ),
    )


def test_mechanical_exit_has_no_terms():
    # A target-hit exit fires intrabar with no rule signal — its Fill must carry
    # empty terms and no signal_time (the TP marker already explains it).
    candles = _series([100, 200, 100])
    series = {"EMA_1": [200.0, 200.0, 200.0]}  # always above open → entry every bar
    entry = RuleGroup("AND", [Rule(_ind("EMA", 1), "gt", _price("open"))])
    risk = RiskConfig(StopSpec("none"), TargetSpec("pct", value=1.0))  # +1% target
    strat = RuleStrategy(entry, _empty(), _empty(), _empty(), series, quantity=1.0, base_timeframe="MINUTE")
    result = BacktestEngine(strat, series=series, long_risk=risk).run(candles)

    exits = [f for f in result.fills if f.side is Side.SELL]
    assert exits, "expected a target exit"
    for f in exits:
        assert f.terms == ()
        assert f.signal_time is None
        assert f.combine is None


def test_or_group_only_passing_rule_terms():
    # OR entry with one passing and one failing rule → only the passing rule's
    # term is captured.
    candles = _series([100, 101, 102, 103])
    series = {"EMA_2": [50.0, 200.0, 60.0, 60.0], "EMA_3": [10.0, 10.0, 10.0, 10.0]}
    entry = RuleGroup(
        "OR",
        [
            Rule(_ind("EMA", 2), "gt", _price("open")),  # passes at bar 1
            Rule(_ind("EMA", 3), "gt", _price("open")),  # never passes
        ],
    )
    strat = RuleStrategy(entry, _empty(), _empty(), _empty(), series, quantity=1.0, base_timeframe="MINUTE")
    result = BacktestEngine(strat, series=series).run(candles)

    entry_fill = result.fills[0]
    assert entry_fill.combine == "OR"
    assert [t.left_label for t in entry_fill.terms] == ["EMA(2)"]


def test_counted_exit_term_reflects_firing_bar():
    # Exit fires on the 2nd bar since entry where close > entryPrice. The captured
    # term must hold the values at the FIRING bar, not an earlier occurrence.
    # Entry fills bar 1 @ open 100. Occurrences of close>100: bar 2 (105, 1st),
    # bar 3 (110, 2nd → fires) → exit fills bar 4 @ open 110.
    candles = _series([100, 100, 105, 110, 110])
    series = {"EMA_1": [999.0] * 5}  # always above open → entry every bar
    entry = RuleGroup("AND", [Rule(_ind("EMA", 1), "gt", _price("open"))])
    exit_grp = RuleGroup("AND", [Rule(_price("close"), "gt", Operand(kind="entry"), count=2)])
    strat = RuleStrategy(entry, exit_grp, _empty(), _empty(), series, quantity=1.0, base_timeframe="MINUTE")
    result = BacktestEngine(strat, series=series).run(candles)

    exit_fill = next(f for f in result.fills if f.side is Side.SELL and f.terms)
    term = exit_fill.terms[0]
    assert term.left_label == "close"
    assert term.right_label == "entryPrice"
    assert term.left_val == 110.0  # close at the firing bar (bar 3), not bar 2's 105
    assert term.right_val == 100.0  # entryPrice
