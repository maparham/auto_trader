"""API tests for the expression surface: /api/expr/backtest, /series, /literals.

The structured /api/backtest is untouched; this exercises the parallel expr
surface end to end (parse/validate -> compile -> engine run -> shared serializer).
"""

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from auto_trader.api import deps
from auto_trader.api.app import app
from auto_trader.api.routers import expr
from auto_trader.api.schemas import CandleDTO, ExprBacktestRequest
from auto_trader.api.sweep_apply import candle_from_dto
from auto_trader.core import progress as pr
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


# --- ATR panel risk ----------------------------------------------------------
# The expr wire format carries no `series`, so the route computes the ATR_{n}
# series an atr/trailAtr stop, target, or scaling spacing executes against. These
# used to 422 with atr_risk_unsupported.


# Bars 0..9 are warm-up (before tradeFromTime), matching what the real client
# posts: lib/backtestWindow.ts sizes its history fetch by riskAtrLengths, so an
# ATR stop always has its warm-up bars in hand before the window opens.
_ATR_WARMUP_BARS = 10
_ATR_TRADE_FROM = 3600 * _ATR_WARMUP_BARS


def _atr_stop_candles():
    """20 quiet bars (range 1.0 each) then a spike down. ATR is 1.0 across the
    quiet stretch, so a 2x ATR stop from a fill near 10 sits at ~8 and the final
    bar's low of 5 takes it out."""
    bars = [{"time": 3600 * k, "open": 10.0, "high": 10.5, "low": 9.5,
             "close": 10.0, "volume": 100.0} for k in range(20)]
    bars[12]["close"] = 11.0     # crossAbove(close, 10.5) -> entry on bar 13
    bars[12]["high"] = 11.0
    bars[-1].update(open=10.0, high=10.0, low=5.0, close=5.5)
    return bars


def _atr_req(**over):
    over.setdefault("tradeFromTime", _ATR_TRADE_FROM)
    over.setdefault("candles", _atr_stop_candles())
    return _base_req(
        longEntry=[{"expr": "crossAbove(candle.close, 10.5)"}],
        longExit=[],
        **over,
    )


def test_expr_backtest_atr_stop_runs_and_fires():
    atr_risk = {"stop": {"kind": "atr", "mult": 2.0, "length": 3},
                "target": {"kind": "none"}}
    r = client.post("/api/expr/backtest", json=_atr_req(longRisk=atr_risk))
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert trades, "ATR stop run produced no trades"
    # The spike bar takes the stop out — not the range-end flatten.
    assert any("stop" in t["reason"].lower() for t in trades), trades
    assert all(t["stop_initial"] is not None for t in trades), trades


def test_expr_backtest_without_atr_stop_survives_the_spike():
    # Control for the test above: same candles, no stop -> the position is still
    # open at range end. Proves the stop above is what closed the trade.
    r = client.post("/api/expr/backtest", json=_atr_req())
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert all("stop" not in t["reason"].lower() for t in trades), trades


def test_expr_backtest_atr_target_fires():
    # Same candles but with a rally after the entry bar, so a 1x ATR target above
    # the fill is actually reachable — a 200 alone would not show the target got
    # a real ATR value.
    bars = _atr_stop_candles()
    for k in range(14, 20):
        bars[k].update(open=10.0, high=13.0, low=10.0, close=12.5)
    atr_risk = {"stop": {"kind": "none"},
                "target": {"kind": "atr", "mult": 1.0, "length": 3}}
    r = client.post("/api/expr/backtest", json=_atr_req(candles=bars, longRisk=atr_risk))
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert trades, "no trades — the fixture stopped exercising the target"
    assert all(t["target"] is not None for t in trades), trades
    assert any("target" in t["reason"].lower() for t in trades), trades


def test_expr_backtest_trail_atr_stop_runs():
    atr_risk = {"stop": {"kind": "trailAtr", "mult": 2.0, "length": 3},
                "target": {"kind": "none"}}
    r = client.post("/api/expr/backtest", json=_atr_req(longRisk=atr_risk))
    assert r.status_code == 200


def test_expr_backtest_atr_stop_short_warmup_422():
    # ATR(500) over 20 candles is undefined at every bar: running it would open a
    # position with no stop at all, which is exactly what the old guard existed
    # to prevent. 422 rather than degrade silently.
    atr_risk = {"stop": {"kind": "atr", "mult": 2.0, "length": 500},
                "target": {"kind": "none"}}
    r = client.post("/api/expr/backtest", json=_atr_req(longRisk=atr_risk))
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "atr_warmup"
    assert "ATR(500)" in d["message"]


def test_expr_backtest_atr_warmup_boundary():
    # atr_series defines its first value at index length-1, and bar 10 is the
    # first tradeable one, so ATR(11) is exactly warm there and ATR(12) is not.
    def run(length):
        return client.post("/api/expr/backtest", json=_atr_req(
            longRisk={"stop": {"kind": "atr", "mult": 2.0, "length": length},
                      "target": {"kind": "none"}}))

    assert run(11).status_code == 200
    assert run(12).status_code == 422


def test_expr_backtest_atr_warmup_measured_at_first_tradeable_bar():
    # Not bar 0: the same ATR(11) that is warm with a window starting at bar 10
    # 422s when the whole range is tradeable, because bar 0 has no ATR and an
    # entry there would carry stop_initial=None for the position's whole life.
    atr_risk = {"stop": {"kind": "atr", "mult": 2.0, "length": 11},
                "target": {"kind": "none"}}
    assert client.post("/api/expr/backtest", json=_atr_req(
        longRisk=atr_risk)).status_code == 200
    assert client.post("/api/expr/backtest", json=_atr_req(
        longRisk=atr_risk, tradeFromTime=0)).status_code == 422


def _scale_in_req(**over):
    """A repeatedly-true entry with maxConcurrent > 1, so the spacing gate is
    actually consulted on every bar after the first fill. The single-cross entry
    _atr_req uses would never open a second position, leaving the gate untouched."""
    over.setdefault("tradeFromTime", _ATR_TRADE_FROM)
    return _base_req(
        candles=_atr_stop_candles(),
        longEntry=[{"expr": "candle.close > 0"}],  # every bar
        longExit=[],
        **over,
    )


def _entry_count(**over):
    r = client.post("/api/expr/backtest", json=_scale_in_req(**over))
    assert r.status_code == 200, r.text
    return len(r.json()["trades"])


def test_expr_backtest_atr_scaling_spacing_gates_entries():
    # Scaling spacing of kind atr reads the same ATR_{n} map. Before this it was
    # unguarded AND unpopulated: the gate read None and stopped gating, silently.
    # A wide ATR spacing must therefore admit FEWER positions than no spacing at
    # all — equal counts would mean the series still isn't reaching the gate.
    ungated = _entry_count(longScaling={"maxConcurrent": 3, "spacing": None})
    gated = _entry_count(longScaling={
        "maxConcurrent": 3, "spacing": {"kind": "atr", "mult": 50.0, "length": 3}})
    assert ungated > 1, "fixture opened no second position — the gate is untested"
    assert gated < ungated, (gated, ungated)


def test_expr_backtest_atr_scaling_spacing_short_warmup_422():
    r = client.post("/api/expr/backtest", json=_atr_req(
        longScaling={"maxConcurrent": 3,
                     "spacing": {"kind": "atr", "mult": 1.0, "length": 500}}))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "atr_warmup"


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


def test_expr_series_boolean_row_422s():
    # An and/or/not row has no single operand to plot — must 422, not blow up on
    # `node.a` (AttributeError -> 500) in the operand picker below.
    for expr in ("candle.close > 5 and candle.close > 1",
                 "candle.close > 5 or candle.close > 1",
                 "not candle.close > 5"):
        r = client.post("/api/expr/series", json={
            "epic": "TEST", "resolution": "HOUR", "expr": expr,
            "fromTime": 0, "toTime": 3600,
        })
        assert r.status_code == 422, expr
        assert r.json()["detail"]["code"] == "boolean_not_plottable"


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


# --- fill provenance: reason strings + captured terms ---------------------
#
# The structured rule engine stamped every rule-based Signal with the firing
# rows' text (reason) and captured comparisons (terms); the chart's signal-candle
# carets and the trades table's Reason column read exactly those. The expr
# strategy must do the same or both silently vanish (regression: markers/reasons
# disappeared when the structured engine was deleted).


def test_expr_backtest_entry_fill_carries_reason_and_terms():
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_candles([1, 2, 3, 2, 1, 1]),
    ))
    assert r.status_code == 200
    body = r.json()
    entry = next(m for m in body["markers"] if m["side"] == "buy")
    assert entry["reason"] == "crossAbove(candle.close, 2)"
    assert entry["combine"] == "AND"
    assert len(entry["terms"]) == 1
    t = entry["terms"][0]
    assert t["left"] == "candle.close" and t["right"] == "2"
    assert t["op"] == "crossesAbove"
    # Values as-of the signal bar (close 3 crossing the 2 threshold).
    assert t["lval"] == 3.0 and t["rval"] == 2.0
    # Price/const operands are timeframe-less.
    assert t["leftTf"] is None and t["rightTf"] is None


def test_expr_backtest_rule_exit_reason_reaches_trade_and_fill():
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_candles([1, 2, 3, 2, 1, 1]),
    ))
    assert r.status_code == 200
    body = r.json()
    trades = body["trades"]
    assert len(trades) == 1
    assert trades[0]["reason"] == "candle.close < entry"
    exit_fill = next(m for m in body["markers"] if m["side"] == "sell")
    assert exit_fill["reason"] == "candle.close < entry"
    [term] = exit_fill["terms"]
    assert term["left"] == "candle.close" and term["op"] == "<" and term["right"] == "entry"
    assert term["lval"] == 1.0 and term["rval"] == 2.0  # close 1 vs entry price 2


def test_expr_backtest_multi_row_group_joins_reasons_and_concats_terms():
    bars = [(101, 102), (102, 104), (104, 103), (103, 102), (102, 101), (101, 100), (100, 100)]
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_oc_candles(bars),
        longEntry=[{"expr": "crossAbove(candle.close, 103)"}],
        longExit=[{"expr": "count(bearish(candle), barsSinceEntry) >= 3"},
                  {"expr": "candle.close < entry"}],
    ))
    assert r.status_code == 200
    body = r.json()
    assert body["trades"][0]["reason"] == (
        "count(bearish(candle), barsSinceEntry) >= 3 AND candle.close < entry"
    )
    exit_fill = next(m for m in body["markers"] if m["side"] == "sell")
    assert [t["left"] for t in exit_fill["terms"]] == [
        "count(bearish(candle), barsSinceEntry)", "candle.close",
    ]


def test_expr_terms_tf_attribution_unit():
    """Term timeframe attribution: a @tf pin anywhere in the operand wins (as its
    canonical resolution); an unpinned indicator operand runs on the base
    resolution; price/const/entry operands are timeframe-less."""
    from auto_trader.strategy.expr.evaluate import compile_row
    from auto_trader.strategy.expr.parser import parse

    candles = [candle_from_dto(CandleDTO(**c)) for c in _candles([1.0] * 30)]
    hourly = candles
    src = "EMA(3) > candle.close@1H"
    row = compile_row(parse(src), candles, "MINUTE_5", {"HOUR": hourly}, source=src)
    [term] = row.terms_at(len(candles) - 1, None, None)
    assert term.left_label == "EMA(3)" and term.left_tf == "MINUTE_5"
    assert term.right_label == "candle.close@1H" and term.right_tf == "HOUR"

    src2 = "candle.close < entry"
    row2 = compile_row(parse(src2), candles, "MINUTE_5", {}, source=src2)
    [term2] = row2.terms_at(len(candles) - 1, 2.0, None)
    assert term2.left_tf is None and term2.right_tf is None
    assert term2.right_val == 2.0


def test_expr_terms_predicate_row_single_operand_term():
    """A predicate row (bullish/bearish/pattern) has no left/right comparison —
    it captures a single-operand term (op "") the popover renders as label-only."""
    from auto_trader.strategy.expr.evaluate import compile_row
    from auto_trader.strategy.expr.parser import parse

    bars = [(101, 102), (102, 104)]
    candles = [candle_from_dto(CandleDTO(**c)) for c in _oc_candles(bars)]
    src = "bullish(candle)"
    row = compile_row(parse(src), candles, "MINUTE_5", {}, source=src)
    [term] = row.terms_at(1, None, None)
    assert term.left_label == "bullish(candle)" and term.op == ""
    assert term.right_label == ""


def test_referenced_tfs_sees_into_count_and_predicates():
    from auto_trader.api.routers.expr import _referenced_tfs
    from auto_trader.strategy.expr.parser import parse

    node = parse("count(bearish(candle@1H), 10) >= 2")
    assert _referenced_tfs(node) == {"1H"}


def test_referenced_tfs_sees_into_boolean_rows():
    # A @tf pin inside an and/or/not branch is invisible to HTF collection unless
    # referenced_tfs walks BoolOp/Not — _ensure_htf then never fetches those
    # candles and the pinned series degrades to all-None (silent Kleene unknown).
    from auto_trader.api.routers.expr import _referenced_tfs
    from auto_trader.strategy.expr.parser import parse

    assert _referenced_tfs(parse("EMA(50)@1H > 0 and candle.close > 0")) == {"1H"}
    assert _referenced_tfs(parse("candle.close > 0 or EMA(50)@1H > 0")) == {"1H"}
    assert _referenced_tfs(parse("not EMA(50)@1H > 0")) == {"1H"}
    assert _referenced_tfs(
        parse("count(EMA(50)@1H > 0 and candle.close > 0, 10) >= 2")
    ) == {"1H"}


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


def test_tf_inner_warmup_sees_into_boolean_rows():
    # Same defect as _referenced_tfs above, one layer on: a pin inside an
    # and/or/not branch must charge its own warm-up, or the route fetches one
    # bar of HTF and warms the series from nothing.
    solo = _tiw("EMA(50)@1H > 0", "1H")
    assert solo > 0
    assert _tiw("EMA(50)@1H > 0 and candle.close > 0", "1H") == solo
    assert _tiw("candle.close > 0 or EMA(50)@1H > 0", "1H") == solo
    assert _tiw("not EMA(50)@1H > 0", "1H") == solo
    assert _tiw("count(EMA(50)@1H > 0 and candle.close > 0, 10) >= 2", "1H") == solo


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


def test_series_plots_first_operand_of_a_leading_cross_part(monkeypatch):
    """A chain whose FIRST part is an infix cross has `.a`/`.b`, not
    `.left`/`.right` — /series must still find the primary series to plot."""
    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, side):
        return [candle_from_dto(CandleDTO(**c)) for c in _hourly_dtos()]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    r = client.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "HOUR",
        "expr": "EMA(3) x> EMA(4) > EMA(5)",
        "fromTime": -40 * 3600, "toTime": 0,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # EMA(3) is the plotted operand: defined from bar 2 on, and rising.
    assert len(body["values"]) == len(body["times"])
    assert any(v is not None for v in body["values"])


# --- per-group AND/OR combine -------------------------------------------------


def _split_entry_req(**over):
    """Two long-entry rows where only the second can ever pass."""
    return _base_req(
        longEntry=[{"expr": "candle.close > 100"}, {"expr": "candle.close > 0"}],
        **over,
    )


def test_expr_backtest_or_combine_lets_one_passing_row_fire():
    r = client.post("/api/expr/backtest", json=_split_entry_req(longEntryCombine="OR"))
    assert r.status_code == 200, r.text
    assert len(r.json()["trades"]) >= 1


def test_expr_backtest_default_combine_is_and():
    # Same rules, omitted combine -> AND -> the impossible row blocks every entry.
    r = client.post("/api/expr/backtest", json=_split_entry_req())
    assert r.status_code == 200, r.text
    assert r.json()["trades"] == []


def test_expr_backtest_rejects_a_non_canonical_combine():
    # "or" lowercase would fold as AND while labelling the reason "or" — the
    # Literal type rejects it at the DTO boundary instead.
    r = client.post("/api/expr/backtest", json=_split_entry_req(longEntryCombine="or"))
    assert r.status_code == 422


@pytest.fixture(autouse=True)
def _drop_stray_progress_entries():
    """Cleanup insurance for the id the progress test registers. Teardown, NOT
    an in-test finally: it must run AFTER the assertions so the handler's own
    `finally: clear_progress(...)` is what the clear-on-finish assertion tests."""
    yield
    pr.clear_progress("expr-prog")


def test_expr_backtest_with_progress_id_updates_then_clears(monkeypatch):
    # Direct call (per test_api_backtest_progress.py) so the registry can be
    # spied on in-process while the run is in flight.
    req = ExprBacktestRequest(**_base_req(progressId="expr-prog"))
    snapshots: list[dict] = []
    real_update = pr.update_progress

    def spying_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        snapshots.append(pr.get_progress(pid))

    monkeypatch.setattr(pr, "update_progress", spying_update)
    asyncio.run(expr.expr_backtest(req))
    assert snapshots, "engine progress never reached the registry"
    assert all(s["stage"] == "simulate" for s in snapshots)
    dones = [s["done"] for s in snapshots]
    assert dones == sorted(dones), "progress must advance monotonically"
    assert snapshots[-1]["done"] == snapshots[-1]["total"] > 0
    assert pr.get_progress("expr-prog") is None  # cleared in finally


def test_expr_baseline_passes_never_rewind_the_wire_fraction(monkeypatch):
    """Baselines are several engine passes under one stage label; the wire
    payload must aggregate them into one 0→100% climb instead of restarting
    at 0 per pass (the UI bar would visibly rewind under an unchanged label)."""
    req = ExprBacktestRequest(**_base_req(
        progressId="expr-prog", baselines=["null", "hold", "reversed"]))
    snapshots: list[dict] = []
    real_update = pr.update_progress

    def spying_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        snapshots.append(pr.get_progress(pid))

    monkeypatch.setattr(pr, "update_progress", spying_update)
    asyncio.run(expr.expr_backtest(req))
    fracs = [s["done"] / s["total"] for s in snapshots
             if s["stage"] == "baselines" and s["total"]]
    assert fracs, "baseline passes never reported progress"
    assert fracs == sorted(fracs), f"baselines fraction rewound: {fracs}"
    assert fracs[-1] == 1.0


def test_expr_backtest_without_progress_id_touches_no_registry(monkeypatch):
    """Zero behavior change when the client ships no id: nothing is registered."""
    calls: list[tuple] = []
    monkeypatch.setattr(pr, "set_progress", lambda *a, **k: calls.append((a, k)))
    asyncio.run(expr.expr_backtest(ExprBacktestRequest(**_base_req())))
    assert calls == []


def test_expr_backtest_carries_analysis_and_entry_context():
    """The expression surface enriches and analyses like the structured one.

    Without this the whole Analysis tab (context breakdowns, win/loss contrast)
    is empty for rule strategies, which is what the UI runs by default.
    """
    # 60 bars of a clean ramp-and-fade so the entry rule fires with enough
    # history for the context features' EMA(50)/ATR(14) lookbacks.
    closes = [100 + (k % 10) for k in range(60)]
    r = client.post("/api/expr/backtest", json=_base_req(
        candles=_candles(closes),
        longEntry=[{"expr": "crossAbove(candle.close, 105)"}],
    ))
    assert r.status_code == 200
    body = r.json()
    assert body["trades"], "expected the rule to fire at least once"
    assert body["analysis"] is not None
    assert body["analysis"]["n_trades"] == len(body["trades"])
    ctx = body["trades"][0]["context"]
    assert ctx is not None
    assert "session" in ctx and "hour_utc" in ctx
