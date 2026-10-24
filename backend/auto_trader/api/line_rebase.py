"""Move a picked line's reference bar onto the first loaded bar when neither of
its anchors sits inside the loaded range: a screen or backtest run long after
the pick (both anchors before the range), or a backtest over a past window of a
line picked today (t2 before the range, tRef after it). Counting bars needs the
line's own timeframe history, so this is an async pre-pass in the handler,
before the sync compile."""
from __future__ import annotations

import bisect
import time

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.strategy.expr.lines import line_active, parse_lines

from . import deps

REBASE_MAX_BARS = 5000


def _ms(c) -> int:
    return int(c.time.timestamp() * 1000)


def _warning(lid: str) -> str:
    return (f"{lid} could not be placed on the loaded bars. Lines older than "
            f"{REBASE_MAX_BARS} bars of their timeframe need picking again.")


async def rebase_lines(lines, *, first_ms: int, last_ms: int, broker: str, side: str,
                       loader) -> list[str]:
    """Rebase each line in `lines` (mutated in place: tRef/pRef only) whose
    anchors both miss [first_ms, last_ms]. The caller filters to ACTIVE lines
    and passes the request's resolved `broker`; a line's own broker field is
    never fetched from."""
    warnings: list[str] = []
    for lid, ln in lines.items():
        if ln.t2 > last_ms:
            continue  # the line starts after the range: no value, nothing to place
        if first_ms <= ln.t2 or first_ms <= ln.tRef <= last_ms:
            continue  # an anchor is inside the range
        period_ms = resolution_seconds(ln.timeframe) * 1000
        oldest = min(ln.tRef, first_ms)
        count = min(REBASE_MAX_BARS, (int(time.time() * 1000) - oldest) // period_ms + 50)
        try:
            bars, degraded = await loader(broker, ln.epic, ln.timeframe, side, count)
        except Exception:
            bars, degraded = [], True
        times = [_ms(c) for c in bars]
        i_ref = bisect.bisect_left(times, ln.tRef)
        i_first = bisect.bisect_left(times, first_ms)
        # tRef may be the forming bar just past the last loaded one.
        ref_ok = i_ref < len(times) or (times and ln.tRef <= times[-1] + period_ms)
        if degraded or not times or times[0] > oldest or i_first >= len(times) or not ref_ok:
            warnings.append(_warning(lid))
            continue
        ln.pRef = ln.pRef + ln.slope * (i_first - i_ref)
        ln.tRef = times[i_first]
    return warnings


async def rebase_request_lines(req, *, first_ms: int, last_ms: int) -> list[str]:
    """The one rebase pre-pass every expr/strategy handler runs, after it has
    resolved req.broker and before request_instances. Validates req.lines first
    (parse_lines: caps, geometry, timeframe; LineSpecError, the caller's 422),
    so nothing is fetched for a request that is refused anyway. Only lines
    active on this request's symbol (line_instances' predicate) are rebased,
    and their history comes from req.broker, never from the line's own field.
    Mutates req.lines' DTOs in place, which request_instances and a pool
    worker's req_dict rebuild both read."""
    lines = getattr(req, "lines", None) or {}
    parsed = parse_lines({k: v.model_dump() for k, v in lines.items()})
    for lid, pl in parsed.items():
        lines[lid].timeframe = pl.timeframe  # canonical, for the loader
    active = {lid: lines[lid] for lid, pl in parsed.items()
              if line_active(pl, epic=req.epic, broker=req.broker or "")}
    if not active:
        return []
    return await rebase_lines(active, first_ms=first_ms, last_ms=last_ms, broker=req.broker,
                              side=req.priceSide or "mid", loader=deps.load_alert_bars)
