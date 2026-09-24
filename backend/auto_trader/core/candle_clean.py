"""Repair stale pre-split prints in candle series.

On a split day some brokers back-adjust the whole history but stamp the first
post-split bar's open with the last PRE-split price. Capital.com's BKNG bar for
2026-04-06 (25:1 split) reads O 4187.5 H 4187.5 L 166.3 C 176.1: one number 25x
off stretches the price axis and hands a backtest a fake 4187 print.

The bad value always sits in the OPEN (and, pulled along by it, the high for a
forward split or the low for a reverse one). A real gap looks different: the
price stays where it opened, so the open agrees with its own close. A stale
print disagrees with BOTH the previous close and its own close.

Two ways to call a bar stale:

- Split-confirmed: a listed split within a day of the bar, and open / previous
  close within 2% of the split ratio (the stale open is exactly the adjusted
  previous close times the ratio; BKNG is 25.000). Without a previous bar (a
  window starting on the bad bar) open / own close must sit within 15% of the
  ratio instead, because the close carries a day of real movement.
- Threshold (no split list needed): open 3x or more away from both the previous
  close and its own close, while those two agree within 1.5x. That describes
  a single stale print and not a gap; only a 3x gap that fully reverses inside
  one bar would match, which liquid markets do not do.

Pure: no I/O. The cache hook (api/candle_repair.py) supplies the split list,
the previous bar and the intraday rebuild; pattern search (pattern_series.py)
reads the store into numpy and uses repair_stale_arrays.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timezone

import numpy as np

from auto_trader.core.models import Candle

# Crypto venues: a 3x bar there can be real, so only a listed split repairs.
NO_THRESHOLD_BROKERS = frozenset({"nobitex", "oanor"})

# Loose gate for "worth a closer look" (and worth a split-list lookup).
_SUSPECT_JUMP = 1.4  # open vs previous close
_SUSPECT_OWN = 1.25  # open vs own close
# Split confirmation tolerances.
_RATIO_TOL_PREV = 0.02
_RATIO_TOL_OWN = 0.15
_SPLIT_SLACK_S = 86_400  # IG daily bars open the evening before; Yahoo stamps 09:30 ET
# Threshold rule.
_THRESHOLD = 3.0
_AGREE = 1.5


@dataclass(frozen=True, slots=True)
class Split:
    """One split event. `ratio` is new shares per old share: 25.0 for a 25:1
    split, 0.1 for a 1:10 reverse split."""

    ts: int  # unix seconds
    ratio: float


@dataclass(frozen=True, slots=True)
class Repair:
    index: int
    ratio: float | None  # the confirming split's ratio; None for the threshold rule
    old: Candle
    new: Candle


def _off(ratio: float, limit: float) -> bool:
    return ratio > limit or ratio * limit < 1.0


def _own_odd(bar: Candle) -> bool:
    return bar.close > 0 and _off(bar.open / bar.close, _SUSPECT_OWN)


def needs_prev(bars: Sequence[Candle]) -> bool:
    """Whether the FIRST bar looks stale enough that the caller should fetch the
    bar before it (a window can start exactly on the bad bar)."""
    return bool(bars) and _own_odd(bars[0])


def suspect_indices(bars: Sequence[Candle], prev: Candle | None = None) -> list[int]:
    """Indices whose open disagrees with both the previous close and its own
    close by the loose gate. Cheap, one pass; empty for almost every series."""
    out: list[int] = []
    p = prev.close if prev is not None else None
    for i, b in enumerate(bars):
        o, c = b.open, b.close
        if c > 0 and _off(o / c, _SUSPECT_OWN):
            if p is None or (p > 0 and _off(o / p, _SUSPECT_JUMP)):
                out.append(i)
        p = c
    return out


def _confirming_split(
    bar: Candle, p: float | None, splits: Sequence[Split], res_seconds: int
) -> Split | None:
    t = int(bar.time.timestamp())
    for s in splits:
        if not (t - _SPLIT_SLACK_S <= s.ts < t + res_seconds + _SPLIT_SLACK_S):
            continue
        if p is not None:
            if p > 0 and abs(bar.open / p / s.ratio - 1) <= _RATIO_TOL_PREV:
                return s
        elif abs(bar.open / bar.close / s.ratio - 1) <= _RATIO_TOL_OWN:
            return s
    return None


def _threshold_stale(bar: Candle, p: float | None) -> bool:
    if p is None or p <= 0:
        return False
    o, c = bar.open, bar.close
    up = o / p >= _THRESHOLD and o / c >= _THRESHOLD
    down = o / p <= 1 / _THRESHOLD and o / c <= 1 / _THRESHOLD
    return (up or down) and not _off(c / p, _AGREE)


def _repaired(bar: Candle, ref: float) -> Candle:
    """Replace the stale open with `ref` (the adjusted previous close), kept
    inside the part of the bar that is still real, and rebuild the extreme the
    stale print had dragged along. The true intraday extreme is lost; the cache
    hook rebuilds it from finer bars where it can."""
    if bar.open > bar.close:  # stale print above: forward split, the low is real
        o = max(ref, bar.low)
        return replace(bar, open=o, high=max(o, bar.close))
    o = min(ref, bar.high)  # stale print below: reverse split, the high is real
    return replace(bar, open=o, low=min(o, bar.close))


def repair_stale_prints(
    bars: Sequence[Candle],
    splits: Sequence[Split],
    *,
    res_seconds: int,
    prev: Candle | None = None,
    allow_threshold: bool = True,
) -> tuple[list[Candle], list[Repair]]:
    """Return (bars with stale prints repaired, the repairs made). `prev` is
    the closed bar before bars[0], when the caller has it."""
    out = list(bars)
    repairs: list[Repair] = []
    for i in suspect_indices(bars, prev):
        bar = bars[i]
        before = bars[i - 1] if i > 0 else prev
        p = before.close if before is not None else None
        split = _confirming_split(bar, p, splits, res_seconds)
        if split is not None:
            ref = p if p is not None else bar.open / split.ratio
        elif allow_threshold and _threshold_stale(bar, p):
            ref = p  # type: ignore[assignment]  # _threshold_stale needs p
        else:
            continue
        new = _repaired(bar, ref)
        out[i] = new
        repairs.append(Repair(i, split.ratio if split else None, bar, new))
    return out, repairs


def _candle(ts: int, row: np.ndarray) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(int(ts), tz=timezone.utc),
        open=float(row[0]), high=float(row[1]), low=float(row[2]), close=float(row[3]),
        volume=0.0,
    )


def repair_stale_arrays(
    ts: np.ndarray,
    ohlc: np.ndarray,
    splits: Sequence[Split],
    *,
    res_seconds: int,
    prev_close: float | None = None,
    allow_threshold: bool = True,
) -> int:
    """repair_stale_prints on raw (ts, [open, high, low, close]) arrays, in
    place; returns how many bars it repaired. The loose gate is vectorized, so
    a clean million-bar series costs a few array ops; only the rare suspect
    bars go through the Candle logic, which keeps the two forms identical."""
    if len(ts) == 0:
        return 0
    o, c = ohlc[:, 0], ohlc[:, 3]
    prev = np.empty_like(c)
    prev[1:] = c[:-1]
    prev[0] = np.nan if prev_close is None else prev_close
    with np.errstate(divide="ignore", invalid="ignore"):
        own = o / c
        jump = o / prev
        suspect = (c > 0) & ((own > _SUSPECT_OWN) | (own * _SUSPECT_OWN < 1)) & (
            np.isnan(prev) | ((prev > 0) & ((jump > _SUSPECT_JUMP) | (jump * _SUSPECT_JUMP < 1)))
        )
    repaired = 0
    for i in np.flatnonzero(suspect):
        bar = _candle(ts[i], ohlc[i])
        p = None if np.isnan(prev[i]) else float(prev[i])
        before = None if p is None else replace(bar, open=p, high=p, low=p, close=p)
        (new,), repairs = repair_stale_prints(
            [bar], splits, res_seconds=res_seconds, prev=before, allow_threshold=allow_threshold
        )
        if repairs:
            ohlc[i, 0], ohlc[i, 1], ohlc[i, 2] = new.open, new.high, new.low
            repaired += 1
    return repaired
