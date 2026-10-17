import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_series import (
    MAX_WARMUP, IndicatorKey, compute, config_json, config_of, heavy, key_of, line_key, min_bars,
    projects_intrabar, sparse, warmup,
)
from auto_trader.indicators.alert_specs import ALERT_SPECS
from auto_trader.indicators.registry import SERIES_INDICATORS

_VALUES = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "values.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in _VALUES["candles"]
]


def test_every_alert_spec_is_a_registry_type():
    assert set(ALERT_SPECS) <= set(SERIES_INDICATORS)
    assert set(ALERT_SPECS) == {
        "MA", "EMA", "RSI", "ATR", "TRENDLINES", "SLOPE", "FVG", "PIVOT_BANDS",
        "PIVOT_ANALYSIS", "SR_LEVELS", "SPIKE", "AUTO_FIB", "LR",
    }


@pytest.mark.parametrize("t", sorted(ALERT_SPECS))
def test_config_round_trips_through_json(t):
    cfg = SERIES_INDICATORS[t].parse_config(None, None)
    raw = config_json(cfg)
    json.loads(raw)  # strict JSON: config_json uses allow_nan=False
    assert config_of(t, raw) == cfg


@pytest.mark.parametrize("t", sorted(ALERT_SPECS))
def test_alert_outputs_are_registry_outputs(t):
    cfg = SERIES_INDICATORS[t].parse_config(None, None)
    outs = ALERT_SPECS[t].outputs(cfg)
    assert outs, t
    assert set(outs) <= set(SERIES_INDICATORS[t].outputs(cfg))
    for name in outs:
        assert ALERT_SPECS[t].label(cfg, name)


def test_parsing_ignores_unknown_extend_data_and_number_spelling():
    a = SERIES_INDICATORS["RSI"].parse_config([14], {"source": "hl2", "hideLegendValue": True})
    b = SERIES_INDICATORS["RSI"].parse_config([14.0], {"source": "hl2"})
    assert config_json(a) == config_json(b)


def test_labels_keep_todays_wording():
    p = lambda t, c, e: SERIES_INDICATORS[t].parse_config(c, e)  # noqa: E731
    assert ALERT_SPECS["MA"].label(p("MA", [20], {"maType": "ema"}), "ma") == "EMA 20"
    assert ALERT_SPECS["MA"].label(p("MA", [20], {"source": "hl2"}), "ma") == "SMA 20 hl2"
    assert ALERT_SPECS["RSI"].label(p("RSI", [14], {}), "value") == "RSI 14"
    assert ALERT_SPECS["RSI"].label(p("RSI", [14], {"source": "hl2"}), "value") == "RSI 14 hl2"
    assert ALERT_SPECS["ATR"].label(p("ATR", [14], {}), "14") == "ATR 14"
    assert ALERT_SPECS["ATR"].label(p("ATR", [14], {"smoothing": "ema"}), "14") == "ATR 14 ema"
    assert ALERT_SPECS["TRENDLINES"].label(p("TRENDLINES", [], {}), "tl_nearest") == "Trendlines nearest"
    fib = p("AUTO_FIB", [], {})
    assert ALERT_SPECS["AUTO_FIB"].label(fib, "f0_618") == "Auto fib 0.618"
    assert ALERT_SPECS["AUTO_FIB"].label(fib, "fm0_236") == "Auto fib -0.236"


def test_output_kinds():
    rsi = ALERT_SPECS["RSI"].outputs(SERIES_INDICATORS["RSI"].parse_config(None, None))
    assert rsi["value"].kind == "level" and not rsi["value"].price_scale
    assert rsi["bullDiv"].kind == "event"
    tl = ALERT_SPECS["TRENDLINES"].outputs(SERIES_INDICATORS["TRENDLINES"].parse_config(None, None))
    assert list(tl) == ["tl_nearest"] and tl["tl_nearest"].price_only
    ma = ALERT_SPECS["MA"].outputs(SERIES_INDICATORS["MA"].parse_config([20], {"envelope": True}))
    assert list(ma) == ["ma", "bandHi", "bandLo"] and all(o.price_scale for o in ma.values())


def _key(t, calc, ext, output, bar_hours=1.0):
    cfg = SERIES_INDICATORS[t].parse_config(calc, ext)
    return IndicatorKey(t, config_json(cfg), output, bar_hours)


def test_compute_matches_the_registry_series():
    k = _key("RSI", [14], {}, "value")
    cfg = SERIES_INDICATORS["RSI"].parse_config([14], {})
    assert compute(k, CANDLES) == {"value": SERIES_INDICATORS["RSI"].series(cfg, "value", CANDLES, 1.0)}


def test_trendlines_nearest_carries_its_side_series():
    out = compute(_key("TRENDLINES", [], {}, "tl_nearest"), CANDLES)
    assert set(out) == {"value", "held", "slope", "a1", "a2"}
    assert len(out["value"]) == len(CANDLES)


def test_line_key_compute():
    t0 = int(CANDLES[10].time.timestamp() * 1000)
    out = compute(line_key(t0, 100.0, 0.5), CANDLES)["value"]
    assert out[9] is None and out[10] == 100.0 and out[12] == 101.0


def test_flags():
    tl = _key("TRENDLINES", [], {}, "tl_nearest")
    rsi = _key("RSI", [14], {}, "value")
    sr = _key("SR_LEVELS", [], {}, "support")
    assert heavy(tl) and projects_intrabar(tl) and sparse(tl)
    assert not heavy(rsi) and not projects_intrabar(rsi) and not sparse(rsi)
    assert heavy(sr) and not projects_intrabar(sr) and sparse(sr)
    assert warmup(rsi) == warmup(tl) == MAX_WARMUP
    assert min_bars(rsi) == SERIES_INDICATORS["RSI"].warmup(SERIES_INDICATORS["RSI"].parse_config([14], {}), "value")
    assert min_bars(line_key(1, 1.0, 0.0)) == 1


def test_key_of_reads_stored_params():
    cfg = SERIES_INDICATORS["ATR"].parse_config([14], {})
    params = {"type": "ATR", "config": json.loads(config_json(cfg)), "output": "14", "timeframe": "HOUR"}
    k = key_of(params)
    assert k.indicator == "ATR" and k.output == "14" and k.bar_hours == 1.0
    assert k == key_of({**params, "config": dict(reversed(list(params["config"].items())))})
