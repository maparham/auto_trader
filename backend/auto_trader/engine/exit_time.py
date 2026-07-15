"""Resolve the sub-bar exit time of an intra-bar stop/target exit.

The engine runs on the run timeframe's OHLC, so an intra-bar exit is stamped at
the run bar's open. Given that bar's 1-minute candles, find the FIRST minute that
actually pierced the exit level. Pure and side-effect free so it unit-tests
without a database; the caller supplies the candles.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime, timezone

from auto_trader.core.models import Candle, Trade

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
    (injected so this is testable without a candle store). Runs at most one load
    per distinct exit bar."""
    if run_tf_seconds <= 60:
        return
    memo: dict[int, list[Candle]] = {}
    for t in trades:
        if t.reason_out not in _INTRABAR:
            continue
        start_s = int(t.exit_time.timestamp())
        if start_s not in memo:
            memo[start_s] = await load_minutes(start_s, start_s + run_tf_seconds)
        exact = resolve_exit_time(
            leg=t.leg, reason=t.reason_out, run_tf_seconds=run_tf_seconds,
            stop_final=t.stop_final, target=t.target, exit_price=t.exit_price,
            minute_candles=memo[start_s],
        )
        if exact is not None:
            t.exit_time_exact = datetime.fromtimestamp(exact, tz=timezone.utc)
