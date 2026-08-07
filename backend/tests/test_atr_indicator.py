"""ATR pane instance refs resolution and evaluation."""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.atr import (
    AtrConfig, atr_outputs, atr_warmup, parse_atr_config, atr_pane_series,
)
from auto_trader.indicators.core import atr_series, atr_smoothed_series
from auto_trader.indicators.registry import SERIES_INDICATORS, resolve_instances

FIXTURE = Path(__file__).parent / "fixtures" / "indicator_golden.json"


@pytest.fixture(scope="module")
def golden():
    """Load golden fixture from indicator_golden.json."""
    data = json.loads(FIXTURE.read_text())
    candles = [
        Candle(
            time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
            open=c["open"], high=c["high"], low=c["low"], close=c["close"],
            volume=c["volume"],
        )
        for c in data["candles"]
    ]
    return candles, data["anchorMs"], data["series"]


def test_parse_defaults_and_fallbacks():
    assert parse_atr_config(None, None) == AtrConfig(length=14, smoothing="rma")
    assert parse_atr_config([], {}) == AtrConfig(length=14, smoothing="rma")
    assert parse_atr_config(["garbage"], {"smoothing": "vwma"}) == AtrConfig(14, "rma")
    assert parse_atr_config([21.9], {"smoothing": "ema"}) == AtrConfig(21, "ema")
    # Zero falls back to 14
    assert parse_atr_config([0], {}) == AtrConfig(14, "rma")
    # Negative stays negative
    assert parse_atr_config([-5], {}) == AtrConfig(-5, "rma")
    # Non-finite values (inf, -inf, nan) fall back to 14
    assert parse_atr_config([float("inf")], {}) == AtrConfig(14, "rma")
    assert parse_atr_config([float("-inf")], {}) == AtrConfig(14, "rma")
    assert parse_atr_config([float("nan")], {}) == AtrConfig(14, "rma")


def test_outputs_named_by_length():
    assert atr_outputs(AtrConfig(14, "rma")) == ("14",)
    assert atr_outputs(AtrConfig(21, "wma")) == ("21",)


def test_warmup_is_the_length():
    cfg = AtrConfig(21, "ema")
    assert atr_warmup(cfg, "21") == 21
    assert atr_warmup(cfg, "bogus") == 0


def test_series_matches_core(golden):
    candles, _, _ = golden
    rma = atr_pane_series(AtrConfig(14, "rma"), "14", candles, 1.0)
    assert rma == atr_series(candles, 14)
    ema = atr_pane_series(AtrConfig(14, "ema"), "14", candles, 1.0)
    assert ema == atr_smoothed_series(candles, 14, "ema")


def test_registered_and_resolvable():
    spec = SERIES_INDICATORS["ATR"]
    resolved = resolve_instances(
        {"ATR#x1": {"type": "ATR", "calcParams": [21], "extendData": {"smoothing": "sma"}}}
    )
    inst = resolved["ATR#x1"]
    assert inst.type == "ATR"
    assert inst.config == AtrConfig(21, "sma")
    assert spec.outputs(inst.config) == ("21",)
    assert spec.timeframe(inst.config) is None
