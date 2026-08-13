"""Engine guarantees the baseline feature rests on: `1==1` parses, enters on
the first tradeable bar (no indicator warmup), and a Hold-shaped request
(no exits, no risk, no mask) opens exactly one position per side and carries
it to the end of the window."""
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.api.baselines import hold_request, null_request
from auto_trader.api.schemas import ExprBacktestRequest

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c,
             "volume": 100.0} for k, c in enumerate(closes)]


def _req(**over):
    d = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": _candles([100 + i for i in range(30)]),  # steady rise
        "longEntry": [{"expr": "EMA(3) x> EMA(5)"}],
        "longExit": [], "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": False,
        "longRisk": None, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0, "mask": None,
    }
    d.update(over)
    return ExprBacktestRequest.model_validate(d)


def _post(model: ExprBacktestRequest):
    r = client.post("/api/expr/backtest",
                    json=model.model_dump(mode="json", exclude_none=True))
    assert r.status_code == 200, r.text
    return r.json()


def test_always_true_hold_opens_once_and_holds_to_end():
    body = _post(hold_request(_req()))
    trades = body["trades"]
    assert len(trades) == 1  # one entry, force-closed at range end
    # Signal after bar 0 closes, fills at bar 1's open (t=3600); the earliest
    # any strategy can fill, so no warmup.
    assert trades[0]["entry_time"] == 3600
    # Position held to the last bar of the window.
    assert trades[0]["exit_time"] == 3600 * 29
    assert trades[0]["reason"] == "range end"
    # Rising market, long hold: profitable.
    assert body["summary"]["net_pnl"] > 0


def test_always_true_null_keeps_brackets():
    req = _req(longRisk={"stop": {"kind": "pct", "value": 1.0},
                         "target": {"kind": "pct", "value": 1.0}})
    body = _post(null_request(req))
    # With 1% brackets on a steady rise, the run re-enters repeatedly:
    # strictly more trades than the single hold position.
    assert len(body["trades"]) > 1


def test_always_true_short_side():
    body = _post(hold_request(_req(longEnabled=False, shortEnabled=True,
                                   shortEntry=[{"expr": "EMA(3) x< EMA(5)"}])))
    trades = body["trades"]
    assert len(trades) == 1
    assert trades[0]["side"] == "sell"
    assert trades[0]["entry_time"] == 3600
    assert trades[0]["exit_time"] == 3600 * 29
    assert trades[0]["reason"] == "range end"


def test_always_true_both_sides():
    body = _post(hold_request(_req(longEnabled=True, shortEnabled=True,
                                   shortEntry=[{"expr": "EMA(3) x< EMA(5)"}])))
    trades = body["trades"]
    assert len(trades) == 2
    # One position per leg: long and short.
    legs = sorted([t["leg"] for t in trades])
    assert legs == ["long", "short"]
