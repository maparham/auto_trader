"""POST /api/expr/backtest with baselines=["null","hold"]: the response embeds
each baseline's full metrics dict; omitting the field keeps the response
unchanged (None)."""
from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c,
             "volume": 100.0} for k, c in enumerate(closes)]


def _base_req(**over):
    req = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": _candles([100 + i for i in range(30)]),
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
    req.update(over)
    return req


def test_baselines_absent_by_default():
    r = client.post("/api/expr/backtest", json=_base_req())
    assert r.status_code == 200
    assert r.json()["baselines"] is None


def test_baselines_null_and_hold_returned():
    r = client.post("/api/expr/backtest",
                    json=_base_req(baselines=["null", "hold"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    for kind in ("null", "hold"):
        m = b[kind]
        assert m is not None
        assert "net_pnl" in m and "return_pct" in m and "sharpe" in m
    # Rising market: the hold baseline is profitable.
    assert b["hold"]["net_pnl"] > 0


def test_baselines_null_only():
    r = client.post("/api/expr/backtest", json=_base_req(baselines=["null"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    assert b["null"] is not None and b["hold"] is None


def test_null_and_hold_diverge_under_risk():
    """The two baselines must not be interchangeable. With a real bracket on the
    request, `null` keeps the risk config (so it exits at the target and
    RE-ENTERS on the next bar, many trades) while `hold` strips risk entirely
    (one entry carried to the window end, exactly 1 trade). Without this the
    suite would pass with the null/hold dispatch swapped, even though Task 8
    labels the two differently in the UI."""
    risk = {"stop": {"kind": "pct", "value": 1.0},
            "target": {"kind": "pct", "value": 1.0}}
    r = client.post("/api/expr/backtest",
                    json=_base_req(longRisk=risk, baselines=["null", "hold"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    assert b["hold"]["n_trades"] == 1
    assert b["null"]["n_trades"] > 1
    assert b["null"] != b["hold"]
