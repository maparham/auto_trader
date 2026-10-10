import pytest

from auto_trader.indicators import alertable as A


def key(ind, calc, **cfg):
    return A.IndicatorKey(ind, tuple(calc), tuple(sorted(cfg.items())))


def test_validate_fills_defaults():
    assert A.validate_indicator("MA", [50], {"maType": "ema"}, "value", "price") == {
        "maType": "ema", "source": "close",
    }
    assert A.validate_indicator("ATR", [14], {}, "value", "value") == {"smoothing": "rma"}


@pytest.mark.parametrize("args,msg", [
    (("BOLL", [20, 2], {}, "upper", "price"), "not alertable"),
    (("MA", [0], {"maType": "ema"}, "value", "price"), "calcParams"),
    (("MA", [50.5], {"maType": "ema"}, "value", "price"), "calcParams"),
    (("MA", [50], {"maType": "hull"}, "value", "price"), "maType"),
    (("MA", [50], {"maType": "ema", "bogus": "x"}, "value", "price"), "config.bogus"),
    (("MA", [50], {"maType": "ema"}, "upper", "price"), "line"),
    (("RSI", [14], {}, "value", "price"), "target"),
    (("RSI", [1], {}, "value", "value"), "calcParams"),
    (("MA", [50, 1], {"maType": "ema"}, "value", "price"), "calcParams"),
    (("MA", [True], {"maType": "ema"}, "value", "price"), "calcParams"),
])
def test_validate_rejects(args, msg):
    with pytest.raises(ValueError, match=msg):
        A.validate_indicator(*args)


def test_warmup_rejects_too_long():
    with pytest.raises(ValueError, match="too long"):
        A.validate_indicator("RSI", [400], {}, "value", "value")


def test_warmup_figures():
    assert A.warmup(key("MA", [20], maType="sma", source="close")) == 20
    assert 170 <= A.warmup(key("MA", [50], maType="ema", source="close")) <= 180
    assert A.warmup(key("RSI", [14], source="close")) > A.warmup(key("MA", [14], maType="ema", source="close"))


def test_compute_and_label():
    from datetime import datetime, timedelta, timezone
    from auto_trader.core.models import Candle
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    bars = [Candle(t0 + timedelta(hours=i), 1, 2, 0.5, float(i), 10) for i in range(30)]
    out = A.compute(key("MA", [3], maType="sma", source="close"), bars)
    assert out["value"][-1] == pytest.approx((27 + 28 + 29) / 3)
    assert A.indicator_label(key("MA", [50], maType="ema", source="close")) == "EMA 50"
    assert A.indicator_label(key("MA", [50], maType="sma", source="hl2")) == "SMA 50 hl2"
    assert A.indicator_label(key("RSI", [14], source="close")) == "RSI 14"
    assert A.volume_weighted(key("MA", [5], maType="vwma", source="close"))
