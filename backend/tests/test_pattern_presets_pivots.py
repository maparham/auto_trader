"""The preset detector's pivot pass: a zigzag over the raw close with an
absolute k*ATR reversal threshold, built on pattern_shape's engine."""
import numpy as np
import pytest

from auto_trader.core.pattern_presets import Pivot, atr, series_pivots


def bars_from_close(c):
    """Minimal OHLC around a close path: open = previous close, high/low hug
    the segment, so ATR reflects the per-bar moves and nothing else."""
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) + 0.1
    l = np.minimum(o, c) - 0.1
    return np.stack([o, h, l, c], axis=1)


class TestAtr:
    def test_positive_on_flat_series(self):
        assert atr(bars_from_close(np.full(50, 100.0))) > 0

    def test_scales_with_move_size(self):
        small = bars_from_close(100 + 0.5 * np.sin(np.arange(50)))
        big = bars_from_close(100 + 5.0 * np.sin(np.arange(50)))
        assert atr(big) > atr(small)


class TestSeriesPivots:
    def test_three_swings_found(self):
        # 0 -> 10 -> 2 -> 12 -> 1: interior pivots at the 10-high, 2-low, 12-high.
        c = np.concatenate([
            np.linspace(0, 10, 20), np.linspace(10, 2, 20),
            np.linspace(2, 12, 20), np.linspace(12, 1, 20),
        ])
        piv = series_pivots(bars_from_close(c), k=2.0)
        assert [p.d for p in piv] == [1, -1, 1]
        assert piv[0].price == pytest.approx(10, abs=0.5)
        assert piv[1].price == pytest.approx(2, abs=0.5)

    def test_alternates_and_sorted(self):
        rng = np.random.default_rng(7)
        c = np.cumsum(rng.normal(0, 1, 500)) + 100
        piv = series_pivots(bars_from_close(c), k=3.0)
        assert all(a.i < b.i for a, b in zip(piv, piv[1:]))
        assert all(a.d == -b.d for a, b in zip(piv, piv[1:]))

    def test_higher_k_fewer_pivots(self):
        rng = np.random.default_rng(7)
        c = np.cumsum(rng.normal(0, 1, 500)) + 100
        b = bars_from_close(c)
        assert len(series_pivots(b, k=1.0)) >= len(series_pivots(b, k=4.0))

    def test_flat_series_no_pivots(self):
        assert series_pivots(bars_from_close(np.full(50, 100.0)), k=2.0) == []

    def test_prices_are_raw_not_normalized(self):
        c = np.concatenate([np.linspace(5000, 5100, 30), np.linspace(5100, 5010, 30)])
        piv = series_pivots(bars_from_close(c), k=2.0)
        assert piv and piv[0].price == pytest.approx(5100, abs=5)
