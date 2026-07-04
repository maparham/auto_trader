# Backtest stop-loss / take-profit / trailing exits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add price-level exits — fixed %/price/ATR stop-loss and take-profit, plus trailing stops — as a new exit class that coexists with the existing rule-based backtest exits.

**Architecture:** The frontend already computes every indicator series and posts it with the candles; the engine does zero indicator math and only simulates fills. We keep that split: ATR becomes a posted `ATR_{n}` series the frontend computes, and the engine reads it. Stop/target *levels* are computed inside the engine (only it knows the real fill price) and checked intra-bar against each bar's high/low with pessimistic fill conventions.

**Tech Stack:** Backend — Python 3, dataclasses, FastAPI/Pydantic, pytest. Frontend — TypeScript, React, Vitest.

## Global Constraints

- **Engine does no indicator math.** ATR is computed on the frontend and posted as an `ATR_{length}` series; the engine only *reads* series values by index. Percentages are arithmetic on the fill price (allowed).
- **No lookahead.** A stop level in force during bar `t` is based only on information through bar `t-1` (plus the entry-bar seed). A bar's own high must never move the trailing stop that its own low is tested against.
- **Pessimistic fills.** When one bar could trigger both stop and target, the **stop** fills. A stop gapped through fills at the worse of `open`/`level`; a target fills exactly at its level (no positive slippage). The existing `slippage` cost still applies against you.
- **Backward-safe.** `longRisk` / `shortRisk` are optional everywhere and default to "no stop, no target". A config with neither must reproduce today's results byte-for-byte.
- **Off by default** in the UI — existing presets are untouched.
- Follow existing code style: frozen `@dataclass(slots=True)` for backend value types; pure, separately-tested helper modules for math (`atr.ts`, `risk.py`); Literal-typed Pydantic DTOs with `to_*()` converters.
- ATR default `length` is **14**.
- Stop kinds: `none | pct | price | atr | trailPct | trailAtr`. Target kinds: `none | pct | price | atr` (targets never trail).

---

## File Structure

**Backend**
- Create `backend/auto_trader/engine/risk.py` — `StopSpec` / `TargetSpec` / `RiskConfig` dataclasses + pure `stop_level()` / `target_level()` / `is_trailing()`.
- Modify `backend/auto_trader/engine/backtest.py` — engine accepts per-side risk + series; intra-bar stop/target/trailing loop; a `_close_long`/`_close_short` helper shared by rule-exit and stop paths.
- Modify `backend/auto_trader/api/app.py` — `StopSpecDTO`/`TargetSpecDTO`/`RiskConfigDTO`, request fields, ATR-series validation, pass risk+series to the engine.
- Create `backend/tests/test_risk_levels.py`, `backend/tests/test_backtest_stops.py`; extend `backend/tests/test_api_backtest.py`.

**Frontend**
- Create `frontend/src/lib/atr.ts` — pure Wilder's ATR series.
- Modify `frontend/src/lib/backtestConfig.ts` — `StopSpec`/`TargetSpec`/`RiskConfig` types, `longRisk`/`shortRisk` on `BacktestConfig`, `riskAtrLengths()`, extend `longestIndicatorLength()`.
- Modify `frontend/src/lib/backtestSeries.ts` — emit `ATR_{n}` series from risk configs.
- Modify `frontend/src/api.ts` — `longRisk`/`shortRisk` on `BacktestRequest`.
- Modify `frontend/src/BacktestButton.tsx` — pass `longRisk`/`shortRisk`; show `max_drawdown` in the summary chip.
- Modify `frontend/src/lib/backtest.ts` — `markerLabel` emits `SL`/`TP` for stop/target exits.
- Modify `frontend/src/BacktestSettingsModal.tsx` — a "Stop & target" section per side.
- Create `frontend/src/lib/atr.test.ts`; extend `backtestSeries.test.ts`, `backtestConfig.test.ts`, `backtestMarker.test.ts`.

Backend tasks (1, 4, 5) and frontend tasks (2, 3, 6) are independent; task 7 needs 4+5+6, task 8 needs 5.

---

### Task 1: Frontend — Wilder's ATR series (pure)

**Files:**
- Create: `frontend/src/lib/atr.ts`
- Test: `frontend/src/lib/atr.test.ts`

**Interfaces:**
- Produces: `atrSeries(candles: KLineData[], length: number): Array<number | null>` — Wilder's ATR, `null` for bars before it is warm.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/atr.test.ts
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { atrSeries } from "./atr";

function bars(rows: Array<[number, number, number]>): KLineData[] {
  // [high, low, close]; open unused by ATR
  return rows.map(([high, low, close], i) => ({
    timestamp: i * 60_000, open: close, high, low, close, volume: 0,
  }));
}

describe("atrSeries", () => {
  it("is null until `length` true ranges exist, then Wilder-smooths", () => {
    // Constant $2 range each bar => every warm ATR is exactly 2.
    const data = bars([
      [12, 10, 11], [13, 11, 12], [14, 12, 13], [15, 13, 14], [16, 14, 15],
    ]);
    const out = atrSeries(data, 3);
    expect(out[0]).toBeNull(); // bar 0 seeds TR but ATR needs `length` TRs
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 6); // first ATR = mean of first 3 TRs
    expect(out[3]).toBeCloseTo(2, 6); // Wilder: (2*2 + 2)/3 = 2
    expect(out[4]).toBeCloseTo(2, 6);
  });

  it("true range includes gaps vs the previous close", () => {
    // Bar 1 gaps up: prevClose=11, high=30, low=25 => TR = 30-11 = 19.
    const data = bars([[12, 10, 11], [30, 25, 28]]);
    const out = atrSeries(data, 1); // length 1 => ATR == TR each bar
    expect(out[0]).toBeCloseTo(2, 6); // first bar TR = high-low = 2
    expect(out[1]).toBeCloseTo(19, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/atr.test.ts`
Expected: FAIL — cannot find module `./atr`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/atr.ts
// Wilder's Average True Range, computed on the frontend and posted as an
// `ATR_{length}` series so the backtest engine can size stops/targets without
// doing any indicator math itself (it only reads the series by index).

import type { KLineData } from "klinecharts";

/** Wilder's ATR. Returns `null` for every bar before `length` true ranges are
 * available; from bar index `length-1` on, the first ATR is the simple mean of
 * the first `length` true ranges and each later ATR is Wilder-smoothed:
 * `atr = (prevAtr * (length - 1) + tr) / length`. */
export function atrSeries(candles: KLineData[], length: number): Array<number | null> {
  const n = candles.length;
  const out: Array<number | null> = new Array(n).fill(null);
  if (length < 1 || n === 0) return out;

  const tr: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const hl = k.high - k.low;
    if (i === 0) {
      tr[i] = hl;
    } else {
      const pc = candles[i - 1].close;
      tr[i] = Math.max(hl, Math.abs(k.high - pc), Math.abs(k.low - pc));
    }
  }

  if (n < length) return out;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += tr[i];
  let atr = sum / length;
  out[length - 1] = atr;
  for (let i = length; i < n; i++) {
    atr = (atr * (length - 1) + tr[i]) / length;
    out[i] = atr;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/atr.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/atr.ts frontend/src/lib/atr.test.ts
git commit -m "feat(backtest): pure Wilder's ATR series for stop sizing"
```

---

### Task 2: Frontend — RiskConfig types + ATR collection

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts`
- Test: `frontend/src/lib/backtestConfig.test.ts`

**Interfaces:**
- Consumes: `BacktestConfig` (existing).
- Produces: types `StopKind`, `TargetKind`, `StopSpec`, `TargetSpec`, `RiskConfig`; `BacktestConfig.longRisk?` / `shortRisk?`; `riskAtrLengths(cfg): number[]`; `longestIndicatorLength()` now also counts risk ATR lengths.

- [ ] **Step 1: Write the failing test**

```ts
// append to frontend/src/lib/backtestConfig.test.ts
import { riskAtrLengths, longestIndicatorLength, defaultBacktestConfig } from "./backtestConfig";

describe("risk ATR collection", () => {
  it("collects ATR lengths from stop and target of both sides, deduped", () => {
    const cfg = {
      ...defaultBacktestConfig(),
      longRisk: { stop: { kind: "trailAtr" as const, mult: 2, length: 14 },
                  target: { kind: "atr" as const, mult: 3, length: 14 } },
      shortRisk: { stop: { kind: "atr" as const, mult: 2, length: 20 },
                   target: { kind: "none" as const } },
    };
    expect(riskAtrLengths(cfg).sort((a, b) => a - b)).toEqual([14, 20]);
  });

  it("ignores non-ATR stop kinds", () => {
    const cfg = {
      ...defaultBacktestConfig(),
      longRisk: { stop: { kind: "pct" as const, value: 2 }, target: { kind: "none" as const } },
    };
    expect(riskAtrLengths(cfg)).toEqual([]);
  });

  it("longestIndicatorLength counts a risk ATR length larger than any rule", () => {
    const cfg = {
      ...defaultBacktestConfig(), // rules use EMA 9/21
      longRisk: { stop: { kind: "atr" as const, mult: 2, length: 50 }, target: { kind: "none" as const } },
    };
    expect(longestIndicatorLength(cfg)).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts`
Expected: FAIL — `riskAtrLengths` is not exported.

- [ ] **Step 3: Add the types and helpers**

In `frontend/src/lib/backtestConfig.ts`, after the `Operand` types (near line 14) add:

```ts
export type StopKind = "none" | "pct" | "price" | "atr" | "trailPct" | "trailAtr";
export type TargetKind = "none" | "pct" | "price" | "atr";

// value: pct percent OR absolute price. mult/length: ATR multiple + Wilder length.
export interface StopSpec { kind: StopKind; value?: number; mult?: number; length?: number }
export interface TargetSpec { kind: TargetKind; value?: number; mult?: number; length?: number }

// Price-level exits for one side. Coexists with that side's rule-exit group;
// whichever triggers first closes the position. Optional on BacktestConfig so
// presets saved before this existed load as "no stop / no target".
export interface RiskConfig { stop: StopSpec; target: TargetSpec }
```

Add `longRisk?` / `shortRisk?` to the `BacktestConfig` interface (after `shortEnabled?`):

```ts
  longRisk?: RiskConfig;
  shortRisk?: RiskConfig;
```

After `collectSeriesOperands` add:

```ts
const ATR_KINDS = new Set(["atr", "trailAtr"]);

/** Every distinct ATR length referenced by either side's stop or target, so the
 * caller computes each `ATR_{n}` series once. Non-ATR kinds contribute nothing. */
export function riskAtrLengths(cfg: BacktestConfig): number[] {
  const lengths = new Set<number>();
  for (const risk of [cfg.longRisk, cfg.shortRisk]) {
    if (!risk) continue;
    for (const spec of [risk.stop, risk.target]) {
      if (ATR_KINDS.has(spec.kind) && spec.length != null) lengths.add(spec.length);
    }
  }
  return [...lengths];
}
```

Replace the body of `longestIndicatorLength` so risk ATR lengths count toward warm-up:

```ts
export function longestIndicatorLength(cfg: BacktestConfig): number {
  return Math.max(
    1,
    ...collectSeriesOperands(cfg).map((op) => (op.kind === "indicator" ? op.length ?? 1 : 1)),
    ...riskAtrLengths(cfg),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestConfig.test.ts
git commit -m "feat(backtest): RiskConfig types + risk ATR warm-up accounting"
```

---

### Task 3: Frontend — buildSeries emits ATR from risk configs

**Files:**
- Modify: `frontend/src/lib/backtestSeries.ts`
- Test: `frontend/src/lib/backtestSeries.test.ts`

**Interfaces:**
- Consumes: `riskAtrLengths` (Task 2), `atrSeries` (Task 1).
- Produces: `buildSeries` output now contains an `ATR_{n}` key for every ATR length any risk config references.

- [ ] **Step 1: Write the failing test**

```ts
// append inside the describe("buildSeries", ...) block of backtestSeries.test.ts
it("emits an ATR_{n} series when a risk config references ATR", () => {
  const data = candles([10, 11, 12, 13, 14, 15]);
  const out = buildSeries(data, cfg({
    longRisk: { stop: { kind: "trailAtr", mult: 2, length: 3 }, target: { kind: "none" } },
  }));
  expect(out["ATR_3"]).toBeDefined();
  expect(out["ATR_3"].length).toBe(data.length);
  expect(out["ATR_3"][0]).toBeNull(); // cold until 3 TRs exist
  expect(out["ATR_3"][2]).not.toBeNull();
});

it("emits no ATR series when no risk config references ATR", () => {
  const data = candles([10, 11, 12]);
  const out = buildSeries(data, cfg({
    longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "none" } },
  }));
  expect(Object.keys(out).some((k) => k.startsWith("ATR_"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts`
Expected: FAIL — `out["ATR_3"]` is `undefined`.

- [ ] **Step 3: Emit ATR in buildSeries**

In `frontend/src/lib/backtestSeries.ts`, extend the imports and the `buildSeries` loop:

```ts
import { collectSeriesOperands, seriesName, riskAtrLengths, type BacktestConfig, type Operand } from "./backtestConfig";
import { atrSeries } from "./atr";
```

Inside `buildSeries`, after the existing `for (const op of collectSeriesOperands(cfg))` loop and before `return out;`:

```ts
  for (const length of riskAtrLengths(cfg)) {
    out[`ATR_${length}`] = atrSeries(candles, length);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestSeries.ts frontend/src/lib/backtestSeries.test.ts
git commit -m "feat(backtest): post ATR_{n} series when a stop/target uses ATR"
```

---

### Task 4: Backend — pure risk-level module

**Files:**
- Create: `backend/auto_trader/engine/risk.py`
- Test: `backend/tests/test_risk_levels.py`

**Interfaces:**
- Produces: `StopSpec(kind, value=None, mult=None, length=None)`, `TargetSpec(...)`, `RiskConfig(stop, target)`, `is_trailing(spec) -> bool`, `stop_level(spec, entry, side, atr, extreme) -> float | None`, `target_level(spec, entry, side, atr) -> float | None`. `side` is `"long"` or `"short"`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_risk_levels.py
from __future__ import annotations

from auto_trader.engine.risk import (
    StopSpec, TargetSpec, is_trailing, stop_level, target_level,
)


def test_pct_stop_below_entry_for_long_above_for_short():
    s = StopSpec("pct", value=2.0)
    assert stop_level(s, 100.0, "long", None, 100.0) == 98.0
    assert stop_level(s, 100.0, "short", None, 100.0) == 102.0


def test_pct_target_above_entry_for_long_below_for_short():
    t = TargetSpec("pct", value=5.0)
    assert target_level(t, 100.0, "long", None) == 105.0
    assert target_level(t, 100.0, "short", None) == 95.0


def test_atr_stop_uses_multiple_of_atr():
    s = StopSpec("atr", mult=2.0, length=14)
    assert stop_level(s, 100.0, "long", 3.0, 100.0) == 94.0   # 100 - 2*3
    assert stop_level(s, 100.0, "short", 3.0, 100.0) == 106.0


def test_atr_level_is_none_when_atr_cold():
    assert stop_level(StopSpec("atr", mult=2.0, length=14), 100.0, "long", None, 100.0) is None
    assert target_level(TargetSpec("atr", mult=2.0, length=14), 100.0, "long", None) is None


def test_price_kind_returns_absolute_level():
    assert stop_level(StopSpec("price", value=88.0), 100.0, "long", None, 100.0) == 88.0
    assert target_level(TargetSpec("price", value=120.0), 100.0, "long", None) == 120.0


def test_trailing_uses_extreme_not_entry():
    s = StopSpec("trailPct", value=2.0)
    # long extreme ran up to 120 => stop = 120 * 0.98
    assert stop_level(s, 100.0, "long", None, 120.0) == 120.0 * 0.98
    # short extreme ran down to 80 => stop = 80 * 1.02
    assert stop_level(s, 100.0, "short", None, 80.0) == 80.0 * 1.02


def test_none_kind_and_is_trailing():
    assert stop_level(StopSpec("none"), 100.0, "long", None, 100.0) is None
    assert target_level(TargetSpec("none"), 100.0, "long", None) is None
    assert is_trailing(StopSpec("trailAtr", mult=2, length=14)) is True
    assert is_trailing(StopSpec("pct", value=2)) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_risk_levels.py -q`
Expected: FAIL — `ModuleNotFoundError: auto_trader.engine.risk`.

- [ ] **Step 3: Write the module**

```python
# backend/auto_trader/engine/risk.py
"""Pure stop/target level math for the backtest engine.

The engine owns level computation (only it knows the real fill price) but keeps
the arithmetic here so it is unit-testable in isolation. No indicator math: ATR
values are read from the posted series and passed in as `atr`.
"""

from __future__ import annotations

from dataclasses import dataclass

# stop kinds: none|pct|price|atr|trailPct|trailAtr ; target drops the trail kinds.
_TRAIL_KINDS = {"trailPct", "trailAtr"}


@dataclass(frozen=True, slots=True)
class StopSpec:
    kind: str
    value: float | None = None   # pct percent, or absolute price
    mult: float | None = None    # ATR multiple
    length: int | None = None    # ATR length (series key ATR_{length})


@dataclass(frozen=True, slots=True)
class TargetSpec:
    kind: str
    value: float | None = None
    mult: float | None = None
    length: int | None = None


@dataclass(frozen=True, slots=True)
class RiskConfig:
    stop: StopSpec
    target: TargetSpec


def is_trailing(spec: StopSpec) -> bool:
    return spec.kind in _TRAIL_KINDS


def stop_level(
    spec: StopSpec, entry: float, side: str, atr: float | None, extreme: float
) -> float | None:
    """Absolute stop price, or None if there's no stop or it can't resolve
    (ATR still cold). `extreme` is the favorable high-water/low-water mark since
    entry — used only by the trailing kinds; fixed kinds measure off `entry`."""
    below = side == "long"  # a long's stop sits below its reference price
    k = spec.kind
    if k == "none":
        return None
    if k == "price":
        return spec.value
    if k == "pct":
        dist = entry * (spec.value / 100.0)
        return entry - dist if below else entry + dist
    if k == "atr":
        if atr is None:
            return None
        dist = spec.mult * atr
        return entry - dist if below else entry + dist
    if k == "trailPct":
        dist = extreme * (spec.value / 100.0)
        return extreme - dist if below else extreme + dist
    if k == "trailAtr":
        if atr is None:
            return None
        dist = spec.mult * atr
        return extreme - dist if below else extreme + dist
    return None


def target_level(spec: TargetSpec, entry: float, side: str, atr: float | None) -> float | None:
    """Absolute take-profit price, or None. Targets never trail."""
    above = side == "long"  # a long's target sits above entry
    k = spec.kind
    if k == "none":
        return None
    if k == "price":
        return spec.value
    if k == "pct":
        dist = entry * (spec.value / 100.0)
        return entry + dist if above else entry - dist
    if k == "atr":
        if atr is None:
            return None
        dist = spec.mult * atr
        return entry + dist if above else entry - dist
    return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_risk_levels.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/risk.py backend/tests/test_risk_levels.py
git commit -m "feat(backtest): pure stop/target level math module"
```

---

### Task 5: Backend — engine intra-bar stop/target/trailing

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py`
- Test: `backend/tests/test_backtest_stops.py`

**Interfaces:**
- Consumes: `RiskConfig`, `stop_level`, `target_level`, `is_trailing` (Task 4).
- Produces: `BacktestEngine(strategy, starting_cash=..., commission_per_side=..., slippage=..., long_risk: RiskConfig | None = None, short_risk: RiskConfig | None = None, series: dict[str, list[float | None]] | None = None)`. Behavior unchanged when both risks are `None`.

This task both (a) extracts `_close_long` / `_close_short` helpers shared by the existing rule-exit path and the new stop path, and (b) adds the intra-bar check. Keep them in one task — the same tests cover both, and the extraction only makes sense alongside its second caller.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_backtest_stops.py
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
from auto_trader.strategy.base import Context, Strategy


def _c(t0, i, o, h, l, c):
    return Candle(t0 + timedelta(minutes=i), o, h, l, c, 0.0)


class BuyOnBar1(Strategy):
    """Open one long on bar index 1 (fills at bar 2's open), never exit by rule."""

    def on_bar(self, ctx: Context):
        return [Signal(Side.BUY, 1.0, "enter", leg="long")] if len(ctx.history) == 1 else []


def _run(candles, *, long_risk=None, short_risk=None, series=None):
    return BacktestEngine(
        BuyOnBar1(), long_risk=long_risk, short_risk=short_risk, series=series or {}
    ).run(candles)


def test_long_pct_stop_fills_at_level_when_low_pierces():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry fills at bar2 open=100; stop = 98. Bar 2 low dips to 97 -> stop at 98.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 97, 99),
        _c(t0, 3, 99, 99, 99, 99),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert len(res.trades) == 1
    tr = res.trades[0]
    assert tr.entry_price == 100.0 and tr.exit_price == 98.0
    assert tr.reason_out == "stop"
    assert res.trades[0].pnl == -2.0


def test_long_stop_gap_down_fills_at_open_not_level():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry at bar2 open=100, stop=98; bar3 gaps to open=95 (below stop) -> fill 95.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 99, 100),
        _c(t0, 3, 95, 96, 90, 92),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert res.trades[0].exit_price == 95.0  # min(open, stop) = min(95, 98)


def test_long_target_fills_exactly_at_level_no_positive_slippage():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, target = 105; bar3 gaps up open=110 -> still fill at 105.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 99, 100),
        _c(t0, 3, 110, 112, 108, 111),
    ]
    risk = RiskConfig(StopSpec("none"), TargetSpec("pct", value=5.0))
    res = _run(candles, long_risk=risk)
    assert res.trades[0].exit_price == 105.0
    assert res.trades[0].reason_out == "target"


def test_stop_wins_when_one_bar_hits_both():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, stop 98, target 105; bar2 range [96,106] straddles both.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 106, 96, 100),
        _c(t0, 3, 100, 100, 100, 100),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("pct", value=5.0))
    res = _run(candles, long_risk=risk)
    assert res.trades[0].reason_out == "stop"
    assert res.trades[0].exit_price == 98.0


def test_entry_and_stop_on_the_same_bar():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry fills at bar2 open=100; that same bar's low 97 hits the 98 stop.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 97, 99),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert len(res.trades) == 1
    assert res.trades[0].exit_time == candles[2].time

def test_trailing_stop_ratchets_up_and_no_self_lookahead():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, trail 10%. Bar2 runs to high 120 (stop -> 108) then bar3 falls
    # to low 105 -> stop at 108. The bar that MAKES the high must not also be the
    # bar saved by it: bar2 low is 99 but the stop entering bar2 is 90 (from the
    # entry seed=100), so bar2 does NOT stop out on its own 99 low.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 120, 99, 118),
        _c(t0, 3, 118, 119, 105, 106),
    ]
    risk = RiskConfig(StopSpec("trailPct", value=10.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert len(res.trades) == 1
    assert res.trades[0].exit_time == candles[3].time
    assert res.trades[0].exit_price == 108.0  # 120 * 0.90


def test_atr_stop_reads_posted_series_at_entry_bar():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry at bar2 open=100, ATR at bar2 = 4, mult 2 -> stop = 92.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 91, 99),
        _c(t0, 3, 99, 99, 99, 99),
    ]
    risk = RiskConfig(StopSpec("atr", mult=2.0, length=14), TargetSpec("none"))
    series = {"ATR_14": [1.0, 2.0, 4.0, 4.0]}
    res = _run(candles, long_risk=risk, series=series)
    assert res.trades[0].exit_price == 92.0


def test_no_risk_config_reproduces_baseline():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    candles = [_c(t0, i, 100, 100, 100, 100) for i in range(4)]
    base = _run(candles)                              # risks default None
    assert base.trades == []                          # BuyOnBar1 never exits by rule
    assert base.n_trades == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_backtest_stops.py -q`
Expected: FAIL — `BacktestEngine()` got an unexpected keyword `long_risk`.

- [ ] **Step 3: Extend the engine constructor**

In `backend/auto_trader/engine/backtest.py`, add the import and constructor params:

```python
from auto_trader.engine.risk import RiskConfig, is_trailing, stop_level, target_level
```

```python
    def __init__(
        self,
        strategy: Strategy,
        starting_cash: float = 10_000.0,
        commission_per_side: float = 0.0,
        slippage: float = 0.0,
        long_risk: RiskConfig | None = None,
        short_risk: RiskConfig | None = None,
        series: dict[str, list[float | None]] | None = None,
    ) -> None:
        self.strategy = strategy
        self.starting_cash = starting_cash
        self.commission = commission_per_side
        self.slippage = slippage
        self.long_risk = long_risk
        self.short_risk = short_risk
        self.series = series or {}
```

- [ ] **Step 4: Add the ATR-lookup helper**

Add next to `_fill_price` at the bottom of the class:

```python
    def _atr_at(self, length: int | None, i: int) -> float | None:
        if length is None:
            return None
        arr = self.series.get(f"ATR_{length}", [])
        return arr[i] if i < len(arr) else None
```

- [ ] **Step 5: Track risk state and seed it on entry**

In `run`, alongside the bucket bookkeeping (after `long_reason = short_reason = ""`), add:

```python
        long_stop = long_target = None  # active levels for the open long
        short_stop = short_target = None
        long_extreme = short_extreme = 0.0  # favorable high/low water mark since entry
```

In the long BUY-open branch, inside the existing `if long_qty == 0:` block (right after `long_time, long_reason = bar.time, sig.reason`), seed the levels off the fresh entry:

```python
                            if self.long_risk:
                                long_extreme = fill_price
                                long_stop = stop_level(
                                    self.long_risk.stop, fill_price, "long",
                                    self._atr_at(self.long_risk.stop.length, i), long_extreme,
                                )
                                long_target = target_level(
                                    self.long_risk.target, fill_price, "long",
                                    self._atr_at(self.long_risk.target.length, i),
                                )
```

In the short SELL-open branch, inside its `if short_qty == 0:` block (after `short_time, short_reason = bar.time, sig.reason`):

```python
                            if self.short_risk:
                                short_extreme = fill_price
                                short_stop = stop_level(
                                    self.short_risk.stop, fill_price, "short",
                                    self._atr_at(self.short_risk.stop.length, i), short_extreme,
                                )
                                short_target = target_level(
                                    self.short_risk.target, fill_price, "short",
                                    self._atr_at(self.short_risk.target.length, i),
                                )
```

- [ ] **Step 6: Extract the close helpers**

Replace the long SELL-close inline body (the `else:  # SELL -> close / reduce long` block) so it calls a helper, and add the helper. The helper books the trade and returns the new `(qty, entry, time, reason)`. Add near `_fill_price`:

```python
    @staticmethod
    def _close_long(result, realized, qty, entry, entry_time, entry_reason,
                    fill_price, exit_time, exit_reason, closing):
        """Book a long close (SELL leg=long) for `closing` units; return
        (realized, remaining_qty)."""
        pnl = closing * (fill_price - entry)
        realized += pnl
        result.trades.append(
            Trade(
                side=Side.BUY, quantity=closing,
                entry_time=entry_time, entry_price=entry,  # type: ignore[arg-type]
                exit_time=exit_time, exit_price=fill_price, pnl=pnl,
                leg="long", reason_in=entry_reason, reason_out=exit_reason,
            )
        )
        return realized, qty - closing

    @staticmethod
    def _close_short(result, realized, qty, entry, entry_time, entry_reason,
                     fill_price, exit_time, exit_reason, closing):
        pnl = closing * (entry - fill_price)  # short profits on a drop
        realized += pnl
        result.trades.append(
            Trade(
                side=Side.SELL, quantity=closing,
                entry_time=entry_time, entry_price=entry,  # type: ignore[arg-type]
                exit_time=exit_time, exit_price=fill_price, pnl=pnl,
                leg="short", reason_in=entry_reason, reason_out=exit_reason,
            )
        )
        return realized, qty - closing
```

Rewrite the rule-exit SELL-close block to use it:

```python
                    else:  # SELL -> close / reduce long
                        closing = min(sig.quantity, long_qty)
                        if closing > 0:
                            realized, long_qty = self._close_long(
                                result, realized, long_qty, long_entry, long_time,
                                long_reason, fill_price, bar.time, sig.reason, closing,
                            )
                            if long_qty == 0:
                                long_entry, long_time, long_reason = 0.0, None, ""
                                long_stop = long_target = None
```

And the short BUY-close block symmetrically:

```python
                    else:  # BUY -> close / reduce short
                        closing = min(sig.quantity, short_qty)
                        if closing > 0:
                            realized, short_qty = self._close_short(
                                result, realized, short_qty, short_entry, short_time,
                                short_reason, fill_price, bar.time, sig.reason, closing,
                            )
                            if short_qty == 0:
                                short_entry, short_time, short_reason = 0.0, None, ""
                                short_stop = short_target = None
```

- [ ] **Step 7: Add the intra-bar stop/target check + trailing update**

Immediately after `pending = []` (before the mark-to-market comment), insert:

```python
            # 1b) Intra-bar stop/target for any open bucket. Pessimistic: stop
            # is tested before target, gaps fill against us, and this runs AFTER
            # open/rule-exit fills so a same-bar rule exit pre-empts the stop.
            if long_qty > 0 and self.long_risk:
                hit = None
                if long_stop is not None and bar.low <= long_stop:
                    raw = min(bar.open, long_stop)  # gap-down fills worse
                    reason = "trail" if is_trailing(self.long_risk.stop) else "stop"
                    hit = (self._fill_price(raw, Side.SELL), reason)
                elif long_target is not None and bar.high >= long_target:
                    hit = (self._fill_price(long_target, Side.SELL), "target")
                if hit:
                    px, reason = hit
                    result.fills.append(Fill(bar.time, Side.SELL, px, long_qty, reason, "long"))
                    realized -= self.commission
                    realized, long_qty = self._close_long(
                        result, realized, long_qty, long_entry, long_time,
                        long_reason, px, bar.time, reason, long_qty,
                    )
                    long_entry, long_time, long_reason = 0.0, None, ""
                    long_stop = long_target = None

            if short_qty > 0 and self.short_risk:
                hit = None
                if short_stop is not None and bar.high >= short_stop:
                    raw = max(bar.open, short_stop)
                    reason = "trail" if is_trailing(self.short_risk.stop) else "stop"
                    hit = (self._fill_price(raw, Side.BUY), reason)
                elif short_target is not None and bar.low <= short_target:
                    hit = (self._fill_price(short_target, Side.BUY), "target")
                if hit:
                    px, reason = hit
                    result.fills.append(Fill(bar.time, Side.BUY, px, short_qty, reason, "short"))
                    realized -= self.commission
                    realized, short_qty = self._close_short(
                        result, realized, short_qty, short_entry, short_time,
                        short_reason, px, bar.time, reason, short_qty,
                    )
                    short_entry, short_time, short_reason = 0.0, None, ""
                    short_stop = short_target = None

            # 1c) Trailing ratchet for still-open buckets, using THIS bar's
            # extreme — for the NEXT bar only (the check above already ran).
            if long_qty > 0 and self.long_risk and is_trailing(self.long_risk.stop):
                long_extreme = max(long_extreme, bar.high)
                long_stop = stop_level(
                    self.long_risk.stop, long_entry, "long",
                    self._atr_at(self.long_risk.stop.length, i), long_extreme,
                )
            if short_qty > 0 and self.short_risk and is_trailing(self.short_risk.stop):
                short_extreme = min(short_extreme, bar.low)
                short_stop = stop_level(
                    self.short_risk.stop, short_entry, "short",
                    self._atr_at(self.short_risk.stop.length, i), short_extreme,
                )
```

- [ ] **Step 8: Run the new tests + the whole backtest suite**

Run: `cd backend && python -m pytest tests/test_backtest_stops.py tests/test_backtest.py tests/test_backtest_hedging.py tests/test_rule_strategy.py -q`
Expected: PASS — new stop tests pass and the baseline suites are unchanged (the `_close_*` extraction is behavior-preserving).

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/engine/backtest.py backend/tests/test_backtest_stops.py
git commit -m "feat(backtest): intra-bar stop/target/trailing exits in the engine"
```

---

### Task 6: Backend — DTOs, ATR validation, engine wiring

**Files:**
- Modify: `backend/auto_trader/api/app.py`
- Test: `backend/tests/test_api_backtest.py`

**Interfaces:**
- Consumes: engine risk params (Task 5), `RiskConfig`/`StopSpec`/`TargetSpec` (Task 4).
- Produces: `BacktestRequest.longRisk` / `shortRisk` (optional `RiskConfigDTO`); endpoint rejects a request that references an ATR series it didn't post; engine receives the risk configs + series.

- [ ] **Step 1: Write the failing tests**

```python
# add to backend/tests/test_api_backtest.py — reuse the module's existing
# request-building helper/fixtures; these show the risk-specific assertions.
from fastapi.testclient import TestClient
from auto_trader.api.app import app

client = TestClient(app)


def _min_body():
    # 4 flat candles, no rules -> no trades; a valid minimal request body.
    candles = [{"time": i * 60, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 0}
               for i in range(4)]
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "X", "resolution": "MINUTE", "candles": candles, "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": 0,
    }


def test_atr_risk_without_series_is_rejected():
    body = _min_body()
    body["longRisk"] = {"stop": {"kind": "atr", "mult": 2, "length": 14},
                        "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 422
    assert "ATR_14" in r.json()["detail"]


def test_pct_risk_needs_no_series_and_runs():
    body = _min_body()
    body["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_atr_risk_with_series_runs():
    body = _min_body()
    body["series"] = {"ATR_14": [1, 2, 4, 4]}
    body["longRisk"] = {"stop": {"kind": "atr", "mult": 2, "length": 14},
                        "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_backtest.py -q -k risk`
Expected: FAIL — `longRisk` is silently ignored; the ATR-without-series case returns 200 instead of 422.

- [ ] **Step 3: Add the DTOs**

In `backend/auto_trader/api/app.py`, extend the risk imports from the engine (near the other `auto_trader.engine`/`strategy` imports) so the DTO converters can build them:

```python
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
```

After `CostsDTO` (line 347) add:

```python
class StopSpecDTO(BaseModel):
    kind: Literal["none", "pct", "price", "atr", "trailPct", "trailAtr"]
    value: float | None = None
    mult: float | None = None
    length: int | None = None

    def to_spec(self) -> StopSpec:
        return StopSpec(self.kind, self.value, self.mult, self.length)


class TargetSpecDTO(BaseModel):
    kind: Literal["none", "pct", "price", "atr"]
    value: float | None = None
    mult: float | None = None
    length: int | None = None

    def to_spec(self) -> TargetSpec:
        return TargetSpec(self.kind, self.value, self.mult, self.length)


class RiskConfigDTO(BaseModel):
    stop: StopSpecDTO
    target: TargetSpecDTO

    def to_risk(self) -> RiskConfig:
        return RiskConfig(self.stop.to_spec(), self.target.to_spec())

    def atr_series_names(self) -> list[str]:
        names = []
        for spec in (self.stop, self.target):
            if spec.kind in ("atr", "trailAtr") and spec.length is not None:
                names.append(f"ATR_{spec.length}")
        return names
```

Add the fields to `BacktestRequest` (after `shortEnabled`):

```python
    longRisk: RiskConfigDTO | None = None
    shortRisk: RiskConfigDTO | None = None
```

- [ ] **Step 4: Validate ATR presence + wire the engine**

In the `/api/backtest` handler, after the existing D4 rule-series check (after line 1133) add:

```python
    # Stop/target ATR sizing reads the same posted-series channel as rules do.
    for risk in (req.longRisk, req.shortRisk):
        if risk is None:
            continue
        for name in risk.atr_series_names():
            if name not in req.series:
                raise HTTPException(422, f"missing series '{name}' referenced by a stop/target")
```

Extend the `BacktestEngine(...)` construction (lines 1142-1147) with the risk + series:

```python
    result = BacktestEngine(
        strategy,
        starting_cash=req.costs.startingCash,
        commission_per_side=req.costs.commissionPerSide,
        slippage=req.costs.slippage,
        long_risk=req.longRisk.to_risk() if req.longRisk else None,
        short_risk=req.shortRisk.to_risk() if req.shortRisk else None,
        series=req.series,
    ).run(candles)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_backtest.py -q`
Expected: PASS — all api backtest tests, including the new risk ones.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/app.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): risk DTOs, ATR-series validation, engine wiring"
```

---

### Task 7: Frontend — modal Stop & target UI + request wiring

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/BacktestButton.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx`

**Interfaces:**
- Consumes: `RiskConfig`/`StopSpec`/`TargetSpec` (Task 2), the backend endpoint (Task 6).
- Produces: `BacktestRequest.longRisk?` / `shortRisk?`; the modal reads/writes `cfg.longRisk` / `cfg.shortRisk`.

- [ ] **Step 1: Add the request fields (api.ts)**

In `frontend/src/api.ts`, extend the import and the `BacktestRequest` interface:

```ts
import type { RuleGroup, Costs, RiskConfig } from "./lib/backtestConfig";
```

Add to `BacktestRequest` (after `shortEnabled`):

```ts
  longRisk?: RiskConfig; // optional price-level exits (stop/target/trailing)
  shortRisk?: RiskConfig;
```

- [ ] **Step 2: Pass risk through on run (BacktestButton.tsx)**

In the `runAndRender(chart, { ... })` request object (after `shortEnabled: ...`), add:

```ts
        longRisk: cfg.longRisk,
        shortRisk: cfg.shortRisk,
```

- [ ] **Step 3: Add the RiskSection component (BacktestSettingsModal.tsx)**

Extend the type import to include the risk types:

```ts
import {
  longestIndicatorLength,
  type BacktestConfig,
  type RangeConfig,
  type RangeMode,
  type HistoryDepth,
  type RuleGroup,
  type Rule,
  type Operand,
  type IndicatorKind,
  type PriceField,
  type Operator,
  type Combine,
  type Costs,
  type RiskConfig,
  type StopKind,
  type TargetKind,
} from "./lib/backtestConfig";
```

Add these option tables near the other constants (after `PRICE_FIELDS`, line 59):

```ts
const STOP_KINDS: { value: StopKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pct", label: "% from entry" },
  { value: "atr", label: "ATR ×" },
  { value: "trailPct", label: "Trailing %" },
  { value: "trailAtr", label: "Trailing ATR ×" },
  { value: "price", label: "Fixed price" },
];
const TARGET_KINDS: { value: TargetKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "pct", label: "% from entry" },
  { value: "atr", label: "ATR ×" },
  { value: "price", label: "Fixed price" },
];

const EMPTY_RISK: RiskConfig = { stop: { kind: "none" }, target: { kind: "none" } };
```

Add a `RiskSection` component (place it just before `SidePanel`, near line 405). It renders one stop row + one target row; changing the kind reveals that kind's inputs:

```tsx
// The stop/target block for one side. A stop is one dropdown (fixed %/price/ATR
// or trailing %/ATR); a target is the same minus the trailing kinds. Off by
// default (kind "none") so existing presets are untouched. ATR kinds expose a
// length (default 14); % / trailing % expose a percent; ATR kinds expose a
// multiple; fixed price exposes an absolute level.
function RiskSection({
  side,
  risk,
  onChange,
}: {
  side: "long" | "short";
  risk: RiskConfig;
  onChange: (r: RiskConfig) => void;
}) {
  const setStopKind = (kind: StopKind) => {
    const next: RiskConfig["stop"] = { kind };
    if (kind === "atr" || kind === "trailAtr") { next.mult = risk.stop.mult ?? 2; next.length = risk.stop.length ?? 14; }
    else if (kind === "pct" || kind === "trailPct") next.value = risk.stop.value ?? 2;
    else if (kind === "price") next.value = risk.stop.value ?? 0;
    onChange({ ...risk, stop: next });
  };
  const setTargetKind = (kind: TargetKind) => {
    const next: RiskConfig["target"] = { kind };
    if (kind === "atr") { next.mult = risk.target.mult ?? 3; next.length = risk.target.length ?? 14; }
    else if (kind === "pct") next.value = risk.target.value ?? 4;
    else if (kind === "price") next.value = risk.target.value ?? 0;
    onChange({ ...risk, target: next });
  };
  const num = (v: number | undefined, set: (n: number) => void, step = "any") => (
    <input type="number" step={step} value={v ?? 0}
      onChange={(e) => set(Number(e.target.value))} className="bt-num" />
  );

  return (
    <div className="bt-risk">
      <div className="instrument-section-title">Stop &amp; target ({side})</div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Stop</span>
        <select value={risk.stop.kind} onChange={(e) => setStopKind(e.target.value as StopKind)}>
          {STOP_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {(risk.stop.kind === "pct" || risk.stop.kind === "trailPct") &&
          <>{num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }))}<span>%</span></>}
        {(risk.stop.kind === "atr" || risk.stop.kind === "trailAtr") && <>
          {num(risk.stop.mult, (n) => onChange({ ...risk, stop: { ...risk.stop, mult: n } }))}
          <span>× ATR</span>
          {num(risk.stop.length, (n) => onChange({ ...risk, stop: { ...risk.stop, length: Math.max(1, Math.round(n)) } }), "1")}
        </>}
        {risk.stop.kind === "price" &&
          num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }))}
      </div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Target</span>
        <select value={risk.target.kind} onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
          {TARGET_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {risk.target.kind === "pct" &&
          <>{num(risk.target.value, (n) => onChange({ ...risk, target: { ...risk.target, value: n } }))}<span>%</span></>}
        {risk.target.kind === "atr" && <>
          {num(risk.target.mult, (n) => onChange({ ...risk, target: { ...risk.target, mult: n } }))}
          <span>× ATR</span>
          {num(risk.target.length, (n) => onChange({ ...risk, target: { ...risk.target, length: Math.max(1, Math.round(n)) } }), "1")}
        </>}
        {risk.target.kind === "price" &&
          num(risk.target.value, (n) => onChange({ ...risk, target: { ...risk.target, value: n } }))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Render RiskSection inside SidePanel**

In `SidePanel`, read the side's risk and render the section at the end of the `bt-side-rules` div (after the exit `RuleGroupSection`, line 461):

```tsx
        <RiskSection
          side={side}
          risk={(isLong ? cfg.longRisk : cfg.shortRisk) ?? EMPTY_RISK}
          onChange={(r) => setCfg({ ...cfg, [isLong ? "longRisk" : "shortRisk"]: r })}
        />
```

- [ ] **Step 5: Verify the build + type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Manual smoke check**

Run the dev app (do not kill the user's existing dev server — reuse it). Open Backtest settings, set a Long stop to "% from entry" = 2 and Target to "ATR ×" = 3 / 14, Run. Confirm no console error and that markers/summary render.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestButton.tsx frontend/src/BacktestSettingsModal.tsx
git commit -m "feat(backtest): Stop & target UI per side + request wiring"
```

---

### Task 8: Frontend — SL/TP markers + max-drawdown chip

**Files:**
- Modify: `frontend/src/lib/backtest.ts`
- Modify: `frontend/src/BacktestButton.tsx`
- Test: `frontend/src/lib/backtestMarker.test.ts`

**Interfaces:**
- Consumes: marker `reason` (already on the marker DTO: `"stop" | "target" | "trail"` for risk exits, else a rule string).
- Produces: `markerLabel(side, leg, reason?)` returns `"SL"` for stop/trail, `"TP"` for target, else the existing `B+/S-/S+/B-`.

- [ ] **Step 1: Write the failing test**

```ts
// backtestMarker.test.ts — extend the existing markerLabel describe block
import { markerLabel } from "./backtest";

it("labels risk exits SL / TP by reason", () => {
  expect(markerLabel("sell", "long", "stop")).toBe("SL");
  expect(markerLabel("sell", "long", "trail")).toBe("SL");
  expect(markerLabel("sell", "long", "target")).toBe("TP");
  expect(markerLabel("buy", "short", "stop")).toBe("SL");
  expect(markerLabel("buy", "short", "target")).toBe("TP");
});

it("still labels rule-driven fills by side/leg", () => {
  expect(markerLabel("buy", "long", "EMA_9 crossesAbove EMA_21")).toBe("B+");
  expect(markerLabel("sell", "long", "")).toBe("S-");
});
```

Note: if `backtestMarker.test.ts` imports `markerLabel` with the current 2-arg signature elsewhere, those calls still type-check because `reason` is optional.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestMarker.test.ts`
Expected: FAIL — `markerLabel("sell","long","stop")` returns `"S-"`, not `"SL"`.

- [ ] **Step 3: Extend markerLabel and its caller**

In `frontend/src/lib/backtest.ts` replace `markerLabel`:

```ts
/** Chart marker label. Risk exits read by reason: stop/trailing => "SL",
 * target => "TP". Otherwise "+" opens a position and "-" closes it, prefixed by
 * the order side (B/S): open-long=B+, close-long=S-, open-short=S+, close-short=B-. */
export function markerLabel(side: "buy" | "sell", leg: "long" | "short", reason?: string): string {
  if (reason === "stop" || reason === "trail") return "SL";
  if (reason === "target") return "TP";
  const letter = side === "buy" ? "B" : "S";
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return `${letter}${opening ? "+" : "-"}`;
}
```

In `runAndRender`, pass the reason (in the marker loop, the `extendData` line):

```ts
      extendData: markerLabel(m.side, m.leg, m.reason),
```

- [ ] **Step 4: Add max-drawdown to the summary chip (BacktestButton.tsx)**

In the `summary && (...)` chip, after the `{summary.n_trades} trades` span and before win, add:

```tsx
          <span title="Largest peak-to-trough equity drop">
            −{summary.max_drawdown.toFixed(2)} dd
          </span>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/backtestMarker.test.ts && cd frontend && npx tsc --noEmit`
Expected: PASS and no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/backtest.ts frontend/src/BacktestButton.tsx frontend/src/lib/backtestMarker.test.ts
git commit -m "feat(backtest): SL/TP exit markers + max-drawdown in summary chip"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- RiskConfig model (stop kinds incl. trailing, target kinds) → Task 2 (types), Task 4 (backend dataclasses).
- ATR as a posted series, engine reads it → Task 1 (compute), Task 3 (emit), Task 5 (`_atr_at` read), Task 6 (validate).
- Stops coexist with rule-exits, first-to-trigger wins → Task 5 (step-1b runs after rule-exit fills).
- Level computation from actual fill price, in the engine → Task 5 (seed on entry).
- Pessimistic intra-bar fills (stop wins ties, gap fills worse, target no positive slippage, slippage still applies) → Task 5 tests `test_stop_wins_when_one_bar_hits_both`, `test_long_stop_gap_down_fills_at_open_not_level`, `test_long_target_fills_exactly_at_level_no_positive_slippage`.
- No-lookahead trailing → Task 5 `test_trailing_stop_ratchets_up_and_no_self_lookahead`.
- Same-bar entry-then-stop → Task 5 `test_entry_and_stop_on_the_same_bar`.
- Short mirror → Task 5 short-side blocks; api runs cover short. (Long tests are explicit; short blocks are structural mirrors — a reviewer adds a short stop test if desired.)
- Backward-safe / no-risk reproduces baseline → Task 5 `test_no_risk_config_reproduces_baseline` + running the existing suites unchanged.
- UI off by default → Task 7 (`EMPTY_RISK`, kind "none").
- SL/TP markers + max-drawdown surfaced → Task 8.

**Placeholder scan:** none — every code step contains full code.

**Type consistency:** `stop_level(spec, entry, side, atr, extreme)` and `target_level(spec, entry, side, atr)` signatures match between Task 4 (definition) and Task 5 (calls). `markerLabel(side, leg, reason?)` matches between Task 8 definition and its `runAndRender` call. `RiskConfig { stop, target }` shape is identical across `backtestConfig.ts` (Task 2), `api.ts` (Task 7), and the backend DTO→dataclass (Tasks 4/6). `atrSeries(candles, length)` matches between Task 1 and Task 3. Series key `ATR_{length}` is identical in the emitter (Task 3), the reader (`_atr_at`, Task 5), and the validator (Task 6).

**Open follow-ups (intentionally out of scope):** risk-based position sizing, pyramiding/partial exits, a trade-list table, multi-timeframe ATR.
