"""POST /api/backtest baselines: null/hold companion runs for CODED single runs.

The coded request is converted to an expr request (expr_request_from_structured),
then null_request/hold_request synthesize the two variants and compiled_run
executes them. A baseline never fails the run: on error its slot stays None.
Fixtures mirror tests/test_api_backtest_coded.py (same client, same
STRATEGIES_DIR monkeypatch, same candle/request builders).
"""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app
from auto_trader.api.schemas import BacktestRequest

client = TestClient(app)

# Enters on every 10th bar while flat, exits 3 bars later — the coded route
# test's strategy, which is known to trade on make_candles().
STRAT = '''"""Test strat."""
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) % 10 == 0:
        return [ctx.buy(reason="in")]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    return []
'''


# Alternates short and long entries (n=10 short, n=20 long, ...), exits 3 bars
# later -- trades BOTH legs, so the per-side baselines must split.
BOTH = '''"""Trades both legs."""
def on_bar(ctx):
    n = len(ctx.closes)
    if ctx.position.is_flat and n % 10 == 0:
        if (n // 10) % 2 == 0:
            return [ctx.buy(reason="in")]
        return [ctx.sell(reason="in")]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    if ctx.position.is_short and ctx.bars_since_entry >= 3:
        return [ctx.close_short(reason="out")]
    return []
'''


# Never signals: the baselines block has no traded side to derive from.
NOTRADE = '''"""Never trades."""
def on_bar(ctx):
    return []
'''


def make_candles(n=60):
    t0 = 1_700_000_000
    out = []
    px = 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append({
            "time": t0 + i * 3600, "open": px, "high": px + 1,
            "low": px - 1, "close": px + 0.3, "volume": 10,
        })
    return out


def rising_candles(n=30):
    """Closes 100..100+n-1, one steady step per bar. A 1% target keeps hitting
    on the way up, so a re-entering baseline racks up trades while a
    hold-to-the-end baseline takes exactly one."""
    t0 = 1_700_000_000
    return [{"time": t0 + i * 3600, "open": 100.0 + i, "high": 101.0 + i,
             "low": 99.0 + i, "close": 100.0 + i, "volume": 10}
            for i in range(n)]


def coded_req(candles=None, **over):
    """base_request() from the coded route test, plus an explicit shortEnabled:
    the baselines put `1==1` on every ENABLED side, so leaving the default True
    would make hold enter short as well and the trade counts stop being
    readable."""
    candles = make_candles() if candles is None else candles
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "codedStrategy": "test.py",
        "longEnabled": True, "shortEnabled": False,
    }
    req.update(over)
    return req


@pytest.fixture
def strategies(tmp_path, monkeypatch):
    (tmp_path / "test.py").write_text(STRAT)
    (tmp_path / "notrade.py").write_text(NOTRADE)
    (tmp_path / "both.py").write_text(BOTH)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def test_coded_baselines_absent_by_default(strategies):
    r = client.post("/api/backtest", json=coded_req())
    assert r.status_code == 200, r.text
    assert r.json()["baselines"] is None


def test_coded_baselines_null_and_hold(strategies):
    r = client.post("/api/backtest", json=coded_req(baselines=["null", "hold"]))
    assert r.status_code == 200, r.text
    b = r.json()["baselines"]
    for kind in ("null_long", "hold_long"):
        assert b[kind] is not None
        assert "net_pnl" in b[kind] and "return_pct" in b[kind]
    # The strategy only traded long, so no short-side baselines run.
    assert b["null_short"] is None and b["hold_short"] is None


def test_coded_baselines_only_requested_kinds(strategies):
    """Asking for one kind leaves the other's slot None (not absent)."""
    r = client.post("/api/backtest", json=coded_req(baselines=["hold"]))
    assert r.status_code == 200, r.text
    b = r.json()["baselines"]
    assert b["hold_long"] is not None
    assert b["null_long"] is None


def test_coded_baselines_diverge_under_panel_risk(strategies):
    # 1% stop/target on a steady rise: null re-enters, hold takes one trade.
    r = client.post("/api/backtest", json=coded_req(
        candles=rising_candles(30),
        baselines=["null", "hold"],
        longRisk={"stop": {"kind": "pct", "value": 1.0},
                  "target": {"kind": "pct", "value": 1.0}},
    ))
    assert r.status_code == 200, r.text
    b = r.json()["baselines"]
    assert b["hold_long"]["n_trades"] == 1
    assert b["null_long"]["n_trades"] > 1


def test_coded_reversed_baseline_mirrors_run(strategies):
    """No costs, no brackets, symmetric fills: the reversed run is the exact
    mirror of the main run — same trade count, negated pnl. This can't pass by
    accident: a reversed baseline that re-ran the strategy unflipped would
    match the main pnl, and a null/hold mislabel changes the trade count."""
    r = client.post("/api/backtest", json=coded_req(
        candles=rising_candles(30), baselines=["reversed"],
        longEnabled=True, shortEnabled=True,
    ))
    assert r.status_code == 200, r.text
    b = r.json()["baselines"]
    rev = b["reversed"]
    assert rev is not None
    assert b["null_long"] is None and b["hold_long"] is None
    main = r.json()["summary"]
    assert main["n_trades"] > 0 and main["net_pnl"] > 0
    assert rev["n_trades"] == main["n_trades"]
    assert rev["net_pnl"] == pytest.approx(-main["net_pnl"])


# --- production request shape -------------------------------------------
# The frontend hardwires longEnabled=True AND shortEnabled=True on every coded
# run (an exit-gating workaround, not a user choice), so these are the requests
# the app actually sends. The baselines must follow the sides the MAIN run
# traded, not the request's flags: a both-sides `1==1` baseline is always-in
# long AND short simultaneously, which hedges to ~0 regardless of the market.


def test_hold_baseline_rides_the_market_at_production_side_flags(strategies):
    """Long-only strategy, both flags true: hold must be one long trade that
    profits on rising candles, not a hedged long+short pair worth ~nothing."""
    r = client.post("/api/backtest", json=coded_req(
        candles=rising_candles(30), baselines=["hold"],
        longEnabled=True, shortEnabled=True,
    ))
    assert r.status_code == 200, r.text
    hold = r.json()["baselines"]["hold_long"]
    assert hold["n_trades"] == 1
    assert hold["return_pct"] > 0
    assert r.json()["baselines"]["hold_short"] is None


def test_null_baseline_not_hedged_at_production_side_flags(strategies):
    """Null at both flags true must also trade the strategy's side only. With
    no costs on a steady rise, an always-in long is profitable; an always-in
    long+short pair is ~0."""
    r = client.post("/api/backtest", json=coded_req(
        candles=rising_candles(30), baselines=["null"],
        longEnabled=True, shortEnabled=True,
        longRisk={"stop": {"kind": "pct", "value": 1.0},
                  "target": {"kind": "pct", "value": 1.0}},
    ))
    assert r.status_code == 200, r.text
    null = r.json()["baselines"]["null_long"]
    assert null["n_trades"] >= 1
    assert null["return_pct"] > 0


def test_no_trades_skips_baseline_synthesis(strategies):
    """A strategy that never signals has no traded side to copy, and a
    both-sides baseline would be meaningless — so both kinds stay None."""
    r = client.post("/api/backtest", json=coded_req(
        candles=rising_candles(30), baselines=["null", "hold"],
        codedStrategy="notrade.py", longEnabled=True, shortEnabled=True,
    ))
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["n_trades"] == 0
    assert r.json()["baselines"] == {"null_long": None, "null_short": None, "hold_long": None, "hold_short": None, "reversed": None, "oracle_entries": None}


def test_rules_mode_structured_request_accepts_baselines_field():
    """A request without codedStrategy accepts the field; the handler's
    coded-only guard is what keeps the response block None for it.

    Asserted on the model rather than over HTTP because POST /api/backtest has
    no rules mode left: it calls loader.load_strategy(req.codedStrategy)
    unconditionally, which raises on None long before any baseline code runs.
    """
    req = BacktestRequest(**coded_req(codedStrategy=None, baselines=["null", "hold"]))
    assert req.codedStrategy is None
    assert req.baselines == ["null", "hold"]


def test_baseline_failure_leaves_kind_none(strategies, monkeypatch):
    """A baseline never fails the run: the main response still comes back 200
    with that kind's slot None."""
    import auto_trader.api.expr_exec as expr_exec

    async def boom(r, **kw):
        raise RuntimeError("baseline kaboom")

    monkeypatch.setattr(expr_exec, "compiled_run", boom)
    r = client.post("/api/backtest", json=coded_req(baselines=["null", "hold"]))
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["n_trades"] >= 1
    assert r.json()["baselines"] == {"null_long": None, "null_short": None, "hold_long": None, "hold_short": None, "reversed": None, "oracle_entries": None}


def test_both_sides_strategy_gets_per_side_holds(strategies):
    """A strategy that traded both legs must NOT get a hedged both-sides hold
    (that is always exactly minus the round-trip costs). Each side rides the
    market alone: on rising candles the long hold profits, the short one
    mirrors it into a loss."""
    r = client.post("/api/backtest", json=coded_req(
        candles=rising_candles(40), codedStrategy="both.py",
        baselines=["null", "hold"], longEnabled=True, shortEnabled=True,
    ))
    assert r.status_code == 200, r.text
    legs = {t["leg"] for t in r.json()["trades"]}
    assert legs == {"long", "short"}, "fixture must trade both legs"
    b = r.json()["baselines"]
    for k in ("null_long", "null_short", "hold_long", "hold_short"):
        assert b[k] is not None, k
    assert b["hold_long"]["n_trades"] == 1 and b["hold_short"]["n_trades"] == 1
    assert b["hold_long"]["net_pnl"] > 0 > b["hold_short"]["net_pnl"]
    # No costs in this fixture: the two sides mirror exactly, so a hedged
    # both-sides run would have summed to ~0 -- the split must not.
    assert b["hold_long"]["net_pnl"] == pytest.approx(-b["hold_short"]["net_pnl"])
