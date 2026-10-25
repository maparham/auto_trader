"""SWEEP instances (`SWEEP.bearSweep` / `.bullSweep` / `.bearConfirmed` /
`.bullConfirmed` / `.score` / `.sweptLevel` / `.barsSince` / `.bearReversal` /
`.bullReversal`): a causal
liquidity-sweep (stop hunt) detector, mirrored operation-for-operation in
frontend lib/indicators/sweepCompute.ts per the parity contract in
indicators/core.py. Chart-timeframe only (no MTF pin).

Levels are strict fractal pivots, born `pivot_right` bars after the pivot bar
(when they confirm), plus the previous day's high and low in the pane tz,
born on the first bar of the new day. A level is live while
`i - born <= level_max_age`. Per bar: births, expiry, crossings, the confirm
check of the pending sweep, then this bar's flag.

A high level dies on the first bar whose high trades above it, whatever the
close; every level crossed on that bar dies and the highest one is the bear
candidate. It is a sweep when the bar closes back below it, and it flags when
its score reaches `min_score`. Lows mirror this. A bar that flags both ways
takes the higher score, unless one side is a previous-candle reversal (below),
which always wins; an exact tie between two non-reversal sides flags neither.

With `use_prev_bar` on (default), bar i >= 1 also tests a one-bar reversal
against candle i-1, never stored: a bull reversal needs i-1 bearish
(close < open), `low[i] < low[i-1]`, and `close[i] > high[i-1]`, with level
`low[i-1]`; a bear reversal mirrors it on a bullish i-1 with
`high[i] > high[i-1]` and `close[i] < low[i-1]`, level `high[i-1]`. A doji
i-1 (close == open) gives neither, and both are mutually exclusive on one
bar. The reversal level joins the crossing step's "most extreme crossed
level" contest for its side (a stored level still wins if it is more extreme
and its own close test holds; the reversal level's close test always passes
by construction). A side with a reversal flags regardless of its score, and
beats a non-reversal flag on the other side even when that side scored
higher. `bullReversal` / `bearReversal` are 1 on exactly the bars that hold
the reversal (0 throughout while `use_prev_bar` is off); a reversal always
flags its side, so each implies the matching sweep output.

A flagged sweep becomes pending and confirms `confirm_bars` later if no close
went back through its level; a close through drops it, and any new flag
replaces it."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series
from auto_trader.indicators.prev_hl import _zone, estimate_bar_ms

# Pane order. `bearSweep` first: the chart click-to-insert token emits
# outputs[0], an event that is usable as a rule at once.
SWEEP_OUTPUTS: tuple[str, ...] = (
    "bearSweep", "bullSweep", "bearConfirmed", "bullConfirmed", "score", "sweptLevel", "barsSince",
    "bearReversal", "bullReversal",
)

_OUTPUT_INDEX = {name: i for i, name in enumerate(SWEEP_OUTPUTS)}
_DAY_MS = 86_400_000


@dataclass(frozen=True, slots=True)
class SweepConfig:
    pivot_left: int = 5
    pivot_right: int = 5
    level_max_age: int = 150
    min_wick_pct: float = 50.0  # swept-side wick, % of range, for full wick credit
    atr_len: int = 14
    min_range_atr: float = 1.5  # bar range in ATRs for full range credit
    vol_len: int = 20
    vol_z: float = 2.0
    min_score: float = 70.0
    confirm_bars: int = 3
    use_prev_day: bool = True
    use_volume: bool = False
    use_prev_bar: bool = True
    tz: str = "UTC"


_DEFAULT = SweepConfig()


def parse_sweep_config(calc_params: object, extend_data: object) -> SweepConfig:
    """Mirrors frontend sweepOutputs.parseSweepConfig: lengths fall back on
    anything non-finite or 0 (then floor, at least 1), positive reals on
    anything non-finite or <= 0. calcParams order: [pivotLeft, pivotRight,
    levelMaxAge, minWickPct, atrLen, minRangeAtr, volLen, volZ, minScore,
    confirmBars]. extendData: usePrevDay (absent means on), useVolume (only
    `true` turns it on), usePrevBar (absent or anything but false means on),
    tz (PREV_HL's _zone rules)."""
    p = calc_params if isinstance(calc_params, (list, tuple)) else []
    ext = extend_data if isinstance(extend_data, dict) else {}

    def num_at(i: int) -> float:
        try:
            return float(p[i])
        except (IndexError, TypeError, ValueError):
            return float("nan")

    def len_at(i: int, default: int) -> int:
        v = num_at(i)
        if not math.isfinite(v) or v == 0:
            v = default
        return max(1, math.floor(v))

    def pos_at(i: int, default: float) -> float:
        v = num_at(i)
        return v if math.isfinite(v) and v > 0 else default

    d = _DEFAULT
    return SweepConfig(
        pivot_left=len_at(0, d.pivot_left),
        pivot_right=len_at(1, d.pivot_right),
        level_max_age=len_at(2, d.level_max_age),
        min_wick_pct=pos_at(3, d.min_wick_pct),
        atr_len=len_at(4, d.atr_len),
        min_range_atr=pos_at(5, d.min_range_atr),
        vol_len=len_at(6, d.vol_len),
        vol_z=pos_at(7, d.vol_z),
        min_score=pos_at(8, d.min_score),
        confirm_bars=len_at(9, d.confirm_bars),
        use_prev_day=ext.get("usePrevDay") is not False,
        use_volume=ext.get("useVolume") is True,
        use_prev_bar=ext.get("usePrevBar") is not False,
        tz=_zone(ext.get("tz")),
    )


def _clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def sweep_score(
    cfg: SweepConfig, bear: bool, o: float, h: float, l: float, c: float,
    atr_prev: float | None, vol_z: float | None,
) -> float:
    """Weighted mean of the clamped components, times 100. Range 0 scores 0;
    a missing ATR or volume reading gives that component 0."""
    rng = h - l
    if rng <= 0:
        return 0.0
    if bear:
        wick = (h - max(o, c)) / rng
        close_d = (h - c) / rng
    else:
        wick = (min(o, c) - l) / rng
        close_d = (c - l) / rng
    w = _clamp01(wick / (cfg.min_wick_pct / 100.0))
    cl = _clamp01(close_d / (2.0 / 3.0))
    r = _clamp01(rng / (cfg.min_range_atr * atr_prev)) if atr_prev is not None and atr_prev > 0 else 0.0
    if cfg.use_volume:
        v = _clamp01(vol_z / cfg.vol_z) if vol_z is not None else 0.0
        return (w * 0.3 + cl * 0.15 + r * 0.3 + v * 0.25) * 100.0
    return (w * 0.4 + cl * 0.2 + r * 0.4) * 100.0


def _vol_z(vols: Sequence[float], i: int, n: int) -> float | None:
    """z of bar i's volume against the n bars before it (population stdev)."""
    if i < n:
        return None
    s = 0.0
    for j in range(i - n, i):
        s += vols[j]
    mean = s / n
    ss = 0.0
    for j in range(i - n, i):
        d = vols[j] - mean
        ss += d * d
    sd = math.sqrt(ss / n)
    if sd == 0:
        return None
    return (vols[i] - mean) / sd


def _is_pivot(vals: Sequence[float], p: int, left: int, right: int, want_high: bool) -> bool:
    """Strict fractal: every neighbour in [p-left, p+right] strictly beyond."""
    v = vals[p]
    for j in range(p - left, p + right + 1):
        if j == p:
            continue
        w = vals[j]
        if want_high:
            if w >= v:
                return False
        elif w <= v:
            return False
    return True


@dataclass(slots=True)
class _Level:
    price: float
    born: int
    start: int


def _compute_points(cfg: SweepConfig, candles: Sequence[Candle]) -> list[tuple[float | None, ...]]:
    n = len(candles)
    opens = [c.open for c in candles]
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    closes = [c.close for c in candles]
    vols = [c.volume for c in candles]
    ts = [int(c.time.timestamp() * 1000) for c in candles]
    atr = atr_series(candles, cfg.atr_len)
    day_on = cfg.use_prev_day and estimate_bar_ms(ts) <= _DAY_MS
    zone = ZoneInfo(cfg.tz) if day_on else None

    hi_levels: list[_Level] = []
    lo_levels: list[_Level] = []
    day_key = None
    day_hi = -math.inf
    day_lo = math.inf
    pend_dir = 0
    pend_level = 0.0
    pend_bar = 0
    last_score: float | None = None
    last_level: float | None = None
    last_bar = -1

    out: list[tuple[float | None, ...]] = []
    for i in range(n):
        # Births: the pivot at p confirms on this bar.
        p = i - cfg.pivot_right
        if p - cfg.pivot_left >= 0:
            if _is_pivot(highs, p, cfg.pivot_left, cfg.pivot_right, True):
                hi_levels.append(_Level(highs[p], i, p))
            if _is_pivot(lows, p, cfg.pivot_left, cfg.pivot_right, False):
                lo_levels.append(_Level(lows[p], i, p))
        if zone is not None:
            key = datetime.fromtimestamp(ts[i] / 1000, zone).date()
            if day_key is None:
                day_key = key
            elif key != day_key:
                hi_levels.append(_Level(day_hi, i, i))
                lo_levels.append(_Level(day_lo, i, i))
                day_key = key
                day_hi = -math.inf
                day_lo = math.inf

        # Expiry.
        hi_levels = [lv for lv in hi_levels if i - lv.born <= cfg.level_max_age]
        lo_levels = [lv for lv in lo_levels if i - lv.born <= cfg.level_max_age]

        # Crossings: every crossed level dies; the most extreme is the candidate.
        bear_lv: _Level | None = None
        kept: list[_Level] = []
        for lv in hi_levels:
            if highs[i] > lv.price:
                if bear_lv is None or lv.price > bear_lv.price:
                    bear_lv = lv
            else:
                kept.append(lv)
        hi_levels = kept
        bull_lv: _Level | None = None
        kept = []
        for lv in lo_levels:
            if lows[i] < lv.price:
                if bull_lv is None or lv.price < bull_lv.price:
                    bull_lv = lv
            else:
                kept.append(lv)
        lo_levels = kept

        # Previous-candle outside-bar reversal: a one-bar crossing candidate,
        # never stored, that joins the "most extreme crossed level" contest.
        bull_reversal = False
        bear_reversal = False
        prev_bull_lv: _Level | None = None
        prev_bear_lv: _Level | None = None
        if cfg.use_prev_bar and i >= 1:
            if closes[i - 1] < opens[i - 1] and lows[i] < lows[i - 1] and closes[i] > highs[i - 1]:
                bull_reversal = True
                prev_bull_lv = _Level(lows[i - 1], i, i - 1)
            elif closes[i - 1] > opens[i - 1] and highs[i] > highs[i - 1] and closes[i] < lows[i - 1]:
                bear_reversal = True
                prev_bear_lv = _Level(highs[i - 1], i, i - 1)

        atr_prev = atr[i - 1] if i >= 1 else None
        vz = (
            _vol_z(vols, i, cfg.vol_len)
            if cfg.use_volume and (bear_lv or bull_lv or bear_reversal or bull_reversal)
            else None
        )
        bear_s: float | None = None
        bull_s: float | None = None
        bear_win: _Level | None = None
        bull_win: _Level | None = None
        if bear_reversal:
            assert prev_bear_lv is not None
            if bear_lv is not None and closes[i] < bear_lv.price and bear_lv.price > prev_bear_lv.price:
                bear_win = bear_lv
            else:
                bear_win = prev_bear_lv
            bear_s = sweep_score(cfg, True, opens[i], highs[i], lows[i], closes[i], atr_prev, vz)
        elif bear_lv is not None and closes[i] < bear_lv.price:
            s = sweep_score(cfg, True, opens[i], highs[i], lows[i], closes[i], atr_prev, vz)
            if s >= cfg.min_score:
                bear_s = s
                bear_win = bear_lv
        if bull_reversal:
            assert prev_bull_lv is not None
            if bull_lv is not None and closes[i] > bull_lv.price and bull_lv.price < prev_bull_lv.price:
                bull_win = bull_lv
            else:
                bull_win = prev_bull_lv
            bull_s = sweep_score(cfg, False, opens[i], highs[i], lows[i], closes[i], atr_prev, vz)
        elif bull_lv is not None and closes[i] > bull_lv.price:
            s = sweep_score(cfg, False, opens[i], highs[i], lows[i], closes[i], atr_prev, vz)
            if s >= cfg.min_score:
                bull_s = s
                bull_win = bull_lv

        flag = 0
        if bear_s is not None and bull_s is not None:
            if bear_reversal and not bull_reversal:
                flag = -1
            elif bull_reversal and not bear_reversal:
                flag = 1
            else:
                flag = -1 if bear_s > bull_s else 1 if bull_s > bear_s else 0
        elif bear_s is not None:
            flag = -1
        elif bull_s is not None:
            flag = 1

        # Confirm check of the sweep pending from an earlier bar.
        bear_conf = 0.0
        bull_conf = 0.0
        if pend_dir != 0:
            if pend_dir < 0 and closes[i] > pend_level:
                pend_dir = 0
            elif pend_dir > 0 and closes[i] < pend_level:
                pend_dir = 0
            elif i - pend_bar >= cfg.confirm_bars:
                if pend_dir < 0:
                    bear_conf = 1.0
                else:
                    bull_conf = 1.0
                pend_dir = 0

        # This bar's flag: it replaces any pending sweep.
        if flag != 0:
            lv = bear_win if flag < 0 else bull_win
            assert lv is not None
            pend_dir = flag
            pend_level = lv.price
            pend_bar = i
            last_score = bear_s if flag < 0 else bull_s
            last_level = lv.price
            last_bar = i

        if zone is not None:
            day_hi = max(day_hi, highs[i])
            day_lo = min(day_lo, lows[i])

        out.append((
            1.0 if flag < 0 else 0.0,
            1.0 if flag > 0 else 0.0,
            bear_conf,
            bull_conf,
            last_score,
            last_level,
            float(i - last_bar) if last_bar >= 0 else None,
            1.0 if bear_reversal else 0.0,
            1.0 if bull_reversal else 0.0,
        ))
    return out


def sweep_outputs(cfg: SweepConfig) -> tuple[str, ...]:
    return SWEEP_OUTPUTS


def sweep_series(
    cfg: SweepConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    idx = _OUTPUT_INDEX.get(output, 0)
    return [pt[idx] for pt in _compute_points(cfg, candles)]


def sweep_warmup(cfg: SweepConfig, output: str) -> int:
    """ATR (read at i-1), the volume window (read before i), and a level's
    whole life plus its pivot and confirm delay. Confirm outputs lag their
    flag by confirmBars. Previous-day levels add a calendar dependency no bar
    count bounds, as prev_hl_warmup notes. 0 for an output this config does
    not expose."""
    if output not in _OUTPUT_INDEX:
        return 0
    return max(
        cfg.atr_len + 1,
        cfg.vol_len + 1 if cfg.use_volume else 0,
        cfg.level_max_age + cfg.pivot_left + cfg.pivot_right + cfg.confirm_bars,
    )
