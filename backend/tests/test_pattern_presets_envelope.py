"""The envelope grammar: two fitted trendlines over an alternating pivot run,
classified by slope signs into broadening/triangle/wedge variants."""
import numpy as np

from auto_trader.core.pattern_presets import Instance, atr, find_envelope, series_pivots

P = {"min_pivots": 5, "max_pivots": 12, "fit_tol": 1.2, "flat_slope": 0.04,
     "min_slope_gap": 0.06, "min_height": 3.0, "break_tol": 0.5, "partial_frac": 0.25,
     "break_horizon": 1.0}


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) + 0.05
    l = np.minimum(o, c) - 0.05
    return np.stack([o, h, l, c], axis=1)


def path(knots, n=240, lead=60, level=100.0, span=20.0):
    """A flat lead, then the knot path scaled to `span` price units: the lead
    gives the zigzag room to confirm the first pattern pivot as interior."""
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


# Alternating knots: swing highs walk up, swing lows walk down -> megaphone.
MEGAPHONE = ((0.0, 0.5), (0.12, 0.65), (0.25, 0.35), (0.4, 0.78),
             (0.55, 0.22), (0.72, 0.9), (0.88, 0.1), (1.0, 0.6))
# Tops rising on a line, floor flat -> ascending broadening (RABFA).
ASC_BROAD = ((0.0, 0.2), (0.12, 0.5), (0.25, 0.2), (0.4, 0.65),
             (0.55, 0.2), (0.72, 0.8), (0.88, 0.2), (1.0, 0.55))
# Highs descending, lows ascending -> symmetric triangle.
SYM_TRI = ((0.0, 0.1), (0.12, 0.9), (0.28, 0.2), (0.45, 0.75),
           (0.62, 0.32), (0.8, 0.62), (1.0, 0.45))
# Parallel channel: both lines rise at the same rate -> NOT an instance.
CHANNEL = ((0.0, 0.0), (0.12, 0.3), (0.25, 0.1), (0.4, 0.42),
           (0.55, 0.22), (0.72, 0.55), (0.88, 0.35), (1.0, 0.65))


def scan(knots, tail=None, **kw):
    c = path(knots, **kw)
    if tail is not None:
        c = np.concatenate([c, tail(c[-1])])
    b = bars_from_close(c)
    return find_envelope(series_pivots(b, k=2.0), b[:, 3], atr(b), P), b


class TestClassification:
    def test_megaphone_found_forming(self):
        inst, _ = scan(MEGAPHONE)
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits and hits[0].family == "broadening" and hits[0].forming

    def test_ascending_broadening_found(self):
        inst, _ = scan(ASC_BROAD)
        assert any(i.variant == "ascending" and i.family == "broadening" for i in inst)

    def test_symmetric_triangle_found(self):
        inst, _ = scan(SYM_TRI)
        assert any(i.variant == "symmetric" and i.family == "triangle" for i in inst)

    def test_parallel_channel_rejected(self):
        inst, _ = scan(CHANNEL)
        assert inst == []

    def test_shallow_pattern_rejected_by_min_height(self):
        # Same megaphone at 1/20th the price span: swings shrink below
        # min_height ATRs of the (lead-dominated) series and nothing fires.
        inst, _ = scan(MEGAPHONE, span=1.0)
        assert inst == []


class TestCompletion:
    def test_upward_break_completes(self):
        # The megaphone, then a strong rally clear of the upper line.
        inst, b = scan(MEGAPHONE, tail=lambda last: np.linspace(last, last + 40, 40))
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits and not hits[0].forming
        assert hits[0].direction == 1 and hits[0].break_i is not None
        assert hits[0].end == hits[0].break_i

    def test_no_break_at_live_edge_is_forming(self):
        inst, b = scan(MEGAPHONE)
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits[0].forming and hits[0].end == len(b) - 1


class TestPartialTell:
    def test_partial_decline_detected(self):
        # A tight ascending-broadening run (five highs/lows, small envelope
        # height) whose final low reverses well above the fitted lower line:
        # a partial decline. Needs its own compact scale (not MEGAPHONE's,
        # whose envelope height dwarfs fit_tol by construction) and a few
        # trailing flat bars so ATR's median isn't skewed by the live edge.
        knots = tuple([(0.0, 0.0)] + [(k / 26, v) for k, v in [
            (2, 0.7), (4, -0.7), (6, 1.02), (8, -1.02), (10, 1.34), (12, -1.34),
            (14, 1.66), (16, -1.66), (18, 1.98), (20, -1.98), (22, 2.3),
            (24, -0.1), (26, 1.9),
        ]])
        inst, _ = scan(knots, tail=lambda last: np.full(4, last), n=27, lead=15, span=1.0)
        hits = [i for i in inst if i.family == "broadening" and i.forming]
        assert hits and hits[0].tell == "partial-decline"

    def test_full_swing_no_tell(self):
        inst, _ = scan(MEGAPHONE)
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits[0].tell is None


class TestBreakHorizon:
    def test_break_beyond_horizon_not_completed(self):
        # The megaphone, then a flat drift far longer than the pattern's span
        # before any breakout: the formation dissolved, nothing to report.
        inst, _ = scan(
            MEGAPHONE,
            tail=lambda last: np.concatenate(
                [np.full(300, last), np.linspace(last, last + 40, 40)]
            ),
        )
        assert [i for i in inst if i.family == "broadening"] == []
