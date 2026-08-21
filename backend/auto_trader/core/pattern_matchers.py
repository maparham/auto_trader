"""The matcher registry: what a search mode means, in one place.

A matcher is three decisions. Which array the first-stage exact scan ranks
(whole candles, the close path alone, or the close path smoothed relative to
the query length), whether a second stage re-scores the scan's best candidates
with a costlier metric, and which array that second stage should look at (the
scanned one, or the raw close path when the scan saw a smoothed copy). The
rigid modes stop after stage one; a refining matcher re-ranks a pool much
deeper than the panel shows, so a candidate the first stage ranks at 80 can
still surface.

Structured as data rather than branches so a future matcher (or a future
candidate generator, if cross-symbol search ever needs an index) is one entry
here, not another if-chain in the endpoint."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal

import numpy as np

from .pattern_dtw import refine as dtw_refine
from .pattern_scan import Match
from .pattern_shape import refine as shape_refine


@dataclass(frozen=True)
class Matcher:
    key: str
    # What stage one scans: whole candles, the close column, or the close
    # column smoothed with a query-length-relative kernel.
    scan: Literal["ohlc", "close", "smooth"] = "ohlc"
    # Second stage: re-score and re-rank the exact scan's picks, or None to
    # trust the scan's own ranking. Receives (series array, query array,
    # hits) and returns the hits re-scored and re-sorted.
    refine: Callable[[np.ndarray, np.ndarray, list[Match]], list[Match]] | None = None
    # Which arrays `refine` receives: the ones stage one scanned, or the raw
    # close path. "close" exists for the shape mode, where stage one decides
    # what surfaces on a smoothed copy but the visible ranking must judge the
    # candles the user will actually look at.
    refine_on: Literal["scan", "close"] = "scan"
    # How many candidates stage one hands to `refine`. Zero when there is no
    # second stage.
    candidate_pool: int = 0


MATCHERS: dict[str, Matcher] = {
    "shape": Matcher(
        "shape", scan="smooth", refine=shape_refine, refine_on="close", candidate_pool=100
    ),
    "ohlc": Matcher("ohlc"),
    "close": Matcher("close", scan="close"),
    "dtw": Matcher("dtw", refine=dtw_refine, candidate_pool=100),
}
