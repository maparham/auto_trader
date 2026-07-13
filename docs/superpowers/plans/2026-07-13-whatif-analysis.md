# What-if Analysis Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-trade counterfactual analytics (exit-rule replay, target replay, stop/target placement curves, fill-delay cost, pullback limit entry) computed at backtest time and rendered as a "What-if" section in the Analysis tab.

**Architecture:** A pure replay helper mirrors the engine's pessimistic intrabar bracket rules. A post-run enrichment stamps a `whatif` dict onto each `Trade` (same pattern as `context`), so pure aggregate functions over TradeDTO-shaped dicts serve both the live response and the run-store recompute with zero store schema changes. `compute_analysis` gains a `whatif` key; the frontend renders it as sentence bullets plus two small tables.

**Tech Stack:** Python 3 stdlib (backend), React + TypeScript + vitest (frontend), pytest (backend tests).

**Spec:** `docs/superpowers/specs/2026-07-13-whatif-analysis-design.md` (read it; the scenario semantics there are binding).

## Global Constraints

- Backend owns business logic; the frontend only formats.
- What-if enrichment is BEST-EFFORT: a failure logs a warning and leaves `whatif` None; it must never fail the backtest response.
- Sweep child runs skip enrichment and persistence (already true; do not change the sweep path).
- No run-store schema changes; per-trade what-if data rides inside `trades_json`.
- R units: 1R = |entry_price − stop_initial|. Trades without `stop_initial` get None for R-based scenario fields, never fabricated values.
- v1 constants (not user-tunable): replay horizon 500 bars; limit entry at the signal-bar close (offset 0) with a 3-bar fill window; stop curve grid 0.1..1.0 step 0.1; target curve grid 0.5..5.0 step 0.5.
- Backend tests: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest <paths> -q`. NO pytest-asyncio: async handlers are tested via `asyncio.run(...)` + `pytest.raises(HTTPException)` (mirror `backend/tests/test_api_backtest.py`). `backend/tests/conftest.py` already isolates `RUN_STORE` per test.
- Frontend tests: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run <path>`. Typecheck: `npx tsc -b` (NOT `--noEmit`, which is a no-op). 60 pre-existing errors exist in unrelated files; introduce none.
- UI copy: plain trading language; bulleted sentences and small flat tables; NO bar charts; NEVER use "—"/"--" as punctuation in any text (numeric ranges like `0.5–1` are allowed); `InfoTip` must sit inside a styled ancestor wired into the grouped `.ind-info` selectors in `App.css` or it renders as a black circle.
- Commit directly to main; do NOT push. Other sessions commit concurrently: `git add` only your specific files, never `-A`.

---

### Task 1: Replay helper

**Files:**
- Create: `backend/auto_trader/engine/whatif.py`
- Test: `backend/tests/test_whatif_replay.py` (new)

**Interfaces:**
- Consumes: `Candle` from `auto_trader.core.models` (fields: time, open, high, low, close, volume).
- Produces: `replay_bracket(candles, start, leg, stop, target, horizon=500) -> tuple[str, int | None]` returning `("target" | "stop" | "undecided", exit_bar_index_or_None)`. Task 2 builds on it in this same file.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_whatif_replay.py`:

```python
"""replay_bracket: walk bars forward with the engine's pessimistic intrabar
bracket rules (mirrors BacktestEngine._intrabar_exit ordering)."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.whatif import replay_bracket


def _mk(bars):
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=o, high=h, low=lo, close=c, volume=0.0)
        for i, (o, h, lo, c) in enumerate(bars)
    ]


def test_long_hits_target():
    candles = _mk([(100, 101, 99, 100), (100, 106, 99, 105)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "target" and i == 1


def test_long_hits_stop_before_target_same_bar():
    # Same bar touches both: stop wins (pessimistic), matching _intrabar_exit,
    # which checks low <= stop before high >= target when the open gaps neither.
    candles = _mk([(100, 106, 94, 100)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "stop" and i == 0


def test_long_gap_open_through_target():
    # Open at/above target resolves as target at the open, before the stop check.
    candles = _mk([(106, 107, 94, 100)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "target" and i == 0


def test_short_hits_stop():
    candles = _mk([(100, 101, 99, 100), (100, 105, 99, 104)])
    outcome, i = replay_bracket(candles, 0, "short", stop=104.0, target=90.0)
    assert outcome == "stop" and i == 1


def test_short_gap_open_through_target():
    candles = _mk([(89, 106, 88, 100)])
    outcome, i = replay_bracket(candles, 0, "short", stop=105.0, target=90.0)
    assert outcome == "target" and i == 0


def test_undecided_at_array_end():
    candles = _mk([(100, 101, 99, 100)] * 3)
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0)
    assert outcome == "undecided" and i is None


def test_undecided_at_horizon():
    candles = _mk([(100, 101, 99, 100)] * 10)
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=105.0, horizon=5)
    assert outcome == "undecided" and i is None


def test_stop_only_and_none_bracket():
    candles = _mk([(100, 101, 94, 95)])
    outcome, i = replay_bracket(candles, 0, "long", stop=95.0, target=None)
    assert outcome == "stop" and i == 0
    assert replay_bracket(candles, 0, "long", stop=None, target=None) == ("undecided", None)


def test_start_beyond_array_is_undecided():
    candles = _mk([(100, 101, 99, 100)])
    assert replay_bracket(candles, 5, "long", stop=95.0, target=105.0) == ("undecided", None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_whatif_replay.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.engine.whatif`.

- [ ] **Step 3: Implement**

Create `backend/auto_trader/engine/whatif.py`. Before writing, read `BacktestEngine._intrabar_exit` in `backend/auto_trader/engine/backtest.py` (~line 411) to confirm the ordering being mirrored; the helper below reproduces it without slippage (counterfactuals compare levels, not fill costs):

```python
"""Per-trade what-if counterfactuals for backtest analysis.

Replay-based scenarios (exit-rule counterfactual, target counterfactual,
pullback limit entry) walk candles forward with the SAME pessimistic intrabar
bracket rules as BacktestEngine._intrabar_exit: an open gapping through the
target resolves as target first, then stop by bar range, then target by bar
range. No slippage is modelled: counterfactuals compare price levels.

All results are per-trade attribution. They deliberately ignore knock-on
effects on later trades (single-position netting means a longer hold could
have blocked the next entry), so any finding should be confirmed with a real
rerun or sweep before acting on it.

Enrichment is best-effort and mutates trade.whatif (JSON-safe scalars only),
same pattern as context_features.enrich_trades; aggregates are pure functions
over TradeDTO-shaped dicts so the live response and the run-store recompute
share one code path.
"""

from __future__ import annotations

from auto_trader.core.models import Candle, Trade

REPLAY_HORIZON = 500      # max bars a replay walks; beyond -> undecided
LIMIT_FILL_WINDOW = 3     # bars a v1 limit entry stays working
STOP_CURVE_FRACS = [round(0.1 * k, 1) for k in range(1, 11)]      # 0.1 .. 1.0
TARGET_CURVE_RS = [round(0.5 * k, 1) for k in range(1, 11)]       # 0.5 .. 5.0


def replay_bracket(
    candles: list[Candle],
    start: int,
    leg: str,
    stop: float | None,
    target: float | None,
    horizon: int = REPLAY_HORIZON,
) -> tuple[str, int | None]:
    """Outcome of holding a bracket from bar `start` (inclusive): ("target" |
    "stop" | "undecided", exit bar index or None). Undecided when both levels
    are None, `start` is past the array, or the horizon/data ends first."""
    if stop is None and target is None:
        return ("undecided", None)
    end = min(len(candles), start + horizon)
    for i in range(max(start, 0), end):
        bar = candles[i]
        if leg == "long":
            if target is not None and bar.open >= target:
                return ("target", i)
            if stop is not None and bar.low <= stop:
                return ("stop", i)
            if target is not None and bar.high >= target:
                return ("target", i)
        else:
            if target is not None and bar.open <= target:
                return ("target", i)
            if stop is not None and bar.high >= stop:
                return ("stop", i)
            if target is not None and bar.low <= target:
                return ("target", i)
    return ("undecided", None)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_whatif_replay.py -q`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/whatif.py backend/tests/test_whatif_replay.py
git commit -m "feat(backtest): what-if bracket replay helper"
```

---

### Task 2: Per-trade what-if enrichment

**Files:**
- Modify: `backend/auto_trader/core/models.py` (Trade dataclass, directly after `context: dict | None = None`)
- Modify: `backend/auto_trader/engine/whatif.py` (append)
- Test: `backend/tests/test_whatif_enrich.py` (new)

**Interfaces:**
- Consumes: `replay_bracket` (Task 1); `Trade` fields `entry_time, exit_time, entry_price, exit_price, leg, reason_out, stop_initial, stop_final, target`.
- Produces: `Trade.whatif: dict | None = None`; `enrich_trades_whatif(trades: list[Trade], candles: list[Candle]) -> None` setting per-trade `whatif` with keys:
  - `rule_exit`: `{"would_have": "won"|"lost"|"undecided", "delta_r": float|None}` | None
  - `no_target`: `{"would_have": "stopped"|"survived", "delta_r": float|None}` | None
  - `fill_delay_r`: float | None
  - `limit_entry`: `{"filled": bool, "delta_r": float|None}` or `{"filled": false, "foregone_r": float}` | None (filled entries carry `delta_r`; unfilled carry `foregone_r`)

- [ ] **Step 1: Add the Trade field**

In `backend/auto_trader/core/models.py`, after `context: dict | None = None` on `Trade`:

```python
    # Per-trade counterfactual results (see engine.whatif): exit-rule replay,
    # target replay, fill-delay cost, limit-entry replay. None until enriched.
    whatif: dict | None = None
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_whatif_enrich.py`:

```python
"""enrich_trades_whatif: per-trade counterfactual stamps (rule-exit replay,
no-target replay, fill-delay cost, limit-entry replay), None when inputs are
missing, never fabricated."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Trade
from auto_trader.engine.whatif import enrich_trades_whatif

T0 = datetime(2026, 1, 5, tzinfo=timezone.utc)


def _mk(bars):
    return [
        Candle(time=T0 + timedelta(hours=i), open=o, high=h, low=lo, close=c, volume=0.0)
        for i, (o, h, lo, c) in enumerate(bars)
    ]


def _trade(entry_i, exit_i, *, entry=100.0, exit_=101.0, leg="long",
           reason="rule", stop_initial=95.0, stop_final=95.0, target=110.0):
    return Trade(
        side=Side.BUY if leg == "long" else Side.SELL, quantity=1.0,
        entry_time=T0 + timedelta(hours=entry_i), entry_price=entry,
        exit_time=T0 + timedelta(hours=exit_i), exit_price=exit_, pnl=exit_ - entry,
        leg=leg, reason_in="rule", reason_out=reason,
        stop_initial=stop_initial, stop_final=stop_final, target=target,
    )


def test_rule_exit_would_have_won():
    # Rule exit at bar3 open=101; bars 3..4 then run to the 110 target.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal bar (close 100)
        (100, 103, 98, 102),   # 1 entry fill at open 100
        (102, 104, 100, 103),  # 2
        (101, 105, 100, 104),  # 3 rule exit fills at open 101
        (104, 111, 103, 110),  # 4 would have hit target 110
    ])
    t = _trade(1, 3, exit_=101.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["rule_exit"]
    assert w["would_have"] == "won"
    # cf_r = (110-100)/5 = 2.0; actual_r = (101-100)/5 = 0.2; delta = 1.8
    assert w["delta_r"] == 1.8


def test_rule_exit_would_have_lost_and_short_leg():
    # Short rule exit at bar2 open=99 (profit); afterwards price rallies to the
    # 104 stop: holding would have LOST.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 97, 98),    # 1 short entry at 100
        (99, 100, 97, 98),     # 2 rule exit at open 99
        (99, 105, 98, 104),    # 3 stop 104 hit
    ])
    t = _trade(1, 2, exit_=99.0, leg="short", stop_initial=104.0,
               stop_final=104.0, target=90.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["rule_exit"]
    assert w["would_have"] == "lost"
    # risk 4; cf_r = (100-104)/4 = -1.0; actual_r = (100-99)/4 = 0.25
    assert w["delta_r"] == -1.25


def test_rule_exit_excluded_for_mechanical_reasons_and_no_bracket():
    candles = _mk([(100, 101, 99, 100)] * 4)
    stop_out = _trade(1, 2, reason="stop")
    no_bracket = _trade(1, 2, stop_initial=None, stop_final=None, target=None)
    enrich_trades_whatif([stop_out, no_bracket], candles)
    assert stop_out.whatif["rule_exit"] is None
    assert no_bracket.whatif["rule_exit"] is None


def test_no_target_counterfactual():
    # Target exit at bar2; afterwards price falls to the 95 stop.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 111, 99, 110),   # 1 entry 100, target 110 hit intrabar
        (110, 110, 94, 95),    # 2 would-have-stopped bar
    ])
    t = _trade(1, 1, exit_=110.0, reason="target")
    enrich_trades_whatif([t], candles)
    w = t.whatif["no_target"]
    assert w["would_have"] == "stopped"
    # cf_r = (95-100)/5 = -1.0; actual_r = (110-100)/5 = 2.0; delta = -3.0
    assert w["delta_r"] == -3.0


def test_no_target_survived_gives_none_delta():
    candles = _mk([(100, 111, 99, 110), (110, 111, 109, 110)])
    t = _trade(0, 0, exit_=110.0, reason="target")
    enrich_trades_whatif([t], candles)
    assert t.whatif["no_target"] == {"would_have": "survived", "delta_r": None}


def test_fill_delay_r():
    # Signal close 100, long fill at 102: delay cost (102-100)/risk 5 = 0.4.
    candles = _mk([
        (100, 101, 99, 100),
        (102, 103, 101, 102),
    ])
    t = _trade(1, 1, entry=102.0, exit_=103.0, stop_initial=97.0, stop_final=97.0)
    enrich_trades_whatif([t], candles)
    assert t.whatif["fill_delay_r"] == 0.4


def test_fill_delay_none_on_bar0_fill():
    candles = _mk([(100, 101, 99, 100), (100, 101, 99, 100)])
    t = _trade(0, 1)
    enrich_trades_whatif([t], candles)
    assert t.whatif["fill_delay_r"] is None


def test_limit_entry_fills_and_improves():
    # Signal close 100; actual fill bar1 open 102. Limit 100 fills bar2
    # (low 99 <= 100). Re-anchored bracket from 100 (stop dist 5, target dist 8
    # from the actual entry 102): stop 95, target 108; bar3 hits 108.
    candles = _mk([
        (100, 101, 99, 100),    # 0 signal
        (102, 103, 101, 102),   # 1 actual fill at 102 (limit not touched)
        (101, 102, 99, 100),    # 2 limit 100 fills
        (100, 109, 99, 108),    # 3 target 108 hit
    ])
    t = _trade(1, 3, entry=102.0, exit_=108.0, reason="target",
               stop_initial=97.0, stop_final=97.0, target=110.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["limit_entry"]
    assert w["filled"] is True
    # risk = |102-97| = 5. cf move (108-100)=8 -> 1.6R; actual (108-102)=6 -> 1.2R
    assert w["delta_r"] == 0.4


def test_limit_entry_never_fills_reports_foregone():
    # Price never returns to the signal close within the 3-bar window.
    candles = _mk([
        (100, 101, 99, 100),    # 0 signal (close 100)
        (102, 104, 101, 103),   # 1 actual fill 102
        (103, 105, 102, 104),   # 2
        (104, 106, 103, 105),   # 3 window ends
        (105, 111, 104, 110),   # 4
    ])
    t = _trade(1, 4, entry=102.0, exit_=110.0, reason="target",
               stop_initial=97.0, stop_final=97.0, target=110.0)
    enrich_trades_whatif([t], candles)
    w = t.whatif["limit_entry"]
    assert w["filled"] is False
    # foregone = actual realized R = (110-102)/5 = 1.6
    assert w["foregone_r"] == 1.6


def test_unknown_times_leave_whatif_scenarios_none():
    candles = _mk([(100, 101, 99, 100)] * 3)
    t = _trade(1, 2)
    t.entry_time = T0 + timedelta(days=30)
    t.exit_time = T0 + timedelta(days=30)
    enrich_trades_whatif([t], candles)
    assert t.whatif["rule_exit"] is None
    assert t.whatif["fill_delay_r"] is None
    assert t.whatif["limit_entry"] is None


def test_empty_inputs_no_crash():
    enrich_trades_whatif([], _mk([(100, 101, 99, 100)]))
    t = _trade(0, 0)
    enrich_trades_whatif([t], [])
    assert t.whatif is None
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_whatif_enrich.py -q`
Expected: FAIL with `ImportError: cannot import name 'enrich_trades_whatif'`.

- [ ] **Step 4: Implement**

Append to `backend/auto_trader/engine/whatif.py`:

```python
RULE_EXIT_MECHANICAL = {"stop", "trail", "target", "range end"}


def _signed_r(level: float, entry: float, risk: float, leg: str) -> float:
    """Signed R of a move from entry to `level` (positive = in the trade's favor)."""
    move = level - entry if leg == "long" else entry - level
    return move / risk


def _rule_exit(trade: Trade, candles, exit_i: int, risk: float, actual_r: float):
    if trade.reason_out in RULE_EXIT_MECHANICAL:
        return None
    if trade.stop_final is None and trade.target is None:
        return None
    outcome, _ = replay_bracket(candles, exit_i, trade.leg,
                                stop=trade.stop_final, target=trade.target)
    if outcome == "target":
        cf = _signed_r(trade.target, trade.entry_price, risk, trade.leg)
        return {"would_have": "won", "delta_r": round(cf - actual_r, 4)}
    if outcome == "stop":
        cf = _signed_r(trade.stop_final, trade.entry_price, risk, trade.leg)
        return {"would_have": "lost", "delta_r": round(cf - actual_r, 4)}
    return {"would_have": "undecided", "delta_r": None}


def _no_target(trade: Trade, candles, exit_i: int, risk: float, actual_r: float):
    if trade.reason_out != "target" or trade.stop_final is None:
        return None
    outcome, _ = replay_bracket(candles, exit_i, trade.leg,
                                stop=trade.stop_final, target=None)
    if outcome == "stop":
        cf = _signed_r(trade.stop_final, trade.entry_price, risk, trade.leg)
        return {"would_have": "stopped", "delta_r": round(cf - actual_r, 4)}
    return {"would_have": "survived", "delta_r": None}


def _fill_delay(trade: Trade, candles, entry_i: int, risk: float):
    """Cost of the one-bar honest fill vs entering at the signal close, in R
    (positive = the delay cost money)."""
    if entry_i == 0:
        return None
    sig_close = candles[entry_i - 1].close
    cost = ((trade.entry_price - sig_close) if trade.leg == "long"
            else (sig_close - trade.entry_price)) / risk
    return round(cost, 4)


def _limit_entry(trade: Trade, candles, entry_i: int, risk: float, actual_r: float):
    if entry_i == 0:
        return None
    limit = candles[entry_i - 1].close  # v1: limit at the signal close (offset 0)
    fill_i = None
    fill_px = None
    for i in range(entry_i, min(entry_i + LIMIT_FILL_WINDOW, len(candles))):
        bar = candles[i]
        if trade.leg == "long" and bar.low <= limit:
            fill_i, fill_px = i, min(bar.open, limit)
            break
        if trade.leg == "short" and bar.high >= limit:
            fill_i, fill_px = i, max(bar.open, limit)
            break
    if fill_i is None:
        return {"filled": False, "foregone_r": round(actual_r, 4)}
    # Re-anchor the recorded stop/target DISTANCES to the better entry price;
    # deltas stay in the ORIGINAL risk units so they compare to actual_r.
    sign = 1 if trade.leg == "long" else -1
    stop = (fill_px - sign * abs(trade.entry_price - trade.stop_final)
            ) if trade.stop_final is not None else None
    target = (fill_px + sign * abs(trade.target - trade.entry_price)
              ) if trade.target is not None else None
    outcome, _ = replay_bracket(candles, fill_i, trade.leg, stop=stop, target=target)
    if outcome == "undecided":
        return {"filled": True, "delta_r": None}
    hit = target if outcome == "target" else stop
    cf = _signed_r(hit, fill_px, risk, trade.leg)
    return {"filled": True, "delta_r": round(cf - actual_r, 4)}


def enrich_trades_whatif(trades: list[Trade], candles: list[Candle]) -> None:
    """Stamp trade.whatif per the what-if spec. A trade missing what a scenario
    needs gets that key None; a trade with no locatable times or no stop_initial
    (no R basis) gets every scenario None. Empty candles leave whatif None."""
    if not trades or not candles:
        return
    index = {c.time: i for i, c in enumerate(candles)}
    for trade in trades:
        entry_i = index.get(trade.entry_time)
        exit_i = index.get(trade.exit_time)
        risk = (abs(trade.entry_price - trade.stop_initial)
                if trade.stop_initial is not None else 0.0)
        if risk <= 0:
            trade.whatif = {"rule_exit": None, "no_target": None,
                            "fill_delay_r": None, "limit_entry": None}
            continue
        actual_r = _signed_r(trade.exit_price, trade.entry_price, risk, trade.leg)
        trade.whatif = {
            "rule_exit": (_rule_exit(trade, candles, exit_i, risk, actual_r)
                          if exit_i is not None else None),
            "no_target": (_no_target(trade, candles, exit_i, risk, actual_r)
                          if exit_i is not None else None),
            "fill_delay_r": (_fill_delay(trade, candles, entry_i, risk)
                             if entry_i is not None else None),
            "limit_entry": (_limit_entry(trade, candles, entry_i, risk, actual_r)
                            if entry_i is not None else None),
        }
```

- [ ] **Step 5: Run tests to verify they pass, plus no regression on Task 1**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_whatif_enrich.py tests/test_whatif_replay.py -q`
Expected: all pass. Hand-check the two arithmetic tests against the comments if one fails; fix the CODE only if the comment math is right.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/models.py backend/auto_trader/engine/whatif.py backend/tests/test_whatif_enrich.py
git commit -m "feat(backtest): per-trade what-if enrichment (rule exit, target, fill delay, limit entry)"
```

---

### Task 3: Aggregates

**Files:**
- Modify: `backend/auto_trader/engine/whatif.py` (append)
- Modify: `backend/auto_trader/engine/analysis.py` (one line in `compute_analysis`)
- Test: `backend/tests/test_whatif_aggregate.py` (new)

**Interfaces:**
- Consumes: TradeDTO-shaped dicts with keys `pnl, leg, entry_price, exit_price, stop_initial, reason, mae_r, mfe_r, whatif` (whatif shaped per Task 2).
- Produces: `compute_whatif(trades: list[dict]) -> dict` with the exact shape below; `compute_analysis` output gains `"whatif": compute_whatif(trades)`.

```python
{
  "rule_exit": {"by_reason": [{"reason": str, "n": int, "would_have_won": int,
      "would_have_lost": int, "undecided": int, "net_delta_r": float}],
      "totals": {"n": int, "would_have_won": int, "would_have_lost": int,
      "undecided": int, "net_delta_r": float}} | None,
  "no_target": {"n": int, "would_have_stopped": int, "survived": int,
      "net_saved_r": float} | None,
  "stop_curve": [{"frac": float, "winners_killed": int, "losers_cheapened": int,
      "net_delta_r": float}] | None,
  "target_curve": [{"target_r": float, "n_reached": int, "pct_reached": float}] | None,
  "fill_delay": {"n": int, "avg_r": float, "total_r": float} | None,
  "limit_entry": {"n": int, "fill_rate": float, "filled_net_delta_r": float,
      "undecided": int, "unfilled_foregone_r": float, "unfilled_winners": int,
      "net_verdict_r": float} | None,
}
```

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_whatif_aggregate.py`:

```python
"""compute_whatif: pure aggregates over TradeDTO-shaped dicts carrying the
per-trade whatif stamps; every section is None when no trade feeds it."""

from auto_trader.engine.whatif import compute_whatif


def _t(pnl, *, entry=100.0, exit_=None, stop=95.0, leg="long", reason="rule",
       mae_r=None, mfe_r=None, whatif=None):
    return {
        "pnl": pnl, "leg": leg, "entry_price": entry,
        "exit_price": exit_ if exit_ is not None else entry + pnl,
        "stop_initial": stop, "reason": reason,
        "mae_r": mae_r, "mfe_r": mfe_r, "whatif": whatif,
    }


def test_all_none_when_nothing_enriched():
    out = compute_whatif([_t(1.0), _t(-1.0)])
    assert out == {"rule_exit": None, "no_target": None, "stop_curve": None,
                   "target_curve": None, "fill_delay": None, "limit_entry": None}


def test_rule_exit_by_reason_and_totals():
    trades = [
        _t(1.0, reason="Sell to Close",
           whatif={"rule_exit": {"would_have": "won", "delta_r": 1.8}}),
        _t(0.5, reason="Sell to Close",
           whatif={"rule_exit": {"would_have": "lost", "delta_r": -1.2}}),
        _t(0.2, reason="session close",
           whatif={"rule_exit": {"would_have": "undecided", "delta_r": None}}),
        _t(-1.0, reason="stop", whatif={"rule_exit": None}),
    ]
    out = compute_whatif(trades)["rule_exit"]
    rows = {r["reason"]: r for r in out["by_reason"]}
    assert rows["Sell to Close"] == {"reason": "Sell to Close", "n": 2,
        "would_have_won": 1, "would_have_lost": 1, "undecided": 0,
        "net_delta_r": 0.6}
    assert rows["session close"]["undecided"] == 1
    assert out["totals"]["n"] == 3 and out["totals"]["net_delta_r"] == 0.6


def test_no_target_net_saved():
    trades = [
        _t(10.0, reason="target",
           whatif={"no_target": {"would_have": "stopped", "delta_r": -3.0}}),
        _t(10.0, reason="target",
           whatif={"no_target": {"would_have": "survived", "delta_r": None}}),
    ]
    out = compute_whatif(trades)["no_target"]
    # saved = actual minus counterfactual = -delta; one stopped trade at -3.0.
    assert out == {"n": 2, "would_have_stopped": 1, "survived": 1,
                   "net_saved_r": 3.0}


def test_stop_curve():
    # Winner (realized +2R) with mae_r 0.6; loser (realized -1R) with mae_r 1.0.
    trades = [
        _t(10.0, exit_=110.0, mae_r=0.6),
        _t(-5.0, exit_=95.0, mae_r=1.0),
    ]
    curve = {row["frac"]: row for row in compute_whatif(trades)["stop_curve"]}
    # f=0.5: both stopped -> winner delta (-0.5 - 2) = -2.5; loser (-0.5 - -1) = +0.5
    assert curve[0.5] == {"frac": 0.5, "winners_killed": 1,
                          "losers_cheapened": 1, "net_delta_r": -2.0}
    # f=0.8: winner survives (0.6 < 0.8); loser cheapened by 0.2
    assert curve[0.8] == {"frac": 0.8, "winners_killed": 0,
                          "losers_cheapened": 1, "net_delta_r": 0.2}
    # f=1.0: loser unchanged (mae_r >= 1.0 -> outcome -1.0 == realized)
    assert curve[1.0]["net_delta_r"] == 0.0


def test_target_curve():
    trades = [_t(10.0, mfe_r=3.0), _t(-5.0, mfe_r=0.4), _t(2.0, mfe_r=1.0)]
    curve = {row["target_r"]: row for row in compute_whatif(trades)["target_curve"]}
    assert curve[0.5] == {"target_r": 0.5, "n_reached": 2, "pct_reached": 2 / 3}
    assert curve[3.0]["n_reached"] == 1
    assert curve[5.0]["n_reached"] == 0


def test_fill_delay_and_limit_entry():
    trades = [
        _t(1.0, whatif={"fill_delay_r": 0.4,
                         "limit_entry": {"filled": True, "delta_r": 0.4}}),
        _t(2.0, whatif={"fill_delay_r": 0.2,
                         "limit_entry": {"filled": True, "delta_r": None}}),
        _t(3.0, whatif={"fill_delay_r": None,
                         "limit_entry": {"filled": False, "foregone_r": 1.6}}),
    ]
    out = compute_whatif(trades)
    assert out["fill_delay"] == {"n": 2, "avg_r": 0.3, "total_r": 0.6}
    le = out["limit_entry"]
    assert le == {"n": 3, "fill_rate": 2 / 3, "filled_net_delta_r": 0.4,
                  "undecided": 1, "unfilled_foregone_r": 1.6,
                  "unfilled_winners": 1, "net_verdict_r": -1.2}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_whatif_aggregate.py -q`
Expected: FAIL with `ImportError: cannot import name 'compute_whatif'`.

- [ ] **Step 3: Implement**

Append to `backend/auto_trader/engine/whatif.py`. Reuse `_realized_r` from the sibling aggregates module rather than duplicating it:

```python
from auto_trader.engine.analysis import _realized_r  # place with the top imports


def _round4(x: float) -> float:
    return round(x, 4)


def compute_whatif(trades: list[dict]) -> dict:
    """Aggregate the per-trade whatif stamps (dict-based: serves the live
    response and the run-store recompute identically). Sections with no
    eligible trades are None, never empty placeholders."""
    w = [t.get("whatif") or {} for t in trades]

    # A: rule-exit counterfactual, grouped by exit reason.
    rule = [(t, x["rule_exit"]) for t, x in zip(trades, w) if x.get("rule_exit")]
    rule_exit = None
    if rule:
        groups: dict[str, list[dict]] = {}
        for t, r in rule:
            groups.setdefault(t.get("reason") or "unknown", []).append(r)

        def _row(reason, rs):
            return {
                "reason": reason,
                "n": len(rs),
                "would_have_won": sum(1 for r in rs if r["would_have"] == "won"),
                "would_have_lost": sum(1 for r in rs if r["would_have"] == "lost"),
                "undecided": sum(1 for r in rs if r["would_have"] == "undecided"),
                "net_delta_r": _round4(sum(r["delta_r"] or 0.0 for r in rs)),
            }

        by_reason = sorted((_row(k, v) for k, v in groups.items()),
                           key=lambda r: -r["n"])
        totals = _row("", [r for _, r in rule])
        totals.pop("reason")
        rule_exit = {"by_reason": by_reason, "totals": totals}

    # B: target counterfactual.
    nt = [x["no_target"] for x in w if x.get("no_target")]
    no_target = None
    if nt:
        stopped = [r for r in nt if r["would_have"] == "stopped"]
        no_target = {
            "n": len(nt),
            "would_have_stopped": len(stopped),
            "survived": len(nt) - len(stopped),
            # what the target saved = actual minus counterfactual = -delta
            "net_saved_r": _round4(-sum(r["delta_r"] or 0.0 for r in stopped)),
        }

    # C: stop-tightening curve from stored mae_r + realized R.
    cr = [(t["mae_r"], _realized_r(t)) for t in trades
          if t.get("mae_r") is not None and _realized_r(t) is not None]
    stop_curve = None
    if cr:
        stop_curve = []
        for f in STOP_CURVE_FRACS:
            hit = [(m, r) for m, r in cr if m >= f]
            stop_curve.append({
                "frac": f,
                "winners_killed": sum(1 for m, r in hit if r > 0),
                "losers_cheapened": sum(1 for m, r in hit if r < 0),
                "net_delta_r": _round4(sum(-f - r for m, r in hit)),
            })

    # D: target-placement curve from stored mfe_r (hit rate only; censored at
    # each trade's actual target, which scenario B un-censors).
    mfes = [t["mfe_r"] for t in trades if t.get("mfe_r") is not None]
    target_curve = None
    if mfes:
        target_curve = [
            {"target_r": tr, "n_reached": sum(1 for m in mfes if m >= tr),
             "pct_reached": sum(1 for m in mfes if m >= tr) / len(mfes)}
            for tr in TARGET_CURVE_RS
        ]

    # E: fill-delay cost.
    delays = [x["fill_delay_r"] for x in w if x.get("fill_delay_r") is not None]
    fill_delay = None
    if delays:
        fill_delay = {"n": len(delays),
                      "avg_r": _round4(sum(delays) / len(delays)),
                      "total_r": _round4(sum(delays))}

    # F: pullback limit entry.
    le = [x["limit_entry"] for x in w if x.get("limit_entry")]
    limit_entry = None
    if le:
        filled = [r for r in le if r["filled"]]
        unfilled = [r for r in le if not r["filled"]]
        filled_net = sum(r["delta_r"] or 0.0 for r in filled)
        foregone = sum(r["foregone_r"] for r in unfilled)
        limit_entry = {
            "n": len(le),
            "fill_rate": len(filled) / len(le),
            "filled_net_delta_r": _round4(filled_net),
            "undecided": sum(1 for r in filled if r["delta_r"] is None),
            "unfilled_foregone_r": _round4(foregone),
            "unfilled_winners": sum(1 for r in unfilled if r["foregone_r"] > 0),
            "net_verdict_r": _round4(filled_net - foregone),
        }

    return {"rule_exit": rule_exit, "no_target": no_target,
            "stop_curve": stop_curve, "target_curve": target_curve,
            "fill_delay": fill_delay, "limit_entry": limit_entry}
```

In `backend/auto_trader/engine/analysis.py`, add the import at the top
(`from auto_trader.engine.whatif import compute_whatif` creates a cycle since
whatif imports `_realized_r` from analysis — import INSIDE the function
instead) and extend `compute_analysis`'s return dict:

```python
    from auto_trader.engine.whatif import compute_whatif  # local: avoids cycle

    return {
        "n_trades": len(trades),
        "sl": sl,
        "tp": tp,
        "exit_reasons": _rows(trades, lambda t: t.get("reason") or "unknown"),
        "r_hist": _hist(realized, R_EDGES),
        "context": {f: _ctx(f) for f in CONTEXT_FEATURES},
        "whatif": compute_whatif(trades),
    }
```

- [ ] **Step 4: Run tests to verify they pass, plus analysis regression**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_whatif_aggregate.py tests/test_analysis.py -q`
Expected: all pass (existing analysis tests still pass; they don't assert key absence).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/whatif.py backend/auto_trader/engine/analysis.py backend/tests/test_whatif_aggregate.py
git commit -m "feat(backtest): what-if aggregates wired into the analysis payload"
```

---

### Task 4: API wiring

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (TradeDTO, after `context: dict | None = None` ~line 99)
- Modify: `backend/auto_trader/api/routers/backtest.py` (import; enrichment call after `enrich_trades(result.trades, candles)` at ~line 312; TradeDTO conversion)
- Test: `backend/tests/test_api_backtest_analysis.py` (extend)

**Interfaces:**
- Consumes: `enrich_trades_whatif` (Task 2); `compute_analysis` already returning `whatif` (Task 3).
- Produces: `TradeDTO.whatif: dict | None = None`; every backtest response and stored run carries per-trade `whatif` and `analysis["whatif"]`.

- [ ] **Step 1: Write the failing test**

Extend `backend/tests/test_api_backtest_analysis.py` (reuse its existing helpers/fixtures; read the file first):

```python
def test_response_and_stored_run_carry_whatif(tmp_run_store):
    body = asyncio.run(backtest(make_minimal_backtest_request()))
    payload = body.model_dump()
    assert "whatif" in payload["analysis"]
    assert set(payload["analysis"]["whatif"].keys()) == {
        "rule_exit", "no_target", "stop_curve", "target_curve",
        "fill_delay", "limit_entry",
    }
    for t in payload["trades"]:
        assert "whatif" in t

    rec = asyncio.run(get_run(payload["run_id"]))
    assert "whatif" in rec["analysis"]
    assert all("whatif" in t for t in rec["trades"])
```

(Adapt names to the file's actual helper/fixture names; the existing tests in
that file show the exact call pattern for `backtest`/`get_run`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_api_backtest_analysis.py -q`
Expected: the new test FAILS on the missing `whatif` trade key (analysis["whatif"] may already pass via Task 3).

- [ ] **Step 3: Implement**

`backend/auto_trader/api/schemas.py`, on `TradeDTO` after `context`:

```python
    # Per-trade counterfactuals (see engine.whatif); None when not computed.
    whatif: dict | None = None
```

`backend/auto_trader/api/routers/backtest.py`:

1. Import next to the other engine imports:
```python
from auto_trader.engine.whatif import enrich_trades_whatif
```
2. Directly after the existing `enrich_trades(result.trades, candles)` call
(~line 312), best-effort:
```python
    try:
        enrich_trades_whatif(result.trades, candles)
    except Exception:
        logger.warning("what-if enrichment failed; continuing without it",
                       exc_info=True)
```
3. In the Trade -> TradeDTO conversion, alongside `context=t.context`:
```python
        whatif=t.whatif,
```

No other handler changes: `trade_dicts` already flows into both
`compute_analysis` and the run store, and `get_run` already recomputes
analysis from stored trades.

- [ ] **Step 4: Run tests to verify they pass, plus the full backend suite**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_api_backtest_analysis.py -q && .venv/bin/python -m pytest -q`
Expected: all pass (was 733 + new tests; additive fields with defaults break nothing).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_analysis.py
git commit -m "feat(backtest): ship per-trade whatif through the API and run store"
```

---

### Task 5: Frontend "What-if" section

**Files:**
- Modify: `frontend/src/api.ts` (types, next to `BacktestAnalysis`)
- Modify: `frontend/src/BacktestAnalysisPanel.tsx` (new `WhatIfSection` + render after the "Stop & target placement check" section)
- Modify: `frontend/src/App.css` (only if a new container needs the `.ind-info` selector treatment; the section reuses existing classes)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: `analysis.whatif` shaped exactly as Task 3's `compute_whatif` output; existing helpers `fmtPct`, `fmtR`, `InfoTip`, `.bt-analysis-*` classes (`bt-analysis-section`, `bt-analysis-readouts`/`bt-analysis-readout`, `bt-analysis-table`, `bt-analysis-dist-label`).
- Produces: `BacktestWhatif` type exported from `api.ts`.

- [ ] **Step 1: Add the types**

In `frontend/src/api.ts`, after `BacktestAnalysis`'s dependencies:

```ts
export interface WhatifRuleExitRow {
  reason: string;
  n: number;
  would_have_won: number;
  would_have_lost: number;
  undecided: number;
  net_delta_r: number;
}

export interface BacktestWhatif {
  rule_exit: {
    by_reason: WhatifRuleExitRow[];
    totals: Omit<WhatifRuleExitRow, "reason">;
  } | null;
  no_target: {
    n: number;
    would_have_stopped: number;
    survived: number;
    net_saved_r: number;
  } | null;
  stop_curve:
    | { frac: number; winners_killed: number; losers_cheapened: number; net_delta_r: number }[]
    | null;
  target_curve: { target_r: number; n_reached: number; pct_reached: number }[] | null;
  fill_delay: { n: number; avg_r: number; total_r: number } | null;
  limit_entry: {
    n: number;
    fill_rate: number;
    filled_net_delta_r: number;
    undecided: number;
    unfilled_foregone_r: number;
    unfilled_winners: number;
    net_verdict_r: number;
  } | null;
}
```

and extend `BacktestAnalysis` with `whatif?: BacktestWhatif;` (optional: older
stored results predate it). Also extend the frontend `Trade` interface with
`whatif?: Record<string, unknown> | null;` (opaque to the UI).

- [ ] **Step 2: Write the failing test**

Extend `frontend/src/BacktestAnalysisPanel.test.tsx`. Add `whatif` to the
existing `analysis` fixture object:

```ts
  whatif: {
    rule_exit: {
      by_reason: [
        { reason: "Sell to Close", n: 30, would_have_won: 11, would_have_lost: 16,
          undecided: 3, net_delta_r: -14.2 },
      ],
      totals: { n: 30, would_have_won: 11, would_have_lost: 16, undecided: 3,
        net_delta_r: -14.2 },
    },
    no_target: { n: 22, would_have_stopped: 6, survived: 16, net_saved_r: 9.1 },
    stop_curve: [
      { frac: 0.8, winners_killed: 1, losers_cheapened: 26, net_delta_r: 4.1 },
    ],
    target_curve: [{ target_r: 2.0, n_reached: 11, pct_reached: 0.3 }],
    fill_delay: { n: 37, avg_r: 0.07, total_r: 2.6 },
    limit_entry: { n: 37, fill_rate: 0.62, filled_net_delta_r: 3.4, undecided: 2,
      unfilled_foregone_r: 5.1, unfilled_winners: 4, net_verdict_r: -1.7 },
  },
```

and add tests:

```ts
  it("renders the what-if section with bullets and both curve tables", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    expect(screen.getByText(/What if/i)).toBeTruthy();
    expect(
      screen.getByText(/11 of 30 trades closed by "Sell to Close" would have gone on to hit the target/i),
    ).toBeTruthy();
    expect(screen.getByText(/target saved 9.1R net/i)).toBeTruthy();
    expect(screen.getByText(/fill delay costs 0.07R per trade/i)).toBeTruthy();
    expect(screen.getByText(/would have filled 62% of entries/i)).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy(); // stop curve row
    expect(screen.getByText("2R")).toBeTruthy(); // target curve row
  });

  it("skips what-if entirely when absent or all-None", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, whatif: undefined }} />);
    expect(screen.queryByText(/What if/i)).toBeNull();
    cleanup();
    render(
      <BacktestAnalysisPanel
        analysis={{
          ...analysis,
          whatif: { rule_exit: null, no_target: null, stop_curve: null,
            target_curve: null, fill_delay: null, limit_entry: null },
        }}
      />,
    );
    expect(screen.queryByText(/What if/i)).toBeNull();
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: the two new tests FAIL (no what-if section rendered).

- [ ] **Step 4: Implement**

In `frontend/src/BacktestAnalysisPanel.tsx`, add a `WhatIfSection` component
(after `RowsTable`) and render `<WhatIfSection whatif={analysis.whatif} />`
directly after the closing `</section>` of the "Stop & target placement check"
section:

```tsx
const CAVEAT =
  "Per-trade attribution: replays ignore knock-on effects on later trades " +
  "(one position at a time means a longer hold could block the next entry). " +
  "Confirm promising findings with a rerun or sweep.";

function WhatIfSection({ whatif }: { whatif: BacktestWhatif | null | undefined }) {
  if (!whatif) return null;
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry } = whatif;
  if (!rule_exit && !no_target && !stop_curve && !target_curve && !fill_delay && !limit_entry) {
    return null;
  }
  const bullets: string[] = [];
  if (rule_exit) {
    for (const r of rule_exit.by_reason) {
      bullets.push(
        `${r.would_have_won} of ${r.n} trades closed by "${r.reason}" would have gone on to hit the target and ${r.would_have_lost} the stop` +
          (r.undecided ? ` (${r.undecided} undecided)` : "") +
          `. Holding them would have ${r.net_delta_r >= 0 ? "added" : "cost"} ${fmtR(Math.abs(r.net_delta_r))} net.`,
      );
    }
  }
  if (no_target) {
    bullets.push(
      `${no_target.would_have_stopped} of ${no_target.n} target exits would have later hit the stop. The target ${no_target.net_saved_r >= 0 ? "saved" : "cost"} ${fmtR(Math.abs(no_target.net_saved_r))} net.`,
    );
  }
  if (fill_delay) {
    // avg is small: keep 2 decimals so "0.07R" doesn't round to "0.1R".
    bullets.push(
      `The one-bar fill delay ${fill_delay.avg_r >= 0 ? "costs" : "earns"} ${Math.abs(fill_delay.avg_r).toFixed(2)}R per trade (${fmtR(Math.abs(fill_delay.total_r))} over this run).`,
    );
  }
  if (limit_entry) {
    bullets.push(
      `A limit order at the signal close (3-bar window) would have filled ${fmtPct(limit_entry.fill_rate)} of entries, ${limit_entry.filled_net_delta_r >= 0 ? "improving filled entries by" : "worsening filled entries by"} ${fmtR(Math.abs(limit_entry.filled_net_delta_r))} while missing ${fmtR(Math.abs(limit_entry.unfilled_foregone_r))} on ${limit_entry.unfilled_winners} never-filled winners. Net: ${limit_entry.net_verdict_r >= 0 ? "limit entries add" : "market entries keep"} ${fmtR(Math.abs(limit_entry.net_verdict_r))}.`,
    );
  }
  return (
    <section className="bt-analysis-section">
      <h4>
        What if
        <InfoTip title="What if" text={CAVEAT} />
      </h4>
      {bullets.length > 0 && (
        <ul className="bt-analysis-readouts">
          {bullets.map((b, i) => (
            <li key={i} className="bt-analysis-readout">{b}</li>
          ))}
        </ul>
      )}
      <div className="bt-analysis-dists">
        {stop_curve && (
          <div className="bt-analysis-dist">
            <div className="bt-analysis-dist-label">
              Tighter stop
              <InfoTip
                title="Tighter stop"
                text="Outcome if the stop sat at a fraction of its current distance: a trade whose worst drawdown reached that fraction exits there for that loss; others keep their real result. Tightening only, widening needs data past the real stop."
              />
            </div>
            <table className="bt-analysis-table">
              <thead>
                <tr><th>Stop at</th><th>Winners lost</th><th>Losers cheapened</th><th>Net R</th></tr>
              </thead>
              <tbody>
                {stop_curve.map((r) => (
                  <tr key={r.frac}>
                    <td>{Math.round(r.frac * 100)}%</td>
                    <td>{r.winners_killed}</td>
                    <td>{r.losers_cheapened}</td>
                    <td>{r.net_delta_r.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {target_curve && (
          <div className="bt-analysis-dist">
            <div className="bt-analysis-dist-label">
              Target placement
              <InfoTip
                title="Target placement"
                text="Share of trades whose best run-up reached each candidate target. Trades that exited at their real target are censored there; the target bullet above is the uncensored answer."
              />
            </div>
            <table className="bt-analysis-table">
              <thead>
                <tr><th>Target</th><th>Reached</th><th>Share</th></tr>
              </thead>
              <tbody>
                {target_curve.map((r) => (
                  <tr key={r.target_r}>
                    <td>{r.target_r}R</td>
                    <td>{r.n_reached}</td>
                    <td>{fmtPct(r.pct_reached)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
```

Import `BacktestWhatif` from `./api`. The `h4` now hosts an `InfoTip`: add
`.bt-analysis-section h4 .ind-info` (base + `:hover` + `svg`) to the grouped
`.ind-info` selector lists in `App.css` (same three groups that already carry
`.bt-analysis-dist-label .ind-info`), or the icon renders as a black circle.
Also give the h4 inline-flex alignment:

```css
.bt-analysis-section h4 { display: flex; align-items: center; gap: 4px; }
```
(merge into the existing `.bt-analysis-section h4` rule; keep its other
declarations.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx && npx tsc -b`
Expected: all tests pass; `tsc -b` error count unchanged (60 pre-existing, none in touched files).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestAnalysisPanel.tsx frontend/src/App.css frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(backtest): What-if section in the Analysis tab"
```

---

### Task 6: Full-suite verification + live smoke

- [ ] **Step 1: Backend full suite**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 2: Frontend full suite + typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run && npx tsc -b`
Expected: all pass except the KNOWN pre-existing failure in
`src/lib/backtestSeries.test.ts` (MA Slope label, unrelated); tsc error count
unchanged at 60 in untouched files.

- [ ] **Step 3: Live smoke**

With the user's dev servers running (do NOT restart them): run a backtest from
the panel (or POST via curl) and then:

```bash
curl -s "http://localhost:8000/api/backtest/runs?limit=1" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])"
curl -s "http://localhost:8000/api/backtest/runs/<that-id>" | python3 -c "
import json,sys
r = json.load(sys.stdin)
print('whatif keys:', sorted(r['analysis']['whatif'].keys()))
print('trade whatif sample:', r['trades'][0].get('whatif'))"
```

Expected: the six keys; a per-trade whatif dict (values may be None for
scenarios that don't apply to that trade). Visually confirm the What-if section
renders in the Analysis tab on a real run and that its InfoTips are outlined
glyphs, not black circles. If browser automation is used, pin the tab title per
project convention and close the tab afterwards.

- [ ] **Step 4: Commit any stragglers**

```bash
git status --short   # only your files; commit with an appropriate message
```
