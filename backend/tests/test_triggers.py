"""Pure trigger + level-validation logic (no broker, no I/O)."""

from __future__ import annotations

from auto_trader.brokers.paper_exec import evaluate_triggers, validate_levels
from auto_trader.core.models import Position, Side, WorkingOrder


def _pos(side: Side, stop=None, tp=None, deal_id="D1") -> Position:
    return Position(
        epic="E", side=side, quantity=1, open_level=100.0, deal_id=deal_id,
        stop_level=stop, take_profit_level=tp,
    )


def _wo(side: Side, level: float, order_id="W1") -> WorkingOrder:
    return WorkingOrder(epic="E", side=side, quantity=1, limit_level=level, order_id=order_id)


# --- limit fills ---

def test_buy_limit_fills_when_price_drops_to_level() -> None:
    wo = _wo(Side.BUY, 99.0)
    assert evaluate_triggers(99.5, [], [wo]) == []  # above the limit, no fill
    [a] = evaluate_triggers(99.0, [], [wo])
    assert a.kind == "fill" and a.id == "W1" and a.price == 99.0 and a.reason == "limit"


def test_sell_limit_fills_when_price_rises_to_level() -> None:
    wo = _wo(Side.SELL, 101.0)
    assert evaluate_triggers(100.5, [], [wo]) == []
    [a] = evaluate_triggers(101.0, [], [wo])
    assert a.kind == "fill" and a.price == 101.0


def test_limit_fills_at_better_price_when_market_gaps_through() -> None:
    # Buy limit at 99 but the tick gapped down to 98.5 → fill at 98.5 (better),
    # never worse than the limit.
    [a] = evaluate_triggers(98.5, [], [_wo(Side.BUY, 99.0)])
    assert a.price == 98.5
    # Sell limit at 101 but tick gapped up to 101.5 → fill at 101.5 (better).
    [b] = evaluate_triggers(101.5, [], [_wo(Side.SELL, 101.0)])
    assert b.price == 101.5


# --- stop / take-profit ---

def test_long_stops_out_below_stop() -> None:
    [a] = evaluate_triggers(94.9, [_pos(Side.BUY, stop=95.0)], [])
    assert a.kind == "close" and a.reason == "stop" and a.price == 95.0


def test_long_takes_profit_above_tp() -> None:
    [a] = evaluate_triggers(105.1, [_pos(Side.BUY, tp=105.0)], [])
    assert a.kind == "close" and a.reason == "take_profit" and a.price == 105.0


def test_short_stops_out_above_stop() -> None:
    [a] = evaluate_triggers(105.1, [_pos(Side.SELL, stop=105.0)], [])
    assert a.reason == "stop"


def test_short_takes_profit_below_tp() -> None:
    [a] = evaluate_triggers(94.9, [_pos(Side.SELL, tp=95.0)], [])
    assert a.reason == "take_profit"


def test_no_trigger_in_band() -> None:
    pos = _pos(Side.BUY, stop=95.0, tp=105.0)
    assert evaluate_triggers(100.0, [pos], []) == []


def test_stop_wins_over_tp_when_both_cross() -> None:
    # Degenerate (shouldn't happen), but risk-first: stop takes precedence.
    # Long with stop ABOVE tp; price between them crosses both → stop wins.
    pos = _pos(Side.BUY, stop=105.0, tp=104.0)  # nonsensical band
    [a] = evaluate_triggers(104.5, [pos], [])
    assert a.reason == "stop"


# --- level validation ---

def test_validate_long_levels() -> None:
    assert validate_levels(Side.BUY, 100.0, 95.0, 105.0) is None
    assert validate_levels(Side.BUY, 100.0, 105.0, None) is not None  # stop above
    assert validate_levels(Side.BUY, 100.0, None, 95.0) is not None  # tp below


def test_validate_short_levels() -> None:
    assert validate_levels(Side.SELL, 100.0, 105.0, 95.0) is None
    assert validate_levels(Side.SELL, 100.0, 95.0, None) is not None  # stop below
    assert validate_levels(Side.SELL, 100.0, None, 105.0) is not None  # tp above


def test_validate_ignores_unset_levels() -> None:
    assert validate_levels(Side.BUY, 100.0, None, None) is None
