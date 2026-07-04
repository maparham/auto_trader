# Backtest independent multi-open (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a side hold several *independent* positions at once — the engine opens a new position whenever the entry rule re-fires, bounded by a user-set max-concurrent cap and an optional spacing threshold; a rule-exit closes them all.

**Architecture:** The engine becomes the sole owner of position management. `RuleStrategy` drops its flat-gate and simply emits a BUY intent whenever the entry rule is true (and a SELL when the exit rule is true *and* the side is holding). The engine decides per BUY intent whether to open (cap + spacing) or drop it, and a rule-exit closes every open position on the side (other exit-scopes are P3). Pyramiding/merge is a later phase — in P2 an accepted open always appends a new `Position`.

**Tech Stack:** Python 3, dataclasses, FastAPI/Pydantic, pytest; TypeScript/React/Vitest.

## Global Constraints

- **Invariant #1 — defaults reproduce today byte-for-byte.** With no scaling config (or `maxConcurrent = 1`, spacing off), results are identical to P1, and the full suite (330 backend, 23 frontend backtest tests) passes unchanged. This is safe because **no existing test adds to a position** (verified: every test strategy opens once per side), so the engine capping at 1 and dropping the old merge path changes nothing observable.
- **Why the strategy gate-drop is safe:** with `maxConcurrent = 1`, a BUY intent that fires while a position is open is **rejected** by the engine before any fill/commission — the same net result as today, where `RuleStrategy` didn't emit it at all. The exit intent is emitted only when the side is holding (`ctx.position_* > 0`), so a flat side never emits a same-bar open+close.
- Engine does no indicator math — spacing's ATR is read from the posted `ATR_{length}` series via `_atr_at`, validated like the risk configs.
- **Commission per fill:** each accepted open and each position close charges one commission. For the default single-position case this equals today (one open + one close = two commissions).
- P2 introduces **independent mode only**. Pyramiding (merge) and exit-scope options (fifo/lifo/fraction) and break-even are later phases; do not build them here.
- Use `.venv/bin/python -m pytest`; frontend `npx vitest run` and `npx tsc -b` (`--noEmit` is a no-op here; ~20 pre-existing tsc errors in unrelated files are not yours).
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5`.

---

## File Structure

- Create `backend/auto_trader/engine/scaling.py` — `SpacingSpec`, `ScalingConfig` dataclasses + pure `spacing_ok()`.
- Modify `backend/auto_trader/engine/backtest.py` — engine accepts `long_scaling`/`short_scaling`; gate opens (cap + spacing), append-only `_open`, `_close_all`, per-fill commission, last-open tracking.
- Modify `backend/auto_trader/strategy/rule.py` — drop the entry flat-gate; guard exit on holding.
- Modify `backend/auto_trader/api/app.py` — `ScalingConfig` DTO, request fields, spacing-ATR validation, wiring.
- Modify `frontend/src/lib/backtestConfig.ts` — `ScalingConfig` types + `scalingAtrLengths()` + fold into `longestIndicatorLength`.
- Modify `frontend/src/lib/backtestSeries.ts` — emit spacing `ATR_{n}`.
- Modify `frontend/src/api.ts`, `frontend/src/BacktestButton.tsx` — request wiring.
- Modify `frontend/src/BacktestSettingsModal.tsx`, `frontend/src/App.css` — collapsed "Scaling & management" section.
- Tests: `backend/tests/test_scaling.py`, `backend/tests/test_backtest_multi.py`; extend `test_api_backtest.py`, `backtestConfig.test.ts`, `backtestSeries.test.ts`.

Backend tasks 1–3 are independent of frontend tasks 4–5.

---

### Task 1: Scaling config + pure spacing helper

**Files:**
- Create: `backend/auto_trader/engine/scaling.py`
- Test: `backend/tests/test_scaling.py`

**Interfaces:**
- Produces: `SpacingSpec(kind, value=None, mult=None, length=None)`, `ScalingConfig(max_concurrent=1, spacing=None)`, `spacing_ok(spec: SpacingSpec | None, last_open: float | None, fill_price: float, side: str, atr: float | None) -> bool`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_scaling.py
from auto_trader.engine.scaling import SpacingSpec, ScalingConfig, spacing_ok


def test_no_spec_or_no_prior_open_always_ok():
    assert spacing_ok(None, 100.0, 101.0, "long", None) is True
    assert spacing_ok(SpacingSpec("pct", value=1.0), None, 101.0, "long", None) is True


def test_pct_spacing_long_needs_favorable_move():
    s = SpacingSpec("pct", value=1.0)  # 1%
    assert spacing_ok(s, 100.0, 100.9, "long", None) is False  # +0.9% < 1%
    assert spacing_ok(s, 100.0, 101.0, "long", None) is True   # +1.0% ok
    assert spacing_ok(s, 100.0, 99.0, "long", None) is False   # moved against


def test_pct_spacing_short_mirror():
    s = SpacingSpec("pct", value=1.0)
    assert spacing_ok(s, 100.0, 99.0, "short", None) is True    # -1% favorable for short
    assert spacing_ok(s, 100.0, 100.5, "short", None) is False


def test_atr_spacing_uses_multiple_and_is_false_when_cold():
    s = SpacingSpec("atr", mult=2.0, length=14)
    assert spacing_ok(s, 100.0, 106.0, "long", 3.0) is True   # +6 >= 2*3
    assert spacing_ok(s, 100.0, 105.0, "long", 3.0) is False  # +5 < 6
    assert spacing_ok(s, 100.0, 106.0, "long", None) is False  # cold ATR: reject (be conservative)


def test_scaling_defaults():
    c = ScalingConfig()
    assert c.max_concurrent == 1 and c.spacing is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_scaling.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the module**

```python
# backend/auto_trader/engine/scaling.py
"""Scaling config for the backtest: how many independent positions a side may
hold and how far apart their opens must be. Pure spacing math lives here; the
engine owns the cap and calls this per candidate open."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SpacingSpec:
    kind: str            # "pct" | "atr"
    value: float | None = None   # pct: percent of last open
    mult: float | None = None    # atr: multiple
    length: int | None = None    # atr: series length (ATR_{length})


@dataclass(frozen=True, slots=True)
class ScalingConfig:
    max_concurrent: int = 1
    spacing: SpacingSpec | None = None


def spacing_ok(
    spec: SpacingSpec | None, last_open: float | None, fill_price: float,
    side: str, atr: float | None,
) -> bool:
    """True if `fill_price` is far enough in the FAVORABLE direction from the
    side's last open to permit another open. No spec or no prior open => True.
    A required-but-cold ATR => False (don't open on missing data)."""
    if spec is None or last_open is None:
        return True
    if spec.kind == "pct":
        dist = last_open * (spec.value / 100.0)
    elif spec.kind == "atr":
        if atr is None:
            return False
        dist = spec.mult * atr
    else:
        return True
    if side == "long":
        return fill_price >= last_open + dist
    return fill_price <= last_open - dist
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_scaling.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/scaling.py backend/tests/test_scaling.py
git commit -m "feat(backtest): scaling config + pure spacing helper"  # + trailers
```

---

### Task 2: Engine multi-open + strategy gate-drop

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py`
- Modify: `backend/auto_trader/strategy/rule.py`
- Test: `backend/tests/test_backtest_multi.py`

**Interfaces:**
- Consumes: `ScalingConfig`, `spacing_ok` (Task 1).
- Produces: `BacktestEngine(..., long_scaling: ScalingConfig | None = None, short_scaling: ScalingConfig | None = None)`. When `None`, defaults to `ScalingConfig()` (independent, cap 1) — behaviour identical to today. `RuleStrategy.on_bar` no longer gates entries on flat.

- [ ] **Step 1: Confirm baseline green**

Run: `cd backend && .venv/bin/python -m pytest -q` → 330 passed. Record it.

- [ ] **Step 2: Write the failing multi-open tests**

```python
# backend/tests/test_backtest_multi.py
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.scaling import ScalingConfig, SpacingSpec
from auto_trader.strategy.base import Context, Strategy


def _c(t0, i, o, h, l, c):
    return Candle(t0 + timedelta(minutes=i), o, h, l, c, 0.0)


class BuyEveryBar(Strategy):
    """Emit a BUY(long) on every bar (tests the engine cap, not the strategy)."""
    def on_bar(self, ctx: Context):
        return [Signal(Side.BUY, 1.0, "enter", leg="long")]


def test_cap_limits_concurrent_opens():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    candles = [_c(t0, i, 100, 100, 100, 100) for i in range(6)]
    res = BacktestEngine(BuyEveryBar(), long_scaling=ScalingConfig(max_concurrent=3)).run(candles)
    # BUY fires every bar; fills land from bar 1 on; only 3 ever open.
    assert len([f for f in res.fills if f.side is Side.BUY]) == 3


def test_default_cap_one_reproduces_single_position():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    candles = [_c(t0, i, 100, 100, 100, 100) for i in range(5)]
    res = BacktestEngine(BuyEveryBar()).run(candles)  # default cap 1
    assert len([f for f in res.fills if f.side is Side.BUY]) == 1


def test_spacing_rejects_until_price_moves():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # rising opens: 100,101,102,... ; 1% spacing lets each successive bar open.
    candles = [_c(t0, i, 100 + i, 100 + i, 100 + i, 100 + i) for i in range(5)]
    scaling = ScalingConfig(max_concurrent=5, spacing=SpacingSpec("pct", value=0.5))
    res = BacktestEngine(BuyEveryBar(), long_scaling=scaling).run(candles)
    assert len([f for f in res.fills if f.side is Side.BUY]) >= 2  # opens spaced by the rise

    flat = [_c(t0, i, 100, 100, 100, 100) for i in range(5)]
    res2 = BacktestEngine(BuyEveryBar(), long_scaling=scaling).run(flat)
    assert len([f for f in res2.fills if f.side is Side.BUY]) == 1  # never moves -> one open
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_backtest_multi.py -q`
Expected: FAIL — `long_scaling` is not a valid kwarg / cap not enforced.

- [ ] **Step 4: Engine — accept `*_scaling`, gate opens, close-all, per-fill commission, last-open tracking**

In `backend/auto_trader/engine/backtest.py`:

Add the import:

```python
from auto_trader.engine.scaling import ScalingConfig, spacing_ok
```

Extend `__init__` (after `series=...`):

```python
        long_scaling: ScalingConfig | None = None,
        short_scaling: ScalingConfig | None = None,
```
and in the body:
```python
        self.long_scaling = long_scaling or ScalingConfig()
        self.short_scaling = short_scaling or ScalingConfig()
```

Replace `_open_or_add` with an append-only `_open` (independent mode; merge is a later phase):

```python
    def _open(self, positions, side, risk, fill_price, bar_time, reason, qty, i):
        """Open a NEW independent position; seed its stop/target/extreme from the
        fill price. (Pyramiding/merge is a later phase.)"""
        p = Position(qty=qty, entry=fill_price, open_time=bar_time, open_reason=reason)
        if risk:
            p.extreme = fill_price
            p.stop = stop_level(risk.stop, fill_price, side, self._atr_at(risk.stop.length, i), p.extreme)
            p.target = target_level(risk.target, fill_price, side, self._atr_at(risk.target.length, i))
        positions.append(p)
```

Add `_close_all` (P2 rule-exit scope = all):

```python
    def _close_all(self, positions, side, result, realized, close_side, fill_price, bar_time, reason):
        """Close EVERY open position on the side (P2 exit scope). One fill +
        commission + Trade per position. Returns updated realized."""
        while positions:
            result.fills.append(Fill(bar_time, close_side, fill_price, positions[0].qty, reason, side))
            realized -= self.commission
            realized = self._reduce(positions, side, result, realized, fill_price, bar_time, reason, positions[0].qty)
        return realized
```

Add last-open tracking state + the accept check. Near the top of `run()` add:

```python
        last_long_open: float | None = None
        last_short_open: float | None = None
```

Rewrite the pending-fill loop (the `for sig in pending:` block) so opens are gated *before* any fill/commission and exits close all:

```python
            for sig in pending:
                fill_price = self._fill_price(bar.open, sig.side)
                if sig.leg == "long":
                    positions, side, risk, scaling = longs, "long", self.long_risk, self.long_scaling
                    opening = sig.side is Side.BUY
                    last_open = last_long_open
                    close_side = Side.SELL
                else:
                    positions, side, risk, scaling = shorts, "short", self.short_risk, self.short_scaling
                    opening = sig.side is Side.SELL
                    last_open = last_short_open
                    close_side = Side.BUY

                if opening:
                    atr = self._atr_at(scaling.spacing.length if scaling.spacing else None, i)
                    if len(positions) >= scaling.max_concurrent or not spacing_ok(
                        scaling.spacing, last_open, fill_price, side, atr
                    ):
                        continue  # cap/spacing rejected: no fill, no commission
                    result.fills.append(Fill(bar.time, sig.side, fill_price, sig.quantity, sig.reason, sig.leg))
                    realized -= self.commission
                    self._open(positions, side, risk, fill_price, bar.time, sig.reason, sig.quantity, i)
                    if side == "long":
                        last_long_open = fill_price
                    else:
                        last_short_open = fill_price
                else:
                    realized = self._close_all(positions, side, result, realized, close_side, fill_price, bar.time, sig.reason)
                    if side == "long":
                        last_long_open = None
                    else:
                        last_short_open = None
            pending = []
```

Note: `_reduce` and the intra-bar/trailing/`_unrealized`/settle logic from P1 are unchanged. Because intra-bar stops can close individual positions, the last-open trackers are only reset on a rule-exit-all and on natural flat is fine to leave (spacing compares to the last accepted open; once positions exist again the cap/spacing still bound correctly). Delete the now-unused `_open_or_add`.

- [ ] **Step 5: Strategy — drop the entry flat-gate, guard exit on holding**

In `backend/auto_trader/strategy/rule.py`, replace the long and short bucket blocks in `on_bar` with:

```python
        # Long: entry fires whenever the rule passes (the ENGINE caps how many
        # positions open); exit fires only while the side is holding.
        if self.long_enabled:
            if not gated:
                passed, results = self._eval_group(self.long_entry, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.BUY, self.quantity, self._reason(self.long_entry, results), leg="long")
                    )
            if ctx.position_long > 0:
                passed, results = self._eval_group(self.long_exit, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.SELL, self.quantity, self._reason(self.long_exit, results), leg="long")
                    )

        if self.short_enabled:
            if not gated:
                passed, results = self._eval_group(self.short_entry, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.SELL, self.quantity, self._reason(self.short_entry, results), leg="short")
                    )
            if ctx.position_short > 0:
                passed, results = self._eval_group(self.short_exit, ctx, i)
                if passed:
                    signals.append(
                        Signal(Side.BUY, self.quantity, self._reason(self.short_exit, results), leg="short")
                    )
```

(The SELL/BUY exit quantity is nominal — the engine's `_close_all` closes full positions regardless.)

- [ ] **Step 6: Run the new tests, then the FULL suite**

Run: `cd backend && .venv/bin/python -m pytest tests/test_backtest_multi.py -q` → PASS.
Run: `cd backend && .venv/bin/python -m pytest -q` → the SAME count as Step 1 plus the new tests (all pass). If a regression fails, the default path diverged — reconcile (do not edit existing tests).

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/engine/backtest.py backend/auto_trader/strategy/rule.py backend/tests/test_backtest_multi.py
git commit -m "feat(backtest): independent multi-open with max-concurrent + spacing"  # + trailers
```

---

### Task 3: Backend DTO + wiring

**Files:**
- Modify: `backend/auto_trader/api/app.py`
- Test: `backend/tests/test_api_backtest.py`

**Interfaces:**
- Consumes: `ScalingConfig`, `SpacingSpec` (Task 1); engine `long_scaling`/`short_scaling` (Task 2).
- Produces: `BacktestRequest.longScaling` / `shortScaling` (optional); spacing-ATR series validated; engine receives the configs.

- [ ] **Step 1: Write the failing tests**

```python
# add to backend/tests/test_api_backtest.py  (reuse the existing _min_body helper)
def test_scaling_atr_spacing_without_series_is_rejected():
    body = _min_body()
    body["longScaling"] = {"maxConcurrent": 3, "spacing": {"kind": "atr", "mult": 2, "length": 14}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 422
    assert "ATR_14" in r.json()["detail"]


def test_scaling_pct_spacing_runs():
    body = _min_body()
    body["longScaling"] = {"maxConcurrent": 3, "spacing": {"kind": "pct", "value": 1.0}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_backtest.py -q -k scaling` → FAIL (field ignored / 200 not 422).

- [ ] **Step 3: Add the DTO + fields + validation + wiring**

In `app.py` add the import `from auto_trader.engine.scaling import ScalingConfig, SpacingSpec` and, after the risk DTOs:

```python
class SpacingSpecDTO(BaseModel):
    kind: Literal["pct", "atr"]
    value: float | None = None
    mult: float | None = None
    length: int | None = None

    def to_spec(self) -> SpacingSpec:
        return SpacingSpec(self.kind, self.value, self.mult, self.length)


class ScalingConfigDTO(BaseModel):
    maxConcurrent: int = Field(default=1, ge=1)
    spacing: SpacingSpecDTO | None = None

    def to_scaling(self) -> ScalingConfig:
        return ScalingConfig(self.maxConcurrent, self.spacing.to_spec() if self.spacing else None)

    def atr_series_names(self) -> list[str]:
        if self.spacing and self.spacing.kind == "atr" and self.spacing.length is not None:
            return [f"ATR_{self.spacing.length}"]
        return []
```

Add to `BacktestRequest`: `longScaling: ScalingConfigDTO | None = None` and `shortScaling: ScalingConfigDTO | None = None`.

In the handler, extend the ATR-presence loop to also cover scaling:

```python
    for cfg in (req.longScaling, req.shortScaling):
        if cfg is None:
            continue
        for name in cfg.atr_series_names():
            if name not in req.series:
                raise HTTPException(422, f"missing series '{name}' referenced by spacing")
```

And pass to the engine:

```python
        long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
        short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
```

- [ ] **Step 4: Run tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_backtest.py -q` → PASS (all, incl. new).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/app.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): scaling DTO, spacing-ATR validation, engine wiring"  # + trailers
```

---

### Task 4: Frontend types + spacing ATR series

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts`
- Modify: `frontend/src/lib/backtestSeries.ts`
- Test: `frontend/src/lib/backtestConfig.test.ts`, `frontend/src/lib/backtestSeries.test.ts`

**Interfaces:**
- Produces: types `SpacingSpec`, `ScalingConfig`; `BacktestConfig.longScaling?` / `shortScaling?`; `scalingAtrLengths(cfg): number[]`; `longestIndicatorLength` and `buildSeries` also account for spacing ATR.

- [ ] **Step 1: Write the failing tests**

```ts
// backtestConfig.test.ts
import { scalingAtrLengths, longestIndicatorLength, defaultBacktestConfig } from "./backtestConfig";
describe("scaling ATR", () => {
  it("collects spacing ATR lengths and folds into warm-up", () => {
    const cfg = { ...defaultBacktestConfig(),
      longScaling: { maxConcurrent: 3, spacing: { kind: "atr" as const, mult: 2, length: 40 } } };
    expect(scalingAtrLengths(cfg)).toEqual([40]);
    expect(longestIndicatorLength(cfg)).toBe(40);
  });
  it("no ATR when spacing is pct/absent", () => {
    const cfg = { ...defaultBacktestConfig(),
      longScaling: { maxConcurrent: 3, spacing: { kind: "pct" as const, value: 1 } } };
    expect(scalingAtrLengths(cfg)).toEqual([]);
  });
});
```

```ts
// backtestSeries.test.ts (inside the describe("buildSeries"...) block)
it("emits ATR_{n} for scaling spacing", () => {
  const data = candles([10, 11, 12, 13]);
  const out = buildSeries(data, cfg({
    longScaling: { maxConcurrent: 3, spacing: { kind: "atr", mult: 2, length: 3 } },
  }));
  expect(out["ATR_3"]).toBeDefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts src/lib/backtestSeries.test.ts` → FAIL.

- [ ] **Step 3: Add the types + collectors**

In `backtestConfig.ts`, after the risk types:

```ts
export type SpacingKind = "pct" | "atr";
export interface SpacingSpec { kind: SpacingKind; value?: number; mult?: number; length?: number }
export interface ScalingConfig { maxConcurrent: number; spacing?: SpacingSpec }
```

Add `longScaling?: ScalingConfig; shortScaling?: ScalingConfig;` to `BacktestConfig`. Add:

```ts
export function scalingAtrLengths(cfg: BacktestConfig): number[] {
  const out = new Set<number>();
  for (const sc of [cfg.longScaling, cfg.shortScaling]) {
    if (sc?.spacing?.kind === "atr" && sc.spacing.length != null) out.add(sc.spacing.length);
  }
  return [...out];
}
```

Extend `longestIndicatorLength`'s `Math.max(...)` args with `...scalingAtrLengths(cfg)` (alongside the existing `...riskAtrLengths(cfg)`).

In `backtestSeries.ts`, import `scalingAtrLengths` and, in `buildSeries` after the risk-ATR loop:

```ts
  for (const length of scalingAtrLengths(cfg)) {
    if (!out[`ATR_${length}`]) out[`ATR_${length}`] = atrSeries(candles, length);
  }
```

- [ ] **Step 4: Run tests** → PASS.

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts src/lib/backtestSeries.test.ts`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestSeries.ts frontend/src/lib/backtestConfig.test.ts frontend/src/lib/backtestSeries.test.ts
git commit -m "feat(backtest): scaling config types + spacing ATR series"  # + trailers
```

---

### Task 5: Frontend "Scaling & management" UI + request wiring

**Files:**
- Modify: `frontend/src/api.ts`, `frontend/src/BacktestButton.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx`, `frontend/src/App.css`

**Interfaces:**
- Consumes: `ScalingConfig` (Task 4), the backend endpoint (Task 3).
- Produces: `BacktestRequest.longScaling?`/`shortScaling?`; a collapsed per-side "Scaling & management" section with max-concurrent + spacing controls.

- [ ] **Step 1: api.ts + BacktestButton wiring**

In `api.ts` import `ScalingConfig` and add to `BacktestRequest`:
```ts
  longScaling?: ScalingConfig;
  shortScaling?: ScalingConfig;
```
In `BacktestButton.tsx`'s request object add `longScaling: cfg.longScaling, shortScaling: cfg.shortScaling,`.

- [ ] **Step 2: Modal section (per side, collapsed by default)**

In `BacktestSettingsModal.tsx`, import `ScalingConfig` and add a `ScalingSection` rendered inside `SidePanel` after `RiskSection`. Default when unset: `{ maxConcurrent: 1 }`. A `<details>` element keeps it collapsed so the common case stays simple:

```tsx
const DEFAULT_SCALING: ScalingConfig = { maxConcurrent: 1 };

function ScalingSection({ side, scaling, onChange }: {
  side: "long" | "short"; scaling: ScalingConfig; onChange: (s: ScalingConfig) => void;
}) {
  const spacingKind = scaling.spacing?.kind ?? "none";
  const setSpacingKind = (k: "none" | "pct" | "atr") => {
    if (k === "none") return onChange({ ...scaling, spacing: undefined });
    if (k === "pct") return onChange({ ...scaling, spacing: { kind: "pct", value: scaling.spacing?.value ?? 1 } });
    onChange({ ...scaling, spacing: { kind: "atr", mult: scaling.spacing?.mult ?? 1, length: scaling.spacing?.length ?? 14 } });
  };
  return (
    <details className="bt-scaling">
      <summary className="instrument-section-title">Scaling &amp; management ({side})</summary>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Max positions</span>
        <input type="number" min={1} step="1" className="bt-num" value={scaling.maxConcurrent}
          onChange={(e) => onChange({ ...scaling, maxConcurrent: Math.max(1, Math.round(Number(e.target.value))) })} />
      </div>
      <div className="bt-risk-row">
        <span className="bt-risk-label">Min spacing</span>
        <select value={spacingKind} onChange={(e) => setSpacingKind(e.target.value as "none" | "pct" | "atr")}>
          <option value="none">None</option><option value="pct">%</option><option value="atr">ATR ×</option>
        </select>
        {scaling.spacing?.kind === "pct" &&
          <>{<input type="number" step="any" className="bt-num" value={scaling.spacing.value ?? 0}
            onChange={(e) => onChange({ ...scaling, spacing: { kind: "pct", value: Number(e.target.value) } })} />}<span>%</span></>}
        {scaling.spacing?.kind === "atr" && <>
          <input type="number" step="any" className="bt-num" value={scaling.spacing.mult ?? 0}
            onChange={(e) => onChange({ ...scaling, spacing: { ...scaling.spacing!, kind: "atr", mult: Number(e.target.value) } })} />
          <span>× ATR</span>
          <input type="number" step="1" className="bt-num" value={scaling.spacing.length ?? 14}
            onChange={(e) => onChange({ ...scaling, spacing: { ...scaling.spacing!, kind: "atr", length: Math.max(1, Math.round(Number(e.target.value))) } })} />
        </>}
      </div>
    </details>
  );
}
```

Render inside `SidePanel`'s `bt-side-rules` after `RiskSection`:

```tsx
        <ScalingSection
          side={side}
          scaling={(isLong ? cfg.longScaling : cfg.shortScaling) ?? DEFAULT_SCALING}
          onChange={(s) => setCfg({ ...cfg, [isLong ? "longScaling" : "shortScaling"]: s })}
        />
```

- [ ] **Step 3: CSS**

In `App.css` add:

```css
.bt-scaling { padding: 12px 0; border-top: 1px solid var(--border); }
.bt-scaling > summary { cursor: pointer; margin-bottom: 8px; list-style: revert; }
```

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc -b` — confirm no NEW errors in the touched files (baseline ~20 pre-existing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestButton.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/App.css
git commit -m "feat(backtest): Scaling & management UI (max positions + spacing)"  # + trailers
```

---

## Self-Review

**Spec coverage:** implements spec §3 (scale-in bounds: maxConcurrent + spacing), the independent-mode half of §1–§2 (append a new position per accepted open; engine owns management; strategy gate dropped), and the P2 default of §4 (rule-exit closes all). **Deferred (own phases):** pyramiding/merge mode (§2 pyramiding, §6 `mode`) → later; exit-scope fifo/lifo/fraction (§4) → P3; break-even (§5) → P4; per-position chart lines (§7) → P5.

**Placeholder scan:** none — full code for the module, engine loop, strategy blocks, DTO, types, and UI.

**Type consistency:** `ScalingConfig(max_concurrent, spacing)` / `SpacingSpec(kind, value, mult, length)` identical across `scaling.py`, the DTO (`ScalingConfigDTO.to_scaling`), and the TS types. `spacing_ok(spec, last_open, fill_price, side, atr)` signature matches its engine call site. Series key `ATR_{length}` identical across `atr_series_names` (validation), `scalingAtrLengths` (emit), and `_atr_at` (read). Engine `long_scaling`/`short_scaling` default to `ScalingConfig()` so `None` == today.

**Invariant #1 rationale (restated):** default `ScalingConfig(max_concurrent=1)` + the strategy emitting BUY-while-holding that the engine rejects at cap 1 (no fill, no commission) + the exit guarded on `position > 0` = byte-for-byte identical to P1; safe because no existing test adds to a position.
