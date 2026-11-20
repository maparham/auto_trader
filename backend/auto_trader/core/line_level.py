"""The level of a frozen line (a line alert, a picked line L<n>) `bars` bars
after its reference bar. A Log Scale trendline is straight in ln price, so its
geometry carries `log: True` and a slope in ln per bar: the level then grows by
the factor e^slope per bar. pRef stays a PRICE either way. Mirrors frontend
src/lib/lineLevel.ts."""

from __future__ import annotations

import math


def line_level(p_ref: float, slope: float, bars: float, log: bool = False) -> float:
    return p_ref * math.exp(slope * bars) if log else p_ref + slope * bars
