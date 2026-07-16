"""Cost-sensitivity summary: where does net P&L cross zero as slippage and
commission scale? Pure arithmetic; the router owns the re-runs."""
from __future__ import annotations


def breakeven_multiple(multiples: list[float], nets: list[float]) -> float | None:
    """First zero crossing of nets over ascending cost multiples, linearly
    interpolated. None when every multiple stays profitable. 0.0 when the
    zero-cost run is already unprofitable (there is nothing to break even
    from). An exact zero net at multiple m returns m."""
    if nets[0] <= 0:
        return 0.0 if nets[0] < 0 else round(multiples[0], 2)
    for (m0, n0), (m1, n1) in zip(zip(multiples, nets), zip(multiples[1:], nets[1:])):
        if n1 <= 0:
            return round(m1, 2) if n1 == 0 else round(m0 + n0 / (n0 - n1) * (m1 - m0), 2)
    return None
