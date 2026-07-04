# Backtest position-list refactor (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the backtest engine's two scalar position buckets into a `list[Position]` per side, with zero observable change, as the foundation for multiple independent positions.

**Architecture:** Introduce a `Position` dataclass and move all per-position logic (open/add, reduce, intra-bar stop/target, trailing ratchet, mark-to-market) into per-side helper methods that iterate a `list[Position]`. `RuleStrategy` is untouched, so each side still holds at most one position and every result is identical. Later phases (P2+) change only *how many* positions the engine opens.

**Tech Stack:** Python 3, dataclasses, pytest. Engine file: `backend/auto_trader/engine/backtest.py`.

## Global Constraints

- **Invariant #1 — no observable change.** The full existing suite (329 backend tests, notably `test_backtest.py`, `test_backtest_hedging.py`, `test_rule_strategy.py`, `test_backtest_stops.py`, `test_api_backtest.py`) must pass **unchanged**. This refactor adds no config and no new behavior.
- `RuleStrategy` (`strategy/rule.py`) is **not modified** in P1.
- Engine does no indicator math — ATR is read from the posted `ATR_{length}` series via `_atr_at` (unchanged).
- Preserve every existing fill/trade/equity semantic exactly: fills at next bar's open; a BUY on an already-open side **merges** (weighted-average entry, keeps the original open time/reason, does **not** re-seed stop/target); a SELL **reduces** and books a `Trade`; stop/target/trailing conventions and the pessimistic/no-lookahead rules from the stops feature are unchanged.
- Use `.venv/bin/python -m pytest` (not bare `python`).
- Commit messages end with the two trailer lines used across this feature:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5`.

---

## File Structure

- Modify `backend/auto_trader/engine/backtest.py` — add `Position`; rewrite `run()` and the per-position helpers. No other file changes.
- The existing `test_backtest*.py` suites are the regression harness. One new tiny test documents the `Position` dataclass defaults.

The refactor is one interlocking rewrite of `run()`, so it is a single task: the existing suites are its test. A second task adds a focused structural test.

---

### Task 1: Refactor `run()` onto `list[Position]`

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py` (add `Position`; rewrite `run()` + helpers)
- Test (regression, unchanged): `backend/tests/test_backtest.py`, `test_backtest_hedging.py`, `test_rule_strategy.py`, `test_backtest_stops.py`, `test_api_backtest.py`

**Interfaces:**
- Consumes: `RiskConfig`, `is_trailing`, `stop_level`, `target_level` (from `engine/risk.py`); `Candle`, `Fill`, `Side`, `Signal`, `Trade` (from `core/models`).
- Produces: `Position` dataclass (fields below); engine per-side helpers `_open_or_add`, `_reduce`, `_intrabar_exit`, `_ratchet_trailing`, `_unrealized`. `BacktestEngine.__init__` signature and `run(candles) -> BacktestResult` are unchanged.

- [ ] **Step 1: Confirm the regression baseline is green before touching anything**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS (329 passed). Record the number — it must be identical after the refactor.

- [ ] **Step 2: Add the `Position` dataclass**

In `backend/auto_trader/engine/backtest.py`, after the `EquityPoint` dataclass (around line 30), add:

```python
@dataclass(slots=True)
class Position:
    """One open position on a side. For independent mode each entry is its own
    Position; for the current (single-bucket) behaviour a side holds at most one.
    `stop`/`target` are absolute levels (None = none); `extreme` is the favorable
    high/low water mark since entry (for trailing); `breakeven_armed` is reserved
    for a later phase and unused here."""
    qty: float
    entry: float
    open_time: datetime
    open_reason: str
    stop: float | None = None
    target: float | None = None
    extreme: float = 0.0
    breakeven_armed: bool = False
```

- [ ] **Step 3: Add per-side helper methods**

Add these methods to `BacktestEngine`, next to `_fill_price`/`_atr_at` (they replace the inline long/short duplication). `side` is `"long"` or `"short"`; `risk` is the side's `RiskConfig | None`; `positions` is that side's list.

```python
    def _open_or_add(self, positions, side, risk, fill_price, bar_time, reason, qty, i):
        """A BUY(long)/SELL(short) intent fill. With an existing open position on
        the side, MERGE (weighted-average entry, keep original open time/reason,
        levels unchanged) — matching today's single-bucket add. Otherwise open a
        new Position and seed its stop/target/extreme from the fill price."""
        if positions:
            p = positions[0]
            new_qty = p.qty + qty
            p.entry = (p.qty * p.entry + qty * fill_price) / new_qty if new_qty else 0.0
            p.qty = new_qty
            return
        p = Position(qty=qty, entry=fill_price, open_time=bar_time, open_reason=reason)
        if risk:
            p.extreme = fill_price
            p.stop = stop_level(risk.stop, fill_price, side, self._atr_at(risk.stop.length, i), p.extreme)
            p.target = target_level(risk.target, fill_price, side, self._atr_at(risk.target.length, i))
        positions.append(p)

    def _reduce(self, positions, side, result, realized, fill_price, bar_time, reason, qty):
        """A closing fill (SELL for long, BUY for short) of `qty` units against the
        side's open position; books a Trade and drops the position if flat. Returns
        the updated realized pnl."""
        if not positions:
            return realized
        p = positions[0]
        closing = min(qty, p.qty)
        if closing <= 0:
            return realized
        if side == "long":
            pnl = closing * (fill_price - p.entry)
            trade_side = Side.BUY
        else:
            pnl = closing * (p.entry - fill_price)
            trade_side = Side.SELL
        realized += pnl
        result.trades.append(
            Trade(
                side=trade_side, quantity=closing,
                entry_time=p.open_time, entry_price=p.entry,
                exit_time=bar_time, exit_price=fill_price, pnl=pnl,
                leg=side, reason_in=p.open_reason, reason_out=reason,
            )
        )
        p.qty -= closing
        if p.qty == 0:
            positions.pop(0)
        return realized

    def _intrabar_exit(self, positions, side, risk, result, realized, bar):
        """Pessimistic intra-bar stop/target for the side's open position (the
        open resolves the order when it gaps through the target). Books the exit
        and returns updated realized pnl. See the stops-feature design."""
        if not positions or not risk:
            return realized
        p = positions[0]
        hit = None
        if side == "long":
            if p.target is not None and bar.open >= p.target:
                hit = (self._fill_price(p.target, Side.SELL), "target")
            elif p.stop is not None and bar.low <= p.stop:
                raw = min(bar.open, p.stop)
                hit = (self._fill_price(raw, Side.SELL), "trail" if is_trailing(risk.stop) else "stop")
            elif p.target is not None and bar.high >= p.target:
                hit = (self._fill_price(p.target, Side.SELL), "target")
            close_side = Side.SELL
        else:
            if p.target is not None and bar.open <= p.target:
                hit = (self._fill_price(p.target, Side.BUY), "target")
            elif p.stop is not None and bar.high >= p.stop:
                raw = max(bar.open, p.stop)
                hit = (self._fill_price(raw, Side.BUY), "trail" if is_trailing(risk.stop) else "stop")
            elif p.target is not None and bar.low <= p.target:
                hit = (self._fill_price(p.target, Side.BUY), "target")
            close_side = Side.BUY
        if hit:
            px, reason = hit
            result.fills.append(Fill(bar.time, close_side, px, p.qty, reason, side))
            realized -= self.commission
            realized = self._reduce(positions, side, result, realized, px, bar.time, reason, p.qty)
        return realized

    def _ratchet_trailing(self, positions, side, risk, bar, i):
        """Extend the trailing extreme with THIS bar's high/low and recompute the
        stop for the NEXT bar — clamped so a trailing stop never loosens (and a
        cold ATR never wipes it)."""
        if not positions or not risk or not is_trailing(risk.stop):
            return
        p = positions[0]
        if side == "long":
            p.extreme = max(p.extreme, bar.high)
        else:
            p.extreme = min(p.extreme, bar.low)
        new_stop = stop_level(risk.stop, p.entry, side, self._atr_at(risk.stop.length, i), p.extreme)
        if new_stop is not None:
            if p.stop is None:
                p.stop = new_stop
            else:
                p.stop = max(p.stop, new_stop) if side == "long" else min(p.stop, new_stop)

    @staticmethod
    def _unrealized(positions, side, close):
        total = 0.0
        for p in positions:
            total += p.qty * (close - p.entry) if side == "long" else p.qty * (p.entry - close)
        return total
```

- [ ] **Step 4: Rewrite `run()` to drive the helpers**

Replace the entire `run` method body (the scalar-bucket bookkeeping, the fill loop, the intra-bar blocks, the mark-to-market, and the final settle) with this list-based version. `ctx.position_long`/`ctx.position_short` are still set to the total size on the side (so `RuleStrategy`'s flat-gate sees exactly what it does today).

```python
    def run(self, candles: list[Candle]) -> BacktestResult:
        result = BacktestResult()
        ctx = Context()

        longs: list[Position] = []
        shorts: list[Position] = []
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
                    if sig.side is Side.BUY:
                        self._open_or_add(longs, "long", self.long_risk, fill_price, bar.time, sig.reason, sig.quantity, i)
                    else:
                        realized = self._reduce(longs, "long", result, realized, fill_price, bar.time, sig.reason, sig.quantity)
                else:
                    if sig.side is Side.SELL:
                        self._open_or_add(shorts, "short", self.short_risk, fill_price, bar.time, sig.reason, sig.quantity, i)
                    else:
                        realized = self._reduce(shorts, "short", result, realized, fill_price, bar.time, sig.reason, sig.quantity)
            pending = []

            # 1b) Intra-bar stop/target, then 1c) trailing ratchet — per side.
            realized = self._intrabar_exit(longs, "long", self.long_risk, result, realized, bar)
            realized = self._intrabar_exit(shorts, "short", self.short_risk, result, realized, bar)
            self._ratchet_trailing(longs, "long", self.long_risk, bar, i)
            self._ratchet_trailing(shorts, "short", self.short_risk, bar, i)

            # 2) Mark-to-market on the close.
            equity = (
                self.starting_cash + realized
                + self._unrealized(longs, "long", bar.close)
                + self._unrealized(shorts, "short", bar.close)
            )
            result.equity.append(EquityPoint(bar.time, equity))
            peak_equity = max(peak_equity, equity)
            result.max_drawdown = max(result.max_drawdown, peak_equity - equity)

            # 3) Let the strategy decide for the NEXT bar (no lookahead).
            ctx.history.append(bar)
            ctx.position_long = sum(p.qty for p in longs)
            ctx.position_short = sum(p.qty for p in shorts)
            if i < len(candles) - 1:  # last bar has no next-open to fill on
                pending = list(self.strategy.on_bar(ctx))

        # Settle any still-open positions at the last close so net_pnl matches the
        # final equity point.
        if candles:
            last = candles[-1].close
            realized += self._unrealized(longs, "long", last)
            realized += self._unrealized(shorts, "short", last)
        result.net_pnl = realized
        result.n_trades = len(result.trades)
        round_trip_cost = 2 * self.commission
        wins = sum(1 for t in result.trades if t.pnl > round_trip_cost)
        result.win_rate = wins / result.n_trades if result.n_trades else 0.0
        return result
```

Then delete the now-unused `_close_long` and `_close_short` static methods (their logic moved into `_reduce`).

- [ ] **Step 5: Run the full suite — it must be byte-for-byte green**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS with the **same** count as Step 1 (329 passed). If any test fails, the refactor diverged from today's behaviour — fix the helper logic to match, do not edit the tests.

- [ ] **Step 6: Lint the changed file**

Run: `cd backend && .venv/bin/ruff check auto_trader/engine/backtest.py` (skip if ruff is not installed in the venv).
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/engine/backtest.py
git commit -m "refactor(backtest): store positions as a list[Position] per side

No behaviour change: RuleStrategy is untouched so each side still holds at
most one position. Per-position open/add/reduce/intra-bar/trailing/MTM logic
moved into side-parameterised helpers, replacing the duplicated long/short
scalar buckets — the foundation for multiple independent positions.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5"
```

---

### Task 2: Structural test for the `Position` dataclass

A tiny guard so later phases can rely on the defaults; the behaviour is already covered by the full regression suite.

**Files:**
- Test: `backend/tests/test_position.py` (create)

- [ ] **Step 1: Write the test**

```python
# backend/tests/test_position.py
from datetime import datetime, timezone

from auto_trader.engine.backtest import Position


def test_position_defaults():
    p = Position(qty=1.0, entry=100.0, open_time=datetime(2024, 1, 1, tzinfo=timezone.utc), open_reason="enter")
    assert p.stop is None and p.target is None
    assert p.extreme == 0.0
    assert p.breakeven_armed is False
```

- [ ] **Step 2: Run it**

Run: `cd backend && .venv/bin/python -m pytest tests/test_position.py -q`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_position.py
git commit -m "test(backtest): Position dataclass defaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5"
```

---

## Self-Review

**Spec coverage:** This plan implements P1 of the spec (§8) only — the engine refactor to `list[Position]`, regression-locked, with `RuleStrategy` untouched. P2 (multi-open: mode/maxConcurrent/spacing), P3 (exit scope), P4 (break-even), P5 (per-position chart lines) are **out of scope for this plan** and get their own plans after P1 lands. Deviation from spec §8's P1 wording ("drop the strategy flat-gate"): the gate-drop is deferred to P2 so P1 stays a pure, provably-identical internal refactor.

**Placeholder scan:** none — the full refactored `run()` and every helper is given.

**Type consistency:** `Position` fields (`qty`, `entry`, `open_time`, `open_reason`, `stop`, `target`, `extreme`, `breakeven_armed`) are used consistently across `_open_or_add`, `_reduce`, `_intrabar_exit`, `_ratchet_trailing`, `_unrealized`, and `run()`. Helper signatures match their call sites in `run()`. `_reduce` returns `realized`; `_open_or_add` returns nothing (mutates the list). `Trade` fields match the existing model (`reason_in`/`reason_out`/`leg`).

**Behaviour-preservation checks folded into the code:** merge keeps original `open_time`/`open_reason` and does not re-seed levels (matches the old `if qty == 0` guard); `_reduce` books the same `Trade` shape and pnl sign as the old `_close_long`/`_close_short`; the intra-bar branch order (open-resolves-target, then stop, then target) and the trailing clamp are copied verbatim; final settle and summary math are unchanged.
