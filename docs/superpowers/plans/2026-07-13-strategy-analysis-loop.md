# Strategy Analysis & Optimization Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend computes MAE/MFE + entry-context features + aggregate analytics per backtest run, persists runs to SQLite with a read API, and the backtest dock gains an "Analysis" tab rendering the analytics.

**Architecture:** The backtest engine records per-position excursion watermarks and stamps MAE/MFE onto each `Trade`. A post-run enrichment step attaches context features (trend, vol regime, session, swing distance, candle pattern) computed at each trade's signal bar. A pure-function analysis module aggregates trade dicts into SL/TP-efficiency, exit-reason, R-distribution, and context-breakdown stats returned inline on `BacktestResponse` and recomputable from a new SQLite run store. Frontend renders `analysis` in a new dock tab — no browser-side computation.

**Tech Stack:** Python 3 / FastAPI / stdlib sqlite3 (backend), React + TypeScript + vitest (frontend), pytest (backend tests).

**Spec:** `docs/superpowers/specs/2026-07-13-strategy-analysis-design.md`

## Global Constraints

- Backend owns business logic; the frontend only formats/renders.
- No backward-compat or migration code: new fields/tables start fresh (single user, no old data).
- Run-store writes are best-effort: a failed insert logs a warning, never fails the backtest response.
- Run store keeps the most recent **200** runs; sweep child runs are NOT stored.
- Groups with n < 5 trades get `low_sample: true`, never hidden.
- Flat-trend cutoff: |EMA(50) slope| < **0.02 %/bar** (constant, not user-tunable in v1).
- Frontend: light theme first, no shadows, content-sized, shared `Tooltip`/`InfoTip` components (never native `title=`), plain copy with standard trading terms.
- Commit directly to `main` (1-person team convention).
- Backend tests: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest <path> -v`. Frontend tests: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run <path>`.

---

### Task 1: MAE/MFE tracking in the backtest engine

Track each open position's adverse/favorable price extremes and stamp MAE/MFE (raw + R-multiples) onto every `Trade`.

**Files:**
- Modify: `backend/auto_trader/core/models.py` (Trade dataclass, ~line 159)
- Modify: `backend/auto_trader/engine/backtest.py` (Position ~line 36, run loop ~line 190, `_open` ~line 343, `_reduce` ~line 380)
- Test: `backend/tests/test_excursion.py` (new)

**Interfaces:**
- Produces: `Trade.mae: float`, `Trade.mfe: float` (raw price distance from entry, ≥ 0), `Trade.mae_r: float | None`, `Trade.mfe_r: float | None` (R-multiples vs `stop_initial`; `None` when no initial stop), `Trade.context: dict | None` (filled by Task 2; declared here so the dataclass changes once).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_excursion.py`. Check `backend/tests/test_backtest.py` first for how existing tests build `Candle` objects and drive the engine — reuse its candle-construction pattern if it differs from the below (field names per `core/models.py`).

```python
"""MAE/MFE excursion tracking: the engine records each trade's worst adverse
and best favorable price while open, raw and as R-multiples of the initial stop."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine


def _mk_candles(bars):
    """bars: list of (open, high, low, close) -> hourly Candles."""
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=o, high=h, low=lo, close=c, volume=0.0)
        for i, (o, h, lo, c) in enumerate(bars)
    ]


class _Script:
    """Emits pre-scripted signals keyed by bar index (0-based)."""

    def __init__(self, by_bar):
        self.by_bar = by_bar

    def on_bar(self, ctx):
        return self.by_bar.get(len(ctx.history) - 1, [])


def test_long_mae_mfe_with_r_multiples():
    # Signal on bar0 -> fills bar1 open=100 with per-signal stop 95 (risk = 5).
    # While open: low 97 on bar2 (MAE 3), high 106 on bar2 (MFE 6).
    # Exit signal on bar2 -> fills bar3 open=101.
    candles = _mk_candles([
        (100, 101, 99, 100),
        (100, 104, 98, 103),
        (103, 106, 97, 105),
        (101, 102, 100, 101),
    ])
    script = _Script({
        0: [Signal(side=Side.BUY, quantity=1.0, leg="long", stop_level=95.0)],
        2: [Signal(side=Side.SELL, quantity=1.0, leg="long")],
    })
    result = BacktestEngine(script).run(candles)

    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.mae == 3.0   # 100 - min(low 98, 97) = 3, exit fill 101 doesn't worsen it
    assert t.mfe == 6.0   # max(high 104, 106) - 100
    assert t.mae_r == 0.6  # 3 / 5
    assert t.mfe_r == 1.2  # 6 / 5


def test_short_mae_mfe():
    # Short fills bar1 open=100; adverse = highs above entry, favorable = lows below.
    candles = _mk_candles([
        (100, 101, 99, 100),
        (100, 103, 96, 97),
        (97, 99, 95, 98),
        (98, 99, 97, 98),
    ])
    script = _Script({
        0: [Signal(side=Side.SELL, quantity=1.0, leg="short", stop_level=104.0)],
        2: [Signal(side=Side.BUY, quantity=1.0, leg="short")],
    })
    result = BacktestEngine(script).run(candles)

    t = result.trades[0]
    assert t.mae == 3.0   # high 103 - entry 100
    assert t.mfe == 5.0   # entry 100 - low 95
    assert t.mae_r == 0.75  # 3 / 4
    assert t.mfe_r == 1.25  # 5 / 4


def test_no_stop_means_no_r_multiples():
    candles = _mk_candles([
        (100, 101, 99, 100),
        (100, 104, 98, 103),
        (103, 106, 97, 105),
    ])
    script = _Script({0: [Signal(side=Side.BUY, quantity=1.0, leg="long")]})
    result = BacktestEngine(script).run(candles)  # closed by "range end" at last close

    t = result.trades[0]
    assert t.mae == 3.0 and t.mfe == 6.0
    assert t.mae_r is None and t.mfe_r is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_excursion.py -v`
Expected: FAIL — `Trade` has no attribute `mae` (or `TypeError` on unexpected field).

- [ ] **Step 3: Implement**

In `backend/auto_trader/core/models.py`, extend the `Trade` dataclass (after `target: float | None = None`):

```python
    # Excursion while the trade was open: worst adverse / best favorable price
    # move from entry (raw distance, always >= 0), plus the same as R-multiples
    # of the initial stop distance (None when the trade had no initial stop).
    mae: float = 0.0
    mfe: float = 0.0
    mae_r: float | None = None
    mfe_r: float | None = None
    # Entry-context features at the SIGNAL bar (trend/vol regime/session/...),
    # attached post-run by engine.context_features; None until enriched.
    context: dict | None = None
```

In `backend/auto_trader/engine/backtest.py`:

1. Add watermark fields to `Position` (after `bracket_from_signal`):

```python
    # Excursion watermarks since entry (seeded at the fill price): the most
    # adverse and most favorable prices seen while open. Separate from
    # `extreme`, which only tracks the trailing-stop ratchet.
    adv_extreme: float = 0.0
    fav_extreme: float = 0.0
```

2. In `_open`, right after `p = Position(...)` (before the bracket/risk branches):

```python
        p.adv_extreme = fill_price
        p.fav_extreme = fill_price
```

3. Add a helper next to `_ratchet_trailing`:

```python
    @staticmethod
    def _track_excursion(positions, side, bar):
        """Extend each open position's adverse/favorable watermarks with this
        bar's range. Called before intra-bar exits so the exit bar counts."""
        for p in positions:
            if side == "long":
                p.adv_extreme = min(p.adv_extreme, bar.low)
                p.fav_extreme = max(p.fav_extreme, bar.high)
            else:
                p.adv_extreme = max(p.adv_extreme, bar.high)
                p.fav_extreme = min(p.fav_extreme, bar.low)
```

4. In `run()`, call it right after the `pending = []` line (i.e. after step 1 fills, before `_intrabar_exit`):

```python
            self._track_excursion(longs, "long", bar)
            self._track_excursion(shorts, "short", bar)
```

(Ordering rationale: a position opened at this bar's open includes this bar's range; a signal-exit at this bar's open must NOT include this bar's range beyond the fill price — `_reduce` folds the fill price in below; an intra-bar stop/target exit DOES include this bar's range, hence tracking before `_intrabar_exit`.)

5. In `_reduce`, compute excursion when booking the `Trade`. Before `result.trades.append(...)`:

```python
        if side == "long":
            mae = max(0.0, p.entry - min(p.adv_extreme, fill_price))
            mfe = max(0.0, max(p.fav_extreme, fill_price) - p.entry)
        else:
            mae = max(0.0, max(p.adv_extreme, fill_price) - p.entry)
            mfe = max(0.0, p.entry - min(p.fav_extreme, fill_price))
        risk_dist = abs(p.entry - p.stop_initial) if p.stop_initial is not None else 0.0
        mae_r = mae / risk_dist if risk_dist > 0 else None
        mfe_r = mfe / risk_dist if risk_dist > 0 else None
```

and add to the `Trade(...)` constructor call: `mae=mae, mfe=mfe, mae_r=mae_r, mfe_r=mfe_r,`.

- [ ] **Step 4: Run tests to verify they pass, and that nothing regressed**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_excursion.py tests/test_backtest.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/models.py backend/auto_trader/engine/backtest.py backend/tests/test_excursion.py
git commit -m "feat(backtest): track MAE/MFE per trade, raw + R-multiples"
```

---

### Task 2: Entry-context features module

Pure module computing trend / vol regime / session / swing distance / candle pattern at each trade's **signal bar** (the bar before the entry fill), mutating `trade.context`.

**Files:**
- Create: `backend/auto_trader/engine/context_features.py`
- Test: `backend/tests/test_context_features.py` (new)

**Interfaces:**
- Consumes: `Trade` (with `context` field from Task 1), `Candle` from `core/models.py`.
- Produces:
  - `enrich_trades(trades: list[Trade], candles: list[Candle]) -> None` — sets each `trade.context` to a JSON-safe dict with keys `trend` (`"up"|"down"|"flat"|None`), `vol_regime` (`"low"|"mid"|"high"|None`), `session` (`"asia"|"london"|"newyork"|"overlap"|"off"`), `hour_utc: int`, `day_of_week: int` (0=Mon), `dist_swing_high: float|None`, `dist_swing_low: float|None`, `candle_pattern: str`.
  - `classify_candle(prev, bar) -> str` — one of `"bull_engulfing"|"bear_engulfing"|"pin_top"|"pin_bottom"|"inside"|"outside"|"doji"|"none"` (first match in that order; `"none"` when `prev is None` except doji, which needs no prev).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_context_features.py`:

```python
"""Entry-context features computed at the SIGNAL bar (the bar before the fill):
trend from EMA(50) slope, vol regime from ATR(14) percentile, FX session from
UTC hour, swing distance in ATRs, candlestick pattern classification."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Trade
from auto_trader.engine.context_features import classify_candle, enrich_trades, session_tag


def _c(o, h, lo, c, t=None):
    return Candle(
        time=t or datetime(2026, 1, 5, tzinfo=timezone.utc),
        open=o, high=h, low=lo, close=c, volume=0.0,
    )


# --- candle patterns ---------------------------------------------------------

def test_bull_engulfing():
    prev = _c(102, 103, 99, 100)   # down body 102->100
    bar = _c(99.5, 104, 99, 103)   # up body 99.5->103 engulfs [100, 102]
    assert classify_candle(prev, bar) == "bull_engulfing"


def test_bear_engulfing():
    prev = _c(100, 103, 99, 102)
    bar = _c(102.5, 103, 98, 99.5)
    assert classify_candle(prev, bar) == "bear_engulfing"


def test_pin_bottom():
    # Long lower wick >= 2x body, body in the top third of the range.
    prev = _c(100, 101, 99, 100)
    bar = _c(99.8, 100.2, 96, 100.0)  # range 4.2, body 0.2, lower wick 3.8
    assert classify_candle(prev, bar) == "pin_bottom"


def test_pin_top():
    prev = _c(100, 101, 99, 100)
    bar = _c(100.0, 104.0, 99.8, 99.9)
    assert classify_candle(prev, bar) == "pin_top"


def test_inside_and_outside():
    prev = _c(100, 105, 95, 102)
    assert classify_candle(prev, _c(101, 103, 97, 99)) == "inside"
    assert classify_candle(prev, _c(99, 106, 94, 103)) == "outside"


def test_doji():
    # prev range chosen so the bar is neither inside (bar.low == prev.low, not
    # strictly inside) nor outside (bar.high < prev.high) — falls through to doji.
    prev = _c(100, 103, 98, 100.8)
    bar = _c(100.0, 102, 98, 100.1)  # body 0.1 <= 10% of range 4
    assert classify_candle(prev, bar) == "doji"


def test_none():
    prev = _c(100, 101, 99, 100.5)
    assert classify_candle(prev, _c(100.4, 102, 99.5, 101.2)) == "none"
    assert classify_candle(None, _c(100, 101, 99, 100.5)) == "none"


# --- sessions ----------------------------------------------------------------

def test_session_tags():
    assert session_tag(3) == "asia"
    assert session_tag(9) == "london"
    assert session_tag(13) == "overlap"
    assert session_tag(18) == "newyork"
    assert session_tag(21) == "off"
    assert session_tag(23) == "asia"


# --- enrichment --------------------------------------------------------------

def test_enrich_sets_context_at_signal_bar():
    # 80 flat bars, then a strong up-leg so EMA(50) slope at the signal bar is
    # clearly "up"; trade fills at bar 80 -> signal bar is 79.
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = []
    px = 100.0
    for i in range(81):
        if i >= 60:
            px += 1.0
        candles.append(Candle(
            time=t0 + timedelta(hours=i),
            open=px, high=px + 0.5, low=px - 0.5, close=px, volume=0.0,
        ))
    trade = Trade(
        side=Side.BUY, quantity=1.0,
        entry_time=candles[80].time, entry_price=candles[80].open,
        exit_time=candles[80].time, exit_price=candles[80].close, pnl=0.0,
    )
    enrich_trades([trade], candles)

    ctx = trade.context
    assert ctx is not None
    assert ctx["trend"] == "up"
    assert ctx["vol_regime"] in ("low", "mid", "high")
    assert ctx["session"] == session_tag(candles[79].time.hour)
    assert ctx["hour_utc"] == candles[79].time.hour
    assert ctx["day_of_week"] == candles[79].time.weekday()
    # Note: can be negative — the close sits ABOVE the prior 20-bar swing high
    # in this rising fixture; sign is meaningful, only None-ness is warm-up.
    assert ctx["dist_swing_high"] is not None and ctx["dist_swing_low"] is not None
    assert ctx["candle_pattern"] in (
        "bull_engulfing", "bear_engulfing", "pin_top", "pin_bottom",
        "inside", "outside", "doji", "none",
    )


def test_enrich_warmup_gives_nulls_not_fabrications():
    # Fill at bar 5: EMA(50)/ATR(14)/swing(20) can't warm up -> those are None,
    # but session/hour/day/pattern (no lookback) are still set.
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = [
        Candle(time=t0 + timedelta(hours=i), open=100, high=101, low=99, close=100, volume=0.0)
        for i in range(6)
    ]
    trade = Trade(
        side=Side.BUY, quantity=1.0,
        entry_time=candles[5].time, entry_price=100.0,
        exit_time=candles[5].time, exit_price=100.0, pnl=0.0,
    )
    enrich_trades([trade], candles)

    ctx = trade.context
    assert ctx["trend"] is None
    assert ctx["vol_regime"] is None
    assert ctx["dist_swing_high"] is None and ctx["dist_swing_low"] is None
    assert ctx["session"] == session_tag(candles[4].time.hour)
    assert ctx["candle_pattern"] is not None


def test_enrich_unknown_entry_time_leaves_context_none():
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = [
        Candle(time=t0 + timedelta(hours=i), open=100, high=101, low=99, close=100, volume=0.0)
        for i in range(3)
    ]
    trade = Trade(
        side=Side.BUY, quantity=1.0,
        entry_time=t0 + timedelta(days=30), entry_price=100.0,
        exit_time=t0 + timedelta(days=30), exit_price=100.0, pnl=0.0,
    )
    enrich_trades([trade], candles)
    assert trade.context is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_context_features.py -v`
Expected: FAIL — `ModuleNotFoundError: auto_trader.engine.context_features`.

- [ ] **Step 3: Implement the module**

Create `backend/auto_trader/engine/context_features.py`:

```python
"""Entry-context features for backtest trades, computed at each trade's SIGNAL
bar (the bar before its entry fill — fills happen at the next bar's open).

Pure post-run enrichment: no engine coupling, no lookahead (every feature only
reads bars <= the signal bar). Features whose lookback isn't satisfied are None,
never fabricated. All values are JSON-safe scalars (they ship in TradeDTO and
the run store verbatim).

Constants are v1-fixed (not user-tunable): EMA(50) slope for trend with a
0.02 %/bar flat cutoff, ATR(14) with terciles for vol regime, 20-bar swings.
"""

from __future__ import annotations

from bisect import bisect_left

from auto_trader.core.models import Candle, Trade

EMA_LEN = 50
ATR_LEN = 14
SWING_LEN = 20
FLAT_SLOPE_PCT = 0.02  # |EMA slope| below this (%/bar) reads as "flat"


def _ema(closes: list[float], length: int) -> list[float | None]:
    """Standard EMA seeded with the SMA of the first `length` closes; None while cold."""
    out: list[float | None] = [None] * len(closes)
    if len(closes) < length:
        return out
    k = 2.0 / (length + 1)
    ema = sum(closes[:length]) / length
    out[length - 1] = ema
    for i in range(length, len(closes)):
        ema = closes[i] * k + ema * (1 - k)
        out[i] = ema
    return out


def _atr(candles: list[Candle], length: int) -> list[float | None]:
    """SMA of true range over `length` bars; None while cold (needs length+1 bars)."""
    out: list[float | None] = [None] * len(candles)
    trs: list[float] = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))
        if len(trs) >= length:
            out[i] = sum(trs[-length:]) / length
    return out


def session_tag(hour_utc: int) -> str:
    """FX session from the UTC hour. Overlap (London+NY) wins over either alone."""
    if 12 <= hour_utc < 16:
        return "overlap"
    if 7 <= hour_utc < 12:
        return "london"
    if 16 <= hour_utc < 21:
        return "newyork"
    if hour_utc >= 23 or hour_utc < 7:
        return "asia"
    return "off"  # 21-22 UTC


def classify_candle(prev: Candle | None, bar: Candle) -> str:
    """First-match classification. Body = |close-open|, range = high-low."""
    body = abs(bar.close - bar.open)
    rng = bar.high - bar.low
    if prev is not None:
        p_body_hi = max(prev.open, prev.close)
        p_body_lo = min(prev.open, prev.close)
        b_body_hi = max(bar.open, bar.close)
        b_body_lo = min(bar.open, bar.close)
        prev_down = prev.close < prev.open
        prev_up = prev.close > prev.open
        if bar.close > bar.open and prev_down and b_body_lo <= p_body_lo and b_body_hi >= p_body_hi:
            return "bull_engulfing"
        if bar.close < bar.open and prev_up and b_body_lo <= p_body_lo and b_body_hi >= p_body_hi:
            return "bear_engulfing"
    if rng > 0:
        upper_wick = bar.high - max(bar.open, bar.close)
        lower_wick = min(bar.open, bar.close) - bar.low
        if upper_wick >= 2 * body and min(bar.open, bar.close) <= bar.low + rng / 3:
            return "pin_top"
        if lower_wick >= 2 * body and max(bar.open, bar.close) >= bar.high - rng / 3:
            return "pin_bottom"
    if prev is not None:
        if bar.high < prev.high and bar.low > prev.low:
            return "inside"
        if bar.high > prev.high and bar.low < prev.low:
            return "outside"
    if rng > 0 and body <= 0.10 * rng:
        return "doji"
    return "none"


def enrich_trades(trades: list[Trade], candles: list[Candle]) -> None:
    """Attach a context dict to each trade, computed at its signal bar.

    The signal bar is entry-fill bar minus one (the engine fills a bar-t signal
    at bar t+1's open). A trade whose entry_time isn't in `candles`, or that
    fills on bar 0, keeps context=None.
    """
    if not candles or not trades:
        return
    index = {c.time: i for i, c in enumerate(candles)}
    closes = [c.close for c in candles]
    ema = _ema(closes, EMA_LEN)
    atr = _atr(candles, ATR_LEN)
    atr_sorted = sorted(a for a in atr if a is not None)

    for trade in trades:
        fill_i = index.get(trade.entry_time)
        if fill_i is None or fill_i == 0:
            continue
        s = fill_i - 1  # signal bar
        bar = candles[s]
        prev = candles[s - 1] if s > 0 else None

        trend: str | None = None
        if ema[s] is not None and s > 0 and ema[s - 1] is not None and ema[s - 1] != 0:
            slope_pct = (ema[s] - ema[s - 1]) / ema[s - 1] * 100.0
            if abs(slope_pct) < FLAT_SLOPE_PCT:
                trend = "flat"
            else:
                trend = "up" if slope_pct > 0 else "down"

        vol_regime: str | None = None
        a = atr[s]
        if a is not None and len(atr_sorted) >= 3:
            pct = bisect_left(atr_sorted, a) / len(atr_sorted)
            vol_regime = "low" if pct < 1 / 3 else ("high" if pct > 2 / 3 else "mid")

        dist_hi: float | None = None
        dist_lo: float | None = None
        if s >= SWING_LEN and a is not None and a > 0:
            window = candles[s - SWING_LEN:s]  # the 20 bars BEFORE the signal bar
            dist_hi = (max(c.high for c in window) - bar.close) / a
            dist_lo = (bar.close - min(c.low for c in window)) / a

        trade.context = {
            "trend": trend,
            "vol_regime": vol_regime,
            "session": session_tag(bar.time.hour),
            "hour_utc": bar.time.hour,
            "day_of_week": bar.time.weekday(),
            "dist_swing_high": round(dist_hi, 3) if dist_hi is not None else None,
            "dist_swing_low": round(dist_lo, 3) if dist_lo is not None else None,
            "candle_pattern": classify_candle(prev, bar),
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_context_features.py -v`
Expected: all PASS. If a pattern-fixture assertion fails, fix the FIXTURE only if the classifier is right per the spec's definitions; otherwise fix the classifier.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/context_features.py backend/tests/test_context_features.py
git commit -m "feat(backtest): entry-context features at the signal bar"
```

---

### Task 3: Analysis aggregates module

Pure functions turning a list of **trade dicts** (TradeDTO-shaped, so the same code serves the live response and the run store) into the analysis payload.

**Files:**
- Create: `backend/auto_trader/engine/analysis.py`
- Test: `backend/tests/test_analysis.py` (new)

**Interfaces:**
- Consumes: trade dicts with keys `pnl, leg, entry_price, exit_price, stop_initial, target, reason, mae, mfe, mae_r, mfe_r, context` (exactly the TradeDTO field names — Task 4 wires the DTO).
- Produces: `compute_analysis(trades: list[dict]) -> dict` with shape:

```python
{
  "n_trades": int,
  "sl": {
    "winners_mae_hist": {"edges": [0.25, 0.5, 0.75, 1.0], "counts": [int x5]},
    "losers_mae_hist": {"edges": [...], "counts": [...]},
    "winners_near_stop_pct": float | None,   # share of winners with mae_r >= 0.8
    "n_with_r": int,                          # trades that had an initial stop
  },
  "tp": {
    "avg_winner_mfe_r": float | None,
    "avg_winner_realized_r": float | None,
    "median_left_on_table_r": float | None,   # median(mfe_r - realized_r) over winners
    "pct_nontarget_exits_reached_target": float | None,
  },
  "exit_reasons": [{"bucket": str, "n": int, "win_rate": float, "expectancy": float, "net_pnl": float, "low_sample": bool}],
  "r_hist": {"edges": [-3, -2, -1, 0, 1, 2, 3], "counts": [int x8]},
  "context": {
    "trend": [rows...], "vol_regime": [rows...], "session": [rows...],
    "candle_pattern": [rows...], "day_of_week": [rows...],
  },  # rows shaped like exit_reasons rows; missing/None feature -> bucket "unknown"
}
```

Zero trades → the same shape with `n_trades: 0`, empty lists/zero counts, and `None` scalars (empty-but-valid, per spec). Winner = `pnl > 0`, loser = `pnl < 0` (plain sign; the engine's commission-aware win_rate stays the headline number elsewhere).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_analysis.py`:

```python
"""Aggregate analytics over TradeDTO-shaped dicts: SL/TP efficiency, exit-reason
breakdown, R-multiple histogram, context group-bys with low-sample flags."""

from auto_trader.engine.analysis import compute_analysis


def _t(pnl, *, entry=100.0, exit_=None, stop=95.0, target=None, leg="long",
       reason="rule", mae_r=None, mfe_r=None, context=None):
    if exit_ is None:
        exit_ = entry + pnl  # qty 1 price move == pnl for a long
    return {
        "pnl": pnl, "leg": leg, "entry_price": entry, "exit_price": exit_,
        "stop_initial": stop, "target": target, "reason": reason,
        "mae": (mae_r or 0.0) * 5.0, "mfe": (mfe_r or 0.0) * 5.0,
        "mae_r": mae_r, "mfe_r": mfe_r, "context": context,
    }


def test_empty_run_is_valid():
    a = compute_analysis([])
    assert a["n_trades"] == 0
    assert a["exit_reasons"] == []
    assert sum(a["r_hist"]["counts"]) == 0
    assert a["sl"]["winners_near_stop_pct"] is None
    assert a["tp"]["avg_winner_mfe_r"] is None


def test_sl_section():
    trades = [
        _t(10.0, mae_r=0.9, mfe_r=2.0),   # winner, nearly stopped
        _t(8.0, mae_r=0.2, mfe_r=1.8),    # winner, clean
        _t(-5.0, mae_r=1.0, mfe_r=0.1, reason="stop"),  # stopped loser
    ]
    a = compute_analysis(trades)
    assert a["sl"]["n_with_r"] == 3
    assert a["sl"]["winners_near_stop_pct"] == 0.5  # 1 of 2 winners had mae_r >= 0.8
    # winner mae_r 0.9 lands in the (0.75, 1.0] bucket = index 3
    assert a["sl"]["winners_mae_hist"]["counts"][3] == 1
    assert a["sl"]["losers_mae_hist"]["counts"][3] == 1  # 1.0 falls in (0.75, 1.0]


def test_tp_section():
    # Winner realized 2R (exit 110, risk 5) but saw 3R MFE -> 1R left on table.
    trades = [_t(10.0, exit_=110.0, mfe_r=3.0, mae_r=0.1)]
    a = compute_analysis(trades)
    assert a["tp"]["avg_winner_realized_r"] == 2.0
    assert a["tp"]["avg_winner_mfe_r"] == 3.0
    assert a["tp"]["median_left_on_table_r"] == 1.0


def test_tp_nontarget_exits_reached_target():
    # Two rule exits with a target set at 105 (5 above entry): one saw mfe 6
    # (reached), one saw mfe 2 (didn't).
    trades = [
        {**_t(3.0, target=105.0, mfe_r=1.2, mae_r=0.1), "mfe": 6.0},
        {**_t(1.0, target=105.0, mfe_r=0.4, mae_r=0.1), "mfe": 2.0},
    ]
    a = compute_analysis(trades)
    assert a["tp"]["pct_nontarget_exits_reached_target"] == 0.5


def test_exit_reasons_and_low_sample():
    trades = [_t(5.0, reason="target")] * 5 + [_t(-2.0, reason="stop")] * 2
    a = compute_analysis(trades)
    rows = {r["bucket"]: r for r in a["exit_reasons"]}
    assert rows["target"]["n"] == 5 and rows["target"]["low_sample"] is False
    assert rows["target"]["win_rate"] == 1.0
    assert rows["stop"]["n"] == 2 and rows["stop"]["low_sample"] is True
    assert rows["stop"]["net_pnl"] == -4.0


def test_r_hist_and_short_sign():
    # Short: entry 100 exit 90 with stop 105 -> +2R. Long loser -1R.
    trades = [
        _t(10.0, entry=100.0, exit_=90.0, stop=105.0, leg="short"),
        _t(-5.0, exit_=95.0),
    ]
    a = compute_analysis(trades)
    edges = a["r_hist"]["edges"]
    counts = a["r_hist"]["counts"]
    assert edges == [-3, -2, -1, 0, 1, 2, 3]
    # +2R -> bucket (1, 2] = index 5; -1R -> bucket (-2, -1] = index 2
    assert counts[5] == 1 and counts[2] == 1


def test_context_groupby_with_unknown():
    trades = [
        _t(5.0, context={"trend": "up", "vol_regime": "low", "session": "london",
                         "candle_pattern": "none", "day_of_week": 1}),
        _t(-3.0, context=None),
    ]
    a = compute_analysis(trades)
    trend_rows = {r["bucket"]: r for r in a["context"]["trend"]}
    assert trend_rows["up"]["n"] == 1
    assert trend_rows["unknown"]["n"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_analysis.py -v`
Expected: FAIL — `ModuleNotFoundError: auto_trader.engine.analysis`.

- [ ] **Step 3: Implement the module**

Create `backend/auto_trader/engine/analysis.py`:

```python
"""Aggregate per-run analytics over TradeDTO-shaped trade dicts.

Operates on plain dicts (not Trade dataclasses) so one code path serves both
the live BacktestResponse and re-computation from run-store JSON. Winner =
pnl > 0, loser = pnl < 0 (plain sign — the engine's commission-aware win_rate
remains the headline number in `summary`). Group rows with n < 5 are flagged
low_sample rather than hidden. Zero trades produce an empty-but-valid payload.
"""

from __future__ import annotations

from statistics import median

MAE_EDGES = [0.25, 0.5, 0.75, 1.0]
R_EDGES = [-3, -2, -1, 0, 1, 2, 3]
NEAR_STOP_R = 0.8
LOW_SAMPLE_N = 5
CONTEXT_FEATURES = ("trend", "vol_regime", "session", "candle_pattern", "day_of_week")


def _hist(values: list[float], edges: list[float]) -> dict:
    """Counts per bucket: (-inf, e0], (e0, e1], ..., (eN, +inf) -> len(edges)+1."""
    counts = [0] * (len(edges) + 1)
    for v in values:
        i = 0
        while i < len(edges) and v > edges[i]:
            i += 1
        counts[i] += 1
    return {"edges": edges, "counts": counts}


def _realized_r(t: dict) -> float | None:
    """Signed R-multiple of the realized price move vs the initial stop distance."""
    stop = t.get("stop_initial")
    if stop is None:
        return None
    risk = abs(t["entry_price"] - stop)
    if risk <= 0:
        return None
    move = t["exit_price"] - t["entry_price"]
    if t.get("leg") == "short":
        move = -move
    return move / risk


def _rows(trades: list[dict], key) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for t in trades:
        groups.setdefault(str(key(t)), []).append(t)
    rows = []
    for bucket, ts in groups.items():
        pnls = [t["pnl"] for t in ts]
        rows.append({
            "bucket": bucket,
            "n": len(ts),
            "win_rate": sum(1 for p in pnls if p > 0) / len(ts),
            "expectancy": sum(pnls) / len(ts),
            "net_pnl": sum(pnls),
            "low_sample": len(ts) < LOW_SAMPLE_N,
        })
    rows.sort(key=lambda r: -r["n"])
    return rows


def compute_analysis(trades: list[dict]) -> dict:
    winners = [t for t in trades if t["pnl"] > 0]
    losers = [t for t in trades if t["pnl"] < 0]

    w_mae = [t["mae_r"] for t in winners if t.get("mae_r") is not None]
    l_mae = [t["mae_r"] for t in losers if t.get("mae_r") is not None]
    sl = {
        "winners_mae_hist": _hist(w_mae, MAE_EDGES),
        "losers_mae_hist": _hist(l_mae, MAE_EDGES),
        "winners_near_stop_pct": (
            sum(1 for m in w_mae if m >= NEAR_STOP_R) / len(w_mae) if w_mae else None
        ),
        "n_with_r": sum(1 for t in trades if t.get("mae_r") is not None),
    }

    w_pairs = [
        (t["mfe_r"], _realized_r(t))
        for t in winners
        if t.get("mfe_r") is not None and _realized_r(t) is not None
    ]
    nontarget = [
        t for t in trades
        if t.get("target") is not None and t.get("reason") != "target"
        and t.get("mfe") is not None
    ]
    reached = [
        t for t in nontarget
        if t["mfe"] >= abs(t["target"] - t["entry_price"])
    ]
    tp = {
        "avg_winner_mfe_r": sum(m for m, _ in w_pairs) / len(w_pairs) if w_pairs else None,
        "avg_winner_realized_r": sum(r for _, r in w_pairs) / len(w_pairs) if w_pairs else None,
        "median_left_on_table_r": median(m - r for m, r in w_pairs) if w_pairs else None,
        "pct_nontarget_exits_reached_target": (
            len(reached) / len(nontarget) if nontarget else None
        ),
    }

    realized = [r for r in (_realized_r(t) for t in trades) if r is not None]

    def _ctx(feature):
        return _rows(trades, lambda t, f=feature: (
            (t.get("context") or {}).get(f) if (t.get("context") or {}).get(f) is not None
            else "unknown"
        ))

    return {
        "n_trades": len(trades),
        "sl": sl,
        "tp": tp,
        "exit_reasons": _rows(trades, lambda t: t.get("reason") or "unknown"),
        "r_hist": _hist(realized, R_EDGES),
        "context": {f: _ctx(f) for f in CONTEXT_FEATURES},
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_analysis.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/analysis.py backend/tests/test_analysis.py
git commit -m "feat(backtest): aggregate SL/TP + context analytics module"
```

---

### Task 4: Run store

SQLite-backed store of recent backtest runs, mirroring `state_store.py`'s pattern (stdlib sqlite3, fresh connection per op, schema-on-connect, `asyncio.to_thread`, module singleton from settings).

**Files:**
- Create: `backend/auto_trader/core/run_store.py`
- Modify: `backend/auto_trader/config.py` (add `runs_db_path` to `Settings`, next to `state_db_path` ~line 60)
- Test: `backend/tests/test_run_store.py` (new)

**Interfaces:**
- Produces:
  - `RunStore(db_path: str, cap: int = 200)`
  - `async insert(rec: dict) -> None` — rec keys: `id, created_at, epic, timeframe, range_from, range_to, strategy_kind, strategy_name, request, summary, trades` (request/summary/trades are JSON-serializable Python objects; the store serializes). Prunes to the newest `cap` rows after insert.
  - `async list(limit: int = 50, epic: str | None = None) -> list[dict]` — newest first; each item has `id, created_at, epic, timeframe, range_from, range_to, strategy_kind, strategy_name, summary` (no request/trades).
  - `async get(run_id: str) -> dict | None` — the full record with `request, summary, trades` parsed back to objects.
  - `async delete(run_id: str) -> None` — idempotent.
  - `RUN_STORE` module singleton built from `settings.runs_db_path`.

- [ ] **Step 1: Add the setting**

In `backend/auto_trader/config.py`, inside `Settings`, after `state_db_path`:

```python
    # Where backtest runs (config + trades + metrics) are persisted for the
    # analysis loop. Capped at the most recent 200 runs. Set
    # CAPITAL_RUNS_DB_PATH to relocate.
    runs_db_path: str = "backtest_runs.db"
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_run_store.py`:

```python
"""Run store: insert/list/get/delete round-trip + cap pruning, on a temp db."""

import pytest

from auto_trader.core.run_store import RunStore


def _rec(i, epic="EURUSD"):
    return {
        "id": f"run-{i:03d}", "created_at": 1_000_000 + i,
        "epic": epic, "timeframe": "HOUR",
        "range_from": 1, "range_to": 2,
        "strategy_kind": "rules", "strategy_name": None,
        "request": {"longEntry": {"combine": "AND", "rules": []}},
        "summary": {"net_pnl": float(i), "n_trades": i},
        "trades": [{"pnl": 1.0, "leg": "long"}],
    }


@pytest.mark.asyncio
async def test_round_trip(tmp_path):
    store = RunStore(str(tmp_path / "runs.db"))
    await store.insert(_rec(1))

    listed = await store.list()
    assert len(listed) == 1
    assert listed[0]["id"] == "run-001"
    assert listed[0]["summary"]["n_trades"] == 1
    assert "trades" not in listed[0] and "request" not in listed[0]

    full = await store.get("run-001")
    assert full["trades"] == [{"pnl": 1.0, "leg": "long"}]
    assert full["request"]["longEntry"]["combine"] == "AND"

    await store.delete("run-001")
    assert await store.get("run-001") is None
    await store.delete("run-001")  # idempotent


@pytest.mark.asyncio
async def test_list_filters_and_orders(tmp_path):
    store = RunStore(str(tmp_path / "runs.db"))
    await store.insert(_rec(1, epic="EURUSD"))
    await store.insert(_rec(2, epic="GBPUSD"))
    await store.insert(_rec(3, epic="EURUSD"))

    eur = await store.list(epic="EURUSD")
    assert [r["id"] for r in eur] == ["run-003", "run-001"]  # newest first
    assert len(await store.list(limit=2)) == 2


@pytest.mark.asyncio
async def test_cap_prunes_oldest(tmp_path):
    store = RunStore(str(tmp_path / "runs.db"), cap=3)
    for i in range(5):
        await store.insert(_rec(i))
    listed = await store.list(limit=10)
    assert [r["id"] for r in listed] == ["run-004", "run-003", "run-002"]
```

Note: if `pytest.mark.asyncio` isn't configured in this repo (check `backend/pyproject.toml` for `pytest-asyncio` / an `asyncio_mode` setting, and how existing async tests run — e.g. `tests/test_api_backtest.py`), follow the repo's existing convention instead (e.g. `asyncio.run(...)` wrappers in sync tests). Do not add a new dependency without checking.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_run_store.py -v`
Expected: FAIL — `ModuleNotFoundError: auto_trader.core.run_store`.

- [ ] **Step 4: Implement the store**

Create `backend/auto_trader/core/run_store.py`:

```python
"""Backtest run persistence for the strategy-analysis loop: every normal run
(config + trades incl. MAE/MFE/context + summary metrics) lands here so runs
can be compared across iterations and read by tooling (Claude sessions curl
the read API). Sweep child runs are NOT stored. Capped at the newest `cap`
rows, pruned on insert. Equity curves / fills / bar traces are deliberately
not stored (bulky; re-runnable on demand).

Same storage pattern as state_store.py: stdlib sqlite3, WAL, schema ensured on
every connection, fresh connection per op via asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3


class RunStore:
    def __init__(self, db_path: str, cap: int = 200) -> None:
        self._db_path = db_path
        self._cap = cap
        self._connect().close()  # create the db file + schema up front

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS runs ("
            "id TEXT PRIMARY KEY, created_at INTEGER, epic TEXT, timeframe TEXT, "
            "range_from INTEGER, range_to INTEGER, strategy_kind TEXT, "
            "strategy_name TEXT, request_json TEXT, summary_json TEXT, "
            "trades_json TEXT)"
        )
        conn.commit()
        return conn

    async def insert(self, rec: dict) -> None:
        await asyncio.to_thread(self._insert_sync, rec)

    def _insert_sync(self, rec: dict) -> None:
        conn = self._connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO runs (id, created_at, epic, timeframe, "
                "range_from, range_to, strategy_kind, strategy_name, "
                "request_json, summary_json, trades_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    rec["id"], rec["created_at"], rec["epic"], rec["timeframe"],
                    rec["range_from"], rec["range_to"], rec["strategy_kind"],
                    rec.get("strategy_name"),
                    json.dumps(rec["request"]), json.dumps(rec["summary"]),
                    json.dumps(rec["trades"]),
                ),
            )
            conn.execute(
                "DELETE FROM runs WHERE id NOT IN "
                "(SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?)",
                (self._cap,),
            )
            conn.commit()
        finally:
            conn.close()

    async def list(self, limit: int = 50, epic: str | None = None) -> list[dict]:
        return await asyncio.to_thread(self._list_sync, limit, epic)

    def _list_sync(self, limit: int, epic: str | None) -> list[dict]:
        conn = self._connect()
        try:
            sql = (
                "SELECT id, created_at, epic, timeframe, range_from, range_to, "
                "strategy_kind, strategy_name, summary_json FROM runs"
            )
            params: list = []
            if epic is not None:
                sql += " WHERE epic = ?"
                params.append(epic)
            sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
            return [
                {
                    "id": r[0], "created_at": r[1], "epic": r[2], "timeframe": r[3],
                    "range_from": r[4], "range_to": r[5], "strategy_kind": r[6],
                    "strategy_name": r[7], "summary": json.loads(r[8]),
                }
                for r in rows
            ]
        finally:
            conn.close()

    async def get(self, run_id: str) -> dict | None:
        return await asyncio.to_thread(self._get_sync, run_id)

    def _get_sync(self, run_id: str) -> dict | None:
        conn = self._connect()
        try:
            r = conn.execute(
                "SELECT id, created_at, epic, timeframe, range_from, range_to, "
                "strategy_kind, strategy_name, request_json, summary_json, "
                "trades_json FROM runs WHERE id = ?",
                (run_id,),
            ).fetchone()
            if r is None:
                return None
            return {
                "id": r[0], "created_at": r[1], "epic": r[2], "timeframe": r[3],
                "range_from": r[4], "range_to": r[5], "strategy_kind": r[6],
                "strategy_name": r[7], "request": json.loads(r[8]),
                "summary": json.loads(r[9]), "trades": json.loads(r[10]),
            }
        finally:
            conn.close()

    async def delete(self, run_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, run_id)

    def _delete_sync(self, run_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            conn.commit()
        finally:
            conn.close()


# Module singleton, configured from settings (same pattern as STATE_STORE).
from auto_trader.config import settings  # noqa: E402  (after class def, avoids cycle)

RUN_STORE = RunStore(settings.runs_db_path)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_run_store.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/run_store.py backend/auto_trader/config.py backend/tests/test_run_store.py
git commit -m "feat(backtest): sqlite run store, capped at 200 runs"
```

---

### Task 5: API wiring — DTO fields, enrichment, analysis, run persistence, read endpoints

Thread Tasks 1–4 through the backtest endpoint and add the runs read API.

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (TradeDTO ~line 80, BacktestResponse ~line 145)
- Modify: `backend/auto_trader/api/routers/backtest.py` (handler `async def backtest(req) -> BacktestResponse` ~line 242, response construction ~lines 301–360)
- Test: `backend/tests/test_api_backtest_analysis.py` (new; model it on `backend/tests/test_api_backtest.py` — reuse that file's app/client fixtures and request-building helpers)

**Interfaces:**
- Consumes: `enrich_trades` (Task 2), `compute_analysis` (Task 3), `RUN_STORE` (Task 4), Trade fields (Task 1).
- Produces:
  - `TradeDTO` gains `mae: float = 0.0`, `mfe: float = 0.0`, `mae_r: float | None = None`, `mfe_r: float | None = None`, `context: dict | None = None`.
  - `BacktestResponse` gains `run_id: str | None = None`, `analysis: dict | None = None`.
  - `GET <prefix>/backtest/runs?limit=&epic=` → list summaries; `GET <prefix>/backtest/runs/{run_id}` → full record + recomputed `analysis`; `DELETE <prefix>/backtest/runs/{run_id}`. Use the same route-path prefix style as the existing endpoints in `routers/backtest.py` (the frontend calls `POST {BASE}/api/backtest`, so paths are `/api/backtest/runs` etc. if the prefix is inline in each decorator — match whatever the file does).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_api_backtest_analysis.py`. First read `backend/tests/test_api_backtest.py` and copy its exact fixture/client setup (TestClient construction, how it stubs candles/brokers, how it builds a minimal rules request). Then, using those helpers:

```python
"""API integration: backtest response carries MAE/MFE + context + analysis +
run_id; runs land in the store and are readable via the runs endpoints.

Uses a temp run-store db (monkeypatched RUN_STORE) so tests never touch the
real backtest_runs.db.
"""

import pytest

from auto_trader.core.run_store import RunStore

# Reuse the fixtures/helpers from test_api_backtest.py for the client and a
# minimal working backtest request (copy them here or import if importable).


@pytest.fixture()
def tmp_run_store(tmp_path, monkeypatch):
    store = RunStore(str(tmp_path / "runs.db"))
    # Patch the singleton where the router looks it up:
    import auto_trader.api.routers.backtest as bt_router
    monkeypatch.setattr(bt_router, "RUN_STORE", store)
    return store


def test_backtest_response_has_analysis_and_run_id(client, tmp_run_store):
    resp = client.post("/api/backtest", json=make_minimal_backtest_request())
    assert resp.status_code == 200
    body = resp.json()
    assert body["run_id"]
    assert body["analysis"]["n_trades"] == len(body["trades"])
    for t in body["trades"]:
        assert "mae" in t and "mfe" in t and "mae_r" in t and "context" in t


def test_run_is_persisted_and_readable(client, tmp_run_store):
    run_id = client.post("/api/backtest", json=make_minimal_backtest_request()).json()["run_id"]

    listed = client.get("/api/backtest/runs").json()
    assert any(r["id"] == run_id for r in listed)
    assert "summary" in listed[0] and "trades" not in listed[0]

    full = client.get(f"/api/backtest/runs/{run_id}").json()
    assert full["id"] == run_id
    assert "trades" in full and "request" in full
    assert full["analysis"]["n_trades"] == len(full["trades"])

    assert client.get("/api/backtest/runs/nope").status_code == 404
    assert client.delete(f"/api/backtest/runs/{run_id}").status_code == 200
    assert client.get(f"/api/backtest/runs/{run_id}").status_code == 404


def test_store_failure_does_not_fail_backtest(client, tmp_run_store, monkeypatch):
    async def boom(rec):
        raise RuntimeError("disk full")
    monkeypatch.setattr(tmp_run_store, "insert", boom)
    resp = client.post("/api/backtest", json=make_minimal_backtest_request())
    assert resp.status_code == 200  # best-effort: response unaffected
```

(`make_minimal_backtest_request` and `client` come from the copied test_api_backtest.py setup — keep their real names/shape from that file. Adjust route paths to the prefix style found in the router.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_analysis.py -v`
Expected: FAIL — response has no `run_id` / 404 on `/api/backtest/runs`.

- [ ] **Step 3: Implement schemas**

In `backend/auto_trader/api/schemas.py`:

`TradeDTO` — after `target: float | None = None`:

```python
    # Excursion + entry context (see engine.context_features): mae/mfe are raw
    # price distance from entry; *_r are R-multiples of the initial stop.
    mae: float = 0.0
    mfe: float = 0.0
    mae_r: float | None = None
    mfe_r: float | None = None
    context: dict | None = None
```

`BacktestResponse` — after `bar_traces: list[BarTraceDTO] | None`:

```python
    # Persisted-run id (None if the store write failed) + aggregate analytics.
    run_id: str | None = None
    analysis: dict | None = None
```

- [ ] **Step 4: Implement router changes**

In `backend/auto_trader/api/routers/backtest.py`:

1. Imports at the top:

```python
import logging
import time
import uuid

from auto_trader.core.run_store import RUN_STORE
from auto_trader.engine.analysis import compute_analysis
from auto_trader.engine.context_features import enrich_trades
```

(add `logger = logging.getLogger(__name__)` if the module doesn't already have one — check first.)

2. In the `backtest()` handler, right after the engine run completes and before the `TradeDTO` list is built: enrich trades with context (`candles` here is the engine's candle list variable in the handler — use its actual name):

```python
    enrich_trades(result.trades, candles)
```

3. Extend the existing Trade→TradeDTO conversion (~line 321) with the new fields:

```python
        mae=t.mae, mfe=t.mfe, mae_r=t.mae_r, mfe_r=t.mfe_r, context=t.context,
```

4. After the `trades` DTO list is built and `metrics`/`summary` exist, compute analysis from the DTO dicts and persist best-effort. IMPORTANT: this must run only for normal runs — if the sweep path (`SweepDTO` handling) reuses this handler or a shared helper, gate the store write so sweep child runs are skipped (find how the sweep endpoint invokes the engine — it must not write runs):

```python
    trade_dicts = [t.model_dump() for t in trades_dto]  # the TradeDTO list variable
    analysis = compute_analysis(trade_dicts)

    run_id: str | None = uuid.uuid4().hex
    try:
        await RUN_STORE.insert({
            "id": run_id,
            "created_at": int(time.time()),
            "epic": req.epic,
            "timeframe": req.resolution,
            "range_from": int(candles[0].time.timestamp()) if candles else 0,
            "range_to": int(candles[-1].time.timestamp()) if candles else 0,
            # The handler already branches between coded and rule strategies —
            # reuse that exact condition/field here:
            "strategy_kind": "coded" if <existing coded-strategy condition> else "rules",
            "strategy_name": <coded strategy file/name or None>,
            "request": req.model_dump(),
            "summary": {**summary, **metrics},
            "trades": trade_dicts,
        })
    except Exception:
        logger.warning("run-store write failed; continuing without run_id", exc_info=True)
        run_id = None
```

(`<existing coded-strategy condition>` / `<coded strategy file/name>`: the handler already has a branch that decides coded-vs-rules and knows the strategy file name — reuse those exact expressions; likewise `req.epic` / `req.resolution` should be the request fields the handler already reads for the response's `epic`/`resolution`.)

5. Add `run_id=run_id, analysis=analysis` to the `BacktestResponse(...)` construction.

6. Add the read endpoints (same decorator/prefix style as the file's existing routes; `HTTPException` from fastapi):

```python
@router.get("/api/backtest/runs")
async def list_runs(limit: int = 50, epic: str | None = None) -> list[dict]:
    """Recent persisted runs, newest first (summaries only — no trades)."""
    return await RUN_STORE.list(limit=limit, epic=epic)


@router.get("/api/backtest/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    """One stored run: config + trades (incl. MAE/MFE + context) + recomputed analysis."""
    rec = await RUN_STORE.get(run_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="run not found")
    rec["analysis"] = compute_analysis(rec["trades"])
    return rec


@router.delete("/api/backtest/runs/{run_id}")
async def delete_run(run_id: str) -> dict:
    """Remove one stored run (housekeeping)."""
    await RUN_STORE.delete(run_id)
    return {"ok": True}
```

Route-ordering note: FastAPI matches literal segments before path params, and the existing routes don't overlap `/runs` — but declare `GET /api/backtest/runs` BEFORE `GET /api/backtest/runs/{run_id}` anyway.

- [ ] **Step 5: Run tests to verify they pass, plus the full backend suite**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_analysis.py -v && python -m pytest`
Expected: new tests PASS; full suite green (existing API tests must not break — the new response fields have defaults, so old assertions hold).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_analysis.py
git commit -m "feat(backtest): analysis payload + run store persistence + runs read API"
```

---

### Task 6: Frontend — types + "Analysis" tab in the backtest dock

Render the `analysis` payload in a fourth dock tab. No computation in the browser beyond formatting.

**Files:**
- Modify: `frontend/src/api.ts` (`Trade` interface ~line 80, `BacktestResult` ~line 116)
- Create: `frontend/src/BacktestAnalysisPanel.tsx`
- Modify: `frontend/src/BacktestPanel.tsx` (Tab union ~line 39, tab switcher ~lines 194–219, tab body ~line 225)
- Modify: `frontend/src/App.css` (new `.bt-analysis*` classes near the `.bt-results` block ~line 3742)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx` (new)

**Interfaces:**
- Consumes: `BacktestResult.analysis` shaped exactly as Task 3's `compute_analysis` output; `StoredBacktestResult` (`lib/persist/artifacts.ts:48`) is `Omit<BacktestResult, "candles">`, so `analysis` and `run_id` persist automatically — no persistence changes needed.
- Produces: `BacktestAnalysisPanel({ analysis }: { analysis: BacktestAnalysis | null | undefined })` React component; exported types `BacktestAnalysis`, `AnalysisRow` from `api.ts`.

- [ ] **Step 1: Add the types**

In `frontend/src/api.ts`, extend `Trade` (after `target`):

```ts
  mae: number;
  mfe: number;
  mae_r: number | null;
  mfe_r: number | null;
  context: Record<string, string | number | null> | null;
```

Add above `BacktestResult`:

```ts
export interface AnalysisHist {
  edges: number[];
  counts: number[];
}

export interface AnalysisRow {
  bucket: string;
  n: number;
  win_rate: number;
  expectancy: number;
  net_pnl: number;
  low_sample: boolean;
}

export interface BacktestAnalysis {
  n_trades: number;
  sl: {
    winners_mae_hist: AnalysisHist;
    losers_mae_hist: AnalysisHist;
    winners_near_stop_pct: number | null;
    n_with_r: number;
  };
  tp: {
    avg_winner_mfe_r: number | null;
    avg_winner_realized_r: number | null;
    median_left_on_table_r: number | null;
    pct_nontarget_exits_reached_target: number | null;
  };
  exit_reasons: AnalysisRow[];
  r_hist: AnalysisHist;
  context: Record<string, AnalysisRow[]>;
}
```

and extend `BacktestResult`:

```ts
  run_id?: string | null;
  analysis?: BacktestAnalysis | null;
```

- [ ] **Step 2: Write the failing component test**

Create `frontend/src/BacktestAnalysisPanel.test.tsx` (check `frontend/src/BacktestSettingsModal.test.tsx` for the repo's render-test idioms — testing-library vs manual root — and mirror them; the below assumes testing-library, adjust if the repo differs):

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { BacktestAnalysis } from "./api";
import BacktestAnalysisPanel from "./BacktestAnalysisPanel";

const analysis: BacktestAnalysis = {
  n_trades: 7,
  sl: {
    winners_mae_hist: { edges: [0.25, 0.5, 0.75, 1.0], counts: [2, 1, 0, 1, 0] },
    losers_mae_hist: { edges: [0.25, 0.5, 0.75, 1.0], counts: [0, 0, 1, 2, 0] },
    winners_near_stop_pct: 0.25,
    n_with_r: 7,
  },
  tp: {
    avg_winner_mfe_r: 2.8,
    avg_winner_realized_r: 1.5,
    median_left_on_table_r: 1.1,
    pct_nontarget_exits_reached_target: 0.4,
  },
  exit_reasons: [
    { bucket: "target", n: 4, win_rate: 1, expectancy: 5, net_pnl: 20, low_sample: true },
    { bucket: "stop", n: 3, win_rate: 0, expectancy: -2, net_pnl: -6, low_sample: true },
  ],
  r_hist: { edges: [-3, -2, -1, 0, 1, 2, 3], counts: [0, 0, 3, 0, 0, 2, 2, 0] },
  context: {
    trend: [
      { bucket: "up", n: 5, win_rate: 0.8, expectancy: 3, net_pnl: 15, low_sample: false },
      { bucket: "down", n: 2, win_rate: 0, expectancy: -0.5, net_pnl: -1, low_sample: true },
    ],
    vol_regime: [], session: [], candle_pattern: [], day_of_week: [],
  },
};

describe("BacktestAnalysisPanel", () => {
  it("renders SL/TP read-outs, exit reasons, and context tables", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    expect(screen.getByText(/25% of winners came within 0.8R of the stop/i)).toBeTruthy();
    expect(screen.getByText(/1.1R/)).toBeTruthy(); // left on the table
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.getByText("up")).toBeTruthy();
  });

  it("shows the empty state when there are no trades", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, n_trades: 0 }} />);
    expect(screen.getByText(/no trades to analyse/i)).toBeTruthy();
  });

  it("renders nothing useful crash-free with no analysis (older stored runs)", () => {
    render(<BacktestAnalysisPanel analysis={null} />);
    expect(screen.getByText(/run a backtest/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: FAIL — module `./BacktestAnalysisPanel` not found.

- [ ] **Step 4: Implement the component**

Create `frontend/src/BacktestAnalysisPanel.tsx`:

```tsx
import type { AnalysisHist, AnalysisRow, BacktestAnalysis } from "./api";
import InfoTip from "./components/InfoTip";

/** Analysis tab of the backtest dock: renders the backend-computed `analysis`
 * payload (SL/TP efficiency, exit reasons, R distribution, context breakdowns).
 * Pure formatting — every number here was computed server-side. */

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtR = (v: number) => `${v.toFixed(1)}R`;

function Hist({ hist, label }: { hist: AnalysisHist; label: string }) {
  const max = Math.max(1, ...hist.counts);
  const names = [
    `≤${hist.edges[0]}`,
    ...hist.edges.slice(1).map((e, i) => `${hist.edges[i]}–${e}`),
    `>${hist.edges[hist.edges.length - 1]}`,
  ];
  return (
    <div className="bt-analysis-hist">
      <div className="bt-analysis-hist-label">{label}</div>
      {hist.counts.map((c, i) => (
        <div key={i} className="bt-analysis-hist-row">
          <span className="bt-analysis-hist-bucket">{names[i]}</span>
          <span className="bt-analysis-hist-bar" style={{ width: `${(c / max) * 100}%` }} />
          <span className="bt-analysis-hist-count">{c || ""}</span>
        </div>
      ))}
    </div>
  );
}

function RowsTable({ rows, avg }: { rows: AnalysisRow[]; avg: number }) {
  if (!rows.length) return <div className="bt-analysis-empty">No data.</div>;
  return (
    <table className="bt-analysis-table">
      <thead>
        <tr><th>Bucket</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>Net P&L</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.bucket}
            className={
              (r.low_sample ? "bt-analysis-low " : "") +
              (!r.low_sample && r.expectancy < avg ? "bt-analysis-under" : "")
            }
          >
            <td>
              {r.bucket}
              {r.low_sample && (
                <InfoTip title="Low sample" text="Fewer than 5 trades — treat with caution." />
              )}
            </td>
            <td>{r.n}</td>
            <td>{fmtPct(r.win_rate)}</td>
            <td>{r.expectancy.toFixed(2)}</td>
            <td>{r.net_pnl.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function BacktestAnalysisPanel({
  analysis,
}: {
  analysis: BacktestAnalysis | null | undefined;
}) {
  if (!analysis) {
    return <div className="bt-analysis-empty">Run a backtest to see the analysis.</div>;
  }
  if (analysis.n_trades === 0) {
    return <div className="bt-analysis-empty">No trades to analyse.</div>;
  }
  const { sl, tp } = analysis;
  const runAvg =
    analysis.exit_reasons.reduce((s, r) => s + r.net_pnl, 0) / analysis.n_trades;

  const readouts: string[] = [];
  if (sl.winners_near_stop_pct != null) {
    readouts.push(
      `${fmtPct(sl.winners_near_stop_pct)} of winners came within 0.8R of the stop before working out.`,
    );
  }
  if (tp.avg_winner_mfe_r != null && tp.avg_winner_realized_r != null) {
    readouts.push(
      `Winners ran to ${fmtR(tp.avg_winner_mfe_r)} on average but realized ${fmtR(tp.avg_winner_realized_r)}.`,
    );
  }
  if (tp.median_left_on_table_r != null) {
    readouts.push(`Median ${fmtR(tp.median_left_on_table_r)} left on the table per winner.`);
  }
  if (tp.pct_nontarget_exits_reached_target != null) {
    readouts.push(
      `${fmtPct(tp.pct_nontarget_exits_reached_target)} of trades exited by rule/stop had already reached the target level.`,
    );
  }

  return (
    <div className="bt-analysis">
      <section className="bt-analysis-section">
        <h4>Stops &amp; targets</h4>
        {readouts.map((r, i) => (
          <p key={i} className="bt-analysis-readout">{r}</p>
        ))}
        <div className="bt-analysis-hists">
          <Hist hist={sl.winners_mae_hist} label="Winners — worst drawdown before profit (MAE, in R)" />
          <Hist hist={sl.losers_mae_hist} label="Losers — MAE (in R)" />
          <Hist hist={analysis.r_hist} label="Result distribution (R)" />
        </div>
      </section>

      <section className="bt-analysis-section">
        <h4>Exit reasons</h4>
        <RowsTable rows={analysis.exit_reasons} avg={runAvg} />
      </section>

      {(
        [
          ["trend", "Trend at entry"],
          ["vol_regime", "Volatility regime"],
          ["session", "Session"],
          ["candle_pattern", "Entry-bar pattern"],
          ["day_of_week", "Day of week"],
        ] as const
      ).map(([key, label]) => (
        <section key={key} className="bt-analysis-section">
          <h4>{label}</h4>
          <RowsTable rows={analysis.context[key] ?? []} avg={runAvg} />
        </section>
      ))}
    </div>
  );
}
```

(Verify the `InfoTip` import path/props against `frontend/src/components/InfoTip.tsx` — CLAUDE.md documents `<InfoTip title={string} text={string | string[]} />`. Keep the InfoTip inside the styled table cell — per known feedback it must sit in a styled container or it renders as a black box; if styling looks wrong, extend the `.ind-info`-style selectors in App.css for `.bt-analysis-table`.)

- [ ] **Step 5: Wire the tab into BacktestPanel**

In `frontend/src/BacktestPanel.tsx`:

1. Extend the union (~line 39): `type Tab = "overview" | "trades" | "analysis" | "inspect";`
2. Import the component: `import BacktestAnalysisPanel from "./BacktestAnalysisPanel";`
3. In the segmented switcher (~lines 194–219), add a button after Trades, copying the exact `.seg`/`.seg-on` idiom of its neighbors:

```tsx
<button
  className={tab === "analysis" ? "seg seg-on" : "seg"}
  onClick={() => setTab("analysis")}
>
  Analysis
</button>
```

4. In the tab body (near the `inspect` branch ~line 225):

```tsx
{tab === "analysis" && <BacktestAnalysisPanel analysis={result?.analysis} />}
```

- [ ] **Step 6: Add CSS**

In `frontend/src/App.css`, after the `.bt-results` block (~line 3742) — flat, light-first, no shadows, content-sized:

```css
/* Backtest Analysis tab */
.bt-analysis { display: flex; flex-direction: column; gap: 14px; padding: 10px 12px; overflow-y: auto; }
.bt-analysis-section h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
.bt-analysis-readout { margin: 2px 0; font-size: 12px; }
.bt-analysis-empty { padding: 16px; font-size: 12px; color: var(--muted, #787b86); }
.bt-analysis-table { border-collapse: collapse; font-size: 12px; }
.bt-analysis-table th, .bt-analysis-table td { padding: 3px 10px 3px 0; text-align: left; }
.bt-analysis-table th { font-weight: 500; color: var(--muted, #787b86); }
.bt-analysis-low { color: var(--muted, #787b86); }
.bt-analysis-under td:first-child { border-left: 2px solid #f23645; padding-left: 6px; }
.bt-analysis-hists { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 8px; }
.bt-analysis-hist { font-size: 11px; min-width: 200px; }
.bt-analysis-hist-label { margin-bottom: 4px; color: var(--muted, #787b86); }
.bt-analysis-hist-row { display: flex; align-items: center; gap: 6px; height: 14px; }
.bt-analysis-hist-bucket { width: 64px; text-align: right; color: var(--muted, #787b86); }
.bt-analysis-hist-bar { display: inline-block; height: 8px; background: #2962ff; border-radius: 1px; }
.bt-analysis-hist-count { color: var(--muted, #787b86); }
```

(Check how neighboring `.bt-*` rules reference theme colors — if App.css uses concrete light/dark selectors instead of `var(--muted)`, follow that convention instead.)

- [ ] **Step 7: Run frontend tests + typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx && npx tsc --noEmit`
Expected: tests PASS, no type errors. (If the repo has its own typecheck/build script in package.json, use that instead of bare tsc.)

- [ ] **Step 8: Verify in the running app**

With the user's dev servers already running (do NOT restart them): run a backtest from the panel on any cell, switch to the new Analysis tab, and confirm sections render with real numbers; confirm the tab shows the empty state before any run. Screenshot for the record if browser automation is available; close any browser tab you opened.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx frontend/src/BacktestPanel.tsx frontend/src/App.css
git commit -m "feat(backtest): Analysis tab — SL/TP efficiency, exit reasons, context breakdowns"
```

---

### Task 7: Full-suite verification

- [ ] **Step 1: Backend full suite**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest`
Expected: all PASS.

- [ ] **Step 2: Frontend full suite**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run`
Expected: all PASS (pre-existing failures, if any, must be noted as pre-existing — verify against `git stash` if unsure).

- [ ] **Step 3: End-to-end smoke of the runs API**

With the backend dev server running:

```bash
curl -s "http://localhost:8000/api/backtest/runs?limit=3" | python3 -m json.tool
```

Expected: JSON array containing the run from Task 6 Step 8, with `summary` and no `trades`. Then fetch one full run:

```bash
curl -s "http://localhost:8000/api/backtest/runs/<id-from-list>" | python3 -m json.tool | head -50
```

Expected: full record with `trades` (containing `mae`, `mfe`, `context`) and `analysis`. (Adjust port to the backend's actual dev port if different — check how the frontend's `BASE` in `api.ts` resolves.)

- [ ] **Step 4: Final commit if anything changed**

```bash
git status --short   # commit any stragglers with an appropriate message
```
