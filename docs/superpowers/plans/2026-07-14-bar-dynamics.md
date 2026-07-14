# Per-Trade Bar Dynamics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-trade bar-count statistics (time in profit/loss, entry retests, streaks, chop) computed incrementally in the engine, persisted on each trade, and aggregated in the Analysis tab as a "Bar dynamics" section (winners vs losers, each count with a wall-clock duration).

**Architecture:** A pure `BarStats` dataclass accumulates the counters one bar at a time. The engine calls it from the existing per-bar `_track_excursion` hook and books the counters onto each `Trade`. The counters flow through `TradeDTO` into the run store and into `compute_analysis`, which averages them across winners and losers. The frontend renders a metric x winners/losers table on the Placement sub-tab, formatting bar counts as durations via the run's bar interval.

**Tech Stack:** Python (pytest) backend, React + TypeScript (vitest) frontend.

## Global Constraints

- No em dash and no "--" as punctuation anywhere in code, comments, copy, or tests. Rephrase with colon/comma/period.
- Win/loss grouping is `pnl > 0` / `pnl < 0`, matching the rest of the Analysis tab.
- New fields on `Trade`, `TradeDTO`, and `Position` MUST default to 0 (or a default factory) so existing construction sites and tests are unaffected.
- Bar classification is by the bar's close vs entry price `E`; favorable = up for long, down for short.
- Reuse existing shared components where they fit; the metric x winners/losers table is a justified new small component.
- Do not touch the unrelated in-flight files (`BacktestSettingsModal.tsx`, `backtestSchedule*`).
- Frontend typecheck via `npx tsc -b` (pre-existing errors only, zero new).

The eleven stored per-trade integer metrics (exact field names, used across all tasks):
`bars_held`, `bars_in_profit`, `bars_in_loss`, `body_through`, `wick_from_profit`, `wick_from_loss`, `longest_profit_streak`, `longest_loss_streak`, `bars_to_mfe`, `bars_to_mae`, `entry_crossings`.

---

### Task 1: `BarStats` dataclass (pure, unit-tested)

**Files:**
- Modify: `backend/auto_trader/core/models.py` (add `BarStats` dataclass with `update` method; place it just before `class Trade`)
- Create: `backend/tests/test_bar_stats.py`

**Interfaces:**
- Consumes: the existing `Candle` dataclass in `models.py` (`time, open, high, low, close, volume`).
- Produces: `class BarStats` with eleven public int counter fields (listed in Global Constraints) and a method `update(self, entry: float, leg: str, bar: Candle) -> None`. Later tasks attach a `BarStats` to `Position` and read its counter fields.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_bar_stats.py`:

```python
"""BarStats.update: per-bar accumulation of a trade's time-in-zone, entry
retests, streaks and chop. Pure over hand-built candles, no engine."""

from datetime import datetime, timedelta, timezone

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_bar_stats.py -v`
Expected: FAIL with `ImportError: cannot import name 'BarStats'`.

- [ ] **Step 3: Implement `BarStats`**

In `backend/auto_trader/core/models.py`, add this dataclass immediately before `class Trade` (line ~160). Confirm `from dataclasses import dataclass, field` is already imported at the top of the file (it is, since `Trade` uses `@dataclass`); if `field` is not imported, add it to that import.

```python
@dataclass(slots=True)
class BarStats:
    """Per-trade bar-count dynamics, accumulated one held bar at a time by
    `update`. Classification is by the bar close vs the entry price; favorable
    means up for a long and down for a short. The leading-underscore fields are
    running state, not exported onto the Trade."""

    bars_held: int = 0
    bars_in_profit: int = 0
    bars_in_loss: int = 0
    body_through: int = 0
    wick_from_profit: int = 0
    wick_from_loss: int = 0
    longest_profit_streak: int = 0
    longest_loss_streak: int = 0
    bars_to_mfe: int = 0
    bars_to_mae: int = 0
    entry_crossings: int = 0
    _cur_profit: int = 0
    _cur_loss: int = 0
    _prev_zone: int = 0  # last non-flat zone: +1 profit, -1 loss, 0 unset
    _fav: float = 0.0    # favorable extreme so far (seeded to entry)
    _adv: float = 0.0    # adverse extreme so far (seeded to entry)
    _seeded: bool = False

    def update(self, entry: float, leg: str, bar: "Candle") -> None:
        if not self._seeded:
            self._fav = entry
            self._adv = entry
            self._seeded = True
        self.bars_held += 1
        long = leg == "long"
        o, hi, lo, c = bar.open, bar.high, bar.low, bar.close
        profit = c > entry if long else c < entry
        loss = c < entry if long else c > entry

        if profit:
            self.bars_in_profit += 1
            self._cur_profit += 1
            self._cur_loss = 0
            if self._cur_profit > self.longest_profit_streak:
                self.longest_profit_streak = self._cur_profit
        elif loss:
            self.bars_in_loss += 1
            self._cur_loss += 1
            self._cur_profit = 0
            if self._cur_loss > self.longest_loss_streak:
                self.longest_loss_streak = self._cur_loss
        else:  # flat: neither zone, resets both streaks
            self._cur_profit = 0
            self._cur_loss = 0

        if min(o, c) < entry < max(o, c):
            self.body_through += 1

        if long:
            if profit and lo <= entry:
                self.wick_from_profit += 1
            if loss and hi >= entry:
                self.wick_from_loss += 1
            if hi > self._fav:
                self._fav = hi
                self.bars_to_mfe = self.bars_held
            if lo < self._adv:
                self._adv = lo
                self.bars_to_mae = self.bars_held
        else:
            if profit and hi >= entry:
                self.wick_from_profit += 1
            if loss and lo <= entry:
                self.wick_from_loss += 1
            if lo < self._fav:
                self._fav = lo
                self.bars_to_mfe = self.bars_held
            if hi > self._adv:
                self._adv = hi
                self.bars_to_mae = self.bars_held

        zone = 1 if profit else (-1 if loss else 0)
        if zone != 0:
            if self._prev_zone != 0 and zone != self._prev_zone:
                self.entry_crossings += 1
            self._prev_zone = zone
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_bar_stats.py -v`
Expected: PASS (all six tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/models.py backend/tests/test_bar_stats.py
git commit -m "feat(engine): BarStats per-bar trade dynamics accumulator"
```

---

### Task 2: Wire `BarStats` through the engine onto `Trade` and `TradeDTO`

**Files:**
- Modify: `backend/auto_trader/core/models.py` (add the eleven int fields to `Trade`)
- Modify: `backend/auto_trader/engine/backtest.py` (add `bar_stats` to `Position`; call `update` in `_track_excursion`; book counters in `_reduce`)
- Modify: `backend/auto_trader/api/schemas.py` (add the eleven int fields to `TradeDTO`)
- Modify: `backend/auto_trader/api/routers/backtest.py` (pass the eleven fields into the `TradeDTO(...)` construction)
- Test: `backend/tests/test_backtest.py` (add one integration test)

**Interfaces:**
- Consumes: `BarStats` from Task 1 (fields listed in Global Constraints; method `update(entry, leg, bar)`).
- Produces: each `Trade` and `TradeDTO` carries the eleven int fields (default 0), so `t.model_dump()` includes them for Task 3's aggregation.

- [ ] **Step 1: Add the eleven fields to `Trade`**

In `backend/auto_trader/core/models.py`, inside `class Trade` (after the `mfe_r` line, before `context`), add:

```python
    # Per-trade bar-count dynamics (see engine BarStats): counts over the held
    # bars (entry through exit). All default 0 for trades built without them.
    bars_held: int = 0
    bars_in_profit: int = 0
    bars_in_loss: int = 0
    body_through: int = 0
    wick_from_profit: int = 0
    wick_from_loss: int = 0
    longest_profit_streak: int = 0
    longest_loss_streak: int = 0
    bars_to_mfe: int = 0
    bars_to_mae: int = 0
    entry_crossings: int = 0
```

- [ ] **Step 2: Add `bar_stats` to `Position` and import `BarStats`**

In `backend/auto_trader/engine/backtest.py`: the import line 22 currently reads
`from auto_trader.core.models import BarTrace, Candle, Fill, Side, Signal, Trade`.
Add `BarStats`:
`from auto_trader.core.models import BarStats, BarTrace, Candle, Fill, Side, Signal, Trade`.

Then in `class Position` (after the `fav_extreme: float = 0.0` line ~59), add:

```python
    # Per-bar dynamics accumulator, advanced once per held bar in _track_excursion.
    bar_stats: BarStats = field(default_factory=BarStats)
```

Confirm `field` is imported in `backtest.py` (it is, used by `BacktestResult`).

- [ ] **Step 3: Advance `bar_stats` in `_track_excursion`**

In `_track_excursion` (static method, ~line 473), update each open position's accumulator before the watermark updates. Replace:

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

with:

```python
    @staticmethod
    def _track_excursion(positions, side, bar):
        """Extend each open position's adverse/favorable watermarks with this
        bar's range and advance its per-bar dynamics. Called before intra-bar
        exits so the exit bar counts."""
        for p in positions:
            p.bar_stats.update(p.entry, side, bar)
            if side == "long":
                p.adv_extreme = min(p.adv_extreme, bar.low)
                p.fav_extreme = max(p.fav_extreme, bar.high)
            else:
                p.adv_extreme = max(p.adv_extreme, bar.high)
                p.fav_extreme = min(p.fav_extreme, bar.low)
```

- [ ] **Step 4: Book the counters onto the `Trade` in `_reduce`**

In `_reduce` (~line 415), the `Trade(...)` construction currently ends with the `mae=..., mfe=..., mae_r=..., mfe_r=...,` line. Add the bar-stats fields to that `Trade(...)` call, reading from `p.bar_stats`. Change the `Trade(` construction so it includes:

```python
                mae=mae, mfe=mfe, mae_r=mae_r, mfe_r=mfe_r,
                bars_held=p.bar_stats.bars_held,
                bars_in_profit=p.bar_stats.bars_in_profit,
                bars_in_loss=p.bar_stats.bars_in_loss,
                body_through=p.bar_stats.body_through,
                wick_from_profit=p.bar_stats.wick_from_profit,
                wick_from_loss=p.bar_stats.wick_from_loss,
                longest_profit_streak=p.bar_stats.longest_profit_streak,
                longest_loss_streak=p.bar_stats.longest_loss_streak,
                bars_to_mfe=p.bar_stats.bars_to_mfe,
                bars_to_mae=p.bar_stats.bars_to_mae,
                entry_crossings=p.bar_stats.entry_crossings,
```

(Keep the existing `mae=...` line; the new lines follow it inside the same `Trade(...)` call.)

- [ ] **Step 5: Add the eleven fields to `TradeDTO`**

In `backend/auto_trader/api/schemas.py`, inside `class TradeDTO` (after the `mfe_r: float | None = None` line ~98, before `context`), add:

```python
    # Per-trade bar-count dynamics (see engine BarStats). Default 0 so older
    # stored runs and hand-built DTOs remain valid.
    bars_held: int = 0
    bars_in_profit: int = 0
    bars_in_loss: int = 0
    body_through: int = 0
    wick_from_profit: int = 0
    wick_from_loss: int = 0
    longest_profit_streak: int = 0
    longest_loss_streak: int = 0
    bars_to_mfe: int = 0
    bars_to_mae: int = 0
    entry_crossings: int = 0
```

- [ ] **Step 6: Pass the fields through the router's `TradeDTO(...)`**

In `backend/auto_trader/api/routers/backtest.py`, the `TradeDTO(...)` construction (~line 321) has a line
`mae=t.mae, mfe=t.mfe, mae_r=t.mae_r, mfe_r=t.mfe_r, context=t.context,`.
Immediately after that line (still inside the `TradeDTO(...)` call), add:

```python
            bars_held=t.bars_held, bars_in_profit=t.bars_in_profit,
            bars_in_loss=t.bars_in_loss, body_through=t.body_through,
            wick_from_profit=t.wick_from_profit, wick_from_loss=t.wick_from_loss,
            longest_profit_streak=t.longest_profit_streak,
            longest_loss_streak=t.longest_loss_streak,
            bars_to_mfe=t.bars_to_mfe, bars_to_mae=t.bars_to_mae,
            entry_crossings=t.entry_crossings,
```

- [ ] **Step 7: Write the failing integration test**

Add to `backend/tests/test_backtest.py` (it already imports `Candle, Side, Signal`, `BacktestEngine`, `Context`, `Strategy`, and defines `_series`):

```python
def test_trade_carries_bar_stats():
    class Flip(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            n = len(ctx.history)
            if n == 1:
                return [Signal(Side.BUY, 1.0, "in")]
            if n == 5:
                return [Signal(Side.SELL, 1.0, "out")]
            return []

    # BUY signals on bar index 0 (history length 1) -> fills at index 1's open
    # = 100, so entry == 100. SELL signals on index 4 (history length 5) ->
    # fills at index 5's open. A rule exit is booked at that bar's open BEFORE
    # _track_excursion runs, so the exit bar (index 5) is NOT a held bar. Held
    # bars are indices 1, 2, 3, 4 -> bars_held == 4. Their closes are
    # 100, 101, 102, 103: the entry bar (index 1) closes exactly at entry, so it
    # is flat (neither profit nor loss); indices 2, 3, 4 close above entry.
    # -> bars_in_profit == 3, bars_in_loss == 0.
    candles = _series([100, 100, 101, 102, 103, 104, 104])
    res = BacktestEngine(Flip()).run(candles)
    assert len(res.trades) == 1
    t = res.trades[0]
    assert t.entry_price == 100.0
    assert t.bars_held == 4
    assert t.bars_in_profit == 3
    assert t.bars_in_loss == 0
```

The counts above are exact for this engine (rule exit at bar open, entry bar tracked and flat in a `_series` bar). Do not change the engine to alter them: if the run produces different numbers, investigate the wiring rather than editing the assertions.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_backtest.py tests/test_bar_stats.py -v`
Expected: PASS, including the new `test_trade_carries_bar_stats`. Also run the broader engine + API suite to catch any construction-site breakage from the new fields:
Run: `cd backend && python -m pytest tests/test_backtest.py tests/test_api_backtest.py tests/test_api_backtest_analysis.py -q`
Expected: PASS (new fields are all defaulted, so existing sites are unaffected).

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/core/models.py backend/auto_trader/engine/backtest.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_backtest.py
git commit -m "feat(engine): book per-trade bar dynamics onto Trade and TradeDTO"
```

---

### Task 3: Aggregate bar dynamics in `compute_analysis`

**Files:**
- Modify: `backend/auto_trader/engine/analysis.py` (add `_bar_dynamics` helper + wire into `compute_analysis`)
- Test: `backend/tests/test_analysis.py` (add bar-dynamics tests; extend the local `_t` helper)

**Interfaces:**
- Consumes: trade dicts carrying the eleven int fields (from Task 2's `model_dump()`); grouping by `pnl`.
- Produces: `compute_analysis(trades)["bar_dynamics"]` -> `{"n_winners": int, "n_losers": int, "winners": dict, "losers": dict}` where each inner dict maps each of the eleven metric names plus `"profit_time_pct"` to `float | None`.

- [ ] **Step 1: Extend the `_t` helper and write failing tests**

In `backend/tests/test_analysis.py`, the local `_t` helper builds trade dicts. Add a `bars=None` keyword that, when given a dict, merges bar-stat fields into the trade dict. Change the `_t` signature to add `bars=None` and, before the return, splice it in. Concretely, replace the `_t` function with:

```python
def _t(pnl, *, entry=100.0, exit_=None, stop=95.0, target=None, leg="long",
       reason="rule", mae_r=None, mfe_r=None, context=None, bars=None):
    if exit_ is None:
        exit_ = entry + pnl  # qty 1 price move == pnl for a long
    d = {
        "pnl": pnl, "leg": leg, "entry_price": entry, "exit_price": exit_,
        "stop_initial": stop, "target": target, "reason": reason,
        "mae": (mae_r or 0.0) * 5.0, "mfe": (mfe_r or 0.0) * 5.0,
        "mae_r": mae_r, "mfe_r": mfe_r, "context": context,
    }
    if bars is not None:
        d.update(bars)
    return d
```

Then append these tests:

```python
def _bars(held, profit, loss, **extra):
    d = {"bars_held": held, "bars_in_profit": profit, "bars_in_loss": loss,
         "body_through": 0, "wick_from_profit": 0, "wick_from_loss": 0,
         "longest_profit_streak": 0, "longest_loss_streak": 0,
         "bars_to_mfe": 0, "bars_to_mae": 0, "entry_crossings": 0}
    d.update(extra)
    return d


def test_bar_dynamics_splits_winners_losers_and_averages():
    trades = [
        _t(5.0, bars=_bars(10, 8, 2, entry_crossings=1)),
        _t(3.0, bars=_bars(6, 6, 0, entry_crossings=3)),
        _t(-4.0, bars=_bars(8, 1, 7, entry_crossings=5)),
    ]
    bd = compute_analysis(trades)["bar_dynamics"]
    assert bd["n_winners"] == 2 and bd["n_losers"] == 1
    # winners: bars_held mean (10+6)/2 = 8.0; entry_crossings (1+3)/2 = 2.0.
    assert bd["winners"]["bars_held"] == 8.0
    assert bd["winners"]["entry_crossings"] == 2.0
    # profit_time_pct winners: mean(8/10, 6/6) = mean(0.8, 1.0) = 0.9.
    assert bd["winners"]["profit_time_pct"] == 0.9
    assert bd["losers"]["bars_held"] == 8.0
    assert bd["losers"]["profit_time_pct"] == 1 / 8


def test_bar_dynamics_excludes_trades_without_bar_stats():
    # A trade with no bar-stat fields (older run) is not eligible.
    trades = [_t(5.0, bars=_bars(10, 8, 2)), _t(2.0)]  # second has no bars
    bd = compute_analysis(trades)["bar_dynamics"]
    assert bd["n_winners"] == 1 and bd["n_losers"] == 0
    assert bd["winners"]["bars_held"] == 10.0


def test_bar_dynamics_empty_group_is_all_none():
    bd = compute_analysis([])["bar_dynamics"]
    assert bd["n_winners"] == 0 and bd["n_losers"] == 0
    assert bd["winners"]["bars_held"] is None
    assert bd["winners"]["profit_time_pct"] is None
    assert bd["losers"]["bars_held"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_analysis.py -k bar_dynamics -v`
Expected: FAIL with `KeyError: 'bar_dynamics'`.

- [ ] **Step 3: Implement `_bar_dynamics` and wire it in**

In `backend/auto_trader/engine/analysis.py`, add near the other helpers (after `_month_stats`, before `compute_analysis`):

```python
_BAR_METRICS = (
    "bars_held", "bars_in_profit", "bars_in_loss", "body_through",
    "wick_from_profit", "wick_from_loss", "longest_profit_streak",
    "longest_loss_streak", "bars_to_mfe", "bars_to_mae", "entry_crossings",
)


def _avg_bar_metrics(group: list[dict]) -> dict:
    """Mean of each bar metric over the group, plus mean per-trade profit-time
    ratio. All-None for an empty group."""
    if not group:
        out = {m: None for m in _BAR_METRICS}
        out["profit_time_pct"] = None
        return out
    out = {m: sum(t[m] for t in group) / len(group) for m in _BAR_METRICS}
    ratios = [t["bars_in_profit"] / t["bars_held"] for t in group if t["bars_held"]]
    out["profit_time_pct"] = sum(ratios) / len(ratios) if ratios else None
    return out


def _bar_dynamics(trades: list[dict]) -> dict:
    """Winners-vs-losers averages of the per-trade bar-count dynamics. A trade
    is eligible only if it carries bar stats (older runs predate the fields and
    are skipped); when nothing is eligible both groups are all-None and the
    client hides the section."""
    eligible = [t for t in trades if t.get("bars_held") is not None]
    winners = [t for t in eligible if t["pnl"] > 0]
    losers = [t for t in eligible if t["pnl"] < 0]
    return {
        "n_winners": len(winners),
        "n_losers": len(losers),
        "winners": _avg_bar_metrics(winners),
        "losers": _avg_bar_metrics(losers),
    }
```

Then add to the `compute_analysis` return dict, after the `"month_stats": _month_stats(trades),` line:

```python
        "month_stats": _month_stats(trades),
        "bar_dynamics": _bar_dynamics(trades),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_analysis.py -v`
Expected: PASS (the three new bar-dynamics tests plus all pre-existing analysis tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/analysis.py backend/tests/test_analysis.py
git commit -m "feat(analysis): winners-vs-losers bar dynamics aggregation"
```

---

### Task 4: Frontend "Bar dynamics" section

**Files:**
- Modify: `frontend/src/api.ts` (add `bar_dynamics` + `BarDynamicsMetrics` types to `BacktestAnalysis`)
- Modify: `frontend/src/BacktestAnalysisPanel.tsx` (add `barSeconds` prop, `fmtDuration`, the Bar dynamics table + section on the Placement tab)
- Modify: `frontend/src/BacktestPanel.tsx` (pass `barSeconds={resSeconds}` into `BacktestAnalysisPanel`)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `analysis.bar_dynamics` from Task 3 (`{n_winners, n_losers, winners, losers}`, each metric `number | null`); `resSeconds` already computed in `BacktestPanel.tsx:186`.
- Produces: no new exported symbol; renders the section inline on the Placement sub-tab.

- [ ] **Step 1: Add the types to `api.ts`**

In `frontend/src/api.ts`, above `interface BacktestAnalysis`, add:

```ts
export interface BarDynamicsMetrics {
  bars_held: number | null;
  bars_in_profit: number | null;
  bars_in_loss: number | null;
  body_through: number | null;
  wick_from_profit: number | null;
  wick_from_loss: number | null;
  longest_profit_streak: number | null;
  longest_loss_streak: number | null;
  bars_to_mfe: number | null;
  bars_to_mae: number | null;
  entry_crossings: number | null;
  profit_time_pct: number | null;
}
```

Then inside `interface BacktestAnalysis`, add (near `hour_stats` / `month_stats`):

```ts
  bar_dynamics?: {
    n_winners: number;
    n_losers: number;
    winners: BarDynamicsMetrics;
    losers: BarDynamicsMetrics;
  };
```

- [ ] **Step 2: Write the failing tests**

In `frontend/src/BacktestAnalysisPanel.test.tsx`, the module-level `analysis` literal, the `showTab` helper (`"Placement" | "What-if" | "Context"`), `render`, and `screen` are already in scope. The Bar dynamics section lives on the Placement tab, which is the default tab, so no `showTab` call is needed for it (but calling `showTab("Placement")` is harmless). Add:

```tsx
  describe("Bar dynamics section", () => {
    const metrics = (o: Partial<Record<string, number | null>> = {}) => ({
      bars_held: 10, bars_in_profit: 6, bars_in_loss: 4, body_through: 1,
      wick_from_profit: 2, wick_from_loss: 1, longest_profit_streak: 3,
      longest_loss_streak: 2, bars_to_mfe: 5, bars_to_mae: 3,
      entry_crossings: 2, profit_time_pct: 0.6, ...o,
    });

    it("renders metric rows with a duration when bar_dynamics has trades", () => {
      const bd = { n_winners: 3, n_losers: 2, winners: metrics(), losers: metrics() };
      render(<BacktestAnalysisPanel analysis={{ ...analysis, bar_dynamics: bd }} barSeconds={60} />);
      expect(screen.getByText("Bar dynamics")).toBeTruthy();
      expect(screen.getByText(/Bars held/i)).toBeTruthy();
      // 10 bars at 60s/bar = 600s = 10m; duration string appears in a cell.
      expect(screen.getAllByText(/10m/).length).toBeGreaterThan(0);
    });

    it("is hidden when no eligible trades", () => {
      const bd = {
        n_winners: 0, n_losers: 0,
        winners: metrics(Object.fromEntries(Object.keys(metrics()).map((k) => [k, null]))),
        losers: metrics(Object.fromEntries(Object.keys(metrics()).map((k) => [k, null]))),
      };
      render(<BacktestAnalysisPanel analysis={{ ...analysis, bar_dynamics: bd }} barSeconds={60} />);
      expect(screen.queryByText("Bar dynamics")).toBeNull();
    });

    it("is hidden when bar_dynamics is absent", () => {
      render(<BacktestAnalysisPanel analysis={analysis} barSeconds={60} />);
      expect(screen.queryByText("Bar dynamics")).toBeNull();
    });
  });
```

- [ ] **Step 2b: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx -t "Bar dynamics"`
Expected: FAIL (`getByText("Bar dynamics")` throws; the prop `barSeconds` and the section do not exist yet).

- [ ] **Step 3: Add `barSeconds` prop and `fmtDuration`**

In `frontend/src/BacktestAnalysisPanel.tsx`, extend the component signature (~line 398). The current signature is:

```tsx
export default function BacktestAnalysisPanel({
  analysis,
}: {
  analysis: BacktestAnalysis | null | undefined;
```

Change it to also accept `barSeconds`:

```tsx
export default function BacktestAnalysisPanel({
  analysis,
  barSeconds = 60,
}: {
  analysis: BacktestAnalysis | null | undefined;
  barSeconds?: number;
```

(Leave the rest of the destructured props/type body unchanged.)

Near the other top-level helper functions in the file (for example next to `fmtPct`), add:

```tsx
// Compact wall-clock duration for a bar count at the run's bar interval.
function fmtDuration(bars: number, barSeconds: number): string {
  const s = Math.round(bars * barSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
```

- [ ] **Step 4: Add the Bar dynamics table component and metric config**

Still in `frontend/src/BacktestAnalysisPanel.tsx`, add a metric config and a small table component near `RowsTable`:

```tsx
type BarMetricKind = "duration" | "pct" | "count";
const BAR_DYNAMICS_METRICS: { key: keyof BarDynamicsMetrics; label: string; kind: BarMetricKind }[] = [
  { key: "bars_held", label: "Bars held", kind: "duration" },
  { key: "bars_in_profit", label: "Bars in profit", kind: "duration" },
  { key: "bars_in_loss", label: "Bars in loss", kind: "duration" },
  { key: "profit_time_pct", label: "Time in profit", kind: "pct" },
  { key: "longest_profit_streak", label: "Longest profit streak", kind: "duration" },
  { key: "longest_loss_streak", label: "Longest loss streak", kind: "duration" },
  { key: "bars_to_mfe", label: "Bars to peak (MFE)", kind: "duration" },
  { key: "bars_to_mae", label: "Bars to worst (MAE)", kind: "duration" },
  { key: "body_through", label: "Body through entry", kind: "duration" },
  { key: "wick_from_profit", label: "Wicked in from profit", kind: "duration" },
  { key: "wick_from_loss", label: "Wicked in from loss", kind: "duration" },
  { key: "entry_crossings", label: "Entry crossings", kind: "count" },
];

function fmtBarMetric(v: number | null, kind: BarMetricKind, barSeconds: number): string {
  if (v == null) return "n/a";
  if (kind === "pct") return fmtPct(v);
  if (kind === "count") return v.toFixed(1);
  return `${v.toFixed(1)} bars (${fmtDuration(v, barSeconds)})`;
}

function BarDynamicsTable({
  winners,
  losers,
  barSeconds,
}: {
  winners: BarDynamicsMetrics;
  losers: BarDynamicsMetrics;
  barSeconds: number;
}) {
  return (
    <table className="bt-analysis-table bt-bardyn-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th>Winners</th>
          <th>Losers</th>
        </tr>
      </thead>
      <tbody>
        {BAR_DYNAMICS_METRICS.map(({ key, label, kind }) => (
          <tr key={key}>
            <td>{label}</td>
            <td>{fmtBarMetric(winners[key], kind, barSeconds)}</td>
            <td>{fmtBarMetric(losers[key], kind, barSeconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Import `BarDynamicsMetrics` in the existing type import from `./api` at the top of the file (the line currently importing `AnalysisHist, AnalysisRow, BacktestAnalysis, BacktestWhatif`): add `BarDynamicsMetrics` to that import list.

- [ ] **Step 5: Render the section on the Placement tab**

In the Placement tab block (`{active === "placement" && ( ... )}`, starting ~line 484), after the existing placement sections and before the block closes, add a new section. Locate the end of the Placement tab content (the closing of the last placement `<section>` / `<Dist .../>` group inside the `active === "placement"` conditional) and insert:

```tsx
        {analysis.bar_dynamics &&
          analysis.bar_dynamics.n_winners + analysis.bar_dynamics.n_losers > 0 && (
            <section className="bt-analysis-section">
              <SectionH4
                slug="bar-dynamics"
                open={!collapsed.has("bar-dynamics")}
                onToggle={toggleSection}
              >
                Bar dynamics
              </SectionH4>
              {!collapsed.has("bar-dynamics") && (
                <BarDynamicsTable
                  winners={analysis.bar_dynamics.winners}
                  losers={analysis.bar_dynamics.losers}
                  barSeconds={barSeconds}
                />
              )}
            </section>
          )}
```

Note: `analysis` is guaranteed non-null inside the render body (the component early-returns on null/undefined analysis before this point, same as every other section that reads `analysis.*`). Confirm this by checking the early return near the top of the render; if the early return is present, `analysis.bar_dynamics` is safe.

- [ ] **Step 6: Pass `barSeconds` from `BacktestPanel`**

In `frontend/src/BacktestPanel.tsx`, the render at line ~248 is `<BacktestAnalysisPanel analysis={result?.analysis} />`. `resSeconds` is computed at line ~186 in the same component scope. Change the call to:

```tsx
          <BacktestAnalysisPanel analysis={result?.analysis} barSeconds={resSeconds} />
```

Confirm `resSeconds` is in scope at line 248 (it is defined at line ~186 in the same function body). If line 248 is inside a different scope where `resSeconds` is not visible, compute it inline there from `RESOLUTION_SECONDS[result.resolution] ?? 60` using the same `RESOLUTION_SECONDS` import already used at line 186.

- [ ] **Step 7: Run the frontend tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: PASS (the three new Bar dynamics tests plus all pre-existing tests in the file).

- [ ] **Step 8: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: zero new errors (pre-existing errors, if any, unchanged).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): Bar dynamics section in the Placement tab"
```

---

## Notes for the executor

- Tasks are ordered by dependency: Task 1 (`BarStats`) is pure and standalone; Task 2 wires it through the engine and DTO; Task 3 aggregates the persisted fields; Task 4 renders. Each has an independently testable deliverable.
- The run-store recompute path (`compute_analysis(rec["trades"])`) picks up `bar_dynamics` automatically for stored runs on their next read; runs stored before this feature lack the per-trade fields and are excluded by the eligibility filter (`bars_held` present), so their Bar dynamics section is simply hidden.
- Styling: `bt-bardyn-table` reuses the existing `bt-analysis-table` class for base styling; no new CSS is required for a functional table. If the columns need width tweaks, that is a follow-up, not part of this plan.
