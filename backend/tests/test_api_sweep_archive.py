"""Sweep archive endpoints: roundtrip, summaries, cap, delete."""
from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)


def rec(name="s1", net=100.0):
    return {
        "epic": "EURUSD", "timeframe": "MINUTE_15", "name": name,
        "axes": [{"kind": "range", "target": "param:p", "label": "p",
                  "from": 1, "to": 5, "step": 1}],
        "rows": [{"combo": {"param:p": 1}, "metrics": {"net_pnl": net, "n_trades": 3},
                  "windows": None, "error": None}],
        "windows": None,
    }


def test_roundtrip_and_summary(tmp_path, monkeypatch):
    import auto_trader.api.routers.backtest as bt
    from auto_trader.core.sweep_store import SweepStore
    monkeypatch.setattr(bt, "SWEEP_STORE", SweepStore(str(tmp_path / "s.db")))

    rid = client.post("/api/backtest/sweeps", json=rec()).json()["id"]
    listed = client.get("/api/backtest/sweeps").json()
    assert listed[0]["id"] == rid
    assert listed[0]["n_rows"] == 1 and listed[0]["best_net_pnl"] == 100.0

    full = client.get(f"/api/backtest/sweeps/{rid}").json()
    assert full["axes"][0]["target"] == "param:p"
    assert full["rows"][0]["metrics"]["net_pnl"] == 100.0

    assert client.delete(f"/api/backtest/sweeps/{rid}").json() == {"ok": True}
    assert client.get(f"/api/backtest/sweeps/{rid}").status_code == 404


def test_corrupt_row_is_skipped_not_500(tmp_path, monkeypatch):
    import sqlite3

    import auto_trader.api.routers.backtest as bt
    from auto_trader.core.sweep_store import SweepStore

    db = str(tmp_path / "s.db")
    monkeypatch.setattr(bt, "SWEEP_STORE", SweepStore(db))

    good = client.post("/api/backtest/sweeps", json=rec(name="good")).json()["id"]
    bad = client.post("/api/backtest/sweeps", json=rec(name="bad")).json()["id"]

    conn = sqlite3.connect(db)
    conn.execute("UPDATE sweeps SET rows_json='{broken' WHERE id=?", (bad,))
    conn.commit()
    conn.close()

    resp = client.get("/api/backtest/sweeps")
    assert resp.status_code == 200
    listed = resp.json()
    assert len(listed) == 1 and listed[0]["id"] == good


def test_negative_limit_is_clamped(tmp_path, monkeypatch):
    import auto_trader.api.routers.backtest as bt
    from auto_trader.core.sweep_store import SweepStore

    monkeypatch.setattr(bt, "SWEEP_STORE", SweepStore(str(tmp_path / "s.db"), cap=2))
    for i in range(3):
        client.post("/api/backtest/sweeps", json=rec(name=f"s{i}"))
    # -1 clamps to LIMIT 0 (max(0, min(-1, cap))) so it returns nothing — never
    # SQLite's unbounded LIMIT -1. The store never holds more than `cap` rows, so
    # this empty result is the only observable proof the clamp is in force.
    listed = client.get("/api/backtest/sweeps?limit=-1").json()
    assert listed == []


def test_cap_prunes_oldest(tmp_path, monkeypatch):
    import auto_trader.api.routers.backtest as bt
    from auto_trader.core.sweep_store import SweepStore
    monkeypatch.setattr(bt, "SWEEP_STORE", SweepStore(str(tmp_path / "s.db"), cap=2))
    ids = [client.post("/api/backtest/sweeps", json=rec(name=f"s{i}")).json()["id"]
           for i in range(3)]
    listed = client.get("/api/backtest/sweeps").json()
    assert len(listed) == 2 and ids[0] not in [r["id"] for r in listed]
