"""Higher-timeframe candles for expression trees, in one place.

A rule or screen that references a timeframe (an @tf token, or a chart pane
pinned in its own settings) needs that timeframe's candles before compile_row
can precompute its series. Every surface that runs expressions used to carry
its own copy of "collect the timeframes, work out how many closed bars each
needs, fetch, check": the backtest pipeline, the evaluate and closeness
routes, the screener. They all call here now.

The shape is three small pieces so callers keep their own windows and error
wording: `htf_needs` (pure), `fetch_htf` (one window fetch through
deps._fetch_symbol_candles), `closed_before` (the sufficiency count), and
`source_htf` tying them together for callers that want the backtest's
"fetch what was not shipped, then verify" behaviour.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.registry import PATTERN_FN_NAMES
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.warmup import PATTERN_WARMUP, warmup_bars

from . import deps
from .sweep_apply import referenced_tfs as _referenced_tfs


@dataclass(frozen=True, slots=True)
class HtfNeed:
    """One referenced timeframe and how much of it a set of nodes needs."""
    tf: str      # as referenced: "W", "1H", or a pane's own pin
    res: str     # canonical resolution ("WEEK"), the htf dict key
    tf_s: int    # nominal bar seconds
    need: int    # closed bars required before the cutoff: deepest inner warm-up + 1


class HtfShortfall(Exception):
    """Fewer closed bars of `tf` before the cutoff than the nodes need.
    `bars` is how many bars there were at all (0: the fetch was empty)."""

    def __init__(self, tf: str, closed: int, need: int, bars: int) -> None:
        super().__init__(f"not enough @{tf} history: {closed} of {need} closed bars")
        self.tf, self.closed, self.need, self.bars = tf, closed, need, bars


def _pin_owner(tf: str, instances) -> str | None:
    """The instance whose OWN settings pin names `tf`, if any."""
    return next((i for i, inst in (instances or {}).items()
                 if inst.spec.timeframe(inst.config) == tf), None)


def _tf_span(tf: str, instances=None) -> tuple[int, str]:
    """(nominal bar seconds, canonical resolution) for a referenced timeframe.

    An @tf TOKEN was already alias-checked by validate(). An instance's own pin
    was NOT: it never passes through the parser, so validate() has never seen
    it, and the chart's timeframe vocabulary is a strict superset of this
    backend's Resolution enum (SECOND, SECOND_5/10/15/30/45, ...). Without this
    guard such a pin reaches resolution_seconds() and 500s on an uncaught
    ValueError. Name the offending pane so the user can fix the pane, not guess.
    """
    res = tf_resolution(tf)
    if res is not None:
        try:
            return resolution_seconds(res), res
        except (ValueError, KeyError):
            pass
    owner = _pin_owner(tf, instances)
    where = (f"{owner} is pinned to timeframe '{tf}'" if owner
             else f"timeframe '{tf}' is not supported")
    raise HTTPException(422, {
        "code": "unsupported_timeframe",
        "message": f"{where}, which backtests cannot compute. Change that "
                   f"indicator's timeframe or unpin it.",
        "start": None, "end": None, "group": None, "row": None,
    })


def _same_tf(a: str, b: str) -> bool:
    """Two timeframe spellings naming the same resolution. An instance's own pin
    is whatever its pane settings hold ("1H"), while an @tf token may be either
    the alias or the canonical form ("HOUR") — compare canonically."""
    return (tf_resolution(a) or a) == (tf_resolution(b) or b)


def _tf_inner_warmup(node: N.Node, tf: str, instances=None) -> int:
    """Deepest warm-up (in the PIN's own bars) any @`tf` pin in `node` needs."""
    if isinstance(node, N.Tf):
        return warmup_bars(node.base, tf_resolution(node.tf), instances) if node.tf == tf else 0
    if isinstance(node, N.IndicatorRef):
        # An instance pinned in its OWN SETTINGS is an @tf pin with no @tf in the
        # text: it is computed on `pin`'s bars, so it needs its full warm-up in
        # THOSE bars. Charging only the +1 the caller adds would let the
        # sufficiency check pass on a single closed HTF bar and warm the series
        # from nothing — a silently wrong number, not an error.
        inst = (instances or {}).get(node.instance)
        pin = inst.spec.timeframe(inst.config) if inst else None
        if pin and _same_tf(pin, tf):
            return inst.spec.warmup(inst.config, node.output)
        return 0
    if isinstance(node, (N.Chain, N.BoolOp)):
        return max((_tf_inner_warmup(p, tf, instances) for p in node.parts), default=0)
    if isinstance(node, N.Not):
        return _tf_inner_warmup(node.operand, tf, instances)
    if isinstance(node, (N.Compare, N.Binary)):
        return max(_tf_inner_warmup(node.left, tf, instances), _tf_inner_warmup(node.right, tf, instances))
    if isinstance(node, N.Cross):
        return max(_tf_inner_warmup(node.a, tf, instances), _tf_inner_warmup(node.b, tf, instances))
    if isinstance(node, (N.Field, N.Offset)):
        return _tf_inner_warmup(node.base, tf, instances)
    if isinstance(node, N.Unary):
        return _tf_inner_warmup(node.operand, tf, instances)
    if isinstance(node, N.Call):
        return max((_tf_inner_warmup(a, tf, instances) for a in node.args), default=0)
    if isinstance(node, N.Predicate):
        # A pattern pinned to @`tf` needs PATTERN_WARMUP bars of THAT timeframe
        # before its first honest value. Charge it only when this predicate is
        # actually pinned to `tf`: callers max this across every row for every
        # referenced timeframe, so charging it unconditionally would let an
        # UNPINNED pattern row inflate an unrelated pin's ask (and spuriously
        # 422 on the `closed < need` check below).
        pinned_here = node.fn in PATTERN_FN_NAMES and tf in _referenced_tfs(node.base, instances)
        return (PATTERN_WARMUP if pinned_here else 0) + _tf_inner_warmup(node.base, tf, instances)
    if isinstance(node, N.Count):
        return max(_tf_inner_warmup(node.cond, tf, instances), _tf_inner_warmup(node.window, tf, instances))
    return 0


def htf_needs(nodes: list[N.Node], instances=None, *, resolution: str | None = None) -> list[HtfNeed]:
    """One need per canonical resolution the nodes reference, each with the
    deepest warm-up any node needs in that timeframe's own bars, plus one:
    the closed bar whose value the first judged or traded bar reads.

    Spellings of one resolution merge (`@1H` and `@HOUR`, or a pane pinned
    "1H" beside an `@HOUR` token): they are one fetch, and two needs would let
    a caller's second, shallower fetch overwrite the deeper one under the same
    canonical key. `tf` keeps the first spelling in sorted order.

    `resolution` (the rule's base timeframe, optional) is forwarded to
    `referenced_tfs` so a picked line on that SAME timeframe is never reported
    as a need (it evaluates straight off the base candles)."""
    tfs: set[str] = set()
    for node in nodes:
        tfs |= _referenced_tfs(node, instances, resolution=resolution)
    by_res: dict[str, HtfNeed] = {}
    for tf in sorted(tfs):
        tf_s, res = _tf_span(tf, instances)
        need = max((_tf_inner_warmup(n, tf, instances) for n in nodes), default=0) + 1
        prev = by_res.get(res)
        by_res[res] = HtfNeed(prev.tf if prev else tf, res, tf_s, max(need, prev.need if prev else 0))
    return list(by_res.values())


def warm_window(need: HtfNeed, from_ts: int, to_ts: int) -> tuple[int, int, int]:
    """(from, to, bars) reaching 2x the need plus 10 bars before from_ts: a bar
    count only maps to a span while the market is open, and a weekend or
    holiday can eat most of an exact ask."""
    start = from_ts - (need.need * 2 + 10) * need.tf_s
    return start, to_ts, max(1, (to_ts - start) // need.tf_s + 2)


async def fetch_htf(need: HtfNeed, *, broker: str, epic: str, side: str,
                    from_ts: int, to_ts: int, bars: int | None = None,
                    degraded: dict | None = None) -> list[Candle]:
    """One window fetch of `need.res`. Positional arguments only, matching the
    seven-argument fetch doubles in the tests; `degraded` rides along only when
    the caller wants the cache's degraded flag."""
    if bars is None:
        bars = max(1, (to_ts - from_ts) // need.tf_s + 2)
    if degraded is None:
        return await deps._fetch_symbol_candles(broker, epic, need.res, bars, from_ts, to_ts, side)
    return await deps._fetch_symbol_candles(broker, epic, need.res, bars, from_ts, to_ts, side,
                                            degraded=degraded)


# Extra bars fetched BEFORE the base window for a timeframe a coded strategy
# discovers at run time (`tf=` calls, NeedTimeframe): its indicators warm up on
# them instead of seeding from the first in-window bar and reporting a wrong
# but non-None value. Alignment still gates each bar to its close, so older
# bars only help warm-up.
DISCOVERED_WARMUP_BARS = 300


async def fetch_discovered(timeframe: str, *, broker: str, epic: str, side: str,
                           from_ts: int, to_ts: int) -> list[Candle]:
    """Candles for a timeframe a coded strategy asked for mid-run. Its warm-up
    is unknown until it runs, so a fixed DISCOVERED_WARMUP_BARS replaces the
    need-sized window the expression paths get. Empty is a 422."""
    fetched = await deps._fetch_symbol_candles(
        broker, epic, timeframe, 1000,
        from_ts - DISCOVERED_WARMUP_BARS * resolution_seconds(timeframe), to_ts, side,
    )
    if not fetched:
        raise HTTPException(422, f"no candles for timeframe '{timeframe}'")
    return fetched


def closed_before(bars: list[Candle], tf_s: int, cutoff_ts: int) -> int:
    """Bars whose nominal close (open + tf_s) is at or before the cutoff."""
    return sum(1 for c in bars if int(c.time.timestamp()) + tf_s <= cutoff_ts)


async def source_htf(nodes: list[N.Node], instances, *, broker: str, epic: str, side: str,
                     from_ts: int, to_ts: int, cutoff_ts: int | None,
                     shipped: dict[str, list[Candle]],
                     resolution: str | None = None) -> dict[str, list[Candle]]:
    """The shipped map plus a warm-window fetch for every need it lacks, every
    entry checked for `need` closed bars before `cutoff_ts` (None: no check).
    Keys are canonical; a shipped alias key ("1H") is honoured on read.
    `resolution` is passed through to `htf_needs` (a line on the base
    timeframe is not a need)."""
    out: dict[str, list[Candle]] = dict(shipped)
    for need in htf_needs(nodes, instances, resolution=resolution):
        bars = out.get(need.res) or out.get(need.tf)
        if not bars:
            start, end, n = warm_window(need, from_ts, to_ts)
            bars = await fetch_htf(need, broker=broker, epic=epic, side=side,
                                   from_ts=start, to_ts=end, bars=n)
            if not bars:
                raise HtfShortfall(need.tf, 0, need.need, 0)
            out[need.res] = bars
        if cutoff_ts is not None:
            closed = closed_before(bars, need.tf_s, cutoff_ts)
            if closed < need.need:
                raise HtfShortfall(need.tf, closed, need.need, len(bars))
    return out
