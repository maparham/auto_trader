"""The property the whole design exists to guarantee: a rule referencing a
configured pane's output evaluates to exactly the line the pane plots.

The expected values in `paneCases` are not recomputed arithmetic — they are the
output of the pane's OWN calc (SLOPE_TEMPLATE.calc / SLOPE_ACCEL_TEMPLATE.calc,
the functions klinecharts calls to build the plotted values), captured by
frontend/src/lib/indicators/slopeParityGolden.test.ts. The pane config is
deliberately non-default on every axis: two lines, sma (not ema), hl2 (not
close), pctBar (not pctHr), slope smoothing on, accel on, accelAbsolute on.

The fixture carries the RESOLUTION its pane values were generated at, and the
rule path is evaluated at that same resolution — hardcoding one here could
drift away from the extendData.barHours the pane used. The pair is 4h, not 1h,
deliberately: at a 1h bar width pctHr and pctBar are arithmetically identical,
so a units mis-parse between them would be undetectable.

TypeScript is the source of truth. If this fails, fix indicators/slope.py."""

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import resolve_instances
from auto_trader.strategy.expr.evaluate import series_of
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate

FIXTURE = Path(__file__).parent / "fixtures" / "slope_golden.json"


@pytest.fixture(scope="module")
def golden():
    data = json.loads(FIXTURE.read_text())
    candles = [
        Candle(
            time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
            open=c["open"], high=c["high"], low=c["low"], close=c["close"],
            volume=c["volume"],
        )
        for c in data["candles"]
    ]
    return candles, data["panes"]


@pytest.fixture(scope="module")
def pane(golden):
    """The FIRST pane — the rich integer-valued config the vacuity assertions
    below describe. The equality test itself runs every pane."""
    candles, panes = golden
    return candles, panes[0]["config"], panes[0]["cases"]


def _instances(config):
    return resolve_instances({
        "SLOPE": {"type": "SLOPE", "calcParams": config["calcParams"],
                  "extendData": config["extendData"]},
    })


def test_every_pane_line_equals_its_rule_operand(golden):
    candles, panes = golden
    assert panes, "fixture has no panes — regenerate it"
    # The "fractional-and-stale" pane is the one that catches a COERCION
    # divergence: every number the pane parses is int()-truncated on this side,
    # and JS indexes an array by a fractional offset to undefined (a blank pane)
    # rather than truncating. The pane must be normalised to the same integers
    # before the math runs, or a decimal typed into Slope Period plots nothing
    # while the rule referencing it computes real values.
    assert {p["name"] for p in panes} >= {"canonical", "fractional-and-stale"}
    for pane_ in panes:
        config, cases = pane_["config"], pane_["cases"]
        instances = _instances(config)
        assert cases, f"{pane_['name']}: no pane cases — regenerate the fixture"
        for case in cases:
            label = f"{pane_['name']}/{case['output']}"
            src = f"SLOPE.{case['output']} > 0"
            row = parse(src)
            validate(row, is_exit=False, instances=instances)   # must not raise
            actual = series_of(row.left, candles, config["resolution"], {}, instances)
            expected = case["values"]
            # zip() truncates to the shorter side, so a Python series that stopped
            # early would compare only its own length and pass. Pin the length.
            assert len(actual) == len(expected), (
                f"{label}: {len(actual)} values, fixture has {len(expected)}"
            )
            for i, (a, e) in enumerate(zip(actual, expected)):
                if e is None:
                    assert a is None, f"{label}[{i}]: expected None, got {a}"
                else:
                    assert a is not None and math.isclose(a, e, rel_tol=1e-12, abs_tol=1e-12), (
                        f"{label}[{i}]: {a} != {e}"
                    )


def test_the_comparison_is_not_vacuous(pane):
    """A pane-equality test that compares all-None to all-None proves nothing.
    Pin the shape of what was actually compared."""
    candles, config, cases = pane
    instances = _instances(config)
    by_output = {}
    for case in cases:
        node = parse(f"SLOPE.{case['output']} > 0").left
        by_output[case["output"]] = series_of(node, candles, config["resolution"], {}, instances)

    assert set(by_output) == {"5", "13", "accel5", "accel13"}, (
        "the pane must be multi-line with accel on — regenerate the fixture"
    )
    for output, values in by_output.items():
        defined = [v for v in values if v is not None]
        assert len(defined) > 20, f"{output}: only {len(defined)} defined values"

    # Two different MA lengths must actually produce two different lines.
    assert by_output["5"] != by_output["13"]
    # The slope pane is signed; the accel pane, with accelAbsolute on, is not —
    # so a rule reading SLOPE.accel<length> is demonstrably reading the TRANSFORMED
    # series the pane plots, not the raw signed acceleration.
    assert min(v for v in by_output["5"] if v is not None) < 0
    assert all(v >= 0 for v in by_output["accel5"] if v is not None)
    assert all(v >= 0 for v in by_output["accel13"] if v is not None)


# --- the PINNED path -----------------------------------------------------------
#
# The tests above run a pane that follows the chart. A pane pinned to its own
# timeframe takes a different branch on BOTH sides — evaluate.py computes on
# native HTF bars at `_tf_hours(tf_res)` and aligns to base, and the chart's
# mtfCoordinator.applySlopeTimeframe mirrors it. That branch had no equality
# test at all, and the frontend half of it was measuring bar width off the
# fetched HTF bars (`inferBarHours`) rather than deriving it from the pinned
# resolution — so a MONTH pin plotted at 672h (February's 28 days, the smallest
# gap) while the rule evaluated at the nominal 720h.

from auto_trader.indicators.slope import parse_slope_config, slope_line_series
from auto_trader.strategy.expr.evaluate import _tf_hours, align_htf_to_base
from auto_trader.core.candle_aggregate import resolution_seconds

# Mirrors frontend/src/lib/feed.ts RESOLUTION_SECONDS / 3600, which
# nominalBarHours returns and applySlopeTimeframe now hands the pinned pane.
# feed.test.ts asserts the same pairs on the other side. A divergence here is a
# silent pane-vs-rule mismatch for every %/hr output at that resolution.
FRONTEND_NOMINAL_BAR_HOURS = {
    "MINUTE": 1 / 60, "MINUTE_5": 5 / 60, "MINUTE_15": 0.25, "MINUTE_30": 0.5,
    "HOUR": 1.0, "HOUR_4": 4.0, "DAY": 24.0, "WEEK": 168.0, "MONTH": 720.0,
}


@pytest.mark.parametrize("res,hours", sorted(FRONTEND_NOMINAL_BAR_HOURS.items()))
def test_nominal_bar_hours_agree_with_the_frontend(res, hours):
    assert _tf_hours(res) == pytest.approx(hours)


def _month_opens():
    """Monthly bar opens across a February, so the SMALLEST gap (28d = 672h) is
    not the nominal width (30d = 720h). This is exactly the case inferBarHours
    got wrong."""
    return [datetime(2026, m, 1, tzinfo=timezone.utc) for m in range(1, 13)]


def _pinned_setup():
    """A MONTH-pinned pane, its monthly candles, and daily base candles."""
    htf = [
        Candle(time=t, open=100.0 + i, high=101.0 + i, low=99.0 + i,
               close=100.0 + i * 1.7, volume=1000.0)
        for i, t in enumerate(_month_opens())
    ]
    base = [
        Candle(time=datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(days=d),
               open=100.0, high=101.0, low=99.0, close=100.0, volume=10.0)
        for d in range(360)
    ]
    config = {
        "calcParams": [3],
        # pctHr is the whole point: it is the only unit bar width scales.
        "extendData": {"maType": "sma", "units": "pctHr", "slopePeriod": 1,
                       "mtf": {"timeframe": "MONTH"}},
    }
    instances = _instances(config)
    return htf, base, config, instances


def _ref_series(base, instances, resolution="DAY", htf_key="MONTH", htf=None):
    row = parse("SLOPE.3 > 0")
    validate(row, is_exit=False, instances=instances)
    return series_of(row.left, base, resolution, {htf_key: htf}, instances)


def test_a_pinned_ref_uses_the_pin_s_NOMINAL_bar_width():
    htf, base, config, instances = _pinned_setup()
    actual = _ref_series(base, instances, htf=htf)

    cfg = parse_slope_config(config["calcParams"], config["extendData"])
    base_ms = [int(c.time.timestamp() * 1000) for c in base]
    month_ms = resolution_seconds("MONTH") * 1000

    nominal = align_htf_to_base(
        base_ms, htf, slope_line_series(htf, cfg, 3, 720.0), month_ms
    )
    assert actual == nominal

    # And it is NOT the value an inferred width would have produced: February's
    # 28 days is the smallest gap in this series, which is what the pinned chart
    # path used to measure. Pinning the divergence keeps the fix from silently
    # reverting to "close enough".
    inferred = align_htf_to_base(
        base_ms, htf, slope_line_series(htf, cfg, 3, 672.0), month_ms
    )
    defined = [(a, b) for a, b in zip(actual, inferred) if a is not None and b is not None]
    assert defined, "nothing to compare — the fixture produced no defined values"
    assert all(not math.isclose(a, b, rel_tol=1e-9) for a, b in defined)
    # ~7%: 720/672 - 1. Stated so a future reader can see the size of what was
    # silently wrong, not just that it differed.
    assert all(math.isclose(b / a, 720.0 / 672.0, rel_tol=1e-9) for a, b in defined)


def test_the_pinned_comparison_is_not_vacuous():
    htf, base, config, instances = _pinned_setup()
    actual = _ref_series(base, instances, htf=htf)
    assert sum(v is not None for v in actual) > 200, (
        "the pinned ref produced almost no values — the fixture, not the code, "
        "is what this would be testing"
    )
