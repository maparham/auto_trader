"""Resolve the sub-bar exit time of an intra-bar stop/target exit.

The engine runs on the run timeframe's OHLC, so an intra-bar exit is stamped at
the run bar's open. Given that bar's 1-minute candles, find the FIRST minute that
actually pierced the exit level. Pure and side-effect free so it unit-tests
without a database; the caller supplies the candles.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime, timezone

from auto_trader.core.models import Candle, Trade

logger = logging.getLogger(__name__)

_DAY_S = 86400

# The only exits that happen mid run-bar. Everything else fills at a bar boundary.
_INTRABAR = frozenset({"stop", "trail", "target"})


def resolve_exit_time(
    *,
    leg: str,
    reason: str,
    run_tf_seconds: int,
    stop_final: float | None,
    target: float | None,
    exit_price: float,
    minute_candles: Sequence[Candle],
) -> int | None:
    if reason not in _INTRABAR:
        return None
    if run_tf_seconds <= 60:  # nothing finer than the run bar to resolve to
        return None
    if not minute_candles:
        return None

    if reason == "target":
        level = target if target is not None else exit_price
        pierced = (
            (lambda c: c.high >= level) if leg == "long" else (lambda c: c.low <= level)
        )
    else:  # stop / trail
        level = stop_final if stop_final is not None else exit_price
        pierced = (
            (lambda c: c.low <= level) if leg == "long" else (lambda c: c.high >= level)
        )

    for c in minute_candles:
        if pierced(c):
            return int(c.time.timestamp())
    return None


async def attach_exit_times(
    trades: Sequence[Trade],
    *,
    run_tf_seconds: int,
    load_minutes: Callable[[int, int], Awaitable[list[Candle]]],
) -> None:
    """Populate exit_time_exact on every intra-bar-exit trade, resolving from the
    exit bar's 1-minute candles. `load_minutes(from_s, to_s)` supplies the candles
    (injected so this is testable without a candle store).

    Loads are batched per UTC day of the exit bar — one span covering that day's
    exit bars — because upstream minute fetches pay a large per-call cost (day
    files) that would otherwise repeat per exit bar. Best-effort: a failed load
    skips that day's trades and moves on rather than aborting the rest."""
    if run_tf_seconds <= 60:
        return
    intrabar = [t for t in trades if t.reason_out in _INTRABAR]
    if not intrabar:
        return

    # Distinct exit-bar starts, grouped by the UTC day they begin in.
    days: dict[int, list[int]] = {}
    for t in intrabar:
        start_s = int(t.exit_time.timestamp())
        days.setdefault(start_s // _DAY_S, []).append(start_s)

    minutes: dict[int, list[Candle]] = {}  # exit-bar start -> its minute candles
    for starts in days.values():
        span_from, span_to = min(starts), max(starts) + run_tf_seconds
        try:
            loaded = await load_minutes(span_from, span_to)
        except Exception:
            logger.warning(
                "minute load %s..%s failed; skipping that day's exit times",
                span_from, span_to, exc_info=True,
            )
            continue
        for start_s in starts:
            end_s = start_s + run_tf_seconds
            minutes[start_s] = [
                c for c in loaded if start_s <= int(c.time.timestamp()) < end_s
            ]

    for t in intrabar:
        start_s = int(t.exit_time.timestamp())
        if start_s not in minutes:
            continue
        exact = resolve_exit_time(
            leg=t.leg, reason=t.reason_out, run_tf_seconds=run_tf_seconds,
            stop_final=t.stop_final, target=t.target, exit_price=t.exit_price,
            minute_candles=minutes[start_s],
        )
        if exact is not None:
            t.exit_time_exact = datetime.fromtimestamp(exact, tz=timezone.utc)
