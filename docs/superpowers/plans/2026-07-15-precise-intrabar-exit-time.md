# Precise intra-bar exit time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each intra-bar stop/target exit a canonical 1-minute-resolution exit time, computed on the backend, and use it to show the exact exit time in the results table and draw the trade overlay to its true duration on finer timeframes.

**Architecture:** The backtest engine runs on the run timeframe's OHLC and stamps intra-bar exits at the run bar's open. A new backend post-pass reads the cached 1-minute candles for each intra-bar exit's bar and finds the first minute that pierced the stop/target, storing it as a nullable `exit_time_exact`. The frontend formats that value in the table and rounds it up to the current display candle for the overlay's right edge. No backtest number changes; only the exit time gains resolution.

**Tech Stack:** Python (FastAPI, dataclasses, pydantic), pytest; TypeScript/React frontend, vitest.

## Global Constraints

- Only intra-bar exits get an exact time. Intra-bar exit reasons are exactly `stop`, `trail`, `target`. Every other reason (rule text, `session close`, `range end`) is left untouched.
- Precision is 1-minute (`MINUTE` resolution). No tick precision.
- `exit_time_exact` is nullable everywhere; absent/null means "fall back to `exit_time`". No data migration for old persisted runs.
- No backtest number changes: entry price, exit price, P&L, `bars_held` are all unchanged.
- Use the run's own broker and price side when loading minute candles (`req.broker`, `req.epic`, `req.priceSide`).
- No em dashes in code comments or UI copy; use a colon, comma, or period.

---

### Task 1: Backend pure resolver `resolve_exit_time`

**Files:**
- Create: `backend/auto_trader/engine/exit_time.py`
- Test: `backend/tests/test_exit_time.py`

**Interfaces:**
- Consumes: `auto_trader.core.models.Candle` (`time: datetime`, `high`, `low`, `open`, `close`).
- Produces: `resolve_exit_time(*, leg: str, reason: str, run_tf_seconds: int, stop_final: float | None, target: float | None, exit_price: float, minute_candles: Sequence[Candle]) -> int | None` returning the epoch-seconds open time of the first piercing minute candle, or `None`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_exit_time.py
from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.exit_time import resolve_exit_time


def _c(ts: int, high: float, low: float) -> Candle:
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return Candle(time=dt, open=(high + low) / 2, high=high, low=low, close=(high + low) / 2)


# 1H run bar starting at t0; five minute candles; the third one first dips to the stop.
T0 = 1_783_299_600  # 2026-07-06 01:00 UTC
MINUTES = [
    _c(T0 + 0, high=29690, low=29650),
    _c(T0 + 60, high=29680, low=29600),
    _c(T0 + 120, high=29650, low=29520),   # first low <= 29533.99
    _c(T0 + 180, high=29560, low=29500),
    _c(T0 + 240, high=29540, low=29480),
]


def test_long_stop_returns_first_minute_low_pierces():
    got = resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=MINUTES,
    )
    assert got == T0 + 120


def test_short_stop_uses_high_side():
    mins = [_c(T0, 29500, 29480), _c(T0 + 60, 29560, 29500)]  # 2nd high >= 29540
    got = resolve_exit_time(
        leg="short", reason="stop", run_tf_seconds=3600,
        stop_final=29540.0, target=None, exit_price=29540.0, minute_candles=mins,
    )
    assert got == T0 + 60


def test_long_target_uses_high_side():
    mins = [_c(T0, 29500, 29480), _c(T0 + 60, 29610, 29550)]  # 2nd high >= 29600
    got = resolve_exit_time(
        leg="long", reason="target", run_tf_seconds=3600,
        stop_final=None, target=29600.0, exit_price=29600.0, minute_candles=mins,
    )
    assert got == T0 + 60


def test_gap_through_open_returns_first_minute():
    mins = [_c(T0, 29540, 29500), _c(T0 + 60, 29520, 29480)]  # first already <= 29533.99
    got = resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=mins,
    )
    assert got == T0


def test_non_intrabar_reason_returns_none():
    assert resolve_exit_time(
        leg="long", reason="MA Slope 100 lt 0.5", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=MINUTES,
    ) is None


def test_run_tf_at_or_below_minute_returns_none():
    assert resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=60,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=MINUTES,
    ) is None


def test_empty_minutes_returns_none():
    assert resolve_exit_time(
        leg="long", reason="stop", run_tf_seconds=3600,
        stop_final=29533.99, target=None, exit_price=29533.99, minute_candles=[],
    ) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_exit_time.py -q`
Expected: FAIL with `ModuleNotFoundError: auto_trader.engine.exit_time`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/auto_trader/engine/exit_time.py
"""Resolve the sub-bar exit time of an intra-bar stop/target exit.

The engine runs on the run timeframe's OHLC, so an intra-bar exit is stamped at
the run bar's open. Given that bar's 1-minute candles, find the FIRST minute that
actually pierced the exit level. Pure and side-effect free so it unit-tests
without a database; the caller supplies the candles.
"""

from __future__ import annotations

from collections.abc import Sequence

from auto_trader.core.models import Candle

# The only exits that happen mid run-bar. Everything else fills at a bar boundary.
_INTRABAR = frozenset({"stop", "trail", "target"})


def resolve_exit_time(
    *,
    leg: str,
    reason: str,
    run_tf_seconds: int,
    stop_final: float | None,
    target: float | None,
    exit_price: float,
    minute_candles: Sequence[Candle],
) -> int | None:
    if reason not in _INTRABAR:
        return None
    if run_tf_seconds <= 60:  # nothing finer than the run bar to resolve to
        return None
    if not minute_candles:
        return None

    if reason == "target":
        level = target if target is not None else exit_price
        pierced = (
            (lambda c: c.high >= level) if leg == "long" else (lambda c: c.low <= level)
        )
    else:  # stop / trail
        level = stop_final if stop_final is not None else exit_price
        pierced = (
            (lambda c: c.low <= level) if leg == "long" else (lambda c: c.high >= level)
        )

    for c in minute_candles:
        if pierced(c):
            return int(c.time.timestamp())
    return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_exit_time.py -q`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/exit_time.py backend/tests/test_exit_time.py
git commit -m "feat(backtest): pure resolver for intra-bar exit time"
```

---

### Task 2: Add `exit_time_exact` field to the Trade model, DTO, and serialization

**Files:**
- Modify: `backend/auto_trader/core/models.py:257` (Trade dataclass, add field after `reason_out`)
- Modify: `backend/auto_trader/api/schemas.py:91` (TradeDTO, add field after `target`)
- Modify: `backend/auto_trader/api/routers/backtest.py:324` (TradeDTO(...) construction)
- Test: `backend/tests/test_api_backtest.py` (add one test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Trade.exit_time_exact: datetime | None`, `TradeDTO.exit_time_exact: int | None`. Task 3 sets the model field; Task 4 relies on the serialization line.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_api_backtest.py
def test_trade_dto_has_exit_time_exact_null_for_non_intrabar():
    # A plain no-risk run books its trades via range-end, never an intra-bar stop,
    # so exit_time_exact is null on every trade but the key is always present.
    body = _min_body()
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert trades, "expected at least one trade"
    assert all(t["exit_time_exact"] is None for t in trades)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backtest.py::test_trade_dto_has_exit_time_exact_null_for_non_intrabar -q`
Expected: FAIL with `KeyError: 'exit_time_exact'`.

- [ ] **Step 3: Write minimal implementation**

In `backend/auto_trader/core/models.py`, add the field to the `Trade` dataclass immediately after `reason_out: str = ""` (line 257):

```python
    reason_out: str = ""
    # Canonical sub-bar exit time for an intra-bar stop/target (see
    # engine.exit_time), resolved from 1-minute candles post-run. None when the
    # exit was not intra-bar or no finer data was available; consumers fall back
    # to exit_time. Display only: never affects pnl or exit_price.
    exit_time_exact: datetime | None = None
```

In `backend/auto_trader/api/schemas.py`, add the field to `TradeDTO` immediately after `target: float | None = None` (line 91):

```python
    target: float | None = None
    exit_time_exact: int | None = None
```

In `backend/auto_trader/api/routers/backtest.py`, inside the `TradeDTO(...)` construction (after the `exit_time=_ts(t.exit_time),` line at ~line 328), add:

```python
            exit_time=_ts(t.exit_time),
            exit_time_exact=_ts(t.exit_time_exact) if t.exit_time_exact is not None else None,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_backtest.py::test_trade_dto_has_exit_time_exact_null_for_non_intrabar -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/models.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): thread nullable exit_time_exact through model + DTO"
```

---

### Task 3: Backend wiring helper `attach_exit_times`

**Files:**
- Modify: `backend/auto_trader/engine/exit_time.py` (add async helper)
- Test: `backend/tests/test_exit_time.py` (add tests)

**Interfaces:**
- Consumes: `resolve_exit_time` (Task 1), `Trade.exit_time_exact` (Task 2).
- Produces: `async def attach_exit_times(trades: Sequence[Trade], *, run_tf_seconds: int, load_minutes: Callable[[int, int], Awaitable[list[Candle]]]) -> None`. Mutates each intra-bar-exit trade's `exit_time_exact`. `load_minutes(from_s, to_s)` returns the minute candles in `[from_s, to_s)`.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_exit_time.py
import asyncio

from auto_trader.core.models import Side, Trade
from auto_trader.engine.exit_time import attach_exit_times


def _trade(reason: str, exit_ts: int, *, stop=29533.99) -> Trade:
    dt = datetime.fromtimestamp(exit_ts, tz=timezone.utc)
    return Trade(
        side=Side.BUY, quantity=1.0, entry_time=dt, entry_price=29682.4,
        exit_time=dt, exit_price=stop, pnl=-1.0, leg="long",
        reason_out=reason, stop_final=stop,
    )


def test_attach_sets_exact_for_stop_and_skips_rule_exit():
    calls: list[tuple[int, int]] = []

    async def load(from_s: int, to_s: int) -> list[Candle]:
        calls.append((from_s, to_s))
        return MINUTES  # third minute at T0+120 pierces 29533.99

    stop_trade = _trade("stop", T0)
    rule_trade = _trade("MA Slope lt 0.5", T0)

    asyncio.run(attach_exit_times(
        [stop_trade, rule_trade], run_tf_seconds=3600, load_minutes=load,
    ))

    assert int(stop_trade.exit_time_exact.timestamp()) == T0 + 120
    assert rule_trade.exit_time_exact is None
    assert calls == [(T0, T0 + 3600)]  # only the intra-bar exit triggers a load


def test_attach_memoizes_shared_exit_bar():
    loads = 0

    async def load(from_s: int, to_s: int) -> list[Candle]:
        nonlocal loads
        loads += 1
        return MINUTES

    a, b = _trade("stop", T0), _trade("stop", T0)
    asyncio.run(attach_exit_times([a, b], run_tf_seconds=3600, load_minutes=load))
    assert loads == 1  # same exit bar fetched once
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_exit_time.py -q`
Expected: FAIL with `ImportError: cannot import name 'attach_exit_times'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/auto_trader/engine/exit_time.py` (update the imports line and append the function):

```python
from collections.abc import Awaitable, Callable, Sequence
from datetime import datetime, timezone

from auto_trader.core.models import Candle, Trade


async def attach_exit_times(
    trades: Sequence[Trade],
    *,
    run_tf_seconds: int,
    load_minutes: Callable[[int, int], Awaitable[list[Candle]]],
) -> None:
    """Populate exit_time_exact on every intra-bar-exit trade, resolving from the
    exit bar's 1-minute candles. `load_minutes(from_s, to_s)` supplies the candles
    (injected so this is testable without a candle store). Runs at most one load
    per distinct exit bar."""
    if run_tf_seconds <= 60:
        return
    memo: dict[int, list[Candle]] = {}
    for t in trades:
        if t.reason_out not in _INTRABAR:
            continue
        start_s = int(t.exit_time.timestamp())
        if start_s not in memo:
            memo[start_s] = await load_minutes(start_s, start_s + run_tf_seconds)
        exact = resolve_exit_time(
            leg=t.leg, reason=t.reason_out, run_tf_seconds=run_tf_seconds,
            stop_final=t.stop_final, target=t.target, exit_price=t.exit_price,
            minute_candles=memo[start_s],
        )
        if exact is not None:
            t.exit_time_exact = datetime.fromtimestamp(exact, tz=timezone.utc)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_exit_time.py -q`
Expected: PASS (9 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/exit_time.py backend/tests/test_exit_time.py
git commit -m "feat(backtest): attach_exit_times wiring helper with per-bar memoization"
```

---

### Task 4: Call `attach_exit_times` in the backtest handler

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (import + call after `enrich_trades`, ~line 316)
- Test: `backend/tests/test_api_backtest.py` (add integration test)

**Interfaces:**
- Consumes: `attach_exit_times` (Task 3), `deps._fetch_symbol_candles`, `resolution_seconds`.
- Produces: populated `exit_time_exact` on intra-bar-exit trades in the API response.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_api_backtest.py
from auto_trader.api import deps as _deps
from auto_trader.core.models import Candle as _Candle
from datetime import datetime as _dt, timezone as _tz


def test_intrabar_stop_gets_exact_exit_time(monkeypatch):
    # 5-minute run; entry fills at the 2nd bar's open (300s), whose low pierces
    # the 1% stop same bar, so the exit is intra-bar and stamped at t=300.
    body = _min_body()
    body["resolution"] = "MINUTE_5"
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 1}, "target": {"kind": "none"}}
    body["candles"] = [
        {"time": 0,   "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 300, "open": 100, "high": 100, "low": 98,  "close": 98,  "volume": 0},
        {"time": 600, "open": 98,  "high": 98,  "low": 98,  "close": 98,  "volume": 0},
    ]

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        # 5 one-minute candles for the exit bar [300, 600). The third (t=420) is
        # the first whose low reaches the 99 stop.
        lows = [100, 100, 98, 98, 98]
        return [
            _Candle(time=_dt.fromtimestamp(300 + i * 60, tz=_tz.utc),
                    open=100, high=100, low=lows[i], close=lows[i])
            for i in range(5)
        ]

    monkeypatch.setattr(_deps, "_fetch_symbol_candles", fake_fetch)
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    trades = r.json()["trades"]
    stop_trades = [t for t in trades if t["reason"] == "stop"]
    assert stop_trades, "expected an intra-bar stop"
    assert stop_trades[0]["exit_time"] == 300
    assert stop_trades[0]["exit_time_exact"] == 420
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backtest.py::test_intrabar_stop_gets_exact_exit_time -q`
Expected: FAIL (`exit_time_exact` is `None`, not `420`).

- [ ] **Step 3: Write minimal implementation**

In `backend/auto_trader/api/routers/backtest.py`, add the import near the other engine imports (after line 20):

```python
from auto_trader.engine.exit_time import attach_exit_times
```

Immediately after the `enrich_trades(result.trades, candles)` call (line 316), add:

```python
    # Resolve the sub-bar exit time of intra-bar stop/target exits from the run's
    # own 1-minute candles. Display only; best-effort (a fetch failure or missing
    # minute data just leaves exit_time_exact None).
    run_s = resolution_seconds(req.resolution)

    async def _load_minutes(from_s: int, to_s: int) -> list[Candle]:
        return await deps._fetch_symbol_candles(
            req.broker, req.epic, "MINUTE", run_s // 60 + 2, from_s, to_s, req.priceSide,
        )

    try:
        await attach_exit_times(result.trades, run_tf_seconds=run_s, load_minutes=_load_minutes)
    except Exception:
        logger.warning("exit-time resolution failed; continuing without it", exc_info=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_backtest.py::test_intrabar_stop_gets_exact_exit_time tests/test_exit_time.py -q`
Expected: PASS.

- [ ] **Step 5: Run the backend suite to check nothing regressed**

Run: `cd backend && python -m pytest tests/test_api_backtest.py tests/test_backtest_stops.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): resolve intra-bar exit times from 1m candles in the run handler"
```

---

### Task 5: Frontend table shows the exact exit time

**Files:**
- Modify: `frontend/src/api.ts:92` (Trade interface)
- Modify: `frontend/src/lib/backtestPanelData.ts:331` (tradeRows exitTime)
- Test: `frontend/src/lib/backtestPanelData.test.ts`

**Interfaces:**
- Consumes: `Trade.exit_time_exact` from the API.
- Produces: `TradeRow.exitTime` now holds the effective exit time (exact when present, else raw). `BacktestPanel` display and `sortTradeRows` already read `row.exitTime`, so both follow automatically. `durationBars` keeps using the raw `trade.exit_time` and is unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
// add to frontend/src/lib/backtestPanelData.test.ts
import { tradeRows } from "./backtestPanelData";

test("tradeRows exitTime prefers exit_time_exact when present", () => {
  const res = {
    trades: [
      { side: "buy", leg: "long", entry_time: 1000, entry_price: 100, exit_time: 1000,
        exit_price: 99, pnl: -1, reason: "stop", exit_time_exact: 3000 },
      { side: "buy", leg: "long", entry_time: 2000, entry_price: 100, exit_time: 5000,
        exit_price: 101, pnl: 1, reason: "range end", exit_time_exact: null },
    ],
  } as unknown as Parameters<typeof tradeRows>[0];

  const rows = tradeRows(res, 3600);
  expect(rows[0].exitTime).toBe(3000); // exact wins
  expect(rows[1].exitTime).toBe(5000); // falls back to raw
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestPanelData.test.ts -t "prefers exit_time_exact"`
Expected: FAIL (`rows[0].exitTime` is `1000`, not `3000`).

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/api.ts`, add to the `Trade` interface after `target` (line 92):

```typescript
  target: number | null;
  // Canonical sub-bar exit time (epoch seconds) for an intra-bar stop/target,
  // resolved server-side. Null/absent -> use exit_time. Display only.
  exit_time_exact?: number | null;
```

In `frontend/src/lib/backtestPanelData.ts`, change the `exitTime` line in `tradeRows` (line 331) to prefer the exact value:

```typescript
      exitTime: trade.exit_time_exact ?? trade.exit_time,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestPanelData.test.ts -t "prefers exit_time_exact"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/backtestPanelData.ts frontend/src/lib/backtestPanelData.test.ts
git commit -m "feat(backtest): show exact intra-bar exit time in the trades table"
```

---

### Task 6: Frontend overlay draws to the true duration on finer timeframes

**Files:**
- Modify: `frontend/src/lib/backtest.ts` (add `overlayEndTs`; wire `drawSelectionZone` ~890-942 and the highlight `segment` subscription ~1364-1374)
- Test: `frontend/src/lib/backtest.test.ts` (create if absent, else append)

**Interfaces:**
- Consumes: `Trade.exit_time_exact` (Task 5), `chart.getDataList()` bars, the existing `minPositiveGap`-derived `barMs` in `drawSelectionZone`.
- Produces: `export function overlayEndTs(exitExactMs: number, bars: readonly { timestamp: number }[], barMs: number, entryTs: number): number`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/lib/backtest.test.ts  (append; create with imports if new)
import { overlayEndTs } from "./backtest";

const bars1m = Array.from({ length: 61 }, (_, i) => ({ timestamp: 3_600_000 + i * 60_000 }));

test("overlayEndTs rounds up to the close of the hit minute candle", () => {
  // hit at minute 50 (03:50); its close boundary is minute 51.
  const exitExact = 3_600_000 + 50 * 60_000;
  const end = overlayEndTs(exitExact, bars1m, 60_000, 3_600_000);
  expect(end).toBe(3_600_000 + 51 * 60_000);
});

test("overlayEndTs floors at one bar for a first-minute exit", () => {
  const end = overlayEndTs(3_600_000, bars1m, 60_000, 3_600_000);
  expect(end).toBe(3_600_000 + 60_000); // entryTs + barMs
});

test("overlayEndTs collapses one coarse candle when display == run bar", () => {
  const bars1h = [{ timestamp: 3_600_000 }, { timestamp: 7_200_000 }];
  const exitExact = 3_600_000 + 50 * 60_000; // inside the single 1h bar
  const end = overlayEndTs(exitExact, bars1h, 3_600_000, 3_600_000);
  expect(end).toBe(7_200_000); // that bar's close boundary
});

test("overlayEndTs falls back to max(floor, exact) with no bars", () => {
  const exitExact = 3_600_000 + 50 * 60_000;
  expect(overlayEndTs(exitExact, [], 60_000, 3_600_000)).toBe(exitExact);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtest.test.ts -t overlayEndTs`
Expected: FAIL (`overlayEndTs` is not exported).

- [ ] **Step 3: Write minimal implementation**

Add near the other exported helpers in `frontend/src/lib/backtest.ts`:

```typescript
/** Right edge for a trade overlay whose exit happened at `exitExactMs`, rounded
 * UP to the close of the display candle that contains it, so the overlay covers
 * at least the trade's real duration. Floors at one display bar so a first-bar
 * exit still shows. `bars` are the currently loaded candles (ascending). */
export function overlayEndTs(
  exitExactMs: number,
  bars: readonly { timestamp: number }[],
  barMs: number,
  entryTs: number,
): number {
  const floor = entryTs + barMs;
  if (bars.length === 0) return Math.max(floor, exitExactMs);
  // The display candle containing exitExactMs is the last bar whose open <= it.
  let containing = bars[0].timestamp;
  for (const b of bars) {
    if (b.timestamp <= exitExactMs) containing = b.timestamp;
    else break;
  }
  return Math.max(floor, containing + barMs); // round up to that candle's close
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtest.test.ts -t overlayEndTs`
Expected: PASS (4 passed).

- [ ] **Step 5: Wire `overlayEndTs` into `drawSelectionZone`**

In `drawSelectionZone` (`frontend/src/lib/backtest.ts`), after `const exitTs = t.exit_time * 1000;` (line 894) add:

```typescript
  const hasExact = t.exit_time_exact != null;
  const exitPointTs = hasExact ? (t.exit_time_exact as number) * 1000 : exitTs;
```

Replace the `windowEnd` line (line 918):

```typescript
  const windowEnd = hasExact
    ? overlayEndTs(exitPointTs, data ?? [], barMs, entryTs)
    : Math.max(Math.max(entryTs, exitTs), entryTs + barMs);
```

Change the zone's exit-price point (line 928) to use the exact time:

```typescript
      { timestamp: exitPointTs, value: t.exit_price },
```

Change the scroll call (line 941):

```typescript
  scrollChartToTrade(chart, entryTs, exitPointTs);
```

- [ ] **Step 6: Wire the transient highlight `segment`**

In the `highlightTradeSignal.subscribe` block (line ~1364), change the second point so the hover line ends at the exact exit:

```typescript
      points: [
        { timestamp: t.entry_time * 1000, value: t.entry_price },
        { timestamp: (t.exit_time_exact ?? t.exit_time) * 1000, value: t.exit_price },
      ],
```

- [ ] **Step 7: Typecheck and run the frontend tests**

Run: `cd frontend && npx tsc -b && npx vitest run src/lib/backtest.test.ts src/lib/backtestPanelData.test.ts`
Expected: PASS, no type errors.

- [ ] **Step 8: Verify in the running app**

With the dev servers running, open the app, run the US100 1H backtest, and select trade #1.
- On the 1m chart: the selection overlay should span entry (03:00) to ~03:50, and the table Exit time column should read `03:50`.
- Switch the chart to 1H and back to 1m while the trade stays selected: the overlay should recompute to one 1H candle on 1H and back to the ~50-minute span on 1m. (The zone redraws from `chart.getDataList()` on each reload, so this should already hold. If the overlay does NOT recompute on the timeframe switch, note it: the fix is to redraw the selection zone when the chart data reloads, mirroring the marker reanchor path, but confirm it is actually needed before adding it.)

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/backtest.ts frontend/src/lib/backtest.test.ts
git commit -m "feat(backtest): draw trade overlay to its true duration on finer timeframes"
```

---

## Self-Review

**Spec coverage:**
- Backend canonical exact time from local 1m candles: Tasks 1, 3, 4.
- Nullable `exit_time_exact` on model/DTO/serialization, no migration: Task 2.
- Intra-bar-only scope (`stop`/`trail`/`target`): Task 1 `_INTRABAR`, tested.
- Run-tf <= minute and empty-data fallbacks: Task 1, tested.
- Same broker/side minute fetch: Task 4 `_load_minutes`.
- Table shows exact time (display + sort): Task 5 (effective `exitTime`).
- Overlay round-up to display candle, degenerates cleanly, one-bar floor: Task 6, tested.
- Transient highlight consistency: Task 6 Step 6.
- Reactivity on TF switch: Task 6 Step 8 (verify; recompute already comes from `getDataList()`).
- No backtest-number change: nothing touches pnl/exit_price/bars_held.

**Placeholder scan:** none. Every code step shows the code; every test step shows the assertions.

**Type consistency:** `resolve_exit_time` signature identical across Tasks 1 and 3. `attach_exit_times` signature matches its caller in Task 4. `exit_time_exact` typed `datetime | None` (model), `int | None` (DTO / TS `number | null`) consistently. `overlayEndTs` signature identical between its definition and the Task 6 wiring.

**Out-of-scope note:** the table's `durationBars` still uses the raw `exit_time`, so a same-bar trade shows `0.0 bars` while its exact exit reads `03:50`. This is intentional (bars_held is the engine's own count); making duration reflect the exact time is a possible later follow-up.
