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


from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.trendlines import (
    TL_DEFAULT_PARAMS, TL_SLOT_FIELDS, parse_trendlines_config, trendlines_config_params,
)

H = 3_600_000


def hc(ms, close):
    return Candle(datetime.fromtimestamp(ms / 1000, tz=timezone.utc), close, close, close, close, 1.0)


def test_trendlines_validate_accepts_canonical_only():
    assert len(TL_DEFAULT_PARAMS) == len(TL_SLOT_FIELDS) == 33
    assert A.validate_indicator("TRENDLINES", list(TL_DEFAULT_PARAMS), {}, "value", "price") == {}
    short = list(TL_DEFAULT_PARAMS)[:5]
    with pytest.raises(ValueError, match="Trendlines settings"):
        A.validate_indicator("TRENDLINES", short, {}, "value", "price")
    bad = list(TL_DEFAULT_PARAMS)
    bad[2] = 1  # min_touches parses to 2, so 1 is not canonical
    with pytest.raises(ValueError, match="canonical"):
        A.validate_indicator("TRENDLINES", bad, {}, "value", "price")
    with pytest.raises(ValueError, match="target"):
        A.validate_indicator("TRENDLINES", list(TL_DEFAULT_PARAMS), {}, "value", "value")
    with pytest.raises(ValueError, match="config"):
        A.validate_indicator("TRENDLINES", list(TL_DEFAULT_PARAMS), {"x": "y"}, "value", "price")


def test_trendlines_validate_applies_warmup_cap():
    # min_bars = ATR 14 + 2 * pivot_len + min_span_bars, so a canonical but
    # huge min span must 422 like an over-long MA does. If the parser clamps
    # min_span_bars below the cap, raise pivot_len instead (same slot list).
    huge = list(TL_DEFAULT_PARAMS)
    huge[TL_SLOT_FIELDS.index("min_span_bars")] = A.MAX_WARMUP
    canon = trendlines_config_params(parse_trendlines_config(huge, {}))
    assert A.min_bars(A.IndicatorKey("TRENDLINES", tuple(canon), ())) > A.MAX_WARMUP
    with pytest.raises(ValueError, match="too long"):
        A.validate_indicator("TRENDLINES", canon, {}, "value", "price")


def test_line_and_trendlines_warmup_min_bars_and_sparse():
    tl = A.IndicatorKey("TRENDLINES", tuple(TL_DEFAULT_PARAMS), ())
    ln = A.line_key(10 * H, 100.0, 0.5)
    assert A.warmup(tl) == A.MAX_WARMUP and A.warmup(ln) == A.MAX_WARMUP
    assert A.min_bars(tl) == 14 + 2 * 5 + 20  # trendlines_warmup on the defaults
    assert A.min_bars(ln) == 1
    assert A.sparse(tl) and not A.sparse(ln)
    assert A.indicator_label(tl) == "Trendlines nearest"


def test_line_compute_projects_from_the_reference_bar():
    bars = [hc(h * H, 1.0) for h in range(5, 12)]
    out = A.compute(A.line_key(8 * H, 100.0, 0.5), bars)["value"]
    assert out == [None, None, None, 100.0, 100.5, 101.0, 101.5]
    assert A.compute(A.line_key(99 * H, 100.0, 0.5), bars)["value"] == [None] * 7


def test_line_compute_counts_bars_across_a_gap():
    # Fri 20:00..21:00, then Mon 00:00..01:00: the slope is per BAR.
    fri = int(datetime(2026, 10, 9, 20, tzinfo=timezone.utc).timestamp() * 1000)
    mon = int(datetime(2026, 10, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
    bars = [hc(fri, 1), hc(fri + H, 1), hc(mon, 1), hc(mon + H, 1)]
    assert A.compute(A.line_key(fri, 10.0, 1.0), bars)["value"] == [10.0, 11.0, 12.0, 13.0]


def test_trendlines_held_equals_value_while_the_nearest_line_is_unchanged():
    from tests.test_indicator_parity import _ALERTABLE_CANDLES as candles
    out = A.compute(A.IndicatorKey("TRENDLINES", tuple(TL_DEFAULT_PARAMS), ()), candles)
    assert any(v is not None for v in out["value"])
    same = 0
    for i in range(1, len(candles)):
        if out["a1"][i] is not None and (out["a1"][i], out["a2"][i]) == (out["a1"][i - 1], out["a2"][i - 1]):
            assert out["held"][i] == pytest.approx(out["value"][i], rel=1e-12)
            assert out["value"][i] - out["value"][i - 1] == pytest.approx(out["slope"][i], rel=1e-9, abs=1e-12)
            same += 1
    assert same > 0
