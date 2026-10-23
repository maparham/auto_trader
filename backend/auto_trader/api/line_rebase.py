"""Move a picked line's reference bar up to the first loaded bar when both of
its anchors sit before the loaded range (a screen or backtest run long after
the pick). Counting bars needs the line's own timeframe history, so this is an
async pre-pass in the handler, before the sync compile."""
from __future__ import annotations

import bisect
import time

from auto_trader.core.candle_aggregate import resolution_seconds

REBASE_MAX_BARS = 5000


def _ms(c) -> int:
    return int(c.time.timestamp() * 1000)


async def rebase_lines(lines, *, first_ms: int, side: str, loader) -> list[str]:
    warnings: list[str] = []
    for lid, ln in lines.items():
        if ln.t2 >= first_ms or ln.tRef >= first_ms:
            continue  # an anchor is inside (or the line starts after) the range
        period_ms = resolution_seconds(ln.timeframe) * 1000
        count = min(REBASE_MAX_BARS, (int(time.time() * 1000) - ln.tRef) // period_ms + 50)
        try:
            bars, degraded = await loader(ln.broker, ln.epic, ln.timeframe, side, count)
        except Exception:
            bars, degraded = [], True
        times = [_ms(c) for c in bars]
        i_ref = bisect.bisect_left(times, ln.tRef)
        i_first = bisect.bisect_left(times, first_ms)
        if degraded or not times or times[0] > ln.tRef or i_first >= len(times):
            warnings.append(f"{lid} could not be placed on the loaded bars.")
            continue
        ln.pRef = ln.pRef + ln.slope * (i_first - i_ref)
        ln.tRef = times[i_first]
    return warnings
