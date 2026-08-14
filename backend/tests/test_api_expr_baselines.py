"""POST /api/expr/backtest with baselines: the response embeds each baseline's
full metrics dict, null and hold split PER SIDE (a both-sides always-in run is
a hedge worth exactly minus the costs, so each enabled side runs alone);
omitting the field keeps the response unchanged (None)."""
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
    for kind in ("null_long", "hold_long"):
        m = b[kind]
        assert m is not None
        assert "net_pnl" in m and "return_pct" in m and "sharpe" in m
    # The request is long-only, so no short-side baselines run.
    assert b["null_short"] is None and b["hold_short"] is None
    # Rising market: the long hold baseline is profitable.
    assert b["hold_long"]["net_pnl"] > 0


def test_baselines_split_per_side_when_both_enabled():
    """Both sides enabled: null and hold each run once per side, so the hold
    rows show the actual market both ways instead of a hedged ~zero. Rising
    market: long hold profits, short hold loses about the mirror amount."""
    r = client.post("/api/expr/backtest", json=_base_req(
        shortEnabled=True, baselines=["null", "hold"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    for k in ("null_long", "null_short", "hold_long", "hold_short"):
        assert b[k] is not None, k
    assert b["hold_long"]["net_pnl"] > 0 > b["hold_short"]["net_pnl"]
    assert b["hold_long"]["n_trades"] == 1 and b["hold_short"]["n_trades"] == 1


def test_baselines_null_only():
    r = client.post("/api/expr/backtest", json=_base_req(baselines=["null"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    assert b["null_long"] is not None
    assert b["hold_long"] is None and b["hold_short"] is None


def test_reversed_baseline_mirrors_the_run():
    """Long-only strategy in a steadily rising market: the real run makes
    money going long; the reversed baseline takes the same decisions short
    and loses. If reversal were a no-op the two would match."""
    r = client.post("/api/expr/backtest",
                    json=_base_req(baselines=["reversed"]))
    assert r.status_code == 200
    b = r.json()["baselines"]
    m = b["reversed"]
    assert m is not None
    assert "net_pnl" in m and "return_pct" in m and "sharpe" in m
    assert b["null_long"] is None and b["hold_long"] is None
    main_net = r.json()["summary"]["net_pnl"]
    assert main_net > 0 and m["net_pnl"] < 0


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
    assert b["hold_long"]["n_trades"] == 1
    assert b["null_long"]["n_trades"] > 1
    assert b["null_long"] != b["hold_long"]
