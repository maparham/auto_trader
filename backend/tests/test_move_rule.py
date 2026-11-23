from auto_trader.core.move_rule import validate_action, target_level, decide, headline, action_sig
import pytest

def test_validate_ok_price_and_breakeven():
    validate_action({"account": "capital:demo", "dealId": "D1", "field": "sl", "target": {"type": "price", "value": 1.1}})
    validate_action({"account": "capital:demo", "dealId": "D1", "field": "tp", "target": {"type": "breakeven", "offset": 0}})

@pytest.mark.parametrize("bad", [
    {"account": "", "dealId": "D1", "field": "sl", "target": {"type": "price", "value": 1.1}},
    {"account": "a:b", "dealId": "D1", "field": "x", "target": {"type": "price", "value": 1.1}},
    {"account": "a:b", "dealId": "D1", "field": "sl", "target": {"type": "price", "value": "1.1"}},
    {"account": "a:b", "dealId": "D1", "field": "sl", "target": {"type": "breakeven", "offset": -1}},
    {"account": "a:b", "dealId": "D1", "field": "sl", "target": {"type": "other"}},
])
def test_validate_rejects(bad):
    with pytest.raises(ValueError):
        validate_action(bad)

def test_target_level():
    assert target_level({"type": "price", "value": 1.2}, "BUY", 1.0) == 1.2
    assert target_level({"type": "breakeven", "offset": 0.001}, "BUY", 1.0) == pytest.approx(1.001)
    assert target_level({"type": "breakeven", "offset": 0.001}, "SELL", 1.0) == pytest.approx(0.999)

@pytest.mark.parametrize("field,direction,current,target,want", [
    ("sl", "BUY", 0.95, 1.00, "move"), ("sl", "BUY", 1.00, 1.00, "skip"), ("sl", "BUY", 1.01, 1.00, "skip"),
    ("sl", "SELL", 1.05, 1.00, "move"), ("sl", "SELL", 0.99, 1.00, "skip"),
    ("tp", "BUY", 1.10, 1.05, "move"), ("tp", "BUY", 1.04, 1.05, "skip"),
    ("tp", "SELL", 0.90, 0.95, "move"), ("tp", "SELL", 0.96, 0.95, "skip"),
    ("sl", "BUY", None, 1.00, "move"), ("tp", "SELL", None, 0.95, "move"),
])
def test_decide(field, direction, current, target, want):
    assert decide(field, direction, current, target) == want

def test_headlines_have_no_em_dash():
    a = headline("moved", "EURUSD", "BUY", "sl", new=1.1, old=1.05, precision=4)
    b = headline("skipped", "EURUSD", "SELL", "tp", new=1.1, old=1.0, precision=4)
    c = headline("failed", "EURUSD", "BUY", "sl", new=1.1, old=None, reason="level too close", precision=4)
    assert a == "Moved SL of EURUSD long to 1.1000 (was 1.0500)"
    assert b == "TP of EURUSD short already at 1.0000, not moved to 1.1000"
    assert c == "Could not move SL of EURUSD long to 1.1000: level too close"
    assert headline("moved", "X", "BUY", "tp", new=2.0, old=None, precision=1) == "Moved TP of X long to 2.0 (was none)"
    for s in (a, b, c):
        assert "—" not in s and "--" not in s

def test_action_sig_ignores_target():
    a = {"account": "a:b", "dealId": "D", "field": "sl", "target": {"type": "price", "value": 1}}
    assert action_sig(a) == action_sig({**a, "target": {"type": "breakeven", "offset": 0}})
