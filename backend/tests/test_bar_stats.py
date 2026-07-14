"""BarStats.update: per-bar accumulation of a trade's time-in-zone, entry
retests, streaks and chop. Pure over hand-built candles, no engine."""

from datetime import datetime, timezone

from auto_trader.core.models import BarStats, Candle


def _c(o, h, l, c):
    """One candle; time is irrelevant to BarStats so all share a base time."""
    return Candle(datetime(2024, 1, 1, tzinfo=timezone.utc), o, h, l, c, 0.0)


def _run(entry, leg, bars):
    bs = BarStats()
    for b in bars:
        bs.update(entry, leg, b)
    return bs


def test_long_zone_counts_and_flat():
    # entry=100. closes: 101 (profit), 99 (loss), 100 (flat), 102 (profit).
    bars = [_c(100, 101, 100, 101), _c(101, 101, 99, 99),
            _c(99, 100, 99, 100), _c(100, 102, 100, 102)]
    bs = _run(100.0, "long", bars)
    assert bs.bars_held == 4
    assert bs.bars_in_profit == 2
    assert bs.bars_in_loss == 1
    # flat bar (close == entry) is neither profit nor loss.


def test_long_body_through_and_wicks():
    # Bar A: open 99, close 101 -> body straddles 100 (body_through).
    # Bar B: close 102 (profit), low 99 -> wick_from_profit (retest down to entry).
    # Bar C: close 98 (loss), high 101 -> wick_from_loss (retest up to entry).
    bars = [_c(99, 101, 99, 101), _c(101, 103, 99, 102), _c(99, 101, 97, 98)]
    bs = _run(100.0, "long", bars)
    assert bs.body_through == 1
    assert bs.wick_from_profit == 1
    assert bs.wick_from_loss == 1


def test_long_streaks_and_crossings():
    # closes vs entry 100: 101,102 (profit x2), 99 (loss), 98 (loss), 103 (profit).
    # profit streak max 2, loss streak max 2, crossings: P->L (at 99), L->P (at 103) = 2.
    bars = [_c(100, 101, 100, 101), _c(101, 102, 101, 102),
            _c(102, 102, 99, 99), _c(99, 99, 98, 98), _c(98, 103, 98, 103)]
    bs = _run(100.0, "long", bars)
    assert bs.longest_profit_streak == 2
    assert bs.longest_loss_streak == 2
    assert bs.entry_crossings == 2


def test_long_bars_to_mfe_and_mae():
    # entry 100. Highs: 100,101,101,105 -> favorable extreme (105) set on bar 4.
    # Lows: 100,98,95,95 -> adverse extreme (95) set on bar 3.
    bars = [_c(100, 100, 100, 100), _c(100, 101, 98, 100),
            _c(100, 101, 95, 100), _c(100, 105, 100, 104)]
    bs = _run(100.0, "long", bars)
    assert bs.bars_to_mfe == 4
    assert bs.bars_to_mae == 3


def test_short_mirror():
    # Short, entry 100. Favorable = down. closes: 99 (profit), 101 (loss).
    # Bar 1: close 99 (profit), high 100 -> wick_from_profit (retest up to entry).
    # Bar 2: close 101 (loss), low 100 -> wick_from_loss (retest down to entry).
    bars = [_c(100, 100, 98, 99), _c(100, 102, 100, 101)]
    bs = _run(100.0, "short", bars)
    assert bs.bars_in_profit == 1
    assert bs.bars_in_loss == 1
    assert bs.wick_from_profit == 1
    assert bs.wick_from_loss == 1
    # favorable extreme uses the low: 98 on bar 1 -> bars_to_mfe == 1.
    assert bs.bars_to_mfe == 1
    # adverse extreme uses the high: 102 on bar 2 -> bars_to_mae == 2.
    assert bs.bars_to_mae == 2


def test_never_favorable_leaves_bars_to_mfe_zero():
    # Long that only ever trades at or below entry: never sets a favorable extreme.
    bars = [_c(100, 100, 99, 99), _c(99, 100, 98, 98)]
    bs = _run(100.0, "long", bars)
    assert bs.bars_to_mfe == 0
    assert bs.bars_to_mae == 2
