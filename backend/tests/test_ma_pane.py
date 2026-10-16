import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.ma import ma_outputs, ma_warmup, parse_ma_config
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "ma_pane.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: f"{c['type']}-{json.dumps(c['extendData'])}")
def test_ma_pane_matches_the_chart(case):
    spec = SERIES_INDICATORS[case["type"]]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert set(spec.outputs(cfg)) == set(case["values"])
    for output, want in case["values"].items():
        got = spec.series(cfg, output, CANDLES, 1.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-9, abs=1e-12), (output, i)


def test_template_defaults():
    assert parse_ma_config([], {}, template="ema").length == 9
    assert parse_ma_config([], {}, template="sma").length == 20
    assert parse_ma_config([20], {"maType": "bogus"}, template="ema").ma_type == "ema"
    assert parse_ma_config([20], {"source": "bogus"}, template="sma").source == "close"


def test_pinned_pane_has_no_bands_and_reports_its_pin():
    cfg = parse_ma_config([20], {"envelope": True, "mtf": {"timeframe": "HOUR_4", "htfSeries": [1, 2]}}, template="sma")
    assert cfg.timeframe == "HOUR_4"
    assert ma_outputs(cfg) == ("ma",)
    assert SERIES_INDICATORS["MA"].timeframe(cfg) == "HOUR_4"


def test_warmup():
    cfg = parse_ma_config([20], {"offset": 3, "smoothing": {"type": "ema", "length": 5}}, template="sma")
    assert ma_warmup(cfg, "ma") == 23
    assert ma_warmup(cfg, "smoothingMa") == 25
    assert ma_warmup(cfg, "bandHi") == 0
