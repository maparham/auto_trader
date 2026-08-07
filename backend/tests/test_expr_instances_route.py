"""Transport: a chart indicator instance's SETTINGS ride on the request.

A rule names an OUTPUT (`SLOPE.5`); the pane's parameters travel separately
in the request's `indicators` map. These tests pin down that the map actually
reaches validate/compile/warm-up on EVERY surface that runs an expression — the
backtest route, the sweep/WFO submit paths, the live evaluate route, the
closeness overlay, and the literal-label helper. Each gap below evaluated a
reference to all-`None` (a plausible-looking WRONG backtest) rather than erroring,
so the tests are written to fail loudly if the map stops being threaded.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from auto_trader.api.app import app
from auto_trader.core.models import Candle

T0 = 1700000000
HOUR = 3600


def _candles(n, start=T0, step=HOUR):
    return [
        {"time": start + i * step, "open": 100.0 + i, "high": 101.0 + i,
         "low": 99.0 + i, "close": 100.0 + (i % 7), "volume": 10.0}
        for i in range(n)
    ]


def _core_candles(n, start=T0, step=HOUR):
    return [
        Candle(time=datetime.fromtimestamp(start + i * step, tz=timezone.utc),
               open=100.0 + i, high=101.0 + i, low=99.0 + i,
               close=100.0 + (i % 7), volume=10.0)
        for i in range(n)
    ]


COSTS = {"spread": 0.0, "slippage": {"kind": "fixed", "value": 0.0},
         "commissionPerSide": 0.0, "quantity": 1.0, "startingCash": 10000.0}

BASE = {
    "epic": "TEST", "resolution": "HOUR", "candles": _candles(200),
    "costs": COSTS,
    "tradeFromTime": T0 + 100 * HOUR, "shortEnabled": False,
}

SLOPE_INSTANCE = {"type": "SLOPE", "calcParams": [5],
                  "extendData": {"slopePeriod": 3}}
# Two spellings, both real: production stores the RESOLUTION_SECONDS key verbatim
# ("HOUR" — MaAvwapPanels.tsx), while an @tf token in expression text uses the
# alias ("1H"). Both must reach HTF sourcing identically.
PINNED_INSTANCE = {"type": "SLOPE", "calcParams": [5],
                   "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "1H"}}}
CANON_PINNED_INSTANCE = {"type": "SLOPE", "calcParams": [5],
                         "extendData": {"slopePeriod": 3,
                                        "mtf": {"timeframe": "HOUR"}}}
# A pane's own pin never passes through the parser, so validate() never alias-
# checks it. The chart's timeframe vocabulary is a strict superset of the backend
# Resolution enum, so this is a shape a real sender can produce.
BAD_PINNED_INSTANCE = {"type": "SLOPE", "calcParams": [5],
                       "extendData": {"slopePeriod": 3,
                                      "mtf": {"timeframe": "SECOND_5"}}}


async def _post(path, body):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        return await ac.post(path, json=body)


# --- /api/expr/backtest -------------------------------------------------------

@pytest.mark.anyio
async def test_a_rule_referencing_a_shipped_instance_runs():
    r = await _post("/api/expr/backtest", {
        **BASE,
        "indicators": {"SLOPE": SLOPE_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "longExit": [{"expr": "SLOPE.5 < 0"}],
    })
    assert r.status_code == 200, r.text
    # A ref that evaluated to all-None would never fire; the map must reach compile.
    assert r.json()["trades"], r.text


@pytest.mark.anyio
async def test_a_rule_referencing_a_missing_instance_is_a_422_not_a_500():
    r = await _post("/api/expr/backtest", {
        **BASE,
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
    })
    assert r.status_code == 422
    assert "unknown_indicator_ref" in r.text


@pytest.mark.anyio
async def test_an_unregistered_pane_in_the_map_does_not_error():
    # A chart legitimately carries MACD/BOLL/KDJ panes no rule can reference.
    r = await _post("/api/expr/backtest", {
        **BASE,
        "indicators": {"SLOPE": SLOPE_INSTANCE,
                       "MACD": {"type": "MACD", "calcParams": [12, 26, 9]},
                       "BOLL": {"calcParams": [20, 2]}},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
    })
    assert r.status_code == 200, r.text


# --- a pinned instance's timeframe must reach HTF sourcing --------------------

@pytest.mark.anyio
async def test_a_pinned_instance_runs_off_shipped_htf_candles():
    r = await _post("/api/expr/backtest", {
        **BASE,
        "indicators": {"SLOPE": PINNED_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "htfCandles": {"HOUR": _candles(200)},
    })
    assert r.status_code == 200, r.text


@pytest.mark.anyio
async def test_a_pinned_instances_pin_is_checked_for_htf_sufficiency():
    # THE discriminator for _referenced_tfs/_ensure_htf: the expression text has
    # no @tf at all, so without the instance map the referenced-tf set is empty,
    # no sufficiency check runs, and this returns 200 with a silently mis-warmed
    # series. With the map it must 422.
    r = await _post("/api/expr/backtest", {
        **BASE,
        "indicators": {"SLOPE": PINNED_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "htfCandles": {"HOUR": _candles(3)},
    })
    assert r.status_code == 422, r.text
    assert "not enough history for timeframe" in r.text


def test_referenced_tfs_includes_a_pinned_instances_own_timeframe():
    from auto_trader.api.routers.expr import _referenced_tfs
    from auto_trader.indicators.registry import resolve_instances
    from auto_trader.strategy.expr.parser import parse

    node = parse("SLOPE.5 > 0")
    instances = resolve_instances({"SLOPE": PINNED_INSTANCE})
    assert _referenced_tfs(node, instances) == {"1H"}
    assert _referenced_tfs(node) == set()


def test_tf_inner_warmup_charges_a_pinned_instances_own_warmup():
    # need = warm-up + 1; charging only the +1 would pass the sufficiency check
    # on a single closed HTF bar and warm the series from nothing.
    from auto_trader.api.routers.expr import _tf_inner_warmup
    from auto_trader.indicators.registry import resolve_instances
    from auto_trader.strategy.expr.parser import parse

    node = parse("SLOPE.5 > 0")
    instances = resolve_instances({"SLOPE": PINNED_INSTANCE})
    assert _tf_inner_warmup(node, "1H", instances) == 5 + 3  # length + slopePeriod
    assert _tf_inner_warmup(node, "HOUR", instances) == 8    # canonical or alias
    assert _tf_inner_warmup(node, "DAY", instances) == 0


# --- /api/expr/sweep/jobs (gap 1: sweep + walk-forward) -----------------------

@pytest.mark.anyio
async def test_the_sweep_submit_path_sees_a_pinned_instances_timeframe():
    # _all_row_nodes swallows ExprError, so an unthreaded map makes the row parse
    # to nothing, reference no timeframe, and the workers then run it all-None.
    r = await _post("/api/expr/sweep/jobs", {
        **BASE,
        "indicators": {"SLOPE": PINNED_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "htfCandles": {"HOUR": _candles(3)},
        "sweep": {"combos": [{"lit:long.entry.0.0": 0.1}]},
    })
    assert r.status_code == 422, r.text
    assert "not enough history for timeframe" in r.text


@pytest.mark.anyio
async def test_the_walkforward_submit_path_sees_a_pinned_instances_timeframe():
    r = await _post("/api/expr/walkforward/jobs", {
        **BASE,
        "indicators": {"SLOPE": PINNED_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "htfCandles": {"HOUR": _candles(3)},
        "walkforward": {
            "combos": [{"lit:long.entry.0.0": 0.1}],
            "axes": [{"kind": "range", "targets": ["lit:long.entry.0.0"],
                      "values": [0.1]}],
            "schedule": {"trainSpan": "20b", "testSpan": "10b"},
        },
    })
    assert r.status_code == 422, r.text
    assert "not enough history for timeframe" in r.text


def test_the_sweep_engine_builder_compiles_a_shipped_instance():
    # build_expr_engine runs INSIDE pool workers, which have no request object —
    # they rebuild it from req_dict, so the map must be resolved there.
    from auto_trader.api.schemas import ExprBacktestRequest
    from auto_trader.api.sweep_apply import build_expr_engine

    req = ExprBacktestRequest.model_validate({
        **BASE,
        "indicators": {"SLOPE": SLOPE_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "longExit": [{"expr": "SLOPE.5 < 0"}],
    })
    candles = _core_candles(200)
    engine, strategy = build_expr_engine(req, candles, {}, {}, None, None)
    result = engine.run(candles)
    assert result.n_trades > 0


def test_the_coded_paths_expr_exits_compile_a_shipped_instance():
    from auto_trader.api.sweep_apply import _compile_expr_exits
    from auto_trader.api.schemas import ExprRowDTO
    from auto_trader.indicators.registry import resolve_instances

    candles = _core_candles(200)
    instances = resolve_instances({"SLOPE": SLOPE_INSTANCE})
    rows = [ExprRowDTO(expr="SLOPE.5 > 0")]
    compiled = _compile_expr_exits(rows, candles, "HOUR", {}, instances)
    assert any(compiled[0].evaluate(i, None) for i in range(len(candles))), \
        "the exit row evaluated to all-None"


def test_a_coded_exit_rule_on_a_pinned_pane_asks_for_its_candles():
    """The coded path has no _ensure_htf, and its fetch loop was driven only by
    CodedStrategy's own tf= calls — never by an expression row. So a panel exit
    referencing a PINNED pane compiled to all-None: the strategy opened positions
    and never exited them, silently.

    It now reports the need the same way a tf= call does, so `_run_coded` fetches
    the timeframe and retries."""
    from auto_trader.api.sweep_apply import TimeframeNotPrefetched, _compile_expr_exits
    from auto_trader.api.schemas import ExprRowDTO
    from auto_trader.indicators.registry import resolve_instances

    candles = _core_candles(200)
    pinned = {**SLOPE_INSTANCE,
              "extendData": {**SLOPE_INSTANCE["extendData"], "mtf": {"timeframe": "HOUR_4"}}}
    instances = resolve_instances({"SLOPE": pinned})
    with pytest.raises(TimeframeNotPrefetched) as e:
        _compile_expr_exits([ExprRowDTO(expr="SLOPE.5 > 0")], candles, "HOUR", {}, instances)
    # The CANONICAL resolution, which is what _run_coded feeds to the fetch.
    assert e.value.timeframe == "HOUR_4"


def test_the_same_signal_covers_an_at_tf_token():
    """Not instance-specific: an @tf pin in a coded panel exit row was dead for
    exactly the same reason."""
    from auto_trader.api.sweep_apply import TimeframeNotPrefetched, _compile_expr_exits
    from auto_trader.api.schemas import ExprRowDTO

    with pytest.raises(TimeframeNotPrefetched) as e:
        _compile_expr_exits([ExprRowDTO(expr="EMA(9)@4H > 0")], _core_candles(200), "HOUR", {}, None)
    assert e.value.timeframe == "HOUR_4"  # canonical, not the "4H" alias


def test_present_htf_candles_satisfy_the_check():
    """The point is a MISSING fetch, not that pins are forbidden — a caller that
    shipped (or a retry pass that fetched) the timeframe must compile normally."""
    from auto_trader.api.sweep_apply import _compile_expr_exits
    from auto_trader.api.schemas import ExprRowDTO

    candles = _core_candles(200)
    htf = {"HOUR_4": _core_candles(60, step=4 * HOUR)}
    compiled = _compile_expr_exits([ExprRowDTO(expr="EMA(9)@4H > 0")], candles, "HOUR", htf, None)
    assert len(compiled) == 1


def test_an_unpinned_reference_needs_no_htf_at_all():
    """Guard against over-firing: the common case (a pane following the chart)
    must not start demanding a timeframe."""
    from auto_trader.api.sweep_apply import _compile_expr_exits
    from auto_trader.api.schemas import ExprRowDTO
    from auto_trader.indicators.registry import resolve_instances

    instances = resolve_instances({"SLOPE": SLOPE_INSTANCE})
    compiled = _compile_expr_exits(
        [ExprRowDTO(expr="SLOPE.5 > 0")], _core_candles(200), "HOUR", {}, instances)
    assert len(compiled) == 1


# --- /api/strategy/evaluate (gap 2) -------------------------------------------

@pytest.mark.anyio
async def test_the_live_evaluate_route_accepts_a_shipped_instance():
    r = await _post("/api/strategy/evaluate", {
        "epic": "TEST", "resolution": "HOUR", "candles": _candles(200),
        "series": {}, "exprMode": True,
        "indicators": {"SLOPE": SLOPE_INSTANCE},
        "exprLongEntry": [{"expr": "SLOPE.5 > -999999"}],
    })
    assert r.status_code == 200, r.text
    # An all-None ref never satisfies "> -1e9", so an action proves the map landed.
    assert r.json()["actions"], r.text


# --- /api/expr/closeness (gap 3) ----------------------------------------------

@pytest.mark.anyio
async def test_the_closeness_route_evaluates_a_shipped_instance(monkeypatch):
    from auto_trader.api import deps

    candles = _core_candles(200)

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        return candles

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    r = await _post("/api/expr/closeness", {
        "epic": "TEST", "broker": "capital", "priceSide": "mid",
        "rows": ["SLOPE.5 > 0"], "combine": "AND",
        "baseResolution": "HOUR", "displayResolution": "HOUR",
        "fromTime": T0, "toTime": T0 + 199 * HOUR,
        "indicators": {"SLOPE": SLOPE_INSTANCE},
    })
    assert r.status_code == 200, r.text
    values = r.json()["values"]
    # Without the map series_of returns all-None -> every gap, and every closeness
    # value, is None.
    assert any(v is not None for v in values), "closeness was all-None"


# --- /api/expr/series ---------------------------------------------------------

@pytest.mark.anyio
async def test_the_series_route_plots_a_shipped_instance(monkeypatch):
    from auto_trader.api import deps

    candles = _core_candles(200)

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        return candles

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    r = await _post("/api/expr/series", {
        "epic": "TEST", "resolution": "HOUR", "expr": "SLOPE.5 > 0",
        "fromTime": T0, "toTime": T0 + 199 * HOUR,
        "indicators": {"SLOPE": SLOPE_INSTANCE},
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert any(v is not None for v in body["values"])
    assert body["warmup"] == 8  # length 5 + slopePeriod 3


@pytest.mark.anyio
@pytest.mark.parametrize("pin", ["1H", "HOUR"])
async def test_a_pin_reaches_htf_sourcing_in_either_spelling(pin):
    # Production writes the canonical key ("HOUR"); an @tf token uses the alias.
    # Whichever spelling the pane holds, the sufficiency check must run.
    r = await _post("/api/expr/backtest", {
        **BASE,
        "indicators": {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                                 "extendData": {"slopePeriod": 3,
                                                "mtf": {"timeframe": pin}}}},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "htfCandles": {"HOUR": _candles(3)},
    })
    assert r.status_code == 422, r.text
    assert "not enough history for timeframe" in r.text


@pytest.mark.anyio
async def test_a_canonical_pin_runs_off_shipped_htf_candles():
    r = await _post("/api/expr/backtest", {
        **BASE,
        "indicators": {"SLOPE": CANON_PINNED_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "htfCandles": {"HOUR": _candles(200)},
    })
    assert r.status_code == 200, r.text


# --- an unresolvable pin is a 422, never a 500 --------------------------------
# Three sites turn a referenced timeframe into seconds. Guarding only one leaves
# the other two raising an uncaught ValueError out of resolution_seconds().

@pytest.mark.anyio
async def test_a_malformed_pin_422s_on_the_backtest_route():
    r = await _post("/api/expr/backtest", {
        **BASE,
        "indicators": {"SLOPE": BAD_PINNED_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
        "htfCandles": {"HOUR": _candles(200)},
    })
    assert r.status_code == 422, r.text
    assert "unsupported_timeframe" in r.text
    # Names the pane and the bad value so the user can fix the pane.
    assert "SLOPE" in r.text and "SECOND_5" in r.text


@pytest.mark.anyio
async def test_a_malformed_pin_422s_on_the_series_route(monkeypatch):
    from auto_trader.api import deps

    candles = _core_candles(200)

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        return candles

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    r = await _post("/api/expr/series", {
        "epic": "TEST", "resolution": "HOUR", "expr": "SLOPE.5 > 0",
        "fromTime": T0, "toTime": T0 + 199 * HOUR,
        "indicators": {"SLOPE": BAD_PINNED_INSTANCE},
    })
    assert r.status_code == 422, r.text
    assert "unsupported_timeframe" in r.text
    assert "SLOPE" in r.text and "SECOND_5" in r.text


@pytest.mark.anyio
async def test_a_malformed_pin_422s_on_the_closeness_route(monkeypatch):
    from auto_trader.api import deps

    candles = _core_candles(200)

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        return candles

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    r = await _post("/api/expr/closeness", {
        "epic": "TEST", "broker": "capital", "priceSide": "mid",
        "rows": ["SLOPE.5 > 0"], "combine": "AND",
        "baseResolution": "HOUR", "displayResolution": "HOUR",
        "fromTime": T0, "toTime": T0 + 199 * HOUR,
        "indicators": {"SLOPE": BAD_PINNED_INSTANCE},
    })
    assert r.status_code == 422, r.text
    assert "unsupported_timeframe" in r.text
    assert "SLOPE" in r.text and "SECOND_5" in r.text


def test_the_instance_map_survives_the_job_payload_round_trip():
    # Sweep/WFO workers get the request as JSON: sweep_worker.py rebuilds it with
    # ExprBacktestRequest.model_validate(req_dict). Excluding `indicators` from
    # that dump would silently break every worker while the route tests still
    # pass, so pin the boundary itself.
    from auto_trader.api.schemas import ExprBacktestRequest
    from auto_trader.api.sweep_apply import request_instances

    req = ExprBacktestRequest.model_validate({
        **BASE,
        "indicators": {"SLOPE": PINNED_INSTANCE},
        "longEntry": [{"expr": "SLOPE.5 > 0"}],
    })
    # Exactly the payload submit_expr_sweep_job / submit_expr_wfo_job build.
    req_dict = req.model_dump(mode="json", exclude={"htfCandles"})
    assert "indicators" in req_dict
    worker_req = ExprBacktestRequest.model_validate(req_dict)

    assert worker_req.indicators.keys() == {"SLOPE"}
    # Not just present — resolvable, with the settings intact on the far side.
    inst = request_instances(worker_req)["SLOPE"]
    assert inst.config.lengths == (5,)
    assert inst.config.slope_period == 3
    assert inst.spec.timeframe(inst.config) == "1H"


# --- literals labels (gap 5) --------------------------------------------------

def test_literal_labels_render_an_indicator_ref():
    from auto_trader.strategy.expr.literals import _render, literals
    from auto_trader.strategy.expr.parser import parse

    node = parse("slope(SLOPE.5, 5) > 0.5")
    assert _render(parse("SLOPE.5 > 0").left) == "SLOPE.5"
    labels = {lit.value: lit.label for lit in literals(node)}
    assert labels[5.0] == "slope window"
    assert labels[0.5] == "threshold"


def test_a_multiplier_of_an_indicator_ref_is_labelled_as_one():
    from auto_trader.strategy.expr.literals import literals
    from auto_trader.strategy.expr.parser import parse

    lits = literals(parse("2 * SLOPE.5 > 0.5"))
    assert lits[0].label == "multiplier of SLOPE.5"
