"""The head-and-shoulders grammar: five alternating pivots, head above both
shoulders, shoulders level-ish, neckline near-horizontal."""
import numpy as np

from auto_trader.core.pattern_presets import atr, find_hns, series_pivots

P = {"shoulder_tol": 0.35, "head_prominence": 0.25, "neck_tilt": 0.4,
     "break_tol": 0.5, "min_height": 3.0, "pre_trend": 0.5,
     "break_horizon": 1.0, "time_sym": 0.33}


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return np.stack([o, np.maximum(o, c) + 0.05, np.minimum(o, c) - 0.05, c], axis=1)


def path(knots, n=300, lead=60, level=100.0, span=20.0):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


# LS 0.6, valleys 0.2/0.22, head 1.0, RS 0.58, then the neckline break.
HNS = ((0.0, 0.0), (0.12, 0.6), (0.25, 0.2), (0.42, 1.0),
       (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))
# Same shape, head only just above the shoulders: prominence gate rejects.
FLAT_HEAD = ((0.0, 0.0), (0.12, 0.6), (0.25, 0.2), (0.42, 0.66),
             (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))
# Right shoulder far above the left: symmetry gate rejects. (RS knot lowered
# from 0.9 to 0.75 vs. the brief's draft: at 0.9 the run also failed
# head_prominence, so the shoulder_tol gate was never isolated. At 0.75 the
# run clears min_height/prominence/neck_tilt and fails shoulder_tol alone.)
LOPSIDED = ((0.0, 0.0), (0.12, 0.4), (0.25, 0.2), (0.42, 1.0),
            (0.58, 0.22), (0.72, 0.75), (0.9, 0.15), (1.0, -0.2))


def run(knots, **kw):
    b = bars_from_close(path(knots, **kw))
    return find_hns(series_pivots(b, k=2.0), b[:, 3], atr(b), P), b


class TestHns:
    def test_completed_top_found(self):
        inst, _ = run(HNS)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and not tops[0].forming and tops[0].direction == -1
        assert tops[0].break_i is not None

    def test_inverse_found(self):
        b = bars_from_close(2 * 100.0 - path(HNS))  # mirror about the level
        inst = find_hns(series_pivots(b, k=2.0), b[:, 3], atr(b), P)
        invs = [i for i in inst if i.variant == "inverse"]
        assert invs and invs[0].direction == 1

    def test_forming_before_break(self):
        # Stop right after the right shoulder confirms (one shallow dip).
        knots = HNS[:6] + ((0.9, 0.35),)
        inst, b = run(knots)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and tops[0].forming and tops[0].end == len(b) - 1

    def test_flat_head_rejected(self):
        inst, _ = run(FLAT_HEAD)
        assert [i for i in inst if i.family == "hns"] == []

    def test_lopsided_shoulders_rejected(self):
        inst, _ = run(LOPSIDED)
        assert [i for i in inst if i.family == "hns"] == []


# The structural rules beyond the five-pivot skeleton: reversal context,
# busted-pattern voiding, break horizon, shoulder time symmetry. Each path
# below is the valid HNS geometry with exactly one rule violated.

# Approach into LS is flat (starts at the shoulder's own level): three highs
# in a range, not a reversal of a prior rise.
NO_TREND = ((0.0, 0.58), (0.12, 0.6), (0.25, 0.2), (0.42, 1.0),
            (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))
# After RS, price makes a new high ABOVE the head before any neckline break:
# the pattern busted upward.
BUSTED = HNS[:6] + ((0.82, 1.15), (1.0, -0.2))
# Valid pattern, but the neckline break arrives only after a sideways drift
# far longer than the pattern's own span.
LATE_BREAK = ((0.0, 0.0), (0.06, 0.6), (0.125, 0.2), (0.21, 1.0),
              (0.29, 0.22), (0.36, 0.58), (0.97, 0.4), (1.0, -0.2))
# Head crammed against the left shoulder: 4x more time on the right side.
LOPSIDED_TIME = ((0.0, 0.0), (0.3, 0.6), (0.34, 0.2), (0.38, 1.0),
                 (0.55, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))


class TestStructuralRules:
    def test_no_prior_uptrend_rejected(self):
        inst, _ = run(NO_TREND)
        assert [i for i in inst if i.family == "hns"] == []

    def test_busted_above_head_rejected(self):
        inst, _ = run(BUSTED)
        assert [i for i in inst if i.family == "hns"] == []

    def test_break_beyond_horizon_rejected(self):
        inst, _ = run(LATE_BREAK, n=600)
        assert [i for i in inst if i.family == "hns"] == []

    def test_time_asymmetric_shoulders_rejected(self):
        inst, _ = run(LOPSIDED_TIME)
        assert [i for i in inst if i.family == "hns"] == []
