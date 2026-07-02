# Backtest Hedging (long + short simultaneously) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a backtest strategy hold a long and a short position on the same instrument at the same time, driven by four independent rule groups (long entry/exit, short entry/exit).

**Architecture:** The backtest engine currently tracks one signed position and the strategy returns one signal per bar. This plan splits that into two independent position buckets (long, short) and lets the strategy return a *list* of signals per bar, so a long exit and a short entry can both fire on the same bar without one being dropped. A `leg` field on each signal/trade disambiguates which bucket a buy/sell acts on. The frontend rule schema grows from two groups to four, surfaced behind Long/Short tabs in the settings modal.

**Tech Stack:** Python (FastAPI, pytest, dataclasses) backend; TypeScript/React (Vitest) frontend; klinecharts for chart markers.

## Global Constraints

- **Full hedging:** long and short positions are independent buckets held simultaneously; a "SELL leg=long" only ever reduces the long bucket, never opens a short.
- **Leg semantics (the disambiguation contract):** `leg=long`+`BUY` = open/add long; `leg=long`+`SELL` = reduce/close long; `leg=short`+`SELL` = open/add short; `leg=short`+`BUY` = reduce/close short.
- **Four rule groups, exact names:** `longEntry`, `longExit`, `shortEntry`, `shortExit` (frontend camelCase and backend request DTO field names match exactly).
- **`tradeFromTime` gates BOTH entry legs** (long entry and short entry); exits are never gated (no position can exist before the window to close).
- **Shared quantity:** one `costs.quantity` applies to both long and short opens.
- **Old presets reset, no migration:** frontend persistence keys bump to `.v2`; a saved long-only config (old shape) is simply never read, so the modal falls back to `defaultBacktestConfig()`.
- **Chart markers:** color by side (BUY = green `#26a69a`, SELL = red `#ef5350`); label carries open/close via suffix — `B+`/`S+` = opening a position, `S-`/`B-` = closing. So open-long=`B+`(green), close-long=`S-`(red), open-short=`S+`(red), close-short=`B-`(green).
- **Long/Short tabs** in the settings modal; each tab shows that side's entry+exit groups. Time range, History depth, Costs, Presets stay shared (not per-side).
- **Engine does no indicator math** (unchanged): the frontend posts candles + precomputed series; D1 (post candles, no re-fetch) and D6 (indicators warm on history before `tradeFromTime`, response trimmed to window) are preserved.
- **`seriesName` contract unchanged** — indicators keyed `EMA_9` etc.; `collectSeriesOperands` now walks all four groups.
- **Delete `backend/auto_trader/strategy/sma_cross.py`** — dead code (only reads the removed `ctx.position`, returns a single signal); nothing imports it.
- **Verification commands:**
  - Backend: `cd backend && .venv/bin/python -m pytest`
  - Frontend tests: `cd frontend && npx vitest run`
  - Frontend types: `cd frontend && npx tsc -b` — NOTE `tsc --noEmit` is a no-op in this repo (root tsconfig has `files: []`); `tsc -b` is the real check. It reports 3 PRE-EXISTING errors NOT from this feature (in `src/lib/overlays.test.ts`, `src/lib/persist.test.ts`, `src/lib/positionLines.test.ts`); a task passes if it introduces NO new errors in files it touched.
  - Frontend lint: `cd frontend && npx eslint <changed files>`
- **Base commit:** `9913867` (long-only backtest feature). Local commits on main, do NOT push.

---

### Task 1: Domain model — leg-aware Signal/Trade + dual-position Context + list-returning on_bar

**Files:**
- Modify: `backend/auto_trader/core/models.py` (Signal, Trade dataclasses)
- Modify: `backend/auto_trader/strategy/base.py` (Context, Strategy.on_bar)
- Delete: `backend/auto_trader/strategy/sma_cross.py`
- Test: `backend/tests/test_models_leg.py` (new)

**Interfaces:**
- Produces: `Signal(side, quantity, reason="", leg="long")` where `leg: str` ∈ {"long","short"}; `Trade(..., leg="long")`; `Context.position_long: float`, `Context.position_short: float` (replacing `Context.position`); `Strategy.on_bar(ctx) -> list[Signal]`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_models_leg.py`:

```python
"""leg field on Signal/Trade and dual-position Context."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.core.models import Fill, Side, Signal, Trade
from auto_trader.strategy.base import Context


def test_signal_has_leg_defaulting_long():
    s = Signal(Side.BUY, 1.0, "enter")
    assert s.leg == "long"
    assert Signal(Side.SELL, 1.0, "short-open", leg="short").leg == "short"


def test_fill_has_leg_defaulting_long():
    t = datetime(2024, 1, 1, tzinfo=timezone.utc)
    assert Fill(t, Side.BUY, 10.0, 1.0, "enter").leg == "long"
    assert Fill(t, Side.SELL, 10.0, 1.0, "s", leg="short").leg == "short"


def test_trade_has_leg():
    t = datetime(2024, 1, 1, tzinfo=timezone.utc)
    trade = Trade(
        side=Side.BUY, quantity=1.0, entry_time=t, entry_price=10.0,
        exit_time=t, exit_price=12.0, pnl=2.0, leg="long",
    )
    assert trade.leg == "long"


def test_context_tracks_both_positions():
    ctx = Context()
    assert ctx.position_long == 0.0
    assert ctx.position_short == 0.0
    ctx.position_long = 5.0
    ctx.position_short = 3.0
    assert (ctx.position_long, ctx.position_short) == (5.0, 3.0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_models_leg.py -v`
Expected: FAIL — `Signal.__init__() got an unexpected keyword argument 'leg'` / `Context` has no `position_long`.

- [ ] **Step 3: Add `leg` to Signal, Fill, and Trade**

In `backend/auto_trader/core/models.py`, the `Signal` dataclass currently is:

```python
@dataclass(frozen=True, slots=True)
class Signal:
    """A strategy's intent at a given bar. quantity in instrument units."""

    side: Side
    quantity: float
    reason: str = ""
```

Change to:

```python
@dataclass(frozen=True, slots=True)
class Signal:
    """A strategy's intent at a given bar. quantity in instrument units.

    `leg` picks which position bucket the side acts on (hedging): leg="long"
    + BUY opens/adds long, leg="long" + SELL closes long; leg="short" + SELL
    opens/adds short, leg="short" + BUY closes short.
    """

    side: Side
    quantity: float
    reason: str = ""
    leg: str = "long"
```

The `Fill` dataclass currently is:

```python
@dataclass(slots=True)
class Fill:
    """A single executed order. Markers on the chart come from these."""

    time: datetime
    side: Side
    price: float
    quantity: float
    reason: str = ""
```

Add `leg` so chart markers can tell open-long from close-short:

```python
@dataclass(slots=True)
class Fill:
    """A single executed order. Markers on the chart come from these."""

    time: datetime
    side: Side
    price: float
    quantity: float
    reason: str = ""
    leg: str = "long"
```

The `Trade` dataclass currently ends with `reason_in`/`reason_out`:

```python
@dataclass(slots=True)
class Trade:
    """A completed round-trip (entry -> exit), produced by the engine."""

    side: Side
    quantity: float
    entry_time: datetime
    entry_price: float
    exit_time: datetime
    exit_price: float
    pnl: float
    reason_in: str = ""
    reason_out: str = ""
```

Add `leg: str = "long"` after `pnl` (before the reason defaults so it can be passed positionally by the engine, or keep as keyword — engine will pass it by keyword):

```python
@dataclass(slots=True)
class Trade:
    """A completed round-trip (entry -> exit), produced by the engine."""

    side: Side
    quantity: float
    entry_time: datetime
    entry_price: float
    exit_time: datetime
    exit_price: float
    pnl: float
    leg: str = "long"
    reason_in: str = ""
    reason_out: str = ""
```

- [ ] **Step 4: Update Context and Strategy.on_bar in base.py**

`backend/auto_trader/strategy/base.py` currently:

```python
class Context:
    def __init__(self) -> None:
        self.history: list[Candle] = []
        self.position: float = 0.0

    @property
    def bar(self) -> Candle:
        return self.history[-1]


class Strategy(ABC):
    """Override on_bar. Keep it pure: read ctx, return a Signal or None."""

    @abstractmethod
    def on_bar(self, ctx: Context) -> Signal | None:
        ...
```

Change the `position` field to two buckets and the return type to a list. Update the docstrings accordingly:

```python
class Context:
    """Read-only view the engine passes to the strategy at each bar.

    `position_long` / `position_short` are the current sizes held in each
    bucket (>= 0; a strategy can hold both at once — hedging). `history`
    holds all bars seen so far, inclusive of the current bar, oldest first.
    """

    def __init__(self) -> None:
        self.history: list[Candle] = []
        self.position_long: float = 0.0
        self.position_short: float = 0.0

    @property
    def bar(self) -> Candle:
        return self.history[-1]


class Strategy(ABC):
    """Override on_bar. Keep it pure: read ctx, return a list of Signals
    (0, 1, or 2 — e.g. a long exit and a short entry can fire on one bar)."""

    @abstractmethod
    def on_bar(self, ctx: Context) -> list[Signal]:
        ...
```

- [ ] **Step 5: Delete the dead sma_cross strategy**

Run: `cd backend && rm auto_trader/strategy/sma_cross.py`

(Nothing imports it — the GET endpoint that used it was already replaced by the rule-driven POST endpoint. Confirm with `grep -rn "sma_cross\|SmaCross" auto_trader tests` → no matches.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_models_leg.py -v`
Expected: PASS (3 tests).

Note: the full suite will NOT pass yet — `backtest.py` and `rule.py` still use the old `Context.position` / single-signal `on_bar` and are fixed in Tasks 2-3. That is expected mid-refactor.

- [ ] **Step 7: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/core/models.py backend/auto_trader/strategy/base.py backend/tests/test_models_leg.py
git rm backend/auto_trader/strategy/sma_cross.py
git commit -m "feat(backtest): leg-aware Signal/Trade + dual-position Context"
```

---

### Task 2: Engine — two independent position buckets + list-of-signals fills + hedged equity

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py` (rewrite `run()` and fill handling)
- Modify: `backend/tests/test_backtest.py` (update existing test-double strategies to return lists + dual-position context)
- Test: `backend/tests/test_backtest_hedging.py` (new)

**Interfaces:**
- Consumes: `Signal(side, quantity, reason, leg)`, `Trade(..., leg=...)`, `Context.position_long/position_short`, `Strategy.on_bar -> list[Signal]` (Task 1).
- Produces: `BacktestEngine.run(candles) -> BacktestResult` where `result.trades[i].leg` is set, and equity/net_pnl account for both buckets.

- [ ] **Step 1: Write the failing hedging test**

Create `backend/tests/test_backtest_hedging.py`:

```python
"""Engine hedging: independent long+short buckets, list-of-signals fills."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def _series(closes: list[float]) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [Candle(t0 + timedelta(minutes=i), c, c, c, c, 0.0) for i, c in enumerate(closes)]


def test_short_round_trip_profits_when_price_falls():
    # Open short at bar1 open (fills next open = 100), close at bar3 open (110->? we want profit on a DROP)
    class ShortFlip(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            n = len(ctx.history)
            if n == 1:
                return [Signal(Side.SELL, 1.0, "short-open", leg="short")]
            if n == 3:
                return [Signal(Side.BUY, 1.0, "short-close", leg="short")]
            return []

    # short opens at bar1 open=100, closes at bar3 open=90 -> short pnl = 100-90 = +10
    candles = _series([100, 100, 95, 90, 90])
    res = BacktestEngine(ShortFlip()).run(candles)
    assert len(res.trades) == 1
    assert res.trades[0].leg == "short"
    assert res.trades[0].side is Side.SELL  # short opened with a SELL
    assert res.trades[0].pnl == 10.0
    assert res.net_pnl == 10.0


def test_long_and_short_open_same_bar_both_fill_next_open():
    class Hedge(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            if len(ctx.history) == 1:
                return [
                    Signal(Side.BUY, 1.0, "long-open", leg="long"),
                    Signal(Side.SELL, 1.0, "short-open", leg="short"),
                ]
            return []

    candles = _series([10, 20, 20])
    res = BacktestEngine(Hedge()).run(candles)
    # both fill at bar1 open=20; long unrealized at last close 20 -> 0; short unrealized -> 0
    assert len(res.fills) == 2
    legs = {(f.side, f.reason) for f in res.fills}
    assert (Side.BUY, "long-open") in legs
    assert (Side.SELL, "short-open") in legs
    # ctx exposed both positions after the fills (long=1, short=1) with net_pnl 0 at flat prices
    assert res.net_pnl == 0.0


def test_net_pnl_sums_both_open_legs_at_end():
    # Long opened at 10 and never closed; short opened at 10 and never closed; last close 12.
    # long unrealized = 1*(12-10)=+2 ; short unrealized = 1*(10-12)=-2 ; net = 0
    class Hedge(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            if len(ctx.history) == 1:
                return [
                    Signal(Side.BUY, 1.0, "L", leg="long"),
                    Signal(Side.SELL, 1.0, "S", leg="short"),
                ]
            return []

    candles = _series([10, 10, 12])
    res = BacktestEngine(Hedge()).run(candles)
    assert res.trades == []  # neither leg closed
    assert res.net_pnl == 0.0
    assert res.net_pnl == res.equity[-1].equity - 10_000.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_backtest_hedging.py -v`
Expected: FAIL — engine still returns single-signal path / no `leg` on trades / `on_bar` treated as returning a Signal.

- [ ] **Step 3: Rewrite the engine run loop**

Replace the entire body of `run()` in `backend/auto_trader/engine/backtest.py` and remove the old `_apply` helper. The new `run()` (keep `_fill_price` as-is):

```python
    def run(self, candles: list[Candle]) -> BacktestResult:
        result = BacktestResult()
        ctx = Context()

        # Two independent buckets (hedging). Each holds a non-negative size, its
        # average entry price, and the open time/reason for trade records.
        long_qty = short_qty = 0.0
        long_entry = short_entry = 0.0
        long_time: datetime | None = None
        short_time: datetime | None = None
        long_reason = short_reason = ""
        realized = 0.0
        pending: list[Signal] = []  # signals from the previous bar, filled at this open

        peak_equity = self.starting_cash

        for i, bar in enumerate(candles):
            # 1) Fill everything queued on the previous bar at THIS bar's open.
            for sig in pending:
                fill_price = self._fill_price(bar.open, sig.side)
                result.fills.append(
                    Fill(bar.time, sig.side, fill_price, sig.quantity, sig.reason, sig.leg)
                )
                realized -= self.commission  # one side's commission per fill

                if sig.leg == "long":
                    if sig.side is Side.BUY:  # open / add long
                        new_qty = long_qty + sig.quantity
                        long_entry = (
                            (long_qty * long_entry + sig.quantity * fill_price) / new_qty
                            if new_qty
                            else 0.0
                        )
                        if long_qty == 0:
                            long_time, long_reason = bar.time, sig.reason
                        long_qty = new_qty
                    else:  # SELL -> close / reduce long
                        closing = min(sig.quantity, long_qty)
                        if closing > 0:
                            pnl = closing * (fill_price - long_entry)
                            realized += pnl
                            result.trades.append(
                                Trade(
                                    side=Side.BUY, quantity=closing,
                                    entry_time=long_time, entry_price=long_entry,  # type: ignore[arg-type]
                                    exit_time=bar.time, exit_price=fill_price, pnl=pnl,
                                    leg="long", reason_in=long_reason, reason_out=sig.reason,
                                )
                            )
                            long_qty -= closing
                            if long_qty == 0:
                                long_entry, long_time, long_reason = 0.0, None, ""
                else:  # short leg
                    if sig.side is Side.SELL:  # open / add short
                        new_qty = short_qty + sig.quantity
                        short_entry = (
                            (short_qty * short_entry + sig.quantity * fill_price) / new_qty
                            if new_qty
                            else 0.0
                        )
                        if short_qty == 0:
                            short_time, short_reason = bar.time, sig.reason
                        short_qty = new_qty
                    else:  # BUY -> close / reduce short
                        closing = min(sig.quantity, short_qty)
                        if closing > 0:
                            pnl = closing * (short_entry - fill_price)  # short profits on a drop
                            realized += pnl
                            result.trades.append(
                                Trade(
                                    side=Side.SELL, quantity=closing,
                                    entry_time=short_time, entry_price=short_entry,  # type: ignore[arg-type]
                                    exit_time=bar.time, exit_price=fill_price, pnl=pnl,
                                    leg="short", reason_in=short_reason, reason_out=sig.reason,
                                )
                            )
                            short_qty -= closing
                            if short_qty == 0:
                                short_entry, short_time, short_reason = 0.0, None, ""
            pending = []

            # 2) Mark-to-market both buckets on the close.
            long_unrealized = long_qty * (bar.close - long_entry) if long_qty else 0.0
            short_unrealized = short_qty * (short_entry - bar.close) if short_qty else 0.0
            equity = self.starting_cash + realized + long_unrealized + short_unrealized
            result.equity.append(EquityPoint(bar.time, equity))
            peak_equity = max(peak_equity, equity)
            result.max_drawdown = max(result.max_drawdown, peak_equity - equity)

            # 3) Let the strategy decide for the NEXT bar (no lookahead).
            ctx.history.append(bar)
            ctx.position_long = long_qty
            ctx.position_short = short_qty
            if i < len(candles) - 1:  # last bar has no next-open to fill on
                pending = list(self.strategy.on_bar(ctx))

        # Mark-to-market any still-open buckets at the last bar so net_pnl matches
        # the final equity point instead of reporting ~0 for a held position.
        if candles:
            last = candles[-1].close
            realized += long_qty * (last - long_entry) if long_qty else 0.0
            realized += short_qty * (short_entry - last) if short_qty else 0.0
        result.net_pnl = realized
        result.n_trades = len(result.trades)
        round_trip_cost = 2 * self.commission
        wins = sum(1 for t in result.trades if t.pnl > round_trip_cost)
        result.win_rate = wins / result.n_trades if result.n_trades else 0.0
        return result
```

Also delete the now-unused `_apply` method from the class (everything between `_fill_price` and the end of the class that was the old `_apply`).

- [ ] **Step 4: Update existing engine test doubles to the new interface**

`backend/tests/test_backtest.py` has strategies returning `Signal | None` and reading `ctx.history`/`len`. They must return lists now. Update each `on_bar` in that file: wrap returned signals in a list and return `[]` instead of `None`. The three classes are `BuyBar1`, `Flip` (appears twice), and `BuyLast`. For example `BuyBar1`:

```python
class BuyBar1(Strategy):
    """Buy 1 unit exactly once (on the second bar), then hold."""

    def __init__(self) -> None:
        self.fired = False

    def on_bar(self, ctx: Context) -> list[Signal]:
        if len(ctx.history) == 2 and not self.fired:
            self.fired = True
            return [Signal(Side.BUY, 1.0, "enter")]
        return []
```

And each `Flip`:

```python
    class Flip(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            n = len(ctx.history)
            if n == 1:
                return [Signal(Side.BUY, 1.0, "in")]
            if n == 3:
                return [Signal(Side.SELL, 1.0, "out")]
            return []
```

And `BuyLast`:

```python
    class BuyLast(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            if len(ctx.history) == 3:  # final bar
                return [Signal(Side.BUY, 1.0, "late")]
            return []
```

These are long trades (default `leg="long"`), so their expected fills/PnL/trades are unchanged — the existing assertions in `test_backtest.py` (fill price = next open, round-trip pnl, commission, net_pnl-includes-open-position, drop-last-bar-signal) must still pass verbatim against the new engine.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_backtest.py tests/test_backtest_hedging.py -v`
Expected: PASS — existing long-only engine tests unchanged in outcome; new hedging tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/engine/backtest.py backend/tests/test_backtest.py backend/tests/test_backtest_hedging.py
git commit -m "feat(backtest): engine tracks independent long+short buckets"
```

---

### Task 3: RuleStrategy — four rule groups, list-of-signals per bar

**Files:**
- Modify: `backend/auto_trader/strategy/rule.py` (RuleStrategy constructor + on_bar)
- Modify: `backend/tests/test_rule_strategy.py` (update construction + add short/hedge cases)

**Interfaces:**
- Consumes: `Signal(..., leg=...)`, `Context.position_long/position_short`, list-returning `on_bar` (Tasks 1-2).
- Produces: `RuleStrategy(long_entry, long_exit, short_entry, short_exit, series, quantity, trade_from_time=None)`.

- [ ] **Step 1: Write the failing test**

Update `backend/tests/test_rule_strategy.py`. The existing helper functions (`_series`, `_ind`, `_price`, `_const`) stay. Replace the strategy construction pattern throughout (it currently builds `RuleStrategy(entry, exit_, series, quantity=...)`) — add a small builder and new cases. Add these tests (and adjust existing ones to the new constructor, see Step 4):

```python
def _rule(left, op, right):
    return Rule(left, op, right)


def test_short_entry_sells_to_open_and_exit_buys_to_close():
    candles = _series([10, 10, 10, 10, 10, 10])
    series = {
        "EMA_5": [1.0, 1.0, 3.0, 3.0, 1.0, 1.0],
        "EMA_9": [2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
    }
    # short entry when EMA5 crosses BELOW EMA9 (i=1->2? here 3->1 at i=4); exit on cross above
    short_entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "crossesBelow", _ind("EMA", 9))])
    short_exit = RuleGroup("AND", [_rule(_ind("EMA", 5), "crossesAbove", _ind("EMA", 9))])
    strat = RuleStrategy(
        RuleGroup("AND", []), RuleGroup("AND", []), short_entry, short_exit,
        series, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    assert any(f.side is Side.SELL for f in result.fills)  # short opened with a SELL
    assert all(t.leg == "short" for t in result.trades)


def test_long_and_short_entry_fire_same_bar():
    candles = _series([10] * 4)
    series = {"EMA_5": [3.0, 3.0, 3.0, 3.0], "EMA_9": [2.0, 2.0, 2.0, 2.0]}
    long_entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "gt", _ind("EMA", 9))])
    short_entry = RuleGroup("AND", [_rule(_ind("EMA", 5), "gt", _ind("EMA", 9))])
    strat = RuleStrategy(
        long_entry, RuleGroup("AND", []), short_entry, RuleGroup("AND", []),
        series, quantity=1.0,
    )
    result = BacktestEngine(strat).run(candles)
    # first tradeable bar i=0 true -> both fill at i=1 open
    sides = sorted(f.side.value for f in result.fills[:2])
    assert sides == ["buy", "sell"]


def test_trade_from_time_gates_both_entries():
    candles = _series([10] * 5)
    always = RuleGroup("AND", [_rule(_const(1), "gt", _const(0))])
    strat = RuleStrategy(
        always, RuleGroup("AND", []), always, RuleGroup("AND", []),
        {}, quantity=1.0, trade_from_time=int(candles[2].time.timestamp()),
    )
    result = BacktestEngine(strat).run(candles)
    # both entries gated until bar i=2 -> first fills at i=3 open, none earlier
    assert result.fills
    assert min(f.time for f in result.fills) == candles[3].time
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_rule_strategy.py -v`
Expected: FAIL — `RuleStrategy.__init__()` takes the old `(entry, exit, ...)` shape.

- [ ] **Step 3: Rewrite RuleStrategy constructor and on_bar**

In `backend/auto_trader/strategy/rule.py`, replace the `RuleStrategy` class docstring, `__init__`, and `on_bar` (keep `_eval_group`, `_eval_rule`, `_operand_values`, `_reason` exactly as they are):

```python
class RuleStrategy(Strategy):
    """Hedging rule strategy: four independent rule groups drive two buckets.

    Long: `long_entry` opens (BUY leg=long) when flat-long, `long_exit` closes
    (SELL leg=long) when long. Short: `short_entry` opens (SELL leg=short) when
    flat-short, `short_exit` closes (BUY leg=short) when short. Long and short
    are independent — the strategy can hold both at once.

    `trade_from_time` (unix seconds, optional) gates BOTH entry legs (D6): bars
    before it are history loaded purely to warm the series up. Exits are never
    gated — no bucket can hold anything there, since no entry could have fired.
    """

    def __init__(
        self,
        long_entry: RuleGroup,
        long_exit: RuleGroup,
        short_entry: RuleGroup,
        short_exit: RuleGroup,
        series: dict[str, list[float | None]],
        quantity: float,
        trade_from_time: int | None = None,
    ) -> None:
        self.long_entry = long_entry
        self.long_exit = long_exit
        self.short_entry = short_entry
        self.short_exit = short_exit
        self.series = series
        self.quantity = quantity
        self.trade_from_time = trade_from_time

    def on_bar(self, ctx: Context) -> list[Signal]:
        i = len(ctx.history) - 1
        gated = (
            self.trade_from_time is not None
            and ctx.bar.time.timestamp() < self.trade_from_time
        )
        signals: list[Signal] = []

        # Long bucket.
        if ctx.position_long == 0:
            if not gated:
                passed, results = self._eval_group(self.long_entry, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.BUY, self.quantity, self._reason(self.long_entry, results), leg="long")
                    )
        else:
            passed, results = self._eval_group(self.long_exit, ctx, i)
            if passed:
                signals.append(
                    Signal(Side.SELL, ctx.position_long, self._reason(self.long_exit, results), leg="long")
                )

        # Short bucket.
        if ctx.position_short == 0:
            if not gated:
                passed, results = self._eval_group(self.short_entry, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.SELL, self.quantity, self._reason(self.short_entry, results), leg="short")
                    )
        else:
            passed, results = self._eval_group(self.short_exit, ctx, i)
            if passed:
                signals.append(
                    Signal(Side.BUY, ctx.position_short, self._reason(self.short_exit, results), leg="short")
                )

        return signals
```

- [ ] **Step 4: Update the existing long-only tests to the new constructor**

The existing tests in `test_rule_strategy.py` build `RuleStrategy(entry, exit_, series, quantity=1.0)`. Each must become `RuleStrategy(entry, exit_, RuleGroup("AND", []), RuleGroup("AND", []), series, quantity=1.0)` (long groups filled, short groups empty), and their assertions stay identical (long-only behavior is unchanged). Update every `RuleStrategy(` call site in the file this way. The `test_series_name_contract` test is unaffected.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_rule_strategy.py -v`
Expected: PASS — long-only cases unchanged, new short/hedge/gate cases pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/strategy/rule.py backend/tests/test_rule_strategy.py
git commit -m "feat(backtest): RuleStrategy drives four rule groups (long+short)"
```

---

### Task 4: API — four request groups + leg in the response

**Files:**
- Modify: `backend/auto_trader/api/app.py` (BacktestRequest, MarkerDTO, TradeDTO, backtest handler)
- Modify: `backend/tests/test_api_backtest.py`

**Interfaces:**
- Consumes: `RuleStrategy(long_entry, long_exit, short_entry, short_exit, ...)` (Task 3).
- Produces: `BacktestRequest{..., longEntry, longExit, shortEntry, shortExit, ...}`; `MarkerDTO.leg`, `TradeDTO.leg`.

- [ ] **Step 1: Write the failing test**

In `backend/tests/test_api_backtest.py`, the `_run` helper and existing tests build a body with `entry`/`exit`. Update the body shape everywhere to the four groups and add leg assertions. Add this new test and update `_body`/existing tests (Step 4):

```python
def _groups(long_entry=None, long_exit=None, short_entry=None, short_exit=None):
    empty = {"combine": "AND", "rules": []}
    return {
        "longEntry": long_entry or empty,
        "longExit": long_exit or empty,
        "shortEntry": short_entry or empty,
        "shortExit": short_exit or empty,
    }


def test_post_backtest_short_config_produces_short_trades_with_leg():
    candles = _candles([10, 10, 10, 10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {"EMA_5": [1.0, 1.0, 3.0, 3.0, 1.0, 1.0], "EMA_9": [2.0] * 6},
        **_groups(
            short_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesBelow", "right": _ind("EMA", 9)}]},
            short_exit={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)
    assert result.markers
    assert all(m.leg in ("long", "short") for m in result.markers)
    assert any(m.leg == "short" for m in result.markers)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_backtest.py -v`
Expected: FAIL — `BacktestRequest` has no `longEntry`; `MarkerDTO` has no `leg`.

- [ ] **Step 3: Update the DTOs and handler in app.py**

`BacktestRequest` currently has `entry: RuleGroupDTO` and `exit: RuleGroupDTO`. Replace with four fields:

```python
class BacktestRequest(BaseModel):
    epic: str
    resolution: str
    candles: list[CandleDTO]
    series: dict[str, list[float | None]]
    longEntry: RuleGroupDTO
    longExit: RuleGroupDTO
    shortEntry: RuleGroupDTO
    shortExit: RuleGroupDTO
    costs: CostsDTO
    tradeFromTime: int
```

`MarkerDTO` currently is `time/side/price/reason`; add `leg`:

```python
class MarkerDTO(BaseModel):
    time: int
    side: str
    price: float
    reason: str
    leg: str
```

`TradeDTO` — add `leg`:

```python
class TradeDTO(BaseModel):
    side: str
    quantity: float
    entry_time: int
    entry_price: float
    exit_time: int
    exit_price: float
    pnl: float
    leg: str
```

In the `backtest` handler, the series-name validation loop currently iterates `for group in (req.entry, req.exit):`. Change to all four:

```python
    for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
        for op in group.operands():
            name = series_name(op.to_operand())
            if name is not None and name not in req.series:
                raise HTTPException(422, f"missing series '{name}' referenced by a rule")
```

The strategy construction currently is `RuleStrategy(req.entry.to_group(), req.exit.to_group(), req.series, quantity=..., trade_from_time=...)`. Change to:

```python
    strategy = RuleStrategy(
        req.longEntry.to_group(), req.longExit.to_group(),
        req.shortEntry.to_group(), req.shortExit.to_group(),
        req.series, quantity=req.costs.quantity, trade_from_time=req.tradeFromTime,
    )
```

The markers comprehension currently builds `MarkerDTO(time=..., side=..., price=..., reason=...)`. Add `leg=f.leg` (`Fill.leg` was added in Task 1 and set by the engine in Task 2):

```python
        markers=[
            MarkerDTO(time=_ts(f.time), side=f.side.value, price=f.price, reason=f.reason, leg=f.leg)
            for f in result.fills
        ],
```

The trades comprehension adds `leg=t.leg`:

```python
        trades=[
            TradeDTO(
                side=t.side.value, quantity=t.quantity,
                entry_time=_ts(t.entry_time), entry_price=t.entry_price,
                exit_time=_ts(t.exit_time), exit_price=t.exit_price, pnl=t.pnl, leg=t.leg,
            )
            for t in result.trades
        ],
```

- [ ] **Step 4: Update existing api tests to the four-group body**

Every existing test in `test_api_backtest.py` that builds a body with `"entry": {...}, "exit": {...}` must switch to the four-group shape via `**_groups(...)`. The long-entry ones move their rules into `long_entry=`, empties stay empty. The 422 tests (empty candles, series length mismatch, missing series name, invalid costs, price-operand-missing-field, indicator-missing-indicator) keep their intent — put the offending rule under `long_entry` (or wherever it was). The trim-to-tradeFromTime test uses all-empty groups.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_backtest.py -v`
Expected: PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: all green (Task 1-4 backend work complete).

- [ ] **Step 7: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/api/app.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): API carries four rule groups + trade/marker leg"
```

---

### Task 5: Frontend config schema — four groups + preset reset

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (BacktestConfig, defaultBacktestConfig, collectSeriesOperands)
- Modify: `frontend/src/lib/persist.ts` (bump storage keys to `.v2`)
- Modify: `frontend/src/lib/backtestConfig.test.ts`

**Interfaces:**
- Produces: `BacktestConfig{ range, longEntry, longExit, shortEntry, shortExit, costs }`; `collectSeriesOperands`/`longestIndicatorLength` walk all four groups; `loadBacktestPresets`/`loadBacktestLastUsed` read `.v2` keys.

- [ ] **Step 1: Write the failing test**

In `frontend/src/lib/backtestConfig.test.ts`, the `collectSeriesOperands` and `defaultBacktestConfig` tests currently reference `.entry`/`.exit`. Update them and add a four-group dedupe test. Replace the `defaultBacktestConfig` describe block's assertions and the `collectSeriesOperands` config objects to the four-group shape, e.g.:

```typescript
describe("defaultBacktestConfig", () => {
  it("has four populated groups: long entry/exit + short entry/exit (mirror)", () => {
    const cfg = defaultBacktestConfig();
    expect(cfg.range).toEqual({ mode: "bars", bars: 500, history: "full" });
    expect(cfg.longEntry.rules[0].op).toBe("crossesAbove");
    expect(cfg.longExit.rules[0].op).toBe("crossesBelow");
    expect(cfg.shortEntry.rules[0].op).toBe("crossesBelow"); // mirror of long entry
    expect(cfg.shortExit.rules[0].op).toBe("crossesAbove");
  });
});
```

For `collectSeriesOperands`, change any config literal to include the four groups (put the tested rules under `longEntry`/`shortEntry`, empties elsewhere) and assert dedupe still holds across all four.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts`
Expected: FAIL — `defaultBacktestConfig().longEntry` undefined.

- [ ] **Step 3: Update the schema and helpers**

In `frontend/src/lib/backtestConfig.ts`, the `BacktestConfig` interface currently is:

```typescript
export interface BacktestConfig {
  range: RangeConfig;
  entry: RuleGroup;
  exit: RuleGroup;
  costs: Costs;
}
```

Change to:

```typescript
export interface BacktestConfig {
  range: RangeConfig;
  longEntry: RuleGroup;
  longExit: RuleGroup;
  shortEntry: RuleGroup;
  shortExit: RuleGroup;
  costs: Costs;
}
```

`collectSeriesOperands` currently loops `for (const group of [cfg.entry, cfg.exit])`. Change to:

```typescript
  for (const group of [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit]) {
```

`longestIndicatorLength` calls `collectSeriesOperands` so it needs no change.

`defaultBacktestConfig` currently returns `{ range, entry, exit, costs }`. Replace with the four-group mirror:

```typescript
export function defaultBacktestConfig(): BacktestConfig {
  const cross = (op: Operator): RuleGroup => ({
    combine: "AND",
    rules: [
      {
        left: { kind: "indicator", indicator: "EMA", length: 9 },
        op,
        right: { kind: "indicator", indicator: "EMA", length: 21 },
      },
    ],
  });
  return {
    range: { mode: "bars", bars: 500, history: "full" },
    longEntry: cross("crossesAbove"),
    longExit: cross("crossesBelow"),
    shortEntry: cross("crossesBelow"),
    shortExit: cross("crossesAbove"),
    costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
  };
}
```

- [ ] **Step 4: Bump the persistence keys so old presets reset**

In `frontend/src/lib/persist.ts`, the two keys are:

```typescript
const BACKTEST_PRESETS_KEY = `${PREFIX}.backtestPresets`;
const BACKTEST_LAST_USED_KEY = `${PREFIX}.backtestLastUsed`;
```

Change to `.v2` so any old long-only config is ignored (the modal falls back to `defaultBacktestConfig()`):

```typescript
// v2: config shape changed from entry/exit to four groups (hedging). Old keys
// are abandoned rather than migrated — a stale long-only config would be missing
// the short groups, so callers fall back to defaultBacktestConfig().
const BACKTEST_PRESETS_KEY = `${PREFIX}.backtestPresets.v2`;
const BACKTEST_LAST_USED_KEY = `${PREFIX}.backtestLastUsed.v2`;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestConfig.test.ts frontend/src/lib/persist.ts
git commit -m "feat(backtest): frontend config carries four rule groups; reset presets"
```

---

### Task 6: Frontend API types + leg-aware marker rendering

**Files:**
- Modify: `frontend/src/api.ts` (BacktestRequest, Marker, Trade types)
- Modify: `frontend/src/lib/backtest.ts` (marker label + a `markerLabel` helper)
- Test: `frontend/src/lib/backtestMarker.test.ts` (new)

**Interfaces:**
- Consumes: response markers/trades now carry `leg: "long" | "short"` (Task 4); `BacktestConfig` four groups (Task 5).
- Produces: `markerLabel(side, leg): string` (`"B+"|"S-"|"S+"|"B-"`); `runAndRender` renders it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/backtestMarker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { markerLabel } from "./backtest";

describe("markerLabel", () => {
  it("labels opens with + and closes with -, by leg", () => {
    expect(markerLabel("buy", "long")).toBe("B+");   // open long
    expect(markerLabel("sell", "long")).toBe("S-");  // close long
    expect(markerLabel("sell", "short")).toBe("S+"); // open short
    expect(markerLabel("buy", "short")).toBe("B-");  // close short
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestMarker.test.ts`
Expected: FAIL — `markerLabel` is not exported.

- [ ] **Step 3: Add the types and the marker helper**

In `frontend/src/api.ts`, the `Marker` and `Trade` interfaces gain `leg`, and `BacktestRequest` switches to four groups. `Marker`:

```typescript
interface Marker {
  time: number;
  side: "buy" | "sell";
  price: number;
  reason: string;
  leg: "long" | "short";
}
```

`Trade`:

```typescript
interface Trade {
  side: string;
  quantity: number;
  entry_time: number;
  entry_price: number;
  exit_time: number;
  exit_price: number;
  pnl: number;
  leg: "long" | "short";
}
```

`BacktestRequest` currently has `entry: RuleGroup; exit: RuleGroup;`. Replace with:

```typescript
export interface BacktestRequest {
  epic: string;
  resolution: string;
  candles: Candle[];
  series: Record<string, Array<number | null>>;
  longEntry: RuleGroup;
  longExit: RuleGroup;
  shortEntry: RuleGroup;
  shortExit: RuleGroup;
  costs: Costs;
  tradeFromTime: number;
}
```

In `frontend/src/lib/backtest.ts`, add the exported helper and use it. Opening a position = BUY on long / SELL on short; closing = the opposite. Add near the top (after the color consts):

```typescript
/** Chart marker label: "+" opens a position, "-" closes it; the letter is the
 * order side (B/S). open-long=B+, close-long=S-, open-short=S+, close-short=B-. */
export function markerLabel(side: "buy" | "sell", leg: "long" | "short"): string {
  const letter = side === "buy" ? "B" : "S";
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return `${letter}${opening ? "+" : "-"}`;
}
```

The marker-creation loop in `runAndRender` currently sets `extendData: m.side === "buy" ? "B" : "S"`. Change to `extendData: markerLabel(m.side, m.leg)`. The color stays `m.side === "buy" ? BUY_COLOR : SELL_COLOR` (unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestMarker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/api.ts frontend/src/lib/backtest.ts frontend/src/lib/backtestMarker.test.ts
git commit -m "feat(backtest): leg-labelled chart markers (B+/S-/S+/B-)"
```

---

### Task 7: Frontend settings modal — Long/Short tabs + four groups + button wiring

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (Long/Short tab state, four RuleGroupSections, leg-aware empty hints, usesVolume over four groups)
- Modify: `frontend/src/BacktestButton.tsx` (request payload uses four groups)
- Modify: `frontend/src/App.css` (tab strip styling)

**Interfaces:**
- Consumes: `BacktestConfig` four groups (Task 5); `BacktestRequest` four groups (Task 6).
- Produces: modal edits all four groups; `BacktestButton` posts them.

- [ ] **Step 1: Add the Long/Short tab + four groups to the modal**

In `frontend/src/BacktestSettingsModal.tsx`:

1. Add tab state near the other `useState`s:

```typescript
  const [side, setSide] = useState<"long" | "short">("long");
```

2. `setGroup` currently is `setCfg({ ...cfg, [which]: group })` with `which: "entry" | "exit"`. Change its type to the four keys:

```typescript
  function setGroup(which: "longEntry" | "longExit" | "shortEntry" | "shortExit", group: RuleGroup) {
    setCfg({ ...cfg, [which]: group });
  }
```

3. `usesVolume` currently walks `[cfg.entry, cfg.exit]`. Change to all four:

```typescript
  const usesVolume = [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit].some((g) =>
    g.rules.some((r) =>
      [r.left, r.right].some(
        (op) => op.kind === "indicator" && (op.indicator === "VOL" || op.indicator === "VOLMA" || op.indicator === "AVWAP"),
      ),
    ),
  );
```

4. Replace the two current `<RuleGroupSection ... group={cfg.entry} ...>` / `group={cfg.exit}` blocks with a tab strip + the active side's two groups:

```tsx
          <div className="bt-side-tabs seg">
            <button className={side === "long" ? "seg-on" : ""} onClick={() => setSide("long")}>Long</button>
            <button className={side === "short" ? "seg-on" : ""} onClick={() => setSide("short")}>Short</button>
          </div>
          {side === "long" ? (
            <>
              <RuleGroupSection
                title="Buy to open (long)"
                group={cfg.longEntry}
                onChange={(g) => setGroup("longEntry", g)}
                emptyHint="No long-entry rules — this strategy won't open any long positions."
              />
              <RuleGroupSection
                title="Sell to close (long)"
                group={cfg.longExit}
                onChange={(g) => setGroup("longExit", g)}
                emptyHint="No long-exit rules — an open long holds until the trading window ends."
              />
            </>
          ) : (
            <>
              <RuleGroupSection
                title="Sell to open (short)"
                group={cfg.shortEntry}
                onChange={(g) => setGroup("shortEntry", g)}
                emptyHint="No short-entry rules — this strategy won't open any short positions."
              />
              <RuleGroupSection
                title="Buy to close (short)"
                group={cfg.shortExit}
                onChange={(g) => setGroup("shortExit", g)}
                emptyHint="No short-exit rules — an open short holds until the trading window ends."
              />
            </>
          )}
```

- [ ] **Step 2: Wire the button's request payload**

In `frontend/src/BacktestButton.tsx`, the `runAndRender(chart, {...})` call currently passes `entry: cfg.entry, exit: cfg.exit`. Change those two lines to the four groups:

```typescript
        longEntry: cfg.longEntry,
        longExit: cfg.longExit,
        shortEntry: cfg.shortEntry,
        shortExit: cfg.shortExit,
```

(`buildSeries(bars, cfg)` is unchanged — it walks the config via `collectSeriesOperands`, which Task 5 updated to all four groups.)

- [ ] **Step 3: Style the side tabs**

In `frontend/src/App.css`, add after the `.bt-empty-rules` block:

```css
/* Long/Short side tabs inside the rule-builder — full-width segmented control
   so the two sides read as peers, sitting above that side's entry/exit groups. */
.bt-side-tabs { width: 100%; margin-top: 4px; }
.bt-side-tabs button { flex: 1; }
```

- [ ] **Step 4: Type-check and run the frontend suite**

Run: `cd frontend && npx tsc -b 2>&1 | grep -vE "overlays\.test|persist\.test|positionLines\.test" | grep "error TS" || echo "no new type errors"`
Expected: `no new type errors` (only the 3 pre-existing errors, which are filtered out).

Run: `cd frontend && npx vitest run`
Expected: all pass except the 1 known pre-existing `overlays.test.ts` hoverAlert flake.

Run: `cd frontend && npx eslint src/BacktestSettingsModal.tsx src/BacktestButton.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestButton.tsx frontend/src/App.css
git commit -m "feat(backtest): Long/Short tabs in settings modal + hedged run wiring"
```

---

### Task 8: Full verification + live smoke

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: all green.

- [ ] **Step 2: Full frontend suite + types + lint**

Run: `cd frontend && npx vitest run` → all pass except the known `overlays.test.ts` hoverAlert flake.
Run: `cd frontend && npx tsc -b 2>&1 | grep "error TS" | grep -vE "overlays\.test|persist\.test|positionLines\.test" || echo "no new type errors"` → `no new type errors`.
Run: `cd frontend && npx eslint src/BacktestSettingsModal.tsx src/BacktestButton.tsx src/lib/backtest.ts src/lib/backtestConfig.ts src/api.ts` → clean.

- [ ] **Step 2b: Live smoke (requires running app + browser — controller runs this, not a subagent)**

With the dev servers up, open the app, click ⚙ next to Backtest, and verify three configs on a symbol with history:
1. **Long-only** (default long groups, empty short): produces `B+`/`S-` markers (green/red), trades all `leg=long`.
2. **Short-only** (empty long, short entry = EMA9 crossesBelow EMA21 / exit crossesAbove): produces `S+`/`B-` markers, trades all `leg=short`.
3. **Hedged** (both sides populated): both marker families appear; summary chip aggregates across legs.
Also confirm: Long/Short tabs switch cleanly; empty-group hint shows per side; old presets are gone (Load dropdown empty on first open after the `.v2` bump).

- [ ] **Step 3: Update the SDD ledger and hand off to final review**

Append the final task line to the ledger, then dispatch the final whole-branch review (opus) over `9913867..HEAD`, and finish via superpowers:finishing-a-development-branch.

---

## Self-Review

- **Spec coverage:** full hedging (Tasks 1-3 engine/strategy), four groups exact names (Tasks 3-7), leg semantics (Task 1 contract, Tasks 2-3 fills), tradeFromTime gates both entries (Task 3 + test), shared quantity (Task 3 uses `req.costs.quantity` once), preset reset (Task 5 `.v2`), markers color+/-  (Task 6 helper + test), Long/Short tabs (Task 7), engine-does-no-indicator-math preserved (unchanged buildSeries), seriesName unchanged (Task 5 keeps it), delete sma_cross (Task 1). All covered.
- **Placeholder scan:** every code step has complete code; no TBD/TODO.
- **Type consistency:** `leg` is `str` ("long"/"short") backend, `"long" | "short"` frontend; four group names `longEntry/longExit/shortEntry/shortExit` identical across backend DTO, frontend config, api.ts, modal, button. `markerLabel(side, leg)` signature consistent between test and impl. `RuleStrategy(long_entry, long_exit, short_entry, short_exit, series, quantity, trade_from_time=None)` used identically in Task 3 impl, Task 3 tests, Task 4 handler.
- **Fill.leg dependency:** flagged explicitly in Task 4 Step 3 as a possible carry-over from Task 2; instructions cover adding it in either place.
