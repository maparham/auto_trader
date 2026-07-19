"""Neighborhood plateau scoring over a sweep-style combo grid. The best cell in
a grid is, by selection, the luckiest cell; real edges live on plateaus.
plateau_score = median of the cell and its grid neighbors, capped at the cell's
own value, so a cell cannot borrow credit from a lucky neighbor. Neighbors
differ by at most one step (Chebyshev distance 1) on every range axis and match
exactly on every list axis. Pure functions; mirrors frontend
lib/sweepPlateau.ts so backend selection and frontend display agree."""
from __future__ import annotations

from itertools import product
from statistics import median


def with_plateau(
    combos: list[dict], values: list[float | None], axes: list[dict],
) -> tuple[list[float | None], list[bool]]:
    range_targets = [a["targets"][0] for a in axes if a["kind"] == "range"]
    list_targets = [t for a in axes if a["kind"] == "list" for t in a["targets"]]

    # Ordinal grid index per range axis from the swept values actually present.
    index_of: dict[str, dict[float, int]] = {}
    for t in range_targets:
        vals = sorted({c[t] for c in combos
                       if isinstance(c.get(t), (int, float))
                       and not isinstance(c.get(t), bool)})
        index_of[t] = {v: i for i, v in enumerate(vals)}

    def coord(c: dict) -> tuple[int, ...] | None:
        out: list[int] = []
        for t in range_targets:
            i = index_of[t].get(c.get(t))
            if i is None:
                return None
            out.append(i)
        return tuple(out)

    coords = [coord(c) if values[i] is not None else None
              for i, c in enumerate(combos)]
    list_key = [tuple(str(c.get(t)) for t in list_targets) for c in combos]

    by_cell: dict[tuple, list[int]] = {}
    for i in range(len(combos)):
        if values[i] is None or coords[i] is None:
            continue
        by_cell.setdefault((list_key[i], coords[i]), []).append(i)

    dims = len(range_targets)
    offsets = [o for o in product((-1, 0, 1), repeat=dims) if any(o)]

    scores: list[float | None] = []
    spikes: list[bool] = []
    for i in range(len(combos)):
        if values[i] is None or dims == 0 or coords[i] is None:
            scores.append(None)
            spikes.append(False)
            continue
        neighbors: list[float] = []
        for o in offsets:
            cell = by_cell.get(
                (list_key[i], tuple(c + d for c, d in zip(coords[i], o))))
            if not cell:
                continue
            neighbors.extend(values[j] for j in cell if j != i)
        own = values[i]
        scores.append(min(own, median([own, *neighbors])))
        spikes.append(own > 0 and len(neighbors) >= 2 and median(neighbors) <= 0)
    return scores, spikes
