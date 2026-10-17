import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS, PRICE
from auto_trader.indicators.prev_hl import PREV_HL_OUTPUTS, estimate_bar_ms
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "prev_hl.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: json.dumps(c["extendData"]))
def test_prev_hl_matches_the_chart(case):
    spec = SERIES_INDICATORS["PREV_HL"]
    cfg = spec.parse_config([], case["extendData"])
    assert spec.outputs(cfg) == PREV_HL_OUTPUTS
    for output, want in case["values"].items():
        # A deliberately wrong bar_hours: the port must not use it (bar
        # spacing comes from the candles, as estimateBarMs does).
        got = spec.series(cfg, output, CANDLES, 99.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-12, abs=1e-12), (output, i)
        assert spec.warmup(cfg, output) == case["warmup"][output]


def test_fixture_is_not_vacuous():
    by_ext = {json.dumps(c["extendData"]): c["values"] for c in FIXTURE["cases"]}
    assert any(v is not None for v in by_ext["{}"]["dayHigh"])
    assert any(v is not None for v in by_ext["{}"]["weekLow"])
    assert all(v is None for v in by_ext[json.dumps({"rollingUnit": "minute", "lengths": {"rolling": 10}})]["rollingHigh"])
    ny = by_ext[json.dumps({"tz": "America/New_York", "lengths": {"day": 2, "week": 2}, "aggs": {"day": "avg", "week": "median"}})]
    assert ny["dayHigh"] != by_ext["{}"]["dayHigh"]  # the zone moves the day boundary


def test_missing_chart_and_invalid_zones_are_utc():
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    assert p(None, {}).tz == p(None, {"tz": "chart"}).tz == p(None, {"tz": "Mars/Base"}).tz == "UTC"
    assert p(None, {"tz": "Asia/Tokyo"}).tz == "Asia/Tokyo"


def test_display_toggles_do_not_change_the_config():
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    assert p(None, {"lineHidden": {"dayHigh": True}, "hideLegendValue": True}) == p(None, {})


def test_bar_spacing_is_the_median_gap():
    assert estimate_bar_ms([0, 10, 20, 1000, 1010]) == 10
    assert estimate_bar_ms([5]) == 0


def test_bar_spacing_is_memoized_across_outputs(monkeypatch):
    # series() runs once per output (8 per PREV_HL instance); the same
    # candles shouldn't re-walk and re-sort the whole history every time.
    from auto_trader.indicators import prev_hl

    prev_hl._BAR_MS_CACHE.clear()
    calls = []
    real = prev_hl.estimate_bar_ms
    monkeypatch.setattr(prev_hl, "estimate_bar_ms", lambda ts: calls.append(1) or real(ts))

    spec = SERIES_INDICATORS["PREV_HL"]
    cfg = spec.parse_config(None, {})
    for output in ("rollingHigh", "dayHigh", "weekHigh"):
        spec.series(cfg, output, CANDLES, 1.0)
    assert len(calls) == 1


def test_non_finite_length_yields_no_values():
    # A corrupted stored length (not what computePrevHl would ever write, but
    # what it does if the pane's extendData is ever hand-edited): Math.floor(NaN)
    # on the chart degenerates every window computation it feeds into to no
    # window at all, so the port returns blank rather than silently falling
    # back to length 1 (S8).
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    cfg = p(None, {"lengths": {"rolling": "abc", "day": "abc", "week": "abc"}})
    spec = SERIES_INDICATORS["PREV_HL"]
    for output in ("rollingHigh", "rollingLow", "dayHigh", "dayLow", "weekHigh", "weekLow"):
        assert spec.series(cfg, output, CANDLES, 1.0) == [None] * len(CANDLES)
        assert spec.warmup(cfg, output) == 0


def test_week_key_matches_a_known_monday_sunday_boundary():
    # _period_key's week key is a Python ordinal (d.toordinal() - d.weekday()),
    # a different absolute number from the TS key (a Unix-epoch-day count minus
    # the same weekday), but both are Monday-anchored, so this pins the thing
    # that actually matters: a Sunday and the FOLLOWING Monday fall in different
    # weeks, and that Monday and the Sunday that closes its own week fall in the
    # same one.
    from zoneinfo import ZoneInfo

    from auto_trader.indicators.prev_hl import _period_key

    utc = ZoneInfo("UTC")
    sunday = int(datetime(2024, 3, 10, 12, tzinfo=timezone.utc).timestamp() * 1000)  # Sunday
    monday = int(datetime(2024, 3, 11, 12, tzinfo=timezone.utc).timestamp() * 1000)  # next week's Monday
    following_sunday = int(datetime(2024, 3, 17, 12, tzinfo=timezone.utc).timestamp() * 1000)  # same week as monday
    assert _period_key(sunday, "week", utc) != _period_key(monday, "week", utc)
    assert _period_key(monday, "week", utc) == _period_key(following_sunday, "week", utc)


def test_alert_spec():
    alert = ALERT_SPECS["PREV_HL"]
    p = SERIES_INDICATORS["PREV_HL"].parse_config
    unplaced = p(None, {"lengths": {"day": 3}})
    assert set(alert.outputs(unplaced)) == set(PREV_HL_OUTPUTS) - {"anchorHigh", "anchorLow"}
    assert all(o == PRICE for o in alert.outputs(unplaced).values())
    assert "anchorHigh" in alert.outputs(p(None, {"anchorTs": 1_700_000_000_000}))
    assert alert.label(unplaced, "dayHigh") == "Prev HL 3 days high"
    assert alert.label(unplaced, "weekLow") == "Prev HL week low"
    assert alert.label(unplaced, "rollingHigh") == "Prev HL rolling 1 hour high"
    plural = p(None, {"lengths": {"rolling": 3}})
    assert alert.label(plural, "rollingHigh") == "Prev HL rolling 3 hours high"
    bars = p(None, {"rollingUnit": "bars", "lengths": {"rolling": 3}})
    assert alert.label(bars, "rollingLow") == "Prev HL rolling 3 bars low"
    assert not alert.heavy and alert.sparse


def _bar(ms: int, h: float, l: float) -> Candle:
    return Candle(datetime.fromtimestamp(ms / 1000, tz=timezone.utc), (h + l) / 2, h, l, (h + l) / 2, 1.0)


def test_day_high_steps_when_the_new_day_opens():
    # Why PREV_HL is a light alert spec: the forming bar's level is already the
    # just-completed day's high, not the previous closed bar's (two days ago).
    hour = 3_600_000
    day0 = int(datetime(2024, 3, 11, tzinfo=timezone.utc).timestamp() * 1000)
    bars = [_bar(day0 + i * hour, 100 + i, 90) for i in range(24)]          # day 0: high 123
    bars += [_bar(day0 + (24 + i) * hour, 200 + i, 190) for i in range(24)]  # day 1: high 223
    bars.append(_bar(day0 + 48 * hour, 150, 140))                            # day 2's forming bar
    spec = SERIES_INDICATORS["PREV_HL"]
    got = spec.series(spec.parse_config([], {}), "dayHigh", bars, 1.0)
    assert got[47] == 123 and got[-1] == 223


def test_anchor_before_the_first_bar_is_blank():
    hour = 3_600_000
    day0 = int(datetime(2024, 3, 11, tzinfo=timezone.utc).timestamp() * 1000)
    bars = [_bar(day0 + i * hour, 100 + i, 90) for i in range(10)]
    spec = SERIES_INDICATORS["PREV_HL"]
    old = spec.parse_config([], {"anchorTs": day0 - hour})
    assert spec.series(old, "anchorHigh", bars, 1.0) == [None] * 10
    inside = spec.parse_config([], {"anchorTs": day0 + 3 * hour})
    assert spec.series(inside, "anchorHigh", bars, 1.0)[3] == 103


def test_bars_rolling_warmup_counts_the_excluded_bar():
    spec = SERIES_INDICATORS["PREV_HL"]
    cfg = spec.parse_config([], {"rollingUnit": "bars", "lengths": {"rolling": 5}})
    assert spec.warmup(cfg, "rollingHigh") == 6
    hour = 3_600_000
    bars = [_bar(i * hour, 100 + i, 90) for i in range(8)]
    got = spec.series(cfg, "rollingHigh", bars, 1.0)
    assert got[4] is None and got[5] is not None
