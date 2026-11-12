from datetime import datetime, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.core.position_alert_kind import (
    POSITION_KIND, atr, data_broker_of, headline, is_watchable, step, watched_price,
)


def P(**kw):
    base = {"dealId": "D1", "side": "sl", "atrMult": 0.5}
    base.update(kw)
    return base


def bar(i: int, high: float, low: float, close: float) -> Candle:
    return Candle(
        time=datetime(2026, 11, 12, tzinfo=timezone.utc).replace(minute=i % 60),
        open=close, high=high, low=low, close=close, volume=1.0,
    )


# validate ---------------------------------------------------------------

def test_validate_accepts_default_shape():
    POSITION_KIND.validate(P())


def test_validate_rejects_bad_side():
    with pytest.raises(ValueError):
        POSITION_KIND.validate(P(side="x"))


@pytest.mark.parametrize("mult", [0, 0.04, 5.1, float("nan"), float("inf"), float("-inf"), True, False, "0.5", None])
def test_validate_rejects_mult_out_of_range_or_wrong_type(mult):
    with pytest.raises(ValueError):
        POSITION_KIND.validate(P(atrMult=mult))


@pytest.mark.parametrize("mult", [0.05, 5, 0.5])
def test_validate_accepts_mult_bounds(mult):
    POSITION_KIND.validate(P(atrMult=mult))


@pytest.mark.parametrize("deal", ["", "x" * 129, 42, None])
def test_validate_rejects_bad_deal_id(deal):
    with pytest.raises(ValueError):
        POSITION_KIND.validate(P(dealId=deal))


def test_validate_accepts_128_char_deal_id():
    POSITION_KIND.validate(P(dealId="x" * 128))


def test_validate_missing_keys_raise_value_error():
    with pytest.raises(ValueError):
        POSITION_KIND.validate({})


# sig --------------------------------------------------------------------

def test_sig_ignores_mult():
    assert POSITION_KIND.sig(P(atrMult=0.5)) == POSITION_KIND.sig(P(atrMult=2))


def test_sig_differs_by_side_and_deal():
    assert POSITION_KIND.sig(P(side="sl")) != POSITION_KIND.sig(P(side="tp"))
    assert POSITION_KIND.sig(P(dealId="D1")) != POSITION_KIND.sig(P(dealId="D2"))


def test_sig_is_json_pair():
    assert POSITION_KIND.sig(P()) == '["D1", "sl"]'


# account routing --------------------------------------------------------

def test_data_broker_of_strips_exec_suffix():
    assert data_broker_of("capital-live:live") == "capital-live"
    assert data_broker_of("capital:paper") == "capital"


def test_is_watchable():
    assert is_watchable("capital-live:live")
    assert is_watchable("mt5-self:live")
    assert is_watchable("capital:paper")
    assert not is_watchable("mt5:live")


# watched price ----------------------------------------------------------

def test_watched_price_long_uses_bid_short_uses_ask():
    assert watched_price("BUY", 9, 11) == 9
    assert watched_price("SELL", 9, 11) == 11


def test_watched_price_falls_back_to_other_side():
    assert watched_price("BUY", None, 11) == 11
    assert watched_price("SELL", 9, None) == 9


def test_watched_price_none_when_no_quote():
    assert watched_price("BUY", None, None) is None


# step -------------------------------------------------------------------

def test_step_fires_inside_on_first_tick():
    assert step(100, 104, 5, False) == (True, True)


def test_step_fires_on_the_boundary():
    assert step(100, 105, 5, False) == (True, True)


def test_step_no_refire_while_inside():
    assert step(100, 103, 5, True) == (True, False)


def test_step_hysteresis():
    assert step(100, 107, 5, True) == (True, False)
    assert step(100, 107.6, 5, True) == (False, False)


def test_step_outside_unfired_stays_unfired():
    assert step(100, 120, 5, False) == (False, False)


def test_step_works_for_both_directions():
    assert step(100, 96, 5, False) == (True, True)


# atr --------------------------------------------------------------------

def test_atr_wilder_constant_range():
    candles = [bar(i, 101, 99, 100) for i in range(15)]
    assert atr(candles) == pytest.approx(2.0)


def test_atr_first_candle_range_is_not_a_true_range():
    candles = [bar(0, 200, 0, 100)] + [bar(i, 101, 99, 100) for i in range(1, 15)]
    assert atr(candles) == pytest.approx(2.0)


def test_atr_wilder_smoothing_step():
    # 14 TRs of 2 seed the ATR at 2.0; the 16th bar has TR 16:
    # (2 * 13 + 16) / 14 = 3.0
    candles = [bar(i, 101, 99, 100) for i in range(15)] + [bar(15, 108, 92, 100)]
    assert atr(candles) == pytest.approx(3.0)


def test_atr_uses_prev_close_for_gaps():
    # bar 1 gaps up: prev close 100, high 111, low 109 -> TR = 11 (not 2)
    candles = [bar(0, 101, 99, 100), bar(1, 111, 109, 110)] + [bar(i, 111, 109, 110) for i in range(2, 15)]
    # seed mean of 14 TRs: one TR of 11 (bar 1) and thirteen of 2 -> (11 + 26) / 14 = 37/14
    assert atr(candles) == pytest.approx(37 / 14)


def test_atr_none_when_short():
    candles = [bar(i, 101, 99, 100) for i in range(14)]
    assert atr(candles) is None


def test_atr_custom_length():
    candles = [bar(i, 101, 99, 100) for i in range(4)]
    assert atr(candles, length=3) == pytest.approx(2.0)


# headline ---------------------------------------------------------------

def test_headline():
    assert headline("US100", "BUY", "sl", 18210.0, 18222.4, 32.63, -84.2, "USD", 1) == (
        "US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18210.0 · P&L -84.20 USD"
    )


def test_headline_without_currency_drops_suffix():
    assert headline("US100", "BUY", "sl", 18210.0, 18222.4, 32.63, -84.2, None, 1) == (
        "US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18210.0 · P&L -84.20"
    )


def test_headline_without_upnl_drops_pnl_part():
    assert headline("US100", "BUY", "sl", 18210.0, 18222.4, 32.63, None, "USD", 1) == (
        "US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18210.0"
    )


def test_headline_short_tp():
    assert headline("US100", "SELL", "tp", 18000.0, 17990.0, 20.0, None, None, 1) == (
        "US100 short · near TP · 10.0 pts (0.50 ATR) away · TP 18000.0"
    )
