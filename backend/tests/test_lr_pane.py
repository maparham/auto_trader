import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "lr.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps([c["calcParams"], c["extendData"]]))
def test_lr_matches_the_typescript_series(case):
    spec = SERIES_INDICATORS["LR"]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert spec.outputs(cfg) == ("lr", "up", "dn")
    for output, want in case["values"].items():
        assert spec.warmup(cfg, output) == case["warmup"]
        got = spec.series(cfg, output, CANDLES, 1.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-9, abs=1e-12), (output, i)
        # Warm-up parity: the first value lands exactly at warmup - 1.
        first = next(i for i, v in enumerate(want) if v is not None)
        assert first == case["warmup"] - 1


def test_display_toggles_do_not_change_the_config():
    p = SERIES_INDICATORS["LR"].parse_config
    assert p([20, 2], {"lineHidden": {"up": True}, "hideLegendValue": True}) == p([20.0, 2], {})


def test_exotic_calc_params_fall_back_to_defaults():
    p = SERIES_INDICATORS["LR"].parse_config
    assert p(["Infinity"], {}) == p([], {})
    assert p([True], {}) == p([], {})


def test_series_rejects_an_unknown_output():
    cfg = SERIES_INDICATORS["LR"].parse_config([3, 1], {})
    with pytest.raises(ValueError):
        SERIES_INDICATORS["LR"].series(cfg, "bogus", CANDLES, 1.0)


def test_alert_spec():
    cfg = SERIES_INDICATORS["LR"].parse_config([50, 2], {"source": "hl2"})
    assert ALERT_SPECS["LR"].outputs(cfg) == {"lr": PRICE, "up": PRICE, "dn": PRICE}
    assert ALERT_SPECS["LR"].label(cfg, "lr") == "LR 50 hl2"
    assert ALERT_SPECS["LR"].label(cfg, "up") == "LR 50 hl2 upper"
    assert not ALERT_SPECS["LR"].heavy
