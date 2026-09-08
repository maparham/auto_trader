"""The double top/bottom grammar: twin extremes around one valley/peak."""
import numpy as np

from auto_trader.core.pattern_presets import atr, find_double, series_pivots

P = {"peak_tol": 0.15, "min_height": 3.0, "break_tol": 0.5,
     "pre_trend": 0.5, "break_horizon": 1.0}


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return np.stack([o, np.maximum(o, c) + 0.05, np.minimum(o, c) - 0.05, c], axis=1)


def path(knots, n=240, lead=60, level=100.0, span=20.0):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


DOUBLE_TOP = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.45), (0.75, 0.97), (1.0, 0.1))
LOWER_HIGH = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.45), (0.75, 0.6), (1.0, 0.1))


def run(knots, **kw):
    b = bars_from_close(path(knots, **kw))
    return find_double(series_pivots(b, k=2.0), b[:, 3], atr(b), P), b


class TestDouble:
    def test_completed_top(self):
        inst, _ = run(DOUBLE_TOP)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and not tops[0].forming and tops[0].direction == -1

    def test_bottom_found_on_mirror(self):
        b = bars_from_close(2 * 100.0 - path(DOUBLE_TOP))
        inst = find_double(series_pivots(b, k=2.0), b[:, 3], atr(b), P)
        assert any(i.variant == "bottom" and i.direction == 1 for i in inst)

    def test_lower_second_peak_rejected(self):
        inst, _ = run(LOWER_HIGH)
        assert [i for i in inst if i.family == "double"] == []

    def test_forming_before_valley_break(self):
        # Stop after the second peak confirms with a shallow pullback.
        knots = DOUBLE_TOP[:4] + ((1.0, 0.7),)
        inst, b = run(knots)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and tops[0].forming and tops[0].end == len(b) - 1


# Structural rules shared with the H&S family: reversal context, busted
# voiding, break horizon. Each path is the valid double top with one rule
# violated.
NO_TREND = ((0.0, 0.95), (0.25, 1.0), (0.5, 0.45), (0.75, 0.97), (1.0, 0.1))
BUSTED = DOUBLE_TOP[:4] + ((0.85, 1.2), (1.0, 0.1))
LATE_BREAK = ((0.0, 0.0), (0.2, 1.0), (0.35, 0.45), (0.5, 0.97),
              (0.97, 0.7), (1.0, 0.1))


class TestStructuralRules:
    def test_no_prior_uptrend_rejected(self):
        inst, _ = run(NO_TREND)
        assert [i for i in inst if i.family == "double"] == []

    def test_busted_above_peaks_rejected(self):
        inst, _ = run(BUSTED)
        assert [i for i in inst if i.family == "double"] == []

    def test_break_beyond_horizon_rejected(self):
        inst, _ = run(LATE_BREAK, n=600)
        assert [i for i in inst if i.family == "double"] == []
