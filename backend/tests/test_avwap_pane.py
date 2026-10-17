import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.alert_kinds import IndicatorKind
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.core import avwap_series
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "avwap.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps([c["calcParams"], c["extendData"]]))
def test_avwap_matches_the_chart(case):
    spec = SERIES_INDICATORS["AVWAP"]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert list(spec.outputs(cfg)) == list(case["values"])
    for output, want in case["values"].items():
        got = spec.series(cfg, output, CANDLES, 1.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-9, abs=1e-12), (output, i)
        assert spec.warmup(cfg, output) == 0


def test_bands_pin_up1_dn1_in_stdev_and_percentage_mode():
    """vwap_from's bands are otherwise exercised only generically (every output
    of every fixture case, above); pin them explicitly here. Case 1 is stdev
    mode (the default); case 2 sets bandMode to percentage."""
    stdev_case = FIXTURE["cases"][1]
    pct_case = FIXTURE["cases"][2]
    assert "bandMode" not in stdev_case["extendData"]
    assert pct_case["extendData"]["bandMode"] == "percentage"
    for case in (stdev_case, pct_case):
        cfg = SERIES_INDICATORS["AVWAP"].parse_config(case["calcParams"], case["extendData"])
        for output in ("up1", "dn1"):
            got = SERIES_INDICATORS["AVWAP"].series(cfg, output, CANDLES, 1.0)
            want = case["values"][output]
            assert len(got) == len(want)
            for i, (g, w) in enumerate(zip(got, want)):
                if w is None:
                    assert g is None, (output, i)
                else:
                    assert g == pytest.approx(w, rel=1e-9, abs=1e-12), (output, i)


def test_hlc3_line_equals_the_expr_function():
    anchor = FIXTURE["candles"][50][0]
    cfg = SERIES_INDICATORS["AVWAP"].parse_config([anchor], {})
    assert SERIES_INDICATORS["AVWAP"].series(cfg, "vwap", CANDLES, 1.0) == avwap_series(CANDLES, anchor)


def test_display_keys_do_not_change_the_config():
    p = SERIES_INDICATORS["AVWAP"].parse_config
    assert p([5.0], {"lineHidden": {"vwap": True}, "slopeColor": {"enabled": True}}) == p([5], {})


def test_unplaced_anchor_refuses():
    cfg = SERIES_INDICATORS["AVWAP"].parse_config([0], {})
    assert IndicatorKind.refusal_for("AVWAP", cfg, "HOUR") == "Place the AVWAP anchor on the chart first"


def test_alert_spec():
    cfg = SERIES_INDICATORS["AVWAP"].parse_config([1], {"source": "close", "bands": [
        {"on": True, "mult": 1}, {"on": False, "mult": 2}, {"on": True, "mult": 3}]})
    alert = ALERT_SPECS["AVWAP"]
    assert alert.outputs(cfg) == {"vwap": PRICE, "up1": PRICE, "dn1": PRICE, "up3": PRICE, "dn3": PRICE}
    assert alert.label(cfg, "vwap") == "AVWAP close"
    assert alert.label(cfg, "dn3") == "AVWAP close lower band 3"
    assert alert.needs_volume(cfg) and alert.sparse
