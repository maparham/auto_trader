"""The combined "all" mode's folding and scoring (core/pattern_combine)."""

from __future__ import annotations

import numpy as np
import pytest

from auto_trader.core.pattern_combine import (
    MODE_ORDER,
    combine,
    score_window,
)
from auto_trader.core.pattern_scan import Match


@pytest.fixture()
def series():
    """A wandering series with real texture, plus its own OHLC columns."""
    rng = np.random.default_rng(11)
    close = np.cumsum(rng.normal(0, 1.0, 500)) + 100
    return np.stack(
        [close + rng.normal(0, 0.2, 500), close + 1.0, close - 1.0, close], axis=1
    )


def test_score_window_covers_every_mode_and_zero_on_itself(series):
    query = series[100:140]
    d = score_window(query, query)
    assert set(d) == set(MODE_ORDER)
    for v in d.values():
        assert v == pytest.approx(0.0, abs=1e-9)


def test_score_window_is_positive_on_a_different_window(series):
    d = score_window(series[100:140], series[300:340])
    assert all(v > 0.05 for v in d.values())


def test_score_window_handles_unequal_lengths(series):
    d = score_window(series[100:140], series[300:325])
    assert all(np.isfinite(v) for v in d.values())


def test_overlapping_windows_across_modes_fold_into_one_event(series):
    query = series[100:130]
    hits = {
        "shape": [Match(100, 30, 0.0, 20)],
        # The same event seen by another formula on a nearby offset and rung.
        "ohlc": [Match(102, 24, 0.1, 20)],
        "close": [Match(99, 32, 0.1, 20)],
        "dtw": [Match(300, 30, 0.5, 20)],
    }
    out = combine(series, query, hits)
    assert [c.start for c in out] == [100, 300]
    # The representative geometry comes from the earliest mode in MODE_ORDER.
    assert out[0].length == 30


def test_rows_are_ordered_by_mean_rank_with_the_self_window_first(series):
    query = series[100:130]
    hits = {
        "shape": [Match(300, 30, 0.4, 20), Match(100, 30, 0.0, 20)],
        "ohlc": [Match(100, 30, 0.0, 20)],
        "close": [],
        "dtw": [],
    }
    out = combine(series, query, hits)
    assert out[0].start == 100
    assert out[0].mean_rank == pytest.approx(1.0)
    assert all(v == pytest.approx(0.0, abs=1e-9) for v in out[0].distances.values())
    assert out[1].mean_rank > out[0].mean_rank


def test_every_distinct_event_survives_uncapped(series):
    """No elimination by combined score: a window any formula surfaced stays
    in the list, however the other formulas rate it."""
    query = series[100:120]
    hits = {
        "shape": [Match(i, 20, 0.1, 20) for i in range(0, 200, 25)],
        "ohlc": [Match(300, 20, 0.1, 20)],
        "close": [],
        "dtw": [],
    }
    out = combine(series, query, hits)
    assert len(out) == 9


def test_a_window_flat_under_a_formula_scores_inf_not_a_crash(series):
    # Flat closes with moving wicks: close-based formulas cannot z-normalize.
    flat = series[200:230].copy()
    flat[:, 3] = 50.0
    flat[:, 0] = 50.0
    d = score_window(series[100:130], flat)
    assert d["close"] == np.inf
    assert np.isfinite(d["ohlc"])


def test_empty_hits_combine_to_an_empty_list(series):
    assert combine(series, series[100:130], {k: [] for k in MODE_ORDER}) == []
