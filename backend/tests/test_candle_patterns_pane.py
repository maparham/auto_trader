import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, EVENT
from auto_trader.indicators.candle_patterns import CANDLE_PATTERN_DEFS
from auto_trader.indicators.candle_patterns_pane import (
    CANDLE_PATTERNS_WARMUP, PATTERN_LABELS, PATTERN_TOGGLES,
)
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.strategy.expr.warmup import PATTERN_WARMUP

FIXTURES = Path(__file__).parent / "fixtures"
PANE = json.loads((FIXTURES / "indicator_parity" / "candle_patterns_pane.json").read_text())
T0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
BARS = [
    Candle(time=T0 + timedelta(minutes=i), open=b["open"], high=b["high"], low=b["low"], close=b["close"])
    for i, b in enumerate(json.loads((FIXTURES / "candle_patterns_golden.json").read_text())["bars"])
]


def test_tables_match_the_typescript_defs():
    assert [d.id for d in CANDLE_PATTERN_DEFS] == [d["id"] for d in PANE["defs"]]
    assert PATTERN_TOGGLES == {d["id"]: d["toggle"] for d in PANE["defs"]}
    assert PATTERN_LABELS == {d["id"]: d["label"] for d in PANE["defs"]}


@pytest.mark.parametrize("case", PANE["cases"], ids=lambda c: json.dumps(c["extendData"]))
def test_gated_series_match_the_chart(case):
    spec = SERIES_INDICATORS["CANDLE_PATTERNS"]
    cfg = spec.parse_config([], case["extendData"])
    assert list(spec.outputs(cfg)) == list(case["values"])
    for output, want in case["values"].items():
        assert spec.series(cfg, output, BARS, 1.0) == [float(v) for v in want], output
        assert spec.warmup(cfg, output) == PATTERN_WARMUP


def test_aggregate_respects_toggles():
    spec = SERIES_INDICATORS["CANDLE_PATTERNS"]
    off = spec.parse_config([], {"disabled": {"engulfing": True}})
    agg = spec.series(off, "bullPattern", BARS, 1.0)
    bull = [d.id for d in CANDLE_PATTERN_DEFS if d.polarity == "bull" and PATTERN_TOGGLES[d.id] != "engulfing"]
    rows = [spec.series(off, i, BARS, 1.0) for i in bull]
    assert agg == [1.0 if any(r[k] == 1.0 for r in rows) else 0.0 for k in range(len(BARS))]
    assert "bull_engulfing" not in spec.outputs(off)


def test_config_is_canonical():
    p = SERIES_INDICATORS["CANDLE_PATTERNS"].parse_config
    assert p(None, {"disabled": {"doji": True, "star": False, "bogus": True}, "showLabels": False}) == p(None, {"disabled": {"doji": 1}})
    assert CANDLE_PATTERNS_WARMUP == PATTERN_WARMUP


def test_alert_spec():
    cfg = SERIES_INDICATORS["CANDLE_PATTERNS"].parse_config([], {})
    alert = ALERT_SPECS["CANDLE_PATTERNS"]
    outs = alert.outputs(cfg)
    assert len(outs) == 26 and all(o == EVENT for o in outs.values())
    assert alert.label(cfg, "morning_star") == "Morning Star"
    assert alert.label(cfg, "bearPattern") == "Any bearish pattern"
    assert alert.heavy and not alert.sparse
