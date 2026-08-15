"""Engine `start_index` hook: for a flat-start run whose strategy cannot signal
before bar s (WFO windows gate entries at trade_from), skipping bars 0..s-1 and
starting the loop at s must be identical to grinding through the dead prefix.

This is the fast-forward WFO exact mode relies on: window replays and OOS test
runs pass the FULL candle list (causal indicator series computed once are
reused, and bar indices stay aligned via the seeded history) but only iterate
the bars the window can actually trade."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def _series(closes: list[float]) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [Candle(t0 + timedelta(minutes=i), c, c + 0.5, c - 0.5, c, 0.0)
            for i, c in enumerate(closes)]


class GatedFlip(Strategy):
    """FlipEvery gated at bar index `gate`: silent before it (like a WFO
    window's trade_from), then buys/closes on alternating bars. Pure function
    of history length, so a seeded-history run stays index-aligned."""

    def __init__(self, gate: int) -> None:
        self.gate = gate

    def on_bar(self, ctx: Context) -> list[Signal]:
        n = len(ctx.history)
        if n - 1 < self.gate:
            return []
        if n % 4 == 1:
            return [Signal(Side.BUY, 1.0, "in")]
        if n % 4 == 3:
            return [Signal(Side.SELL, 1.0, "out")]
        return []


def _summary(res):
    return (res.net_pnl, res.n_trades,
            [(t.entry_price, t.exit_price, t.pnl, t.reason_out) for t in res.trades],
            [(p.time, round(p.equity, 6)) for p in res.equity])


def _engine(gate: int, **kw) -> BacktestEngine:
    return BacktestEngine(GatedFlip(gate), commission_per_side=0.5, **kw)


def test_start_index_matches_full_run_for_gated_strategy():
    closes = [10, 11, 12, 11, 13, 14, 12, 15, 16, 14, 13, 12]
    full = _series(closes)
    for s in range(len(full)):
        a = _engine(s).run(full)
        b = _engine(s).run(full, start_index=s)
        pa, pb = _summary(a), _summary(b)
        # Same trades/pnl; the fast run's equity is the full run's from s on.
        assert pa[:3] == pb[:3], f"mismatch at start_index={s}"
        assert pa[3][s:] == pb[3], f"equity mismatch at start_index={s}"


def test_start_index_none_is_full_run():
    full = _series([10, 11, 12, 13, 12, 11])
    a = _engine(0).run(full)
    b = _engine(0).run(full, start_index=None)
    assert _summary(a) == _summary(b)


def test_start_index_composes_with_stop_index():
    closes = [10, 11, 12, 11, 13, 14, 12, 15, 16, 14, 13, 12, 14, 15]
    full = _series(closes)
    s, k = 4, 10
    a = _engine(s).run(full, stop_index=k)
    b = _engine(s).run(full, start_index=s, stop_index=k)
    pa, pb = _summary(a), _summary(b)
    assert pa[:3] == pb[:3]
    assert pa[3][s:] == pb[3]


def test_start_index_keeps_atr_slippage_aligned():
    # ATR-scaled slippage is computed over the run's own candles; a fast-forward
    # run must charge the same per-bar slippage as the full run.
    closes = [10, 11, 12, 11, 13, 14, 12, 15, 16, 14, 13, 12, 14, 15, 16, 17,
              15, 14, 16, 18]
    full = _series(closes)
    s = 16  # past the ATR(14) warm-up so slippage is non-zero
    a = _engine(s, slippage_atr_mult=0.5).run(full)
    b = _engine(s, slippage_atr_mult=0.5).run(full, start_index=s)
    pa, pb = _summary(a), _summary(b)
    assert pa[:3] == pb[:3]
    assert pa[3][s:] == pb[3]
