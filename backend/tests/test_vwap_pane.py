import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "vwap.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps(c["extendData"]))
def test_vwap_matches_the_chart(case):
    spec = SERIES_INDICATORS["VWAP"]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert spec.outputs(cfg) == ("vwap",)
    want = case["values"]["vwap"]
    got = spec.series(cfg, "vwap", CANDLES, 1.0)
    assert len(got) == len(want)
    for i, (g, w) in enumerate(zip(got, want)):
        if w is None:
            assert g is None, i
        else:
            assert g == pytest.approx(w, rel=1e-9, abs=1e-12), i
    # Warm-up parity: blank exactly while cumulative volume is 0 (bars 0..2).
    assert [i for i, v in enumerate(want) if v is None] == [0, 1, 2]
    assert spec.warmup(cfg, "vwap") == 0


def test_no_volume_is_blank():
    flat = [Candle(c.time, c.open, c.high, c.low, c.close, 0.0) for c in CANDLES[:20]]
    cfg = SERIES_INDICATORS["VWAP"].parse_config([], {})
    assert SERIES_INDICATORS["VWAP"].series(cfg, "vwap", flat, 1.0) == [None] * 20


def test_alert_spec():
    cfg = SERIES_INDICATORS["VWAP"].parse_config([], {})
    alert = ALERT_SPECS["VWAP"]
    assert alert.outputs(cfg) == {"vwap": PRICE}
    assert alert.label(cfg, "vwap") == "VWAP"
    assert alert.needs_volume(cfg) and alert.sparse and not alert.heavy
