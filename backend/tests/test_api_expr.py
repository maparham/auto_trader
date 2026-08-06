"""API tests for the expression surface: /api/expr/backtest, /series, /literals.

The structured /api/backtest is untouched; this exercises the parallel expr
surface end to end (parse/validate -> compile -> engine run -> shared serializer).
"""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from auto_trader.api import deps
from auto_trader.api.app import app
from auto_trader.api.schemas import CandleDTO
from auto_trader.api.sweep_apply import candle_from_dto
from auto_trader.core.models import Candle

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c, "volume": 100.0}
            for k, c in enumerate(closes)]


def _base_req(**over):
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": _candles([1, 2, 3, 2, 1]),
        "htfCandles": None,
        "longEntry": [{"expr": "crossAbove(candle.close, 2)"}],
        "longExit": [{"expr": "candle.close < entry"}],
        "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": True,
        "longRisk": None, "shortRisk": None, "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0, "mask": None, "inspect": False,
    }
    req.update(over)
    return req


def test_expr_backtest_runs():
    r = client.post("/api/expr/backtest", json=_base_req())
    assert r.status_code == 200
    body = r.json()
    assert "trades" in body
    assert "equity" in body and "summary" in body and "by_leg" in body


def test_expr_backtest_parse_error_carries_span_and_location():
    r = client.post("/api/expr/backtest", json=_base_req(longEntry=[{"expr": "EMA(9) EMA(21)"}]))
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "expected_operator"
    assert d["group"] == "longEntry" and d["row"] == 0
    assert isinstance(d["start"], int) and isinstance(d["end"], int)


def test_expr_backtest_entry_in_entry_rule_rejected():
    r = client.post("/api/expr/backtest", json=_base_req(longEntry=[{"expr": "entry > candle.close"}]))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "entry_in_entry_rule"


def test_expr_backtest_disabled_row_is_skipped():
    # A disabled entry row is dropped before parse, so even garbage passes.
    r = client.post("/api/expr/backtest", json=_base_req(
        longEntry=[{"expr": "$$$ not parseable", "enabled": False}]))
    assert r.status_code == 200


def test_expr_backtest_blank_enabled_row_is_skipped():
    # An empty placeholder row (what the UI ships for an unauthored side) is not
    # a rule: it must not 422 on an empty parse. shortEntry stays blank here.
    r = client.post("/api/expr/backtest", json=_base_req(
        shortEntry=[{"expr": "", "enabled": True}],
        shortExit=[{"expr": "   ", "enabled": True}]))
    assert r.status_code == 200


def test_expr_backtest_atr_risk_rejected():
    # An ATR-kind stop has no series on the expr surface (series={}); running it
    # would yield a silent stop-less trade, so the handler 422s instead.
    atr_risk = {"stop": {"kind": "atr", "mult": 2.0, "length": 14},
                "target": {"kind": "none"}}
    r = client.post("/api/expr/backtest", json=_base_req(longRisk=atr_risk))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "atr_risk_unsupported"


def test_expr_backtest_fixed_risk_still_runs():
    # Non-ATR (points/pct) risk carries no ATR series requirement, so it runs.
    pct_risk = {"stop": {"kind": "pct", "value": 5.0}, "target": {"kind": "none"}}
    r = client.post("/api/expr/backtest", json=_base_req(longRisk=pct_risk))
    assert r.status_code == 200


# --- @tf sourcing ------------------------------------------------------------
# The expr surface must be able to run a rule pinned to a higher timeframe: the
# route fetches the referenced HTF candles itself when the request doesn't ship
# them (htfCandles stays the override so compute-only hosts never hit a broker).


def _hourly_dtos(n=80, t0=-40 * 3600):
    out, px = [], 10.0
    for i in range(n):
        px += 0.1
        out.append({"time": t0 + i * 3600, "open": px, "high": px + 0.5,
                    "low": px - 0.5, "close": px, "volume": 1.0})
    return out


def _tf_req(**over):
    # 5m base candles so @1H is genuinely a higher timeframe.
    base = [{"time": 300 * k, "open": 10 + (k % 7) * 0.1, "high": 11, "low": 9,
             "close": 10 + (k % 7) * 0.1, "volume": 1.0} for k in range(200)]
    defaults = dict(
        resolution="MINUTE_5", candles=base,
        longEntry=[{"expr": "crossAbove(EMA(3), EMA(4)@1H)"}],
        longExit=[{"expr": "candle.close < entry"}],
    )
    defaults.update(over)
    return _base_req(**defaults)


def test_expr_backtest_fetches_referenced_htf(monkeypatch):
    calls = []

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, side):
        calls.append((broker, epic, resolution, side))
        return [candle_from_dto(CandleDTO(**c)) for c in _hourly_dtos()]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    r = client.post("/api/expr/backtest", json=_tf_req(broker="mt5", priceSide="bid"))
    assert r.status_code == 200, r.text
    # Fetched once, as the CANONICAL resolution, against the request's broker/side.
    assert calls == [("mt5", "TEST", "HOUR", "bid")]


def test_expr_backtest_shipped_htf_skips_fetch(monkeypatch):
    async def boom(*a, **k):  # pragma: no cover - failing is the assertion
        raise AssertionError("must not fetch when htfCandles ships the timeframe")

    monkeypatch.setattr(deps, "_fetch_symbol_candles", boom)
    r = client.post("/api/expr/backtest",
                    json=_tf_req(htfCandles={"HOUR": _hourly_dtos()}))
    assert r.status_code == 200, r.text


def test_expr_backtest_empty_htf_is_422_not_crash(monkeypatch):
    async def empty(*a, **k):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", empty)
    r = client.post("/api/expr/backtest", json=_tf_req())
    assert r.status_code == 422
    assert "1H" in str(r.json()["detail"])


def test_expr_backtest_short_htf_is_422_not_phantom_crosses(monkeypatch):
    # A broker serving SOME hourly bars but fewer than the pin needs must fail
    # loud: an EMA(4)@1H seeded from 2 bars is a different series whose phantom
    # crosses would become trades.
    async def short(*a, **k):
        return [candle_from_dto(CandleDTO(**c)) for c in _hourly_dtos(n=2, t0=-2 * 3600)]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", short)
    r = client.post("/api/expr/backtest", json=_tf_req())
    assert r.status_code == 422
    assert "not enough history for timeframe '1H'" in str(r.json()["detail"])


def test_expr_backtest_unknown_tf_alias_is_422():
    r = client.post("/api/expr/backtest",
                    json=_tf_req(longEntry=[{"expr": "EMA(3)@BOGUS > 0"}]))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unknown_tf"


def test_expr_literals_endpoint():
    r = client.post("/api/expr/literals", json={"expr": "EMA(50) > 30"})
    assert r.status_code == 200
    body = r.json()
    assert body["error"] is None
    lits = body["literals"]
    assert [(x["ordinal"], x["value"], x["label"]) for x in lits] == [
        (0, 50.0, "EMA length"), (1, 30.0, "threshold")]
    # spans are reported for the editor underline
    assert all("start" in x and "end" in x for x in lits)


def test_expr_literals_parse_error_returns_error_body():
    r = client.post("/api/expr/literals", json={"expr": "EMA(9) EMA(21)"})
    assert r.status_code == 200
    body = r.json()
    assert body["literals"] == []
    assert body["error"]["code"] == "expected_operator"


def test_expr_series_overlay(monkeypatch):
    # /api/expr/series fetches its own candles; patch the (async) fetch helper on
    # the deps module (the router calls it module-qualified, so this reaches it).
    closes = [1.0, 2.0, 3.0, 4.0]

    async def _fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        return [
            Candle(time=datetime.fromtimestamp(3600 * k, tz=timezone.utc),
                   open=c, high=c, low=c, close=c, volume=100.0)
            for k, c in enumerate(closes)
        ]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", _fake_fetch)
    r = client.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "HOUR", "expr": "candle.close > 2",
        "fromTime": 0, "toTime": 3600 * 3,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["times"] == [0, 3600, 7200, 10800]
    assert body["values"] == closes  # left side of the comparison is candle.close
    assert isinstance(body["warmup"], int)


def test_expr_series_parse_error():
    r = client.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "HOUR", "expr": "EMA(9) EMA(21)",
        "fromTime": 0, "toTime": 3600,
    })
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "expected_operator"


def test_expr_series_bare_predicate_row_422s():
    # A bare bullish(...)/bearish(...) row is a boolean predicate with no numeric
    # series to plot — must 422, not 500 (parse() can now return N.Predicate).
    r = client.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "HOUR", "expr": "bullish(candle)",
        "fromTime": 0, "toTime": 3600,
    })
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "predicate_not_plottable"


# --- count()/bullish()/bearish()/barsSinceEntry --------------------------


def _oc_candles(bars):
    """bars: list of (open, close); high/low derived. Hourly steps."""
    return [{"time": 3600 * k, "open": o, "high": max(o, c) + 1, "low": min(o, c) - 1,
             "close": c, "volume": 100.0} for k, (o, c) in enumerate(bars)]


def test_expr_backtest_count_red_since_entry_exit():
    """Canonical spec rule: exit when a 3rd red candle since entry closes below
    the entry price. crossAbove(close, 103) fires exactly once, at bar 1
    (102 -> 104); the position fills at bar 2 open (104) -> entry bar 2. Bar 2
    is itself red (104 -> 103) but is the entry bar, so it is EXCLUDED from the
    barsSinceEntry window. Reds since entry: bars 3, 4, 5 -> the count hits 3 on
    bar 5 (close 100 < entry 104 too), exit fills at bar 6 open (100)."""
    bars = [(101, 102), (102, 104), (104, 103), (103, 102), (102, 101), (101, 100), (100, 100)]
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_oc_candles(bars),
        longEntry=[{"expr": "crossAbove(candle.close, 103)"}],
        longExit=[{"expr": "count(bearish(candle), barsSinceEntry) >= 3"},
                  {"expr": "candle.close < entry"}],
    ))
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert len(trades) == 1
    t = trades[0]
    assert t["entry_time"] == 3600 * 2 and t["entry_price"] == 104
    assert t["exit_time"] == 3600 * 6 and t["exit_price"] == 100  # bar-6 open fill
    assert t["reason"] != "range end"


def test_expr_backtest_count_needs_third_red():
    """Same shape but bar 5 is green (101 -> 103, still below the 103 cross
    threshold so the entry never re-fires): only 2 reds since entry, the rule
    never fires, and the trade exits at range end."""
    bars = [(101, 102), (102, 104), (104, 103), (103, 102), (102, 101), (101, 103), (103, 103)]
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_oc_candles(bars),
        longEntry=[{"expr": "crossAbove(candle.close, 103)"}],
        longExit=[{"expr": "count(bearish(candle), barsSinceEntry) >= 3"},
                  {"expr": "candle.close < entry"}],
    ))
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert len(trades) == 1
    assert trades[0]["reason"] == "range end"


def test_referenced_tfs_sees_into_count_and_predicates():
    from auto_trader.api.routers.expr import _referenced_tfs
    from auto_trader.strategy.expr.parser import parse

    node = parse("count(bearish(candle@1H), 10) >= 2")
    assert _referenced_tfs(node) == {"1H"}


# --- pinned candle patterns need HTF warm-up ---------------------------------
# _tf_inner_warmup answers "warm-up in the PIN's own bars", and the routes max
# it across every row for each referenced timeframe. A pattern pinned to @tf
# needs PATTERN_WARMUP bars of THAT timeframe (below it, eps_series uses a
# different epsilon, so _eq-tolerance patterns detect differently rather than
# going quiet) — but the 18 must be charged ONLY to the tf the pattern is
# actually pinned to, or an unrelated pin's ask inflates and can spuriously 422.


def _tiw(expr: str, tf: str) -> int:
    from auto_trader.api.routers.expr import _tf_inner_warmup
    from auto_trader.strategy.expr.parser import parse

    return _tf_inner_warmup(parse(expr), tf)


def test_pinned_pattern_charges_its_warmup_to_the_pinned_tf():
    assert _tiw("bullEngulfing(candle@4H)", "4H") == 18
    # ...and through a count() window and an offset, which are base-aligned.
    assert _tiw("count(doji(candle@4H), 10) >= 2", "4H") == 18


def test_unpinned_pattern_charges_nothing_to_any_tf():
    # THE regression guard: an unconditional `+ PATTERN_WARMUP` here would make
    # an unpinned row inflate every other row's @tf ask.
    assert _tiw("bullEngulfing(candle)", "4H") == 0
    assert _tiw("bullEngulfing(candle[-3])", "1H") == 0


def test_pattern_pinned_to_one_tf_does_not_inflate_another():
    assert _tiw("bullEngulfing(candle@4H)", "1H") == 0


def test_bullish_pinned_is_not_a_pattern_and_stays_zero():
    assert _tiw("bullish(candle@4H)", "4H") == 0


def test_backtest_fetches_enough_htf_for_a_pinned_pattern(monkeypatch):
    """The fetch window must cover the pattern's 18 pin-bars, not 1."""
    calls = []

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, side):
        calls.append(from_ts)
        return [candle_from_dto(CandleDTO(**c)) for c in _hourly_dtos()]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    r = client.post("/api/expr/backtest", json=_tf_req(
        longEntry=[{"expr": "bullEngulfing(candle@1H)"}]))
    assert r.status_code == 200, r.text
    # need = 18 + 1 = 19; the route asks 2x the need + 10 bars of slack.
    assert calls == [0 - (19 * 2 + 10) * 3600]


def test_backtest_unpinned_pattern_row_does_not_inflate_another_tfs_ask(monkeypatch):
    """A pattern row with NO pin, alongside a pinned EMA row: the @1H ask must
    stay at the EMA's need, not jump by 18."""
    calls = []

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, side):
        calls.append(from_ts)
        return [candle_from_dto(CandleDTO(**c)) for c in _hourly_dtos()]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    r = client.post("/api/expr/backtest", json=_tf_req(longEntry=[
        {"expr": "bullEngulfing(candle)"},
        {"expr": "crossAbove(EMA(3), EMA(4)@1H)"},
    ]))
    assert r.status_code == 200, r.text
    # need = EMA(4)'s 4 + 1 = 5. An unconditional +18 would make this -56*3600.
    assert calls == [0 - (5 * 2 + 10) * 3600]


def test_series_fetches_enough_htf_for_a_pinned_pattern(monkeypatch):
    """/api/expr/series has NO sufficiency check, so its fetch window is the
    only thing standing between the overlay and a silently under-warmed
    pattern. A bare predicate 422s, so count() is the reachable shape."""
    calls = []

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, side):
        calls.append((resolution, from_ts))
        return [candle_from_dto(CandleDTO(**c)) for c in _hourly_dtos()]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    r = client.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "MINUTE_5",
        "expr": "count(bullEngulfing(candle@1H), 10) >= 2",
        "fromTime": 0, "toTime": 3600 * 4,
    })
    assert r.status_code == 200, r.text
    # base fetch, then the 1H pin reaching back need = 18 + 1 = 19 hours.
    assert ("HOUR", 0 - 19 * 3600) in calls
