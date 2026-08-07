"""ATR risk/scaling series for the expression surface.

The expr surface has no `series` field on the wire: the browser ships candles and
expression strings, and everything else is recomputed server-side. But panel risk
(`stop`/`target` of kind atr/trailAtr) and scaling spacing (kind atr) execute
against `BacktestEngine.series["ATR_{length}"]` — see `_atr_at`
(engine/backtest.py) and the spacing read in `_open`'s caller. With an empty
series map those reads return None and the position runs stop-less, SILENTLY.
That is why the expr routes used to 422 with `atr_risk_unsupported`.

This module closes the gap by computing those series from the candles the request
already carries. Lengths are static per request (the sweep risk-target regex
allows only `.value`/`.mult`, never `.length`), so one build per request/combo is
enough. `atr_series` is the same Wilder/RMA call the coded path makes, and
tests/test_indicator_parity.py pins it element-wise against the frontend's
ATR_14 fixture — so computing here reproduces exactly the array the browser
would otherwise have posted.

Risk ATR is RMA-only and keyed by length: the risk DTOs carry no smoothing field,
and chart pane instances (ATR#id with SMA/EMA/WMA) are deliberately NOT
referenceable as a stop basis.

Raises a plain AtrWarmupError rather than an HTTPException: the three callers
(expr backtest router, sweep worker, live evaluate router) each report failures
in their own error shape.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

from .schemas import RiskConfigDTO, ScalingConfigDTO


class AtrWarmupError(Exception):
    """An ATR risk/scaling series is still undefined at the first bar that needs
    it, so a position opened there would carry no stop at all.

    `atr_series` defines its first value at index length-1, so this means the
    posted candles don't cover `length` bars before that bar. Checked at the
    FIRST tradeable bar rather than "somewhere in the window": an entry on an
    early bar seeds its bracket once, at entry, so a later-warming ATR gives that
    position stop_initial=None for its whole life — silently, which is the exact
    failure the old atr_risk_unsupported 422 stood in for.

    The frontend already sizes its history fetch by riskAtrLengths/
    scalingAtrLengths (lib/backtestWindow.ts), so a real request carries this
    warm-up; hitting this means the history genuinely wasn't there."""

    def __init__(self, length: int, have: int) -> None:
        self.length = length
        self.have = have
        self.message = (
            f"not enough history for ATR({length}): the ATR is undefined at the "
            f"first bar that can trade ({length} bars of warm-up needed before "
            f"the window, {have} candles posted). Start the range later, fetch "
            f"more history, or shorten the ATR length."
        )
        super().__init__(self.message)


def atr_lengths(
    risks: Iterable[RiskConfigDTO | None],
    scalings: Iterable[ScalingConfigDTO | None],
) -> list[int]:
    """Every ATR length the given panel risk / scaling configs execute against,
    ascending and deduped. Reuses the DTOs' own `atr_series_names()` so this
    can't drift from what the engine looks up."""
    names: set[str] = set()
    for dto in (*risks, *scalings):
        if dto is not None:
            names.update(dto.atr_series_names())
    return sorted(int(n.removeprefix("ATR_")) for n in names)


def build_atr_risk_series(
    candles: Sequence[Candle],
    risks: Iterable[RiskConfigDTO | None],
    scalings: Iterable[ScalingConfigDTO | None],
    ready_index: int,
) -> dict[str, list[float | None]]:
    """`{"ATR_{n}": series}` for every ATR length the configs reference, computed
    over the FULL candle list (warm-up bars included) because `_atr_at` indexes
    it with the engine's own bar index.

    `ready_index` is the first bar that may need a value: the first tradeable bar
    for a backtest, the decision bar for a live evaluate. A series still None
    there raises AtrWarmupError instead of degrading to a stop-less run — the
    same "a shortfall is a 422, never a silent misrun" rule the HTF warm-up check
    applies. (Deliberately stricter than the coded path, which only checks that a
    series of the right NAME was posted.)"""
    out: dict[str, list[float | None]] = {}
    for length in atr_lengths(risks, scalings):
        series = atr_series(candles, length)
        if not (0 <= ready_index < len(series)) or series[ready_index] is None:
            raise AtrWarmupError(length, len(candles))
        out[f"ATR_{length}"] = series
    return out


def first_tradeable_index(candles: Sequence[Candle], trade_from_time: int | None) -> int:
    """Index of the first bar the engine may trade — where an ATR stop first has
    to exist. Mirrors the engine's own `trade_from_time` gate; with no gate set,
    that's bar 0."""
    if trade_from_time is None:
        return 0
    for i, c in enumerate(candles):
        if int(c.time.timestamp()) >= trade_from_time:
            return i
    # Every bar precedes the window: nothing is tradeable, so nothing needs an
    # ATR. Point at the last bar so a genuinely too-short history still 422s.
    return max(0, len(candles) - 1)
