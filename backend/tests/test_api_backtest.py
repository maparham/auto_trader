"""POST /api/backtest — rule-driven backtest endpoint.

No broker calls (D1/D6): the request carries the candles the series were
computed on, so the handler is exercised by calling it directly, same pattern
as test_broker_isolation.py's `app_module.backtest(...)` calls.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from auto_trader.api import app as app_module
from auto_trader.api.app import app

client = TestClient(app)


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 60, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _ind(name: str, length: int | None = None, anchor: int | None = None) -> dict:
    return {"kind": "indicator", "indicator": name, "length": length, "anchor": anchor}


def _costs() -> dict:
    return {"quantity": 1.0, "commissionPerSide": 0.0, "slippage": 0.0, "startingCash": 10_000.0}


def _groups(long_entry=None, long_exit=None, short_entry=None, short_exit=None):
    empty = {"combine": "AND", "rules": []}
    return {
        "longEntry": long_entry or empty,
        "longExit": long_exit or empty,
        "shortEntry": short_entry or empty,
        "shortExit": short_exit or empty,
    }


def _run(body: dict):
    async def scenario():
        return await app_module.backtest(app_module.BacktestRequest(**body))

    return asyncio.run(scenario())


def test_post_backtest_returns_markers_for_a_simple_cross():
    # Real recompute: a flat-then-rising close series makes the shorter EMA(5)
    # cross above EMA(9) exactly once. Ship no series — the backend recomputes.
    candles = _candles([10, 10, 10, 10, 11, 12, 13, 14, 15, 16])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)
    assert result.epic == "EURUSD"
    # One entry marker; the still-open long adds a "range end" exit marker.
    entries = [m for m in result.markers if m.reason != "range end"]
    assert len(entries) == 1
    assert entries[0].side == "buy"
    assert entries[0].leg == "long"
    assert len(result.candles) == len(candles)


def test_post_backtest_avwap_recomputed_when_series_absent():
    # AVWAP is a native indicator, so an empty `series` no longer 422s — the
    # backend recomputes it from candles. With rising closes above the anchored
    # VWAP a marker fires; the essential contract here is that the run succeeds.
    candles = [
        {"time": 1_700_000_000 + i * 60, "open": c, "high": c, "low": c, "close": c, "volume": 1.0}
        for i, c in enumerate([9, 10, 11, 12, 13])
    ]
    anchor_ms = candles[0]["time"] * 1000
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},  # AVWAP recomputed server-side; no longer required in payload
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "price", "field": "close"}, "op": "gt",
                 "right": _ind("AVWAP", anchor=anchor_ms)}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)  # no 422 — recomputed AVWAP means the series need not be posted
    assert result.epic == "EURUSD"
    assert len(result.markers) >= 1  # close rises above the anchored VWAP


def _both_sides_cross_body():
    """Real-recompute config where BOTH a long entry and a short entry fire: a
    rise-then-fall close series makes EMA(5) cross ABOVE EMA(9) on the rise and
    BELOW it on the fall. Used to test the per-side enable flags on the real
    recompute path (verified empirically: one long-leg + one short-leg marker)."""
    candles = _candles([10, 10, 10, 11, 13, 15, 15, 13, 11, 10, 10])
    return {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
            short_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesBelow", "right": _ind("EMA", 9)}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }


def test_post_backtest_disabled_long_side_produces_no_long_markers():
    body = {**_both_sides_cross_body(), "longEnabled": False}
    legs = {m.leg for m in _run(body).markers}
    assert "long" not in legs
    assert "short" in legs  # the enabled side still trades


def test_post_backtest_disabled_short_side_produces_no_short_markers():
    body = {**_both_sides_cross_body(), "shortEnabled": False}
    legs = {m.leg for m in _run(body).markers}
    assert "short" not in legs
    assert "long" in legs


def test_post_backtest_enable_flags_default_to_trading_when_omitted():
    # Omitting longEnabled/shortEnabled must trade BOTH sides (DTO default True),
    # guarding against a flipped default or dropped kwargs in the handler wiring.
    legs = {m.leg for m in _run(_both_sides_cross_body()).markers}
    assert legs == {"long", "short"}


def test_post_backtest_422_on_empty_candles():
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": [],
        "series": {},
        **_groups(),
        "costs": _costs(),
        "tradeFromTime": 0,
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422


def test_post_backtest_422_on_series_length_mismatch():
    # Chart-operand (kind='series') keys can't be recomputed, so their length is
    # still validated against the candles.
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {"CHART_x": [1.0, 2.0]},  # too short
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "series", "seriesKey": "CHART_x", "label": "foo"},
                 "op": "gt", "right": {"kind": "const", "value": 0}}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422


def test_post_backtest_422_on_missing_series_name():
    # A chart-operand series referenced by a rule but not posted still 422s.
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},  # CHART_x referenced by the rule but not provided
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "series", "seriesKey": "CHART_x", "label": "foo"},
                 "op": "gt", "right": {"kind": "const", "value": 0}}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422
    assert "missing series 'CHART_x'" in e.value.detail


def test_post_backtest_trims_response_to_trade_from_time():
    # Two extra warm-up bars before the window; the window itself starts at index 2.
    candles = _candles([10, 10, 10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(),
        "costs": _costs(),
        "tradeFromTime": candles[2]["time"],
    }
    result = _run(body)
    assert [c.time for c in result.candles] == [c["time"] for c in candles[2:]]


@pytest.mark.parametrize(
    "patch",
    [
        {"quantity": 0},
        {"quantity": -1},
        {"commissionPerSide": -0.1},
        {"slippage": -0.1},
        {"startingCash": 0},
    ],
)
def test_post_backtest_422_on_invalid_costs(patch):
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(),
        "costs": {**_costs(), **patch},
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(ValidationError):
        _run(body)


def test_post_backtest_422_on_price_operand_missing_field():
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [{"left": {"kind": "price"}, "op": "gt", "right": {"kind": "const", "value": 0}}],
            },
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(ValidationError):
        _run(body)


def test_post_backtest_422_on_indicator_operand_missing_indicator():
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [{"left": {"kind": "indicator"}, "op": "gt", "right": {"kind": "const", "value": 0}}],
            },
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(ValidationError):
        _run(body)


def _min_body():
    # 4 flat candles, no rules -> no trades; a valid minimal request body.
    candles = [{"time": i * 60, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 0}
               for i in range(4)]
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "X", "resolution": "MINUTE", "candles": candles, "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": 0,
    }


def test_atr_risk_without_series_now_runs():
    # ATR is a native indicator recomputed server-side, so an ATR-sized stop no
    # longer requires a posted ATR series — the run succeeds.
    body = _min_body()
    body["longRisk"] = {"stop": {"kind": "atr", "mult": 2, "length": 14},
                        "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_pct_risk_needs_no_series_and_runs():
    body = _min_body()
    body["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_scaling_atr_spacing_now_runs():
    # Scaling-spacing ATR is likewise recomputed server-side; no posted series.
    body = _min_body()
    body["longScaling"] = {"maxConcurrent": 3, "spacing": {"kind": "atr", "mult": 2, "length": 14}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_scaling_pct_spacing_runs():
    body = _min_body()
    body["longScaling"] = {"maxConcurrent": 3, "spacing": {"kind": "pct", "value": 1.0}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_response_has_metrics_and_trade_reason():
    body = _min_body()
    # a trivial always-open then stop so at least one trade closes with a reason
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 1}, "target": {"kind": "none"}}
    # give it a down-bar so the stop triggers and books a trade
    body["candles"] = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 100, "low": 98, "close": 98, "volume": 0},
    ]
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    data = r.json()
    assert "metrics" in data
    assert "profit_factor" in data["metrics"] and "max_consec_losses" in data["metrics"]
    assert data["trades"], "expected at least one closed trade"
    assert "reason" in data["trades"][0]  # e.g. "stop"


def test_response_has_by_leg_breakdown_that_sums_to_the_aggregate():
    # Both-sides config closes at least one long and one short leg; the per-leg
    # breakdown must be present and reconcile with the aggregate summary/metrics.
    result = _run(_both_sides_cross_body())
    assert result.by_leg is not None
    long, short = result.by_leg["long"], result.by_leg["short"]

    # Counts and net P&L partition exactly across the two legs.
    assert long["n_trades"] + short["n_trades"] == result.summary["n_trades"]
    assert long["n_trades"] > 0 and short["n_trades"] > 0
    assert long["net_pnl"] + short["net_pnl"] == pytest.approx(result.summary["net_pnl"])

    # Per-leg win rate uses the same (commission-aware) rule as the aggregate, so
    # the trade-weighted average of the leg rates equals the summary win rate.
    weighted = long["n_trades"] * long["win_rate"] + short["n_trades"] * short["win_rate"]
    assert weighted == pytest.approx(result.summary["n_trades"] * result.summary["win_rate"])


def test_by_leg_serializes_over_the_wire():
    body = _min_body()
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 1}, "target": {"kind": "none"}}
    body["candles"] = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 100, "low": 98, "close": 98, "volume": 0},
    ]
    data = client.post("/api/backtest", json=body).json()
    assert set(data["by_leg"]) == {"long", "short"}
    assert "max_consec_losses" in data["by_leg"]["long"]
    assert data["by_leg"]["short"]["n_trades"] == 0  # no short trades in this run


def test_trade_dto_carries_stop_target_levels():
    body = _min_body()
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "pct", "value": 4}}
    body["candles"] = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 101, "low": 97, "close": 98, "volume": 0},
    ]
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    t = r.json()["trades"][0]
    assert t["stop_initial"] == 98.0 and t["target"] == 104.0
    assert "stop_final" in t


# --- recurrence mask (period scheduling) ---


def _always_true_entry():
    # close > 0 fires on every in-range bar — a mask-independent entry so these
    # tests exercise mask wiring, not indicator recompute.
    return {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}


def test_backtest_accepts_recurrence_mask():
    candles = _candles([10, 10, 10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(long_entry=_always_true_entry()),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
        "mask": {"enabled": True, "daysOfWeek": [1], "tz": "America/New_York"},
    }
    result = _run(body)  # runs without error; mask is honoured by the engine
    assert result.epic == "EURUSD"


def test_backtest_rejects_bad_tz():
    with pytest.raises(ValidationError):
        app_module.RecurrenceMaskDTO(enabled=True, tz="Not/AZone")


def test_backtest_without_mask_still_works():
    candles = _candles([10, 10, 10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(long_entry=_always_true_entry()),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)
    # price>0 fires each in-range bar; at least one non-"range end" entry marker.
    assert len([m for m in result.markers if m.reason != "range end"]) >= 1


def test_backtest_time_of_day_window_honoured_over_the_wire():
    # Regression: the frontend sends the clock filter as a nested
    # `timeOfDay: {startMin, endMin}` object; the DTO must read that shape (a
    # flat timeStartMin/timeEndMin silently drops it). Candles here sit at
    # ~22:13–22:17 UTC (minute-of-day ~1333); an always-true price>0 entry fires
    # on each in-range bar so the mask window is what gates the markers.
    candles = _candles([10, 10, 10, 10, 10])
    base = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(long_entry=_always_true_entry()),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }

    # A window that EXCLUDES the candles' time-of-day gates the entry away.
    excluded = _run({**base, "mask": {"enabled": True, "timeOfDay": {"startMin": 0, "endMin": 600}, "tz": "UTC"}})
    assert len(excluded.markers) == 0

    # A window that INCLUDES it lets the entry fire.
    included = _run({**base, "mask": {"enabled": True, "timeOfDay": {"startMin": 1300, "endMin": 1400}, "tz": "UTC"}})
    assert len(included.markers) >= 1


def test_markers_carry_signal_time_and_terms():
    # A rule-based entry marker carries the signal bar's time and the passing
    # rule's authoritative values with per-side timeframe tags. Real recompute:
    # a rising close series makes `close gt EMA(3)` fire once (at bar 1), and the
    # DTO must serialize the REAL recomputed term values (not injected constants).
    candles = _candles([10, 11, 12, 13])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": _ind("EMA", 3)}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)
    entry = next(m for m in result.markers if m.reason != "range end")
    assert entry.signal_time == candles[1]["time"]  # first bar where close > EMA(3)
    assert entry.combine == "AND"
    assert len(entry.terms) == 1
    term = entry.terms[0]
    # Left is the price close at bar 1 (11.0); right is the REAL recomputed EMA(3)
    # there (EMA seeds at 10, so at bar 1 it is 10 + (11-10)*2/4 = 10.5).
    assert term.left == "close"
    assert term.lval == 11.0
    assert term.op == "gt"
    assert term.right == "EMA(3)"
    assert term.rval == 10.5
    assert term.lval > term.rval  # the passing condition, on real recomputed values
    assert term.leftTf is None  # price operand carries no timeframe tag
    assert term.rightTf == "MINUTE_5"  # indicator on the base run TF

    # A mechanical exit (range end) carries no signal provenance.
    range_end = next(m for m in result.markers if m.reason == "range end")
    assert range_end.signal_time is None
    assert range_end.terms == []


def test_post_backtest_inspect_returns_bar_traces():
    # Always-true entry -> opens once, then holds; inspect trace explains later bars.
    candles = _candles([10, 11, 12, 13, 14])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "const", "value": 1}, "op": "gt", "right": {"kind": "const", "value": 0}}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
        "inspect": True,
    }
    result = _run(body)
    assert result.bar_traces is not None
    assert len(result.bar_traces) == len(candles)
    first = result.bar_traces[0]
    assert len(first.groups) == 4
    assert {g.group for g in first.groups} == {"longEntry", "shortEntry", "longExit", "shortExit"}
    assert first.action == "opened"
    # a later held bar is suppressed for being in a position
    held = result.bar_traces[2]
    assert held.action == "suppressed"
    assert held.reason == "already in position"


def test_post_backtest_no_inspect_omits_bar_traces():
    candles = _candles([10, 11, 12])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "const", "value": 1}, "op": "gt", "right": {"kind": "const", "value": 0}}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)
    assert result.bar_traces is None
