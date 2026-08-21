"""The matcher configurations under comparison, each a full two-stage
pipeline over raw case arrays. Mirrors the production endpoint's flow
(scan-array choice -> exact scan over the ladder -> optional re-rank) so a
winning entry maps one-to-one onto a `pattern_matchers.Matcher`."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from auto_trader.core.pattern_dtw import refine as dtw_refine
from auto_trader.core.pattern_scan import DEFAULT_SCALES, Match, prefix_sums, scan

from .experimental import query_kernel, rescore, smooth_close

POOL = 100  # stage-one pool handed to any re-ranker, as in production
TOP_K = 20  # final list length the metrics see


@dataclass(frozen=True)
class Variant:
    key: str
    # Stage-one scan array: "ohlc", "close", or a smoothing fraction of the
    # query length ("close" smoothed with kernel = frac * m).
    scan: str = "ohlc"
    smooth_frac: float = 0.0
    smooth_fixed: int = 0
    # Re-rankers, applied to the stage-one pool in order.
    multires: bool = False
    swing: bool = False
    dtw: bool = False
    # Weight of the local-activity profile term (0 = off): penalizes windows
    # whose movement lives in different places than the query's (a flat lead
    # against a structured one), which the amplitude-normalized shape
    # distance cannot see.
    activity: float = 0.0


VARIANTS: dict[str, Variant] = {
    v.key: v
    for v in (
        # Production today.
        Variant("ohlc"),
        Variant("close", scan="close"),
        Variant("dtw", dtw=True),
        # Smoothed candidate scan, three kernel scales.
        Variant("smooth3", scan="close", smooth_fixed=3),
        Variant("smooth-m16", scan="close", smooth_frac=1 / 16),
        Variant("smooth-m8", scan="close", smooth_frac=1 / 8),
        # Multi-resolution refinement on the current scan.
        Variant("mres", multires=True),
        # Combinations.
        Variant("smooth-m8+mres", scan="close", smooth_frac=1 / 8, multires=True),
        Variant("smooth-m16+mres", scan="close", smooth_frac=1 / 16, multires=True),
        Variant("smooth-m8+mres+swing", scan="close", smooth_frac=1 / 8, multires=True, swing=True),
        Variant("smooth-m8+dtw", scan="close", smooth_frac=1 / 8, dtw=True),
        Variant("mres+swing", multires=True, swing=True),
        # Local-activity profile on top of the shipped shape config.
        Variant("shape+act.10", scan="close", smooth_frac=1 / 8, multires=True, activity=0.10),
        Variant("shape+act.15", scan="close", smooth_frac=1 / 8, multires=True, activity=0.15),
        Variant("shape+act.25", scan="close", smooth_frac=1 / 8, multires=True, activity=0.25),
    )
}

# The production "shape" mode: smooth-m8 scan + multires + the activity
# profile at pattern_shape.ACTIVITY_WEIGHT (same code, imported from core).
# Named here so reports read against the shipped configuration.
VARIANTS["shape"] = Variant(
    "shape", scan="close", smooth_frac=1 / 8, multires=True, activity=0.15
)


def run_variant(
    variant: Variant,
    ohlc: np.ndarray,
    ts: np.ndarray,
    query: np.ndarray,
    query_span: float,
) -> list[Match]:
    """Run one full pipeline: returns the final ranked list (TOP_K long)."""
    m = len(query)
    close_series = np.ascontiguousarray(ohlc[:, 3:4])
    close_query = np.ascontiguousarray(query[:, 3:4])

    if variant.scan == "ohlc":
        scan_arr, scan_query = ohlc, query
    else:
        kernel = variant.smooth_fixed or (
            query_kernel(m, variant.smooth_frac) if variant.smooth_frac else 1
        )
        scan_arr = smooth_close(close_series, kernel)
        scan_query = smooth_close(close_query, kernel)

    s1, s2 = prefix_sums(scan_arr)
    refining = variant.multires or variant.dtw or variant.swing or variant.activity > 0
    hits, _ = scan(
        scan_arr,
        s1,
        s2,
        ts,
        scan_query,
        query_span=query_span,
        top_k=POOL if refining else TOP_K,
        forward_bars=0,
        scales=DEFAULT_SCALES,
    )

    if variant.multires or variant.swing or variant.activity:
        # Refinement looks at the RAW close path, not the smoothed scan array:
        # stage one decides what surfaces, stage two ranks what the user sees.
        hits = rescore(
            close_series, close_query, hits,
            use_multires=variant.multires, use_swing=variant.swing,
            activity_weight=variant.activity,
        )
    if variant.dtw:
        hits = dtw_refine(scan_arr, scan_query, hits)
    return hits[:TOP_K]
