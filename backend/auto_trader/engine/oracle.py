"""Oracle baseline: the trades one would take if future prices were known.

`plan_corrected` produces a `PlannedTrade` list in FILL space — `entry_fill` /
`exit_fill` are bar indices whose OPENS fill the trade, mirroring the engine's
pending-signal semantics (a signal on bar i fills at bar i+1's open). A
replay strategy then executes the plan through the real BacktestEngine, so
oracle numbers flow through the identical cost model, equity curve, and
metrics path as every other baseline.

The planner prices fills exactly like the engine's `_fill_price` with a fixed
slippage: buy at open + spread/2 + slippage, sell at open - spread/2 -
slippage, plus a flat commission per side. ATR-scaled slippage and overnight
financing are NOT anticipated by the planner (the replay still charges them),
so with those configured the replayed result is a near-optimal bound rather
than the exact optimum.

Exits that fill at prices other than a bar's open are handled so the oracle
never underperforms the real run: a range-end close gets the final bar's
close as a candidate, and an intra-bar take-profit that beats every open is
kept as a bracket plan (the entry signal carries `target_level` and the
engine's own intra-bar fill closes it). Intra-bar STOP fills need no
candidate — a stop fill is never better than its own bar's open, which is
already in the candidate set.
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from auto_trader.core.models import Candle, Side, Signal, Trade
from auto_trader.strategy.base import Context, Strategy

if TYPE_CHECKING:  # the runtime import is local (below) to avoid a cycle
    from auto_trader.engine.backtest import BacktestResult


@dataclass(slots=True, frozen=True)
class PlannedTrade:
    """One planned round trip. `entry_fill`/`exit_fill` index the bars whose
    opens fill it (exit_fill > entry_fill); `leg` is the engine bucket.
    `exit_fill == len(candles)` means hold to the end of data: no exit signal
    is ever collectible, so the engine's range-end close books the trade at
    the final bar's close. A non-None `target_level` makes it a bracket plan:
    the entry signal carries the absolute target and NO exit signal is
    emitted — the engine's intra-bar target fill (the same one the real trade
    got) closes it; `exit_fill` then only orders/serializes the plan."""

    leg: str  # "long" | "short"
    entry_fill: int
    exit_fill: int
    qty: float
    target_level: float | None = None


def plan_corrected(
    trades: list[Trade], candles: list[Candle], *,
    commission_per_side: float, spread: float, slippage: float,
) -> list[PlannedTrade]:
    """The strategy's own entries, perfected with hindsight: each real trade
    re-enters at its actual entry fill bar, in whichever direction pays best,
    and exits at the best open within its actual holding window (never later
    than the real exit; a same-bar intra-bar exit still gets the minimum
    one-bar round trip). A trade the engine closed at the data end ("range
    end") also gets the final bar's close as a candidate — the real trade got
    that price, and without it the oracle could underperform the run it is
    supposed to bound. Direction ties keep the original leg. A trade is kept
    even when its best outcome still loses to costs — the entry time is the
    constraint being measured.

    Because an engine exit signal closes EVERY position on its leg
    (`_close_all`), overlapping same-leg plans are serialized: an earlier
    plan's exit is clamped to the next plan's entry fill (close and reopen on
    the same open). Only strategies holding concurrent positions are affected,
    and only in those overlaps."""
    adj = spread / 2.0 + slippage
    times = [c.time for c in candles]
    n = len(candles)
    plans: list[PlannedTrade] = []
    for t in trades:
        j = bisect_right(times, t.entry_time) - 1
        if j < 1 or j > n - 2:
            continue
        end = max(bisect_right(times, t.exit_time) - 1, j + 1)
        end = min(end, n - 1)
        # Exit candidates are opens after entry, up to the real exit bar. A
        # trade the engine force-closed at the final CLOSE ("range end") had
        # that price too — without it the oracle can underperform the real
        # run. Candidate k == n is the hold-to-end exit: no exit signal, the
        # engine's own range-end close books it at candles[-1].close.
        exits = [(k, candles[k].open) for k in range(j + 1, end + 1)]
        if t.reason_out == "range end":
            exits.append((n, candles[-1].close))
        best: tuple[float, str, int] | None = None
        for k, px in exits:
            long_pnl = (
                t.quantity * ((px - adj) - (candles[j].open + adj))
                - 2 * commission_per_side
            )
            short_pnl = (
                t.quantity * ((candles[j].open - adj) - (px + adj))
                - 2 * commission_per_side
            )
            for pnl, leg in ((long_pnl, "long"), (short_pnl, "short")):
                better = best is None or pnl > best[0] or (
                    pnl == best[0] and leg == t.leg and best[1] != t.leg
                )
                if better:
                    best = (pnl, leg, k)
        assert best is not None  # j <= n-2 guarantees at least one k
        # An intra-bar take-profit filled at a price that is no bar's open. If
        # it beats every open (and end-close) candidate, keep the real exit as
        # a bracket plan — t.exit_price is already the cost-adjusted fill.
        target = None
        if t.reason_out == "target" and t.target is not None:
            sign = 1.0 if t.leg == "long" else -1.0
            entry = candles[j].open + sign * adj
            keep_pnl = (
                t.quantity * sign * (t.exit_price - entry)
                - 2 * commission_per_side
            )
            if keep_pnl > best[0]:
                best = (keep_pnl, t.leg, end)
                target = t.target
        plans.append(PlannedTrade(
            leg=best[1], entry_fill=j, exit_fill=best[2], qty=t.quantity,
            target_level=target))

    plans.sort(key=lambda p: (p.entry_fill, p.exit_fill))
    # Serialize overlaps per leg (see docstring).
    last_by_leg: dict[str, int] = {}  # leg -> index in plans of last seen plan
    for i, p in enumerate(plans):
        prev_i = last_by_leg.get(p.leg)
        if prev_i is not None and plans[prev_i].exit_fill > p.entry_fill:
            # A clamped bracket plan can no longer wait for its target; it
            # degrades to the ordinary open exit at the clamp point.
            plans[prev_i] = replace(
                plans[prev_i], exit_fill=p.entry_fill, target_level=None)
        last_by_leg[p.leg] = i
    # A clamp can degenerate a plan to zero length (same entry fill on the same
    # leg); drop those rather than emit an unfillable round trip.
    return [p for p in plans if p.exit_fill > p.entry_fill]


class PlannedStrategy(Strategy):
    """Replays a fixed plan: at each bar it emits the signals whose fills are
    due at the NEXT bar's open. Exits are emitted before entries so a close
    and a reopen landing on the same fill bar resolve in that order (the
    engine processes pending signals in emission order)."""

    _ENTRY_SIDE = {"long": Side.BUY, "short": Side.SELL}
    _EXIT_SIDE = {"long": Side.SELL, "short": Side.BUY}

    def __init__(self, plans: list[PlannedTrade]) -> None:
        self._by_signal_bar: dict[int, list[Signal]] = {}
        for p in plans:
            if p.target_level is not None:
                continue  # bracket plan: the engine's target fill exits it
            self._by_signal_bar.setdefault(p.exit_fill - 1, []).append(Signal(
                side=self._EXIT_SIDE[p.leg], quantity=p.qty,
                reason="oracle exit", leg=p.leg))
        for p in plans:
            self._by_signal_bar.setdefault(p.entry_fill - 1, []).append(Signal(
                side=self._ENTRY_SIDE[p.leg], quantity=p.qty,
                reason="oracle entry", leg=p.leg,
                target_level=p.target_level))
        # Exits before entries within one bar, keeping plan order otherwise.
        for sigs in self._by_signal_bar.values():
            sigs.sort(key=lambda s: s.reason != "oracle exit")

    def on_bar(self, ctx: Context) -> list[Signal]:
        return self._by_signal_bar.get(len(ctx.history) - 1, [])


def replay_planned(
    plans: list[PlannedTrade], candles: list[Candle], *,
    starting_cash: float, commission_per_side: float, spread: float,
    slippage: float, slippage_atr_mult: float = 0.0,
    fin_long_daily_pct: float = 0.0, fin_short_daily_pct: float = 0.0,
    on_progress=None,
) -> "BacktestResult":
    """Execute a plan through the real BacktestEngine under the run's cost
    model. No risk/scaling/mask: the plan IS the exit logic, and a stop or
    session flatten would knock out planned trades."""
    from auto_trader.engine.backtest import BacktestEngine, BacktestResult  # noqa: F401  local: avoids import cycle risk

    engine = BacktestEngine(
        PlannedStrategy(plans),
        starting_cash=starting_cash,
        commission_per_side=commission_per_side,
        slippage=slippage,
        slippage_atr_mult=slippage_atr_mult,
        spread=spread,
        fin_long_daily_pct=fin_long_daily_pct,
        fin_short_daily_pct=fin_short_daily_pct,
    )
    return engine.run(candles, on_progress=on_progress)
