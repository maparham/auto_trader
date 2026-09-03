"""Scoring a ranked candidate list against a case's labelled regions.

Hit rule, per the benchmark spec: a candidate hits a labelled region when its
start is within +-2 bars of the region's start and its length is within the
duration ladder's bounds (0.5x..2x) of the region's length — any rung of the
ladder that found the same event counts.
"""

from __future__ import annotations

from dataclasses import dataclass

from auto_trader.core.pattern_scan import Match

START_TOL = 2
RATIO_LO, RATIO_HI = 0.5, 2.0


@dataclass(frozen=True)
class Region:
    """A labelled window: where it starts and how many bars it covers."""

    start: int
    length: int

    @property
    def end(self) -> int:
        return self.start + self.length


def is_hit(cand: Match, region: Region) -> bool:
    # Start tolerance grows with the region: a 4-bar offset on a 120-bar
    # window is the same event to the eye (the smoothed scan's best offset
    # lands a few bars wide of a long plant), while on a 48-bar window +-2
    # stays the rule.
    tol = max(START_TOL, round(0.05 * region.length))
    if abs(cand.start - region.start) > tol:
        return False
    ratio = cand.length / region.length
    return RATIO_LO <= ratio <= RATIO_HI


def overlaps(cand: Match, region: Region) -> bool:
    return cand.start < region.end and region.start < cand.start + cand.length


def is_bad_hit(cand: Match, region: Region) -> bool:
    """Stricter than is_hit, on purpose: a candidate counts against a known-bad
    region only when it covers nearly ALL of it. A ladder rung that matches a
    sub-window of a decoy can be a perfectly correct visual match (the first
    three swings of a four-swing decoy ARE the query's shape); only finding
    the decoy as a whole is the mistake being measured."""
    inter = min(cand.start + cand.length, region.end) - max(cand.start, region.start)
    return inter >= 0.85 * region.length and RATIO_LO <= cand.length / region.length <= RATIO_HI


@dataclass(frozen=True)
class CaseScore:
    """One case, one variant. `ranks` is the 1-based rank of each expected
    region's first hit, None when nothing in the list hit it."""

    ranks: tuple[int | None, ...]
    precision_at_10: float
    recall_at_10: float
    bad_at_10: int

    @property
    def mean_rank(self) -> float | None:
        found = [r for r in self.ranks if r is not None]
        return sum(found) / len(found) if found else None


def score_case(
    cands: list[Match],
    query: Region,
    expected: list[Region],
    known_bad: list[Region],
    k: int = 10,
) -> CaseScore:
    """Score a ranked candidate list. Candidates overlapping the query's own
    window are dropped first: the scan deliberately returns the selection
    itself, and rewarding a matcher for re-finding it would measure nothing."""
    ranked = [c for c in cands if not overlaps(c, query)]

    ranks: list[int | None] = []
    for region in expected:
        rank = next((i + 1 for i, c in enumerate(ranked) if is_hit(c, region)), None)
        ranks.append(rank)

    top = ranked[:k]
    good_in_top = sum(1 for c in top if any(is_hit(c, r) for r in expected))
    bad_in_top = sum(1 for c in top if any(is_bad_hit(c, r) for r in known_bad))
    denom = min(k, len(top)) or 1
    return CaseScore(
        ranks=tuple(ranks),
        precision_at_10=good_in_top / denom,
        recall_at_10=sum(1 for r in ranks if r is not None and r <= k) / (len(expected) or 1),
        bad_at_10=bad_in_top,
    )
