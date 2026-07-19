"""Backend plateau scoring mirrors frontend lib/sweepPlateau.ts semantics."""
from auto_trader.engine.plateau import with_plateau

AXES = [{"kind": "range", "targets": ["param:fast"]}]


def rows(vals):
    return [{"param:fast": f} for f in vals]


def test_isolated_spike_scores_at_neighbor_median():
    combos = rows([5, 10, 15])
    values = [1.0, 100.0, 2.0]           # lucky middle cell
    scores, spikes = with_plateau(combos, values, AXES)
    # median(100, 1, 2) = 2, capped at own value -> 2. Not a spike (neighbors > 0).
    assert scores[1] == 2.0
    assert spikes[1] is False


def test_spike_flag_when_neighbors_nonpositive():
    combos = rows([5, 10, 15])
    values = [-1.0, 100.0, -2.0]
    scores, spikes = with_plateau(combos, values, AXES)
    assert spikes[1] is True


def test_list_axis_partitions_neighborhoods():
    axes = [{"kind": "range", "targets": ["param:fast"]},
            {"kind": "list", "targets": ["param:kind"]}]
    combos = [{"param:fast": 5, "param:kind": "a"},
              {"param:fast": 10, "param:kind": "a"},
              {"param:fast": 5, "param:kind": "b"},
              {"param:fast": 10, "param:kind": "b"}]
    values = [1.0, 3.0, 100.0, 200.0]
    scores, _ = with_plateau(combos, values, axes)
    # "a" rows never see "b" values: median(1,3)=2 for row 0.
    assert scores[0] == 1.0              # capped at own value
    assert scores[1] == 2.0


def test_none_values_excluded():
    combos = rows([5, 10, 15])
    values = [1.0, None, 3.0]
    scores, _ = with_plateau(combos, values, AXES)
    assert scores[1] is None
    # Row 0's only in-range neighbor (idx 1) is ineligible: median(own) = own.
    assert scores[0] == 1.0


def test_no_range_axes_yields_none_scores():
    axes = [{"kind": "list", "targets": ["param:kind"]}]
    combos = [{"param:kind": "a"}, {"param:kind": "b"}]
    scores, spikes = with_plateau(combos, [1.0, 2.0], axes)
    assert scores == [None, None]
    assert spikes == [False, False]
