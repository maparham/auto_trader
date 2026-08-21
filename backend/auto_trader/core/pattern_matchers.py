"""The matcher registry: what a search mode means, in one place.

A matcher is two decisions. Which columns the first-stage exact scan ranks
(whole candles or the close path alone), and whether a second stage re-scores
the scan's best candidates with a costlier, more forgiving metric. The rigid
modes stop after stage one; DTW re-ranks a pool much deeper than the panel
shows, so a warped recurrence the rigid metric buries can still surface.

Structured as data rather than branches so a future matcher (or a future
candidate generator, if cross-symbol search ever needs an index) is one entry
here, not another if-chain in the endpoint."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from .pattern_dtw import refine as dtw_refine
from .pattern_scan import Match


@dataclass(frozen=True)
class Matcher:
    key: str
    # Scan the close column alone instead of all four.
    close_only: bool
    # Second stage: re-score and re-rank the exact scan's picks, or None to
    # trust the scan's own ranking.
    refine: Callable[[np.ndarray, np.ndarray, list[Match]], list[Match]] | None = None
    # How many candidates stage one hands to `refine`. Zero when there is no
    # second stage.
    candidate_pool: int = 0


MATCHERS: dict[str, Matcher] = {
    "ohlc": Matcher("ohlc", close_only=False),
    "close": Matcher("close", close_only=True),
    "dtw": Matcher("dtw", close_only=False, refine=dtw_refine, candidate_pool=100),
}
