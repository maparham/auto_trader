import pytest

from auto_trader.core.account_alert_kind import (
    ACCOUNT_KIND, account_label, crossed_now, evaluate_tiers, fmt_value, headline, hysteresis,
    is_monitorable, near_tier,
)

TIERS = [{"level": 150, "label": "warn"}, {"level": 120, "label": "danger"}, {"level": 100, "label": "critical"}]


def P(**kw):
    base = {"metric": "marginLevel", "tiers": TIERS}
    base.update(kw)
    return base


def test_validate_accepts_margin_tiers():
    ACCOUNT_KIND.validate(P())


@pytest.mark.parametrize("bad", [
    P(metric="leverage"),
    P(tiers=[]),
    P(tiers=TIERS + [{"level": 90, "label": "warn"}]),
    P(tiers=[{"level": 100, "label": "critical"}, {"level": 120, "label": "danger"}]),  # wrong order
    P(tiers=[{"level": 100, "label": "boom"}]),
    P(tiers=[{"level": float("nan"), "label": "warn"}]),
    P(metric="drawdown", tiers=[{"level": 10, "label": "danger"}, {"level": 5, "label": "warn"}]),  # drawdown ascends
    P(metric="drawdown", tiers=[{"level": 5, "label": "warn"}], baseline="weekly"),
])
def test_validate_rejects(bad):
    with pytest.raises(ValueError):
        ACCOUNT_KIND.validate(bad)


def test_drawdown_requires_baseline_and_ascending_tiers():
    ACCOUNT_KIND.validate(P(metric="drawdown", baseline="daily",
                            tiers=[{"level": 5, "label": "warn"}, {"level": 10, "label": "danger"}]))
    with pytest.raises(ValueError):
        ACCOUNT_KIND.validate(P(metric="drawdown", tiers=[{"level": 5, "label": "warn"}]))


def test_sig_ignores_labels_and_order_of_keys():
    a = ACCOUNT_KIND.sig(P())
    b = ACCOUNT_KIND.sig(P(tiers=[{"label": "x", "level": 150}, {"level": 120, "label": "y"}, {"level": 100, "label": "z"}]))
    assert a == b
    assert ACCOUNT_KIND.sig(P(tiers=TIERS[:2])) != a
    assert ACCOUNT_KIND.sig(P(metric="equity")) != a


def test_monitorable():
    assert is_monitorable("capital-live:live", "live")
    assert is_monitorable("capital:demo", "demo")
    assert is_monitorable("ig-demo:demo", "demo")
    assert not is_monitorable("capital:paper", "paper")
    assert not is_monitorable("mt5:live", "live")
    assert not is_monitorable("mt5-self:live", "live")


def test_account_label():
    assert account_label("capital-live:live") == "Capital live"
    assert account_label("ig-demo:demo") == "IG demo"
    assert account_label("weird:env") == "weird:env"


def test_hysteresis():
    assert hysteresis("marginLevel", 120) == 3
    assert hysteresis("drawdown", 10) == 3
    assert hysteresis("equity", 5000) == 100
    assert hysteresis("openPnl", -500) == 10


def test_falling_metric_fires_most_severe_once():
    fired, newly = evaluate_tiers("marginLevel", TIERS, 110.0, set())
    assert fired == {150, 120} and newly == 120
    fired, newly = evaluate_tiers("marginLevel", TIERS, 110.0, fired)
    assert newly is None and fired == {150, 120}


def test_rearm_needs_hysteresis():
    fired = {150, 120}
    fired, newly = evaluate_tiers("marginLevel", TIERS, 122.0, fired)
    assert fired == {150, 120} and newly is None          # within 3 points, still fired
    fired, newly = evaluate_tiers("marginLevel", TIERS, 123.5, fired)
    assert fired == {150} and newly is None               # re-armed 120
    fired, newly = evaluate_tiers("marginLevel", TIERS, 119.0, fired)
    assert newly == 120                                   # fires again


def test_drawdown_rises():
    tiers = [{"level": 5, "label": "warn"}, {"level": 10, "label": "danger"}]
    fired, newly = evaluate_tiers("drawdown", tiers, 6.0, set())
    assert fired == {5} and newly == 5
    fired, newly = evaluate_tiers("drawdown", tiers, 1.5, fired)
    assert fired == set()


def test_crossed_now_seeds_without_firing():
    assert crossed_now("marginLevel", TIERS, 130.0) == {150}
    assert crossed_now("drawdown", [{"level": 5, "label": "warn"}], 2.0) == set()


def test_near_tier():
    assert near_tier("marginLevel", TIERS, 175.0, set())          # 150 within 20% of 150
    assert not near_tier("marginLevel", TIERS, 190.0, set())
    assert near_tier("marginLevel", TIERS, 130.0, {150})          # next unfired is 120
    assert not near_tier("marginLevel", TIERS, 90.0, {150, 120, 100})  # none left
    assert near_tier("openPnl", [{"level": -500, "label": "warn"}], -420.0, set())


def test_fmt_value_rounds_before_deciding_whether_to_show_a_fraction():
    # Float noise from the equity/margin arithmetic (1100.0/1000.0*100) must
    # not force a spurious ".0" onto what is really a whole number.
    assert fmt_value("marginLevel", 110.00000000000001, None) == "110%"
    # 99.97 rounds to 100.0 at one decimal place, which then strips to "100".
    assert fmt_value("marginLevel", 99.97, None) == "100%"


def test_headline():
    assert headline("marginLevel", 118.4, 120, "danger", "capital-live:live", "EUR", 4210.0) == \
        "MARGIN LEVEL 118.4% < 120% (danger) · Capital live · equity 4,210 EUR"
    assert headline("drawdown", 6.2, 5, "warn", "ig-live:live", "GBP", None) == \
        "DRAWDOWN 6.2% > 5% (warn) · IG live"
    assert headline("equity", 4980.5, 5000, "warn", "capital:demo", "EUR", 4980.5) == \
        "EQUITY 4,980.50 EUR < 5,000 EUR (warn) · Capital demo"


def test_hysteresis_amount_floor_keeps_a_level_zero_tier_from_flapping():
    # M6: 2% of a level at or near 0 is (almost) nothing, so an open P/L
    # tier at 0 would fire and re-arm on every tick of noise. One unit floor.
    assert hysteresis("openPnl", 0) == 1.0
    assert hysteresis("openPnl", -20) == 1.0
    assert hysteresis("available", 10) == 1.0
    # Percent metrics keep their fixed 3-point band.
    assert hysteresis("openPnlPct", 0) == 3
