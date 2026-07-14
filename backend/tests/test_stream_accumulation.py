from __future__ import annotations

from auto_trader.api.routers.stream import _accum_params
from auto_trader.core.models import Resolution


def test_accum_params_native_minute():
    params = _accum_params("capital", "EURUSD", Resolution.MINUTE_5.value, "mid", is_ig=False)
    assert params is not None
    key, res_seconds = params
    assert key == ("capital", "EURUSD", "MINUTE_5", "mid")
    assert res_seconds == Resolution.MINUTE_5.seconds


def test_accum_params_seconds_returns_none():
    assert _accum_params("capital", "EURUSD", "SECOND_10", "mid", is_ig=False) is None


def test_accum_params_derived_uses_base_key():
    # 3m derives from 1m; MONTH derives from DAY. Enrollment targets the base series.
    params = _accum_params("capital", "EURUSD", "MINUTE_3", "mid", is_ig=False)
    assert params is not None
    key, res_seconds = params
    assert key == ("capital", "EURUSD", "MINUTE", "mid")
    assert res_seconds == Resolution.MINUTE.seconds
